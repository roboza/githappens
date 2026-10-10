import fs from 'node:fs';
import path from 'node:path';

import type {
  ConflictCode,
  ConflictFileInfo,
  ConflictStage,
  InProgressOp,
  RepoInfo,
  RepoOperationState,
  Sha,
} from '../../types';
import type { GitService } from '../git-service';
import { isBinary } from '../blob-reader';
import { exists, gitPaths, MAX_TEXT_BYTES, rawBlob, readText, refLabel, short, subjects } from './shared';

/** State files of in-progress operations (spec 08 §6.1), resolved with `--git-path`. */
export const OP_FILES = [
  'MERGE_HEAD',
  'MERGE_MSG',
  'SQUASH_MSG',
  'rebase-merge',
  'rebase-apply',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
] as const;
export type OpFile = (typeof OP_FILES)[number];
export type OpPaths = Record<OpFile, string>;

export const opPaths = (service: GitService): Promise<OpPaths> => gitPaths(service, OP_FILES);

const ZERO = /^0+$/;

/** Unmerged index entries from `git status --porcelain=v2 -z` `u` records (spec 08 §6.1). */
export async function readUnmerged(
  service: GitService,
): Promise<{ path: string; code: ConflictCode; stages: ConflictFileInfo['stages'] }[]> {
  if (service.repo.isBare) return [];
  const r = await service.runRead(['status', '--porcelain=v2', '-z', '--untracked-files=no']);
  const out: { path: string; code: ConflictCode; stages: ConflictFileInfo['stages'] }[] = [];
  const toks = r.stdout.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.startsWith('2 ')) {
      i++; // rename/copy record: next token is the original path
      continue;
    }
    if (!t.startsWith('u ')) continue;
    // u XY sub m1 m2 m3 mW h1 h2 h3 path
    const f: string[] = [];
    let rest = t;
    for (let k = 0; k < 10; k++) {
      const sp = rest.indexOf(' ');
      f.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }
    const stage = (mode: string, sha: string): ConflictStage | undefined =>
      sha && !ZERO.test(sha) && !ZERO.test(mode) ? { mode, sha } : undefined;
    const stages: ConflictFileInfo['stages'] = {};
    const base = stage(f[3]!, f[7]!);
    const ours = stage(f[4]!, f[8]!);
    const theirs = stage(f[5]!, f[9]!);
    if (base) stages.base = base;
    if (ours) stages.ours = ours;
    if (theirs) stages.theirs = theirs;
    out.push({ path: rest, code: f[1] as ConflictCode, stages });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface PathAttrs {
  /** `binary` set or `-merge`: never offer a text merge. */
  binary: boolean;
  /** A custom `merge=<driver>` (not text/binary). */
  driver?: string;
}

/** `merge` / `binary` attributes per path (spec 08 §6.4 "Respect custom merge drivers"). */
export async function mergeAttrs(service: GitService, paths: string[]): Promise<Map<string, PathAttrs>> {
  const out = new Map<string, PathAttrs>();
  for (const p of paths) out.set(p, { binary: false });
  if (!paths.length) return out;
  const r = await service.runRead(['check-attr', '-z', '--stdin', 'merge', 'binary'], {
    stdin: paths.join('\0') + '\0',
    expectedExitCodes: [0, 128],
  });
  if (r.exitCode !== 0) return out;
  const f = r.stdout.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) {
    const p = f[i]!;
    const attr = f[i + 1]!;
    const value = f[i + 2]!;
    const a = out.get(p) ?? { binary: false };
    if (attr === 'binary' && value === 'set') a.binary = true;
    if (attr === 'merge') {
      if (value === 'unset' || value === 'binary') a.binary = true;
      else if (value !== 'set' && value !== 'unspecified' && value !== 'text') a.driver = value;
    }
    out.set(p, a);
  }
  return out;
}

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

async function classify(
  service: GitService,
  e: { path: string; stages: ConflictFileInfo['stages'] },
  attrs: PathAttrs | undefined,
): Promise<ConflictFileInfo['kind']> {
  const modes = [e.stages.base, e.stages.ours, e.stages.theirs].filter(Boolean).map((s) => s!.mode);
  if (modes.includes('160000')) return 'submodule';
  if (modes.includes('120000')) return 'symlink';
  if (attrs?.binary) return 'binary';
  for (const side of ['ours', 'theirs', 'base'] as const) {
    const st = e.stages[side];
    if (!st) continue;
    // by object id: a long-lived `cat-file --batch` may hold a stale index, so never read `:N:path` there
    const buf = await rawBlob(service, st.sha, MAX_TEXT_BYTES).catch(() => null);
    if (!buf) return 'binary'; // unreadable or too large for a text merge
    if (isBinary(buf)) return 'binary';
    if (buf.subarray(0, LFS_POINTER.length).toString('latin1') === LFS_POINTER) return 'lfs';
    return 'text';
  }
  return 'text';
}

/** Conflicted files with code and kind (spec 08 §5 `ConflictFileInfo`). */
export async function readConflicts(service: GitService): Promise<ConflictFileInfo[]> {
  const entries = await readUnmerged(service);
  if (!entries.length) return [];
  const attrs = await mergeAttrs(
    service,
    entries.map((e) => e.path),
  );
  const out: ConflictFileInfo[] = [];
  for (const e of entries) {
    const a = attrs.get(e.path);
    const info: ConflictFileInfo = {
      path: e.path,
      stages: e.stages,
      code: e.code,
      kind: await classify(service, e, a),
    };
    if (a?.driver) info.mergeDriver = a.driver;
    if (info.kind === 'text' && (e.code === 'UU' || e.code === 'AA')) {
      const n = markerBlocks(service, e.path);
      if (n !== null) info.unresolvedChunks = n;
    }
    out.push(info);
  }
  return out;
}

const OPEN_MARKER = /^<{7,}(?: |$)/;

/** Conflict blocks (`<<<<<<<` lines) in a working file (spec 08 §4.2 per-file chunk counts). */
export function countMarkerBlocks(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (OPEN_MARKER.test(line.replace(/\r$/, ''))) n++;
  return n;
}

function markerBlocks(service: GitService, rel: string): number | null {
  const root = service.repo.worktreeRoot;
  if (!root) return null;
  try {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return null;
    return countMarkerBlocks(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Paths resolved during the operation (spec 08 §5 `resolvedPending`): index entries carrying resolve-undo
 * information (`ls-files --resolve-undo`) that are no longer unmerged.
 */
export async function resolvedPendingPaths(service: GitService, unmerged: string[]): Promise<string[]> {
  const r = await service.runRead(['ls-files', '--resolve-undo', '-z'], {
    expectedExitCodes: [0, 128, 129],
  });
  if (r.exitCode !== 0) return [];
  const skip = new Set(unmerged);
  const out = new Set<string>();
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const p = rec.slice(tab + 1);
    if (p && !skip.has(p)) out.add(p);
  }
  return [...out].sort();
}

/** The in-progress operation (spec 08 §5 comment: derived from RepoState + state files). */
export function detectOp(state: RepoInfo['state'], p: OpPaths, conflicted: boolean): InProgressOp | null {
  switch (state) {
    case 'merging':
      return 'merge';
    case 'rebasing':
    case 'rebasing-interactive':
      return 'rebase';
    case 'cherry-picking':
      return 'cherry-pick';
    case 'reverting':
      return 'revert';
    case 'applying-mailbox':
      return 'am';
    default:
      break;
  }
  const seq = sequencerTodo(p);
  if (seq.verb) return seq.verb;
  if (exists(p.SQUASH_MSG)) return 'merge'; // `merge --squash` (no MERGE_HEAD; continue = commit)
  return conflicted ? 'stash-apply' : null;
}

/** `sequencer/todo` of a multi-commit cherry-pick / revert: verb + abbreviated shas, current first. */
export function sequencerTodo(p: OpPaths): { verb: 'cherry-pick' | 'revert' | null; shas: string[] } {
  const text = readText(path.join(p.sequencer, 'todo'));
  if (!text) return { verb: null, shas: [] };
  let verb: 'cherry-pick' | 'revert' | null = null;
  const shas: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(pick|p|revert|r)\s+([0-9a-f]{4,})/.exec(line.trim());
    if (!m) continue;
    verb ??= m[1]!.startsWith('p') ? 'cherry-pick' : 'revert';
    shas.push(m[2]!);
  }
  return { verb, shas };
}

const firstLine = (s: string | null): string => (s ?? '').split(/\r?\n/)[0]?.trim() ?? '';

function mergeSourceFromMsg(msg: string | null): string | null {
  const m = /^Merge (?:remote-tracking )?(?:branch(?:es)?|tag|commit) '([^']+)'/.exec(firstLine(msg));
  return m ? m[1]! : null;
}

const readSha = (p: string): Sha | null => {
  const t = readText(p)?.trim();
  return t && /^[0-9a-f]{40,64}$/.test(t) ? t : null;
};

async function mergeBase(service: GitService, a: Sha, b: Sha): Promise<Sha | null> {
  const r = await service.runRead(['merge-base', a, b], { expectedExitCodes: [0, 1, 128] });
  return r.exitCode === 0 ? r.stdout.trim() || null : null;
}

async function resolveShort(service: GitService, abbrevs: string[]): Promise<Sha[]> {
  const out: Sha[] = [];
  for (const a of abbrevs) {
    const s = await service.revParse(a);
    if (s) out.push(s);
  }
  return out;
}

/**
 * `conflict:state` (spec 08 §5, §6.1, §6.2): which operation is in progress, the pane labels (with the
 * rebase ours/theirs swap), progress and the conflicted files.
 */
export async function conflictState(service: GitService): Promise<RepoOperationState> {
  const info = await service.refreshRepoInfo();
  if (info.isBare) {
    return { op: null, current: { label: '', sha: null }, incoming: { label: '', sha: null }, conflicts: [] };
  }
  const [p, conflicts] = await Promise.all([opPaths(service), readConflicts(service)]);
  const op = detectOp(info.state, p, conflicts.length > 0);
  const headSha = info.head.sha || null;
  const headLabel = info.head.kind === 'branch' ? info.head.name : short(headSha);
  const state: RepoOperationState = {
    op,
    current: { label: headLabel, sha: headSha },
    incoming: { label: '', sha: null },
    conflicts,
  };
  if (op) {
    const pending = await resolvedPendingPaths(
      service,
      conflicts.map((c) => c.path),
    );
    if (pending.length) state.resolvedPending = pending;
  }

  switch (op) {
    case 'merge': {
      const mergeHead = readSha(p.MERGE_HEAD);
      if (mergeHead) {
        const msg = readText(p.MERGE_MSG);
        state.incoming = {
          label: mergeSourceFromMsg(msg) ?? (await refLabel(service, mergeHead)),
          sha: mergeHead,
        };
        state.base = { sha: headSha ? await mergeBase(service, headSha, mergeHead) : null };
        if (msg !== null) state.message = msg;
      } else {
        const msg = readText(p.SQUASH_MSG);
        const m = /^commit ([0-9a-f]{40,64})$/m.exec(msg ?? '');
        state.incoming = { label: 'Squashed changes', sha: m ? m[1]! : null };
        if (msg !== null) state.message = msg;
      }
      break;
    }
    case 'rebase': {
      const merge = exists(p['rebase-merge']);
      const dir = merge ? p['rebase-merge'] : p['rebase-apply'];
      const rd = (f: string): string | null => readText(path.join(dir, f))?.trim() ?? null;
      const onto = rd('onto');
      const ontoLabel = onto ? await refLabel(service, onto) : '';
      const step = Number(rd(merge ? 'msgnum' : 'next')) || 0;
      const total = Number(rd(merge ? 'end' : 'last')) || 0;
      const replaying = readSha(p.REBASE_HEAD) ?? (merge ? readSha(path.join(dir, 'stopped-sha')) : null);
      const subj = replaying ? ((await subjects(service, [replaying])).get(replaying) ?? '') : '';
      const headName = (rd('head-name') ?? '').replace(/^refs\/heads\//, '');
      // pane A = the onto side (+ commits replayed so far) = HEAD; pane B = the commit being replayed
      state.current = { label: ontoLabel || short(headSha), sha: headSha };
      state.incoming = replaying
        ? { label: `${short(replaying)} ${subj}`.trim(), sha: replaying }
        : { label: headName && headName !== 'detached HEAD' ? headName : '', sha: null };
      if (replaying) {
        const parent = await service.revParse(`${replaying}^`);
        state.base = { sha: parent };
      }
      state.rebase = {
        step,
        total,
        ontoLabel,
        currentCommit: replaying ? { sha: replaying, subject: subj } : null,
      };
      const msg = merge ? readText(path.join(dir, 'message')) : null;
      if (msg !== null) state.message = msg;
      break;
    }
    case 'cherry-pick':
    case 'revert': {
      const head = readSha(op === 'cherry-pick' ? p.CHERRY_PICK_HEAD : p.REVERT_HEAD);
      const seq = sequencerTodo(p);
      const todo = await resolveShort(service, seq.shas);
      if (head) {
        const subj = (await subjects(service, [head])).get(head) ?? '';
        state.incoming = {
          label:
            op === 'cherry-pick'
              ? `${short(head)} ${subj}`.trim()
              : `Revert of ${short(head)} ${subj}`.trim(),
          sha: head,
        };
        state.base = { sha: op === 'cherry-pick' ? await service.revParse(`${head}^`) : head };
      }
      if (seq.verb) state.sequencer = { remaining: todo.filter((s) => s !== head) };
      const msg = readText(p.MERGE_MSG);
      if (msg !== null && head) state.message = msg;
      break;
    }
    case 'stash-apply':
      state.current = {
        label: headLabel ? `${headLabel} (Updated upstream)` : 'Updated upstream',
        sha: headSha,
      };
      state.incoming = { label: 'Stashed changes', sha: null };
      {
        // pop keeps the stash on conflict: offer to drop it once resolved (spec 08 §6.7)
        const top = (await service.stashList().catch(() => []))[0];
        if (top) {
          state.stash = { index: top.index, sha: top.sha, message: top.message };
          state.incoming = { label: `Stashed changes (stash@{${top.index}})`, sha: top.sha };
        }
      }
      break;
    case 'am':
      state.incoming = { label: 'Patch', sha: null };
      break;
    default:
      break;
  }
  return state;
}
