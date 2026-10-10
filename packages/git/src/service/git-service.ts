import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { GitError, makeError } from '../errors/classify';
import { parseDiff } from '../parsers/diff';
import { COMMIT_DETAIL_FORMAT, logFormat, parseCommitDetailHeader } from '../parsers/log';
import { parseRawNumstat } from '../parsers/numstat';
import {
  parseForEachRef,
  parseTrackRecords,
  REFS_FORMAT_NO_TRACK,
  REFS_FORMAT_TRACK,
  REFS_FORMAT_UPSTREAM,
  TRACK_ONLY_FORMAT,
  type TrackInfo,
} from '../parsers/refs';
import { parseRemotesConfig, REMOTES_CONFIG_REGEXP } from '../parsers/remotes';
import {
  DISCOVERY_ARGS,
  normalizeGitPath,
  parseDiscovery,
  parseRevParse,
  repoStateFrom,
  STATE_FILES,
  type StateFile,
} from '../parsers/revparse';
import { parseStashList, STASH_FORMAT } from '../parsers/stash';
import { countUntracked, parseStatusV2 } from '../parsers/status';
import type { GitProcessRunner, GitRunOptions } from '../process/runner';
import type {
  CommitDetail,
  DiffOptions,
  DiffSpec,
  FileChangeSummary,
  FileDiff,
  GitFeatureFlags,
  HeadInfo,
  LogQuery,
  RefInfo,
  RemoteInfo,
  RepoId,
  RepoInfo,
  SearchQuery,
  SearchTerm,
  Sha,
  ShowFileResult,
  StashEntry,
  StatusEntry,
  StatusResult,
} from '../types';
import { BlobReader, DEFAULT_SHOW_MAX_BYTES } from './blob-reader';
import { COMMIT_GRAPH_THRESHOLD, countCommitsUpTo, hasCommitGraphFile } from './huge-repo';
import {
  isUnbornError,
  LOG_SEED_COUNT,
  StreamingLogCursor,
  type LogCursor,
  type LogCursorArgs,
} from './log-cursor';
import { argvPathspecs, displayPath, isRawPathKey, pathBytes } from './pathspec';
import { assertSafeRev, buildRevSet } from './rev-set';
import {
  buildSearchPlan,
  recordMatches,
  registerSearch,
  SearchQueryError,
  SearchRecordParser,
  searchTerms,
  type SearchHandle,
  type SearchRecord,
} from './search';

export * from './search';

/**
 * One instance per open repo (spec 02 §5.4). Every read runs through the shared GitProcessRunner with
 * `readOnly: true` (GIT_OPTIONAL_LOCKS=0). Mutating ops are out of scope here (OperationQueue, spec 02 §6.13).
 */

export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Untracked explosion threshold (spec 02 §6.15.3). */
export const UNTRACKED_LIMIT = 20_000;
export const DEFAULT_SEARCH_LIMIT = 1000;
const SEARCH_TIMEOUT_MS = 5 * 60_000;
/** Up to this many local tracking branches, refs() computes every ahead/behind itself (spec 02 §6.15.5). */
export const TRACK_SYNC_LIMIT = 50;
/**
 * Background ahead/behind: branches per `for-each-ref` call. The first chunk is small (fast first
 * results), later ones grow to this size (each call costs a spawn plus ≈ 0.1 s of ref-pattern matching).
 */
export const TRACK_CHUNK_SIZE = 500;
const TRACK_FIRST_CHUNK = 100;
/** Background ahead/behind: chunks computed at the same time (2 of the runner's 8 slots). */
export const TRACK_CONCURRENCY = 2;
/** …and at most this many characters of ref names per call (Windows command line limit is 32 767). */
const TRACK_CHUNK_CHARS = 16_000;
/** Background ahead/behind: at most one `onTrackUpdated` notification per this long while chunks land. */
const TRACK_NOTIFY_MS = 400;
/** More untracked directories than this: one plain `--untracked-files=all` status instead. */
const EXPAND_UNTRACKED_DIRS_MAX = 64;
const DIFF_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * `git diff --no-index -z … -- /dev/null -` names the stdin side `-`: give it the display path in the
 * NUL-separated raw / numstat records (the patch headers are not used for names).
 */
function renameStdinDiff(text: string, displayName: string): string {
  return text.split('\0-\0').join(`\0${displayName}\0`);
}

const caseInsensitiveFs = (platform = process.platform): boolean =>
  platform === 'win32' || platform === 'darwin';

/** Stable id for a repo: sha1 hex of the realpath'd root, case-folded on win32/darwin. */
export function repoIdFor(realpathOfRoot: string, platform: NodeJS.Platform = process.platform): RepoId {
  const key = caseInsensitiveFs(platform) ? realpathOfRoot.toLowerCase() : realpathOfRoot;
  return createHash('sha1').update(key).digest('hex');
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return caseInsensitiveFs() ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export interface GitServiceOptions {
  features?: GitFeatureFlags;
  /** Idle timeout before a paused log process is killed (default 5 min, spec 02 §6.6). */
  logIdleMs?: number;
  /** Untracked explosion threshold (default 20k, spec 02 §6.15.3). */
  untrackedLimit?: number;
  /** Use `--date-order` for topo requests on large repos without a commit-graph (default true, §6.15.4). */
  topoFallback?: boolean;
  /** Commit count above which the topo fallback applies (default 10k; tests). */
  commitGraphThreshold?: number;
  /** More local tracking branches than this: ahead/behind is computed lazily (default 50). */
  trackSyncLimit?: number;
  /** Lazy mode: HEAD's branch + the N most recently committed are still computed in refs() (default 20). */
  trackPriorityCount?: number;
  /** Background ahead/behind: largest chunk (default 500; the first one is at most 100). */
  trackChunkSize?: number;
  /** Background ahead/behind: chunks in flight at once (default 2). */
  trackConcurrency?: number;
  /** Background ahead/behind: minimum time between `onTrackUpdated` notifications (default 400 ms). */
  trackNotifyMs?: number;
}

/** Branch / upstream tips a background ahead/behind round works from. */
interface TrackTips {
  shaOf: Map<string, string>;
  heads: { name: string; sha: string; upstream: string; date: number }[];
}

/** Range `to` sentinel for "the working tree" (spec 07 §5 `WORKTREE`). */
export const WORKTREE_REV = ':worktree';

export class GitService {
  private info: RepoInfo;
  private readonly cursors = new Map<string, LogCursor>();
  private blobReader: BlobReader | null = null;
  private emptyTreeSha: Promise<Sha> | null = null;
  private commitCount: Promise<number> | null = null;
  private disposed = false;
  /** Local branches with an upstream at the last refs() (null before the first). */
  private trackedCount: number | null = null;
  /** Ahead/behind per `<branch tip>:<upstream tip>`. */
  private readonly trackCache = new Map<string, TrackInfo>();
  /** Last known ahead/behind per local branch (shown while a recount is pending). */
  private readonly lastTrack = new Map<string, TrackInfo>();
  private trackJob: Promise<void> | null = null;
  /** Restart the background pass after its current chunk (refs moved: different (tip, upstream) pairs). */
  private trackRestart = false;
  /** `<tip>:<upstream tip>` keys the running background pass is still going to compute. */
  private trackPendingKeys = new Set<string>();
  /** Branches to compute first (e.g. what the UI shows), in order. */
  private trackPriority: string[] = [];
  private trackAbort: AbortController | null = null;
  private readonly trackListeners = new Set<() => void>();
  private ucCheck: { at: number; value: boolean; read: Promise<void> } | null = null;

  private constructor(
    private readonly runner: GitProcessRunner,
    info: RepoInfo,
    private readonly opts: GitServiceOptions,
  ) {
    this.info = info;
  }

  /**
   * Discover the repo containing `inputPath` (any subdirectory, a bare repo or a linked worktree) via
   * rev-parse (spec 02 §6.8). Throws GitError `NotARepository`.
   */
  static async open(
    runner: GitProcessRunner,
    inputPath: string,
    opts: GitServiceOptions = {},
  ): Promise<GitService> {
    const notARepo = (): GitError =>
      new GitError(makeError('NotARepository', { argv: ['rev-parse'], exitCode: 128 }));
    let start: string;
    try {
      start = fs.realpathSync.native(path.resolve(inputPath));
      if (!fs.statSync(start).isDirectory()) throw notARepo();
    } catch {
      throw notARepo();
    }
    const disc = parseDiscovery(
      (await runner.run({ cwd: start, args: DISCOVERY_ARGS, readOnly: true })).stdout,
    );
    let worktreeRoot: string | null = null;
    if (!disc.isBare) {
      try {
        const r = await runner.run({ cwd: start, args: ['rev-parse', '--show-toplevel'], readOnly: true });
        worktreeRoot = r.stdout.trim() ? realpathOr(normalizeGitPath(r.stdout)) : null;
      } catch {
        // opened from inside the .git dir: the worktree is its parent (non-linked repos only)
        if (path.basename(disc.gitDir).toLowerCase() === '.git') worktreeRoot = path.dirname(disc.gitDir);
      }
    }
    const gitDir = realpathOr(disc.gitDir);
    const commonDir = realpathOr(disc.commonDir);
    const info: RepoInfo = {
      id: repoIdFor(worktreeRoot ?? gitDir),
      worktreeRoot,
      gitDir,
      commonDir,
      isBare: disc.isBare,
      isShallow: disc.isShallow,
      isLinkedWorktree: !samePath(gitDir, commonDir),
      objectFormat: disc.objectFormat,
      head: { kind: 'branch', name: '', sha: null },
      state: 'clean',
    };
    const svc = new GitService(runner, info, opts);
    await svc.refreshRepoInfo();
    return svc;
  }

  get repo(): RepoInfo {
    return this.info;
  }

  /** Working directory for every command: the worktree root, or the git dir for bare repos. */
  get cwd(): string {
    return this.info.worktreeRoot ?? this.info.gitDir;
  }

  private run(args: string[], o: Partial<GitRunOptions> = {}): ReturnType<GitProcessRunner['run']> {
    return this.runner.run({ cwd: this.cwd, args, readOnly: true, ...o });
  }

  /**
   * Run an arbitrary read-only command in this repo (`GIT_OPTIONAL_LOCKS=0`, read timeout). For op
   * executors' preflight reads; callers must keep user values after `--`.
   */
  runRead(args: string[], o: Omit<Partial<GitRunOptions>, 'cwd' | 'args' | 'readOnly' | 'encoding'> = {}) {
    return this.run(args, o);
  }

  /** Stream a read-only command's stdout (`blame --incremental`, spec 07 §6.8). */
  streamRead(args: string[], o: Omit<Partial<GitRunOptions>, 'cwd' | 'args' | 'readOnly' | 'encoding'> = {}) {
    return this.runner.stream({ cwd: this.cwd, args, readOnly: true, ...o });
  }

  /**
   * Run a mutating command in this repo (no `GIT_OPTIONAL_LOCKS`, no default timeout). Only
   * OperationQueue executors call this (spec 02 §6.13).
   */
  runWrite(args: string[], o: Omit<Partial<GitRunOptions>, 'cwd' | 'args' | 'readOnly' | 'encoding'> = {}) {
    return this.runner.run({ cwd: this.cwd, args, ...o, readOnly: false, encoding: 'utf8' });
  }

  // ---- repo info ----

  /** Re-read HEAD and the in-progress operation state (spec 02 §6.7, §6.8, §11). */
  async refreshRepoInfo(): Promise<RepoInfo> {
    const [head, state] = await Promise.all([this.readHead(), this.readState()]);
    this.info = { ...this.info, head, state };
    return this.info;
  }

  private async readHead(): Promise<HeadInfo> {
    const [sym, verify] = await Promise.all([
      this.run(['symbolic-ref', '-q', 'HEAD'], { expectedExitCodes: [0, 1] }),
      this.run(['rev-parse', '-q', '--verify', 'HEAD'], { expectedExitCodes: [0, 1] }),
    ]);
    const sha = verify.exitCode === 0 ? parseRevParse(verify.stdout) : null;
    if (sym.exitCode === 0) {
      const ref = sym.stdout.trim();
      return { kind: 'branch', name: ref.replace(/^refs\/heads\//, ''), sha };
    }
    return { kind: 'detached', sha: sha ?? '' };
  }

  private async readState(): Promise<RepoInfo['state']> {
    const r = await this.run([
      'rev-parse',
      '--path-format=absolute',
      ...STATE_FILES.flatMap((f) => ['--git-path', f]),
    ]);
    const paths = r.stdout.split(/\r?\n/).filter(Boolean);
    const exists = new Map<StateFile, boolean>();
    STATE_FILES.forEach((f, i) => {
      const p = paths[i];
      exists.set(f, p ? fs.existsSync(normalizeGitPath(p)) : false);
    });
    return repoStateFrom((f) => exists.get(f) ?? false);
  }

  // ---- status ----

  async status(o: { untracked?: 'all' | 'normal' | 'no' } = {}): Promise<StatusResult> {
    if (this.info.isBare) {
      throw new GitError(
        makeError('Unknown', { argv: ['status'] }, 'Status is not available in a bare repository.'),
      );
    }
    const mode = o.untracked ?? 'all';
    if (mode === 'all' && this.indexCachesEnabled()) {
      const fast = await this.statusViaUntrackedCache();
      if (fast) return fast;
    }
    const result = await this.runStatus(mode);
    if (mode === 'all' && countUntracked(result.entries) > (this.opts.untrackedLimit ?? UNTRACKED_LIMIT)) {
      const collapsed = await this.runStatus('normal');
      collapsed.truncatedUntracked = true;
      return collapsed;
    }
    return result;
  }

  /**
   * Status of another linked worktree of this repository (spec 02 §11 "One WIP status per worktree"):
   * `git -C <path> --no-optional-locks status --porcelain=v2 -z --untracked-files=normal` in the read
   * pool. `worktreePath` must be one of `git worktree list`.
   */
  async worktreeStatus(worktreePath: string): Promise<StatusResult> {
    const list = await this.run(['worktree', 'list', '--porcelain']);
    const wanted = realpathOr(path.resolve(worktreePath));
    const known = String(list.stdout)
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => realpathOr(normalizeGitPath(l.slice('worktree '.length))));
    if (!known.some((k) => samePath(k, wanted))) {
      throw new GitError(
        makeError('NotARepository', { argv: ['status'] }, 'Not a worktree of this repository.', {
          worktreePath,
        }),
      );
    }
    const showStash = this.opts.features?.statusShowStash ?? true;
    const r = await this.runner.run({
      cwd: wanted,
      args: [
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        ...(showStash ? ['--show-stash'] : []),
        '--untracked-files=normal',
        '--ignore-submodules=none',
        '--find-renames',
      ],
      readOnly: true,
      priority: 'background',
      maxBuffer: DIFF_MAX_BUFFER,
      encoding: 'buffer',
    });
    return parseStatusV2(r.stdout);
  }

  /**
   * `--untracked-files=all` can't use the untracked cache, and with fsmonitor it is even slower than
   * without (files-100k: ≈ 300 ms vs ≈ 140 ms for `normal`, ≈ 115 ms being the spawn itself). With
   * `core.untrackedCache` or `core.fsmonitor` on, status runs with `normal` and only the untracked
   * directories it reports are expanded, by a second, pathspec-limited status. null → use the plain path.
   */
  private async statusViaUntrackedCache(): Promise<StatusResult | null> {
    const collapsed = await this.runStatus('normal');
    const isDir = (e: StatusEntry): boolean => e.kind === 'untracked' && e.path.endsWith('/');
    const dirs = collapsed.entries.filter(isDir);
    if (!dirs.length) return collapsed;
    if (dirs.length > EXPAND_UNTRACKED_DIRS_MAX || dirs.some((d) => d.rawPath)) return null;
    const expanded = await this.runStatus(
      'all',
      dirs.map((d) => d.path),
    );
    const files = expanded.entries.filter((e) => e.kind === 'untracked');
    const untracked = [...collapsed.entries.filter((e) => e.kind === 'untracked' && !isDir(e)), ...files];
    if (untracked.length > (this.opts.untrackedLimit ?? UNTRACKED_LIMIT)) {
      collapsed.truncatedUntracked = true;
      return collapsed;
    }
    untracked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    collapsed.entries = [...collapsed.entries.filter((e) => e.kind !== 'untracked'), ...untracked];
    return collapsed;
  }

  /**
   * `core.untrackedCache` / `core.fsmonitor` enabled? Read in the background and cached for 30 s, so it
   * never delays a status (the first one after opening takes the plain path).
   */
  indexCachesEnabled(): boolean {
    const now = Date.now();
    if (!this.ucCheck || now - this.ucCheck.at > 30_000) {
      const prev = this.ucCheck?.value ?? false;
      const check: { at: number; value: boolean; read: Promise<void> } = {
        at: now,
        value: prev,
        read: Promise.resolve(),
      };
      this.ucCheck = check;
      check.read = this.run(['config', '--get-regexp', '^core\\.(fsmonitor|untrackedcache)$'], {
        expectedExitCodes: [0, 1],
        priority: 'background',
      })
        .then((r) => {
          check.value = String(r.stdout)
            .split(/\r?\n/)
            .some((l) => {
              const [k, v = ''] = l.trim().split(/\s+/, 2);
              return !!k && !/^(false|no|off|0|)$/i.test(v);
            });
        })
        .catch(() => undefined);
    }
    return this.ucCheck.value;
  }

  /** indexCachesEnabled() from a fresh config read (the cached value is updated too). */
  async indexCachesEnabledNow(): Promise<boolean> {
    if (this.ucCheck) this.ucCheck.at = -Infinity;
    this.indexCachesEnabled();
    await this.ucCheck!.read;
    return this.ucCheck!.value;
  }

  private async runStatus(mode: 'all' | 'normal' | 'no', pathspecs?: string[]): Promise<StatusResult> {
    const showStash = this.opts.features?.statusShowStash ?? true;
    const args = [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      ...(showStash ? ['--show-stash'] : []),
      `--untracked-files=${mode}`,
      '--ignore-submodules=none',
      '--find-renames',
    ];
    if (pathspecs) args.push('--', ...pathspecs);
    const [r, stashCount] = await Promise.all([
      // buffer: paths that are not valid UTF-8 keep their raw bytes (spec 02 §8)
      this.run(args, {
        maxBuffer: DIFF_MAX_BUFFER,
        encoding: 'buffer',
        ...(pathspecs ? { env: { GIT_LITERAL_PATHSPECS: '1' } } : {}),
      }),
      showStash ? Promise.resolve(null) : this.countStashes(),
    ]);
    const result = parseStatusV2(r.stdout as unknown as Buffer);
    if (stashCount !== null) result.stashCount = stashCount;
    return result;
  }

  private async countStashes(): Promise<number> {
    const r = await this.run(['rev-list', '--walk-reflogs', '--count', 'refs/stash'], {
      expectedExitCodes: [0, 1, 128],
    });
    return r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  // ---- refs ----

  /**
   * Branches, remotes, tags and refs/stash (never refs/githappens/*), spec 02 §6.7 / §6.15.5.
   *
   * `%(upstream:track)` costs ≈ 1.5–3 ms per tracking branch (8–15 s for 5k), so with more than
   * `trackSyncLimit` local tracking branches only HEAD's branch and the most recently committed ones are
   * computed before returning; the rest are marked `upstream.trackPending` (with their last known counts)
   * and computed by a progressive background pass (chunks of `trackChunkSize` explicit refs, prioritized
   * branches first, then most recently committed), firing `onTrackUpdated` as chunks land (throttled).
   * Results are cached per (branch tip, upstream tip) pair, so later calls only compute what moved.
   */
  async refs(): Promise<RefInfo[]> {
    const root = this.info.worktreeRoot;
    const mapWorktreePath = (p: string): string | undefined => {
      const n = realpathOr(normalizeGitPath(p));
      return root && samePath(n, root) ? undefined : n;
    };
    const parse = (text: string): RefInfo[] => parseForEachRef(text, { mapWorktreePath });
    const limit = this.opts.trackSyncLimit ?? TRACK_SYNC_LIMIT;
    const headsArgs = (format: string): string[] => ['for-each-ref', `--format=${format}`, 'refs/heads'];
    const othersP = this.run([
      'for-each-ref',
      `--format=${REFS_FORMAT_NO_TRACK}`,
      'refs/remotes',
      'refs/tags',
      'refs/stash',
    ]);

    if (this.trackedCount !== null && this.trackedCount <= limit) {
      // few tracking branches (the common case): one call with ahead/behind, as git computes it
      const [heads, others] = await Promise.all([this.run(headsArgs(REFS_FORMAT_TRACK)), othersP]);
      const local = parse(heads.stdout);
      this.trackedCount = local.filter((r) => r.upstream).length;
      return [...local, ...parse(others.stdout)];
    }

    // Unknown size (first call): race the full track call against the cheap listing and drop it when
    // there are too many tracking branches.
    const ac = this.trackedCount === null ? new AbortController() : null;
    const fullP = ac
      ? this.run(headsArgs(REFS_FORMAT_TRACK), { signal: ac.signal }).catch(() => null)
      : Promise.resolve(null);
    let local: RefInfo[];
    let others: Awaited<typeof othersP>;
    try {
      const [heads, o] = await Promise.all([this.run(headsArgs(REFS_FORMAT_UPSTREAM)), othersP]);
      local = parse(heads.stdout);
      others = o;
    } catch (e) {
      ac?.abort();
      throw e;
    }
    this.trackedCount = local.filter((r) => r.upstream).length;
    if (ac && this.trackedCount <= limit) {
      const full = await fullP;
      if (full) return [...parse(full.stdout), ...parse(others.stdout)];
    } else ac?.abort();
    const rest = parse(others.stdout);
    await this.fillTrack(local, rest, limit);
    return [...local, ...rest];
  }

  /** Called after background ahead/behind results arrive (RepoManager → a `refs` refresh). */
  onTrackUpdated(listener: () => void): () => void {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  }

  /**
   * Branches (full ref names) whose ahead/behind the background pass should compute first, e.g. the rows
   * the UI shows. Takes effect at the next chunk; without hints the pass goes most recently committed first.
   */
  prioritizeTrack(fullNames: string[]): void {
    this.trackPriority = [...fullNames];
  }

  /** Resolves when no background ahead/behind pass is running (bench / tests). */
  async whenTrackIdle(): Promise<void> {
    while (this.trackJob) await this.trackJob;
  }

  /** Fill `upstream` ahead/behind of `local` from the cache, computing the most relevant misses now. */
  private async fillTrack(local: RefInfo[], others: RefInfo[], limit: number): Promise<void> {
    const shaOf = new Map<string, Sha>();
    for (const r of [...local, ...others]) shaOf.set(r.fullName, r.sha);
    type Miss = { ref: RefInfo; up: NonNullable<RefInfo['upstream']>; key: string };
    const misses: Miss[] = [];
    for (const ref of local) {
      const up = ref.upstream;
      if (!up) continue;
      const upSha = shaOf.get(up.fullName);
      if (!upSha) {
        // configured upstream ref does not exist: what `%(upstream:track)` reports as "gone"
        Object.assign(up, { ahead: 0, behind: 0, gone: true });
        continue;
      }
      const key = `${ref.sha}:${upSha}`;
      const hit = this.trackCache.get(key);
      if (hit) Object.assign(up, { ahead: hit.ahead, behind: hit.behind, gone: false });
      else misses.push({ ref, up, key });
    }
    if (!misses.length) return;
    misses.sort(
      (a, b) =>
        Number(b.ref.isHead) - Number(a.ref.isHead) || (b.ref.creatorDate ?? 0) - (a.ref.creatorDate ?? 0),
    );
    // what a running background pass is about to count is left to it (its notifications call refs(): a
    // synchronous recount here would only duplicate its work); new pairs (refs moved) are counted now
    const fresh = this.trackJob ? misses.filter((m) => !this.trackPendingKeys.has(m.key)) : misses;
    const now = misses.length <= limit ? fresh : fresh.slice(0, this.opts.trackPriorityCount ?? 20);
    const counted = new Set(now);
    const later = misses.filter((m) => !counted.has(m));
    if (now.length) {
      try {
        const r = await this.run([
          'for-each-ref',
          `--format=${TRACK_ONLY_FORMAT}`,
          ...now.map((m) => m.ref.fullName),
        ]);
        const recs = new Map(parseTrackRecords(r.stdout).map((t) => [t.fullName, t]));
        for (const m of now) {
          const t = recs.get(m.ref.fullName);
          if (!t || t.sha !== m.ref.sha || t.upstream !== m.up.fullName) {
            later.push(m); // moved in between: leave it to the background pass
            continue;
          }
          this.storeTrack(m.key, m.ref.fullName, t);
          Object.assign(m.up, { ahead: t.ahead, behind: t.behind, gone: t.gone });
        }
      } catch {
        later.push(...now);
      }
    }
    for (const m of later) {
      const last = this.lastTrack.get(m.ref.fullName);
      Object.assign(m.up, { ahead: last?.ahead ?? 0, behind: last?.behind ?? 0, trackPending: true });
    }
    if (later.length) {
      const tips: TrackTips = { shaOf, heads: [] };
      for (const r of local) {
        if (r.upstream) {
          tips.heads.push({
            name: r.fullName,
            sha: r.sha,
            upstream: r.upstream.fullName,
            date: r.creatorDate ?? 0,
          });
        }
      }
      this.scheduleTrack(
        later.map((m) => m.key),
        tips,
      );
    }
  }

  private async readTrackTips(signal: AbortSignal): Promise<TrackTips> {
    const r = await this.run(
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(upstream)%00%(creatordate:unix)%1e',
        'refs/heads',
        'refs/remotes',
      ],
      { priority: 'background', signal },
    );
    const out: TrackTips = { shaOf: new Map(), heads: [] };
    for (const rec of r.stdout.split('\x1e')) {
      const [name, sha, upstream, date] = rec.replace(/^\r?\n/, '').split('\0');
      if (!name || !sha) continue;
      out.shaOf.set(name, sha);
      if (upstream && name.startsWith('refs/heads/')) {
        out.heads.push({ name, sha, upstream, date: Number(date) || 0 });
      }
    }
    return out;
  }

  private storeTrack(key: string, fullName: string, t: TrackInfo): void {
    if (this.trackCache.size > 200_000) this.trackCache.clear();
    const v = { ahead: t.ahead, behind: t.behind, gone: t.gone };
    this.trackCache.set(key, v);
    this.lastTrack.set(fullName, v);
  }

  /**
   * Progressive background ahead/behind (spec 02 §6.15.5): at most one pass at a time. A running pass that
   * already covers every requested `<tip>:<upstream tip>` key just continues (the refs() calls its own
   * notifications trigger never restart it); otherwise it restarts after its current chunk with fresh tips,
   * skipping everything cached meanwhile.
   */
  private scheduleTrack(keys: string[], tips: TrackTips): void {
    if (this.trackJob) {
      if (keys.some((k) => !this.trackPendingKeys.has(k))) this.trackRestart = true;
      return;
    }
    const ac = new AbortController();
    this.trackAbort = ac;
    this.trackJob = this.trackPass(ac.signal, tips)
      .catch(() => undefined)
      .finally(() => {
        this.trackJob = null;
        this.trackAbort = null;
        this.trackPendingKeys = new Set();
      });
  }

  /** `tips`: the refs() listing that found the misses (saves re-reading them for the first round). */
  private async trackPass(signal: AbortSignal, tips: TrackTips | null): Promise<void> {
    const maxChunk = Math.max(1, this.opts.trackChunkSize ?? TRACK_CHUNK_SIZE);
    const concurrency = Math.max(1, this.opts.trackConcurrency ?? TRACK_CONCURRENCY);
    const notifyMs = this.opts.trackNotifyMs ?? TRACK_NOTIFY_MS;
    let unannounced = 0;
    let lastNotify = 0;
    const notify = (): void => {
      if (!unannounced || this.disposed) return;
      unannounced = 0;
      lastNotify = Date.now();
      for (const l of this.trackListeners) l();
    };
    do {
      this.trackRestart = false;
      // tips first: a pair is cached under the upstream tip seen *before* the counts were computed, so a
      // ref moving meanwhile only leaves an unused entry behind (and restarts the pass via refs())
      const { shaOf, heads } = tips ?? (await this.readTrackTips(signal));
      tips = null;
      if (this.disposed) return;
      let todo: { name: string; key: string; date: number }[] = [];
      for (const h of heads) {
        const upSha = shaOf.get(h.upstream);
        if (!upSha) continue; // gone: nothing to count
        const key = `${h.sha}:${upSha}`;
        if (!this.trackCache.has(key)) todo.push({ name: h.name, key, date: h.date });
      }
      this.trackPendingKeys = new Set(todo.map((t) => t.key));
      let priority: string[] | null = null;
      let size = Math.min(TRACK_FIRST_CHUNK, maxChunk);
      /** Next chunk: prioritized branches first, then most recently committed. */
      const take = (): string[] | null => {
        // a pair counted by a previous chunk (another branch with the same tips) needs no call
        todo = todo.filter((t) => !this.trackCache.has(t.key));
        if (!todo.length || this.trackRestart || this.disposed) return null;
        if (priority !== this.trackPriority) {
          priority = this.trackPriority;
          const head = this.info.head.kind === 'branch' ? `refs/heads/${this.info.head.name}` : null;
          const rank = new Map(priority.map((n, i) => [n, i]));
          if (head) rank.set(head, -1); // HEAD's branch first (refs() leaves it to a running pass)
          todo.sort(
            (a, b) =>
              (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity) ||
              b.date - a.date ||
              (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          );
        }
        let n = 0;
        let chars = 0;
        while (n < todo.length && n < size && (n === 0 || chars + todo[n]!.name.length < TRACK_CHUNK_CHARS)) {
          chars += todo[n]!.name.length + 1;
          n++;
        }
        size = Math.min(maxChunk, size * 2);
        const chunk = todo.slice(0, n).map((t) => t.name);
        todo = todo.slice(n);
        return chunk;
      };
      const worker = async (): Promise<void> => {
        for (let chunk = take(); chunk; chunk = take()) {
          const r = await this.run(['for-each-ref', `--format=${TRACK_ONLY_FORMAT}`, ...chunk], {
            priority: 'background',
            signal,
            timeoutMs: 10 * 60_000,
          });
          if (this.disposed) return;
          for (const t of parseTrackRecords(r.stdout)) {
            const upSha = t.upstream ? shaOf.get(t.upstream) : undefined;
            if (!upSha || shaOf.get(t.fullName) !== t.sha) continue; // moved since the tips were read
            const key = `${t.sha}:${upSha}`;
            this.storeTrack(key, t.fullName, t);
            this.trackPendingKeys.delete(key);
            unannounced++;
          }
          if (Date.now() - lastNotify >= notifyMs) notify();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
    } while (this.trackRestart && !this.disposed);
    notify();
  }

  // ---- log ----

  /** Streaming, paged graph log (spec 02 §6.6). The caller must page to `done` or `dispose()`. */
  log(q: LogQuery): LogCursor {
    const cursor = new StreamingLogCursor({
      runner: this.runner,
      cwd: this.cwd,
      signature: q.includeSignatureStatus,
      idleMs: this.opts.logIdleMs,
      buildArgs: () => this.logArgs(q),
      hasCommitGraph: () => hasCommitGraphFile(this.info.commonDir),
      isEmptyRepoError: (e) => isUnbornError(e) || (this.info.head.sha === null && e.code !== 'Cancelled'),
      onDispose: (c) => this.cursors.delete(c.id),
    });
    this.cursors.set(cursor.id, cursor);
    return cursor;
  }

  /** Look up a live cursor by id (IPC `git:log:next` / `git:log:dispose`). */
  getLogCursor(id: string): LogCursor | undefined {
    return this.cursors.get(id);
  }

  /**
   * spec 02 §6.15.4: whether an ordered walk (`--topo-order` / `--date-order`) streams. Without a
   * commit-graph (no generation numbers) both walk the whole history before the first commit (≈ 1.3–1.5 s
   * for 200k commits), so large repos (> 10k commits) get a seeded first page until the graph is written
   * (see logArgs).
   */
  async topoOrderStreams(): Promise<boolean> {
    if (this.opts.topoFallback === false || hasCommitGraphFile(this.info.commonDir)) return true;
    const threshold = this.opts.commitGraphThreshold ?? COMMIT_GRAPH_THRESHOLD;
    this.commitCount ??= countCommitsUpTo(this, threshold + 1).catch(() => 0);
    return (await this.commitCount) <= threshold;
  }

  /**
   * `args`: the ordered walk. On a large repo without a commit-graph, the graph's plain query gets
   * `window` (every page a topologically ordered window drawn from a streaming default-order walk, valid
   * across pages also with clock skew) and filtered queries get `seed` (a default-order `--max-count`
   * probe shown children-first, then the ordered walk minus those); see StreamingLogCursor. `--follow`
   * and author-date order always use the plain walk.
   */
  private async logArgs(q: LogQuery): Promise<LogCursorArgs> {
    const [streams, revs] = await Promise.all([this.topoOrderStreams(), this.revSet(q.revs, q.hiddenRefs)]);
    const order =
      q.order === 'topo'
        ? '--topo-order'
        : q.order === 'author-date'
          ? '--author-date-order'
          : '--date-order';
    const head = ['log', '-z', `--format=${logFormat({ signature: q.includeSignatureStatus })}`];
    const rest = ['--no-color', '--decorate=no'];
    if (q.firstParent) rest.push('--first-parent');
    const authors = q.author === undefined ? [] : Array.isArray(q.author) ? q.author : [q.author];
    for (const a of authors) rest.push(`--author=${a}`);
    if (q.grep) rest.push(`--grep=${q.grep}`, '--regexp-ignore-case');
    if (q.since !== undefined) rest.push(`--max-age=${Math.floor(q.since)}`);
    if (q.until !== undefined) rest.push(`--min-age=${Math.floor(q.until)}`);
    const paths = q.paths ?? [];
    // `--follow` takes no pathspec magic: a raw (non-UTF-8) path is shown without following renames
    const follow = !!q.follow && paths.length === 1 && !isRawPathKey(paths[0]!);
    if (follow) rest.push('--follow');
    const ps = argvPathspecs(paths);
    rest.push(...revs, '--', ...ps.paths);
    const env = ps.env;
    const args = [...head, order, ...rest];
    if (streams || follow || q.order === 'author-date') return { args, env };
    const plain =
      q.revs === 'all' &&
      !q.firstParent &&
      !authors.length &&
      !q.grep &&
      q.since === undefined &&
      q.until === undefined &&
      !paths.length;
    if (plain) {
      // the graph: windowed pages, each topologically consistent with the rest (see StreamingLogCursor)
      const flags = ['--no-color', '--decorate=no'];
      return {
        args,
        env,
        window: {
          stream: [...head, ...flags],
          ordered: [...head, order, ...flags],
          revs,
          tips: ['rev-list', '--no-walk', ...revs, '--'],
        },
      };
    }
    return { args, env, seed: [...head, `--max-count=${LOG_SEED_COUNT}`, ...rest] };
  }

  /**
   * buildRevSet with live HEAD / stash state. Read from `.git/HEAD` and the stash reflog when possible:
   * two `git` spawns (≈ 100–150 ms on Windows) saved on the critical path of every graph page.
   */
  private async revSet(revs: LogQuery['revs'], hiddenRefs?: string[]): Promise<string[]> {
    if (revs !== 'all') return buildRevSet({ revs });
    const fast = this.revSetStateFromFiles(hiddenRefs);
    if (fast) return buildRevSet({ revs: 'all', hiddenRefs, ...fast });
    const [headSha, stashes] = await Promise.all([this.revParse('HEAD'), this.stashList().catch(() => [])]);
    return buildRevSet({
      revs: 'all',
      hiddenRefs,
      includeHead: headSha !== null,
      stashTips: stashes.map((s) => s.sha),
    });
  }

  /**
   * HEAD / stash state without spawning git, or null when the files can't answer (reftable, unusual
   * symrefs, unreadable files). A symbolic HEAD on `refs/heads/x` is already covered by the
   * `refs/heads/*` glob, so `HEAD` is only passed when detached, or when its branch is hidden but exists
   * (as `rev-parse --verify HEAD` would decide).
   */
  private revSetStateFromFiles(hiddenRefs?: string[]): { includeHead: boolean; stashTips: Sha[] } | null {
    const { gitDir, commonDir } = this.info;
    try {
      if (fs.existsSync(path.join(commonDir, 'reftable'))) return null;
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      let includeHead: boolean;
      const sym = /^ref:\s*(\S+)$/.exec(head);
      if (sym) {
        const ref = sym[1]!;
        if (!ref.startsWith('refs/heads/') || ref.endsWith('/.invalid')) return null;
        includeHead = hiddenRefs?.length ? this.refFileExists(ref) : false;
      } else if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) {
        includeHead = true;
      } else return null;
      return { includeHead, stashTips: this.info.isBare ? [] : this.stashTipsFromReflog() };
    } catch {
      return null;
    }
  }

  private refFileExists(ref: string): boolean {
    if (fs.existsSync(path.join(this.info.commonDir, ...ref.split('/')))) return true;
    try {
      const packed = fs.readFileSync(path.join(this.info.commonDir, 'packed-refs'), 'utf8');
      return packed.split(/\r?\n/).some((l) => l.endsWith(` ${ref}`) && !l.startsWith('^'));
    } catch {
      return false;
    }
  }

  /** `refs/stash` reflog tips, newest first (what `git stash list` shows); [] without a stash. */
  private stashTipsFromReflog(): Sha[] {
    if (!this.refFileExists('refs/stash')) return [];
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.info.commonDir, 'logs', 'refs', 'stash'), 'utf8');
    } catch {
      return [];
    }
    const tips: Sha[] = [];
    for (const line of text.split('\n')) {
      const sha = line.split(' ', 2)[1];
      if (sha && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) && !/^0+$/.test(sha)) tips.push(sha);
    }
    return tips.reverse();
  }

  // ---- commit detail ----

  /** Summary + body + changed files (renames with -M; merges vs first parent), spec 02 §6.8. */
  async commitDetail(sha: Sha): Promise<CommitDetail> {
    assertSafeRev(sha);
    const show = await this.run(['show', '-s', '-z', `--format=${COMMIT_DETAIL_FORMAT}`, sha, '--']);
    const { summary, body } = parseCommitDetailHeader(show.stdout);
    const treeArgs = summary.parents.length ? [summary.parents[0]!, summary.sha] : ['--root', summary.sha];
    const files = await this.run(
      ['diff-tree', '-z', '-r', '-M', '--raw', '--numstat', '--no-commit-id', '--no-abbrev', ...treeArgs],
      { maxBuffer: DIFF_MAX_BUFFER },
    );
    return { ...summary, body, files: parseRawNumstat(files.stdout) };
  }

  // ---- diff ----

  async diff(spec: DiffSpec, opts: DiffOptions = {}): Promise<FileDiff[]> {
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--patch-with-raw', '-z'];
    args.push('--full-index', '--no-abbrev', '--submodule=short');
    if (opts.contextLines !== undefined) args.push(`--unified=${Math.max(0, Math.floor(opts.contextLines))}`);
    switch (opts.ignoreWhitespace) {
      case 'eol':
        args.push('--ignore-space-at-eol');
        break;
      case 'amount':
        args.push('--ignore-space-change');
        break;
      case 'all':
        args.push('--ignore-all-space');
        break;
    }
    if (opts.ignoreBlankLines) args.push('--ignore-blank-lines');
    if (opts.renameLimit !== undefined) args.push(`-l${Math.max(0, Math.floor(opts.renameLimit))}`);
    const r = await this.runDiff(args, spec);
    return parseDiff(r, { maxBytesPerFile: opts.maxBytesPerFile });
  }

  async numstat(spec: DiffSpec): Promise<FileChangeSummary[]> {
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--raw', '--numstat', '-z'];
    args.push('--no-abbrev');
    return parseRawNumstat(await this.runDiff(args, spec));
  }

  private async runDiff(base: string[], spec: DiffSpec): Promise<string> {
    if (spec.kind === 'untracked') {
      if (this.info.isBare) throw this.bareError('diff');
      if (isRawPathKey(spec.path)) {
        // not valid UTF-8 (spec 02 §8): argv can't carry the name, so the file's bytes go through stdin
        // (`-`); the patch names it `-`, which is renamed to the (lossy) display path
        const content = await fs.promises.readFile(
          Buffer.concat([Buffer.from(`${this.cwd}/`), pathBytes(spec.path)]),
        );
        const r = await this.run([...base, '--no-index', '--', '/dev/null', '-'], {
          stdin: content,
          expectedExitCodes: [0, 1],
          maxBuffer: DIFF_MAX_BUFFER,
        });
        return renameStdinDiff(String(r.stdout), displayPath(spec.path));
      }
      const r = await this.run([...base, '--no-index', '--', '/dev/null', spec.path.replace(/\\/g, '/')], {
        expectedExitCodes: [0, 1],
        maxBuffer: DIFF_MAX_BUFFER,
      });
      return r.stdout;
    }
    const revs = await this.diffRevs(spec);
    const ps = argvPathspecs(spec.paths ?? []);
    const r = await this.run([...base, ...revs, '--', ...ps.paths], {
      env: ps.env,
      maxBuffer: DIFF_MAX_BUFFER,
    });
    return r.stdout;
  }

  private async diffRevs(spec: Exclude<DiffSpec, { kind: 'untracked' }>): Promise<string[]> {
    switch (spec.kind) {
      case 'workdir':
        if (this.info.isBare) throw this.bareError('diff');
        return [];
      case 'staged': {
        if (this.info.isBare) throw this.bareError('diff');
        const head = await this.revParse('HEAD');
        return head ? ['--cached'] : ['--cached', await this.emptyTree()];
      }
      case 'commit': {
        assertSafeRev(spec.sha);
        const n = spec.parentIndex ?? 1;
        const parent = await this.revParse(`${spec.sha}^${n}`);
        if (!parent && n > 1) {
          throw new GitError(makeError('Unknown', { argv: ['diff'] }, `Commit has no parent #${n}.`));
        }
        return [parent ?? (await this.emptyTree()), spec.sha];
      }
      case 'range':
        assertSafeRev(spec.from);
        // `to: ':worktree'` compares a commit with the working tree (spec 07 §4.8 "Compare commit vs WIP")
        if (spec.to === WORKTREE_REV) {
          if (this.info.isBare) throw this.bareError('diff');
          if (!spec.threeDot) return [spec.from];
          const base = await this.run(['merge-base', spec.from, 'HEAD'], { expectedExitCodes: [0, 1] });
          return [base.stdout.trim() || spec.from];
        }
        assertSafeRev(spec.to);
        return spec.threeDot ? [`${spec.from}...${spec.to}`] : [spec.from, spec.to];
    }
  }

  private emptyTree(): Promise<Sha> {
    if (this.info.objectFormat === 'sha1') return Promise.resolve(EMPTY_TREE_SHA1);
    this.emptyTreeSha ??= this.runner
      .run({ cwd: this.cwd, args: ['hash-object', '-t', 'tree', '--stdin'], stdin: '', readOnly: true })
      .then((r) => r.stdout.trim());
    return this.emptyTreeSha;
  }

  private bareError(cmd: string): GitError {
    return new GitError(
      makeError('Unknown', { argv: [cmd] }, 'This operation needs a working tree (bare repository).'),
    );
  }

  // ---- files ----

  /** File content at a revision or index stage (`:0`..`:3`) via the per-repo BlobReader. */
  showFile(rev: string, filePath: string, maxBytes = DEFAULT_SHOW_MAX_BYTES): Promise<ShowFileResult> {
    return this.blobs().read(rev, filePath, maxBytes);
  }

  /** The per-repo long-lived blob reader (spec 02 §11). */
  blobs(): BlobReader {
    if (this.disposed) throw new Error('GitService disposed');
    this.blobReader ??= new BlobReader(this.runner, this.cwd);
    return this.blobReader;
  }

  // ---- misc reads ----

  async stashList(): Promise<StashEntry[]> {
    if (this.info.isBare) return [];
    const r = await this.run(['stash', 'list', '-z', `--format=${STASH_FORMAT}`]);
    return parseStashList(r.stdout);
  }

  async remotes(): Promise<RemoteInfo[]> {
    const r = await this.run(['config', '-z', '--get-regexp', REMOTES_CONFIG_REGEXP], {
      expectedExitCodes: [0, 1],
    });
    return r.exitCode === 0 ? parseRemotesConfig(r.stdout) : [];
  }

  /** Resolve to a commit sha; null when it does not exist (spec 02 §6.8). */
  async revParse(rev: string): Promise<Sha | null> {
    if (!rev || rev.startsWith('-') || /[\0\n\r]/.test(rev)) return null;
    const r = await this.run(['rev-parse', '-q', '--verify', `${rev}^{commit}`], {
      expectedExitCodes: [0, 1, 128],
    });
    return r.exitCode === 0 ? parseRevParse(r.stdout) : null;
  }

  // ---- search ----

  /**
   * Full-history search over all refs (buildRevSet), spec 12 §6.7 / §11. SHAs newest-first, capped by
   * `limit`. Terms are ANDed; what git cannot AND is post-filtered on the streamed output. With
   * `q.searchId` the search can be cancelled (`cancelSearch`) and polled (`searchProgress`).
   */
  async search(q: SearchQuery, signal?: AbortSignal): Promise<Sha[]> {
    const limit = Math.max(1, Math.floor(q.limit ?? DEFAULT_SEARCH_LIMIT));
    const handle = registerSearch(q.searchId, signal);
    let cancelled = false;
    try {
      const terms = searchTerms(q);
      if (!terms.length) return [];
      if (terms.length === 1 && terms[0]!.field === 'sha') {
        const shas = await this.searchSha(terms[0]!.text, limit, handle.signal);
        handle.progress.shas.push(...shas);
        handle.progress.total = shas.length;
        return shas;
      }
      return await this.searchLog(terms, q.caseSensitive ?? false, limit, handle);
    } catch (e) {
      cancelled = e instanceof GitError && e.code === 'Cancelled';
      if (e instanceof SearchQueryError) throw new GitError(makeError('Unknown', { argv: [] }, e.message));
      throw e;
    } finally {
      handle.finish(cancelled);
    }
  }

  private async searchLog(
    terms: SearchTerm[],
    caseSensitive: boolean,
    limit: number,
    handle: SearchHandle,
  ): Promise<Sha[]> {
    const plan = buildSearchPlan(terms, caseSensitive);
    const progress = handle.progress;
    // without a post-filter git prints only matches, so it can also stop at the limit
    const max = plan.post.length ? [] : [`--max-count=${limit}`];
    progress.scanned = plan.post.length ? 0 : null;
    const args = ['log', plan.format, '--date-order', ...max, ...plan.filter];
    args.push(...(await this.revSet('all')), '--', ...plan.paths);
    const env = { GIT_LITERAL_PATHSPECS: plan.literalPathspecs ? '1' : '0' };
    const s = this.streamRead(args, { env, signal: handle.signal, timeoutMs: SEARCH_TIMEOUT_MS });
    const parser = new SearchRecordParser();
    const decoder = new StringDecoder('utf8');
    let full = false;
    const take = (records: SearchRecord[]): void => {
      for (const r of records) {
        if (full) return;
        if (progress.scanned !== null) progress.scanned++;
        progress.reachedTime = r.time;
        if (plan.post.length && !recordMatches(r, plan.post, caseSensitive)) continue;
        progress.shas.push(r.sha);
        progress.total = progress.shas.length;
        full = progress.shas.length >= limit;
      }
    };
    try {
      for await (const chunk of s.stdout) {
        take(parser.push(decoder.write(chunk as Buffer)));
        if (full) break;
      }
      if (full) {
        s.cancel();
        await s.done.catch(() => undefined);
      } else {
        await s.done;
        take(parser.push(decoder.end()));
        take(parser.end());
      }
    } catch (e) {
      s.cancel();
      if (e instanceof GitError && this.info.head.sha === null && isUnbornError(e)) return [];
      throw e;
    }
    return progress.shas.slice(0, limit);
  }

  private async searchSha(text: string, limit: number, signal?: AbortSignal): Promise<Sha[]> {
    const prefix = text.trim().toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(prefix)) {
      // `#main`, `#v1.2`, `#HEAD~3`: a ref name or revision (spec 12 §11 "SHA prefix or ref name")
      if (/^[0-9a-f]{0,3}$/i.test(text.trim())) return [];
      if (signal?.aborted) throw new GitError(makeError('Cancelled', { argv: ['rev-parse'] }));
      const sha = await this.revParse(text.trim());
      return sha ? [sha] : [];
    }
    const r = await this.run(['rev-parse', `--disambiguate=${prefix}`], {
      expectedExitCodes: [0, 1, 128],
      signal,
    });
    const objects = r.exitCode === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
    const blobs = this.blobs();
    const commits: Sha[] = [];
    for (const sha of objects) {
      const st = await blobs.statObject(sha);
      if (st?.type === 'commit') commits.push(sha);
    }
    // keep only commits reachable from the graph's rev set (refs, HEAD, stash tips)
    const reachable: Sha[] = [];
    const stashTips = (await this.stashList().catch(() => [])).map((s) => s.sha);
    for (const sha of commits) {
      if (await this.isReachable(sha, stashTips, signal)) reachable.push(sha);
    }
    if (!reachable.length) return [];
    const sorted = await this.run(['log', '--no-walk', '--format=%H', ...reachable, '--'], { signal });
    return sorted.stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
  }

  private async isReachable(sha: Sha, stashTips: Sha[], signal?: AbortSignal): Promise<boolean> {
    const refs = await this.run(
      [
        'for-each-ref',
        '--count=1',
        `--contains=${sha}`,
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      { signal },
    );
    if (refs.stdout.trim()) return true;
    for (const tip of ['HEAD', ...stashTips]) {
      const r = await this.run(['merge-base', '--is-ancestor', sha, tip], {
        expectedExitCodes: [0, 1, 128],
        signal,
      });
      if (r.exitCode === 0) return true;
    }
    return false;
  }

  // ---- lifecycle ----

  /** Kill all log cursors and the blob reader. */
  dispose(): void {
    this.disposed = true;
    this.trackAbort?.abort();
    this.trackListeners.clear();
    for (const c of [...this.cursors.values()]) c.dispose();
    this.cursors.clear();
    this.blobReader?.dispose();
    this.blobReader = null;
  }
}
