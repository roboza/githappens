import type { GitService, RefreshScope, RepoId } from '@githappens/git';

import type {
  ConflictHunk,
  ConflictIgnoreRule,
  ConflictIgnoreScope,
  ConflictReport,
  ConflictsEventContract,
  TeammateOverlap,
} from '../../shared/ipc/conflicts-contract';
import type { SettingKey, SettingValue } from '../../shared/settings/registry';
import { IgnoreStore } from './ignore-store';
import {
  CHECK_TIMEOUT_MS,
  hunksFromTree,
  mergeTreeCheck,
  wipSnapshot,
  type MergeCheckResult,
} from './merge-check';
import { resolveTarget, writeTargetConfig, type ResolvedTarget } from './target-resolver';

/** Background re-check after commits / checkouts (spec 14 §6.5); fetches that move the target run at once. */
export const CHECK_DEBOUNCE_MS = 30_000;
const TARGET_TTL_MS = 60_000;
const MERGE_CACHE_MAX = 200;

export interface SettingsLike {
  get<K extends SettingKey>(key: K): SettingValue<K>;
}

export interface RepoAccess {
  get(repoId: RepoId): GitService;
  list(): GitService[];
}

/** Teammate overlap source (TeamService); optional so the target check works without any cloud. */
export interface OverlapSource {
  isActive(): boolean;
  overlaps(
    repoId: RepoId,
    headSha: string,
    target: { ref: string; sha: string | null },
  ): Promise<TeammateOverlap[]>;
  ensurePolled(repoId: RepoId): void;
}

export interface ConflictServiceDeps {
  repos: RepoAccess;
  settings: SettingsLike;
  emit<E extends keyof ConflictsEventContract>(event: E, payload: ConflictsEventContract[E]): void;
  prBase?: (repoId: RepoId, branch: string) => Promise<{ remote: string; branch: string } | null>;
  team?: OverlapSource;
  ignores?: IgnoreStore;
  debounceMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

interface RepoEntry {
  timer?: ReturnType<typeof setTimeout>;
  inflight?: Promise<ConflictReport>;
  /** Re-run requested while a check was in flight. */
  again?: boolean;
  report?: ConflictReport;
  /** Overlaps hidden by ignore rules in `report` (part of its ignoredCount). */
  ignoredOverlaps?: number;
  /** merge-tree result tree of the last check, for on-demand hunks. */
  tree?: string | null;
  target?: { branch: string; at: number; value: ResolvedTarget | null };
}

const RELEVANT: ReadonlySet<RefreshScope> = new Set(['refs', 'repoState', 'config', 'remotes']);

/**
 * Target-branch conflict check (spec 14 §6.5): resolves the current branch's target, runs
 * `git merge-tree` (optionally on a WIP snapshot) in the background, caches by (headSha, targetSha,
 * wipTree) and emits `conflicts:updated` with teammate overlaps merged in.
 */
export class ConflictService {
  private readonly entries = new Map<RepoId, RepoEntry>();
  private readonly mergeCache = new Map<string, MergeCheckResult>();
  private readonly hunkCache = new Map<string, ConflictHunk[]>();
  readonly ignores: IgnoreStore;
  private disposed = false;

  constructor(private readonly d: ConflictServiceDeps) {
    this.ignores = d.ignores ?? new IgnoreStore(d.now);
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private entry(repoId: RepoId): RepoEntry {
    let e = this.entries.get(repoId);
    if (!e) {
      e = {};
      this.entries.set(repoId, e);
    }
    return e;
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }

  forget(repoId: RepoId): void {
    const e = this.entries.get(repoId);
    if (e?.timer) clearTimeout(e.timer);
    this.entries.delete(repoId);
  }

  lastReport(repoId: RepoId): ConflictReport | undefined {
    return this.entries.get(repoId)?.report;
  }

  // ---- target ----

  /** Target of `branch` (cached a minute; config / remotes changes and setTarget invalidate it). */
  async targetFor(repoId: RepoId, branch: string, fresh = false): Promise<ResolvedTarget | null> {
    const e = this.entry(repoId);
    const svc = this.d.repos.get(repoId);
    if (!fresh && e.target && e.target.branch === branch && this.now() - e.target.at < TARGET_TTL_MS) {
      const t = e.target.value;
      // The ref name is cached; its sha is always re-read (a fetch moves it).
      if (!t) return null;
      const sha = t.ref.includes('/')
        ? ((await svc.revParse(`refs/remotes/${t.ref}`)) ?? (await svc.revParse(`refs/heads/${t.ref}`)))
        : await svc.revParse(`refs/heads/${t.ref}`);
      return { ...t, sha };
    }
    const prBase = this.d.prBase;
    const value = await resolveTarget(svc, branch, prBase ? (b) => prBase(repoId, b) : undefined);
    e.target = { branch, at: this.now(), value };
    return value;
  }

  /** Branch target for footprints (any local branch, not just the current one). */
  async branchTarget(repoId: RepoId, branch: string): Promise<ResolvedTarget | null> {
    const svc = this.d.repos.get(repoId);
    const prBase = this.d.prBase;
    return resolveTarget(svc, branch, prBase ? (b) => prBase(repoId, b) : undefined);
  }

  async setTarget(
    repoId: RepoId,
    branch: string | undefined,
    target: string | null,
  ): Promise<ConflictReport> {
    const svc = this.d.repos.get(repoId);
    const info = await svc.refreshRepoInfo();
    const name = branch || (info.head.kind === 'branch' ? info.head.name : '');
    if (!name) throw new Error('No branch is checked out');
    await writeTargetConfig(svc, name, target);
    this.entry(repoId).target = undefined;
    return this.check(repoId, { force: true });
  }

  // ---- ignores ----

  private commonDir(repoId: RepoId): string {
    return this.d.repos.get(repoId).repo.commonDir;
  }

  listIgnores(repoId: RepoId): ConflictIgnoreRule[] {
    return this.ignores.list(this.commonDir(repoId));
  }

  async ignore(
    repoId: RepoId,
    rule: { scope: ConflictIgnoreScope; value: string; until?: string },
    remove = false,
  ): Promise<ConflictIgnoreRule[]> {
    const rules = this.ignores.set(this.commonDir(repoId), rule, remove);
    void this.check(repoId).catch(() => undefined);
    return rules;
  }

  // ---- scheduling ----

  /**
   * Forwarded `RepoManager.onChanged`. Branch switches and target moves (fetch / pull) re-check at once;
   * other ref / worktree changes are debounced 30 s.
   */
  onRepoChanged(repoId: RepoId, scopes: RefreshScope[], _reason?: string): void {
    if (this.disposed) return;
    const wip = this.d.settings.get('conflicts.includeWip');
    const teamActive = !!this.d.team?.isActive();
    const detect = this.d.settings.get('conflicts.detectTarget');
    if (!detect && !teamActive) return;
    const relevant = scopes.some((s) => RELEVANT.has(s) || (s === 'status' && (wip || teamActive)));
    if (!relevant) return;
    const e = this.entry(repoId);
    if (scopes.includes('config') || scopes.includes('remotes')) e.target = undefined;
    void this.probe(repoId)
      .then((now) =>
        now ? this.runSoon(repoId, 0) : this.runSoon(repoId, this.d.debounceMs ?? CHECK_DEBOUNCE_MS),
      )
      .catch(() => undefined);
  }

  /** True when the branch or the target commit changed since the last report. */
  private async probe(repoId: RepoId): Promise<boolean> {
    const last = this.entries.get(repoId)?.report;
    if (!last) return true;
    const svc = this.d.repos.get(repoId);
    const info = await svc.refreshRepoInfo();
    const branch = info.head.kind === 'branch' && info.head.sha ? info.head.name : '';
    if (branch !== last.branch) return true;
    if (!branch) return false;
    const t = await this.targetFor(repoId, branch);
    return (t?.ref ?? '') !== last.target || (t?.sha ?? undefined) !== last.targetSha;
  }

  private runSoon(repoId: RepoId, delay: number): void {
    const e = this.entry(repoId);
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (this.disposed) return;
      void this.check(repoId).catch((err) => this.d.log?.('[conflicts] background check failed', err));
    }, delay);
    e.timer.unref?.();
  }

  /** Re-emit the last report with fresh teammate overlaps (after a footprint poll). */
  async refreshOverlaps(repoId: RepoId): Promise<void> {
    const e = this.entries.get(repoId);
    if (!e?.report) return;
    if (e.inflight) {
      e.again = true;
      return;
    }
    const r = e.report;
    const target = r.target ? { ref: r.target, sha: r.targetSha ?? null } : null;
    const overlaps = target && r.headSha ? await this.overlapsFor(repoId, r.headSha, target) : null;
    const report: ConflictReport = {
      ...r,
      teammateOverlaps: overlaps?.list ?? [],
      ignoredCount: r.ignoredCount - (e.ignoredOverlaps ?? 0) + (overlaps?.ignored ?? 0),
    };
    e.report = report;
    e.ignoredOverlaps = overlaps?.ignored ?? 0;
    this.d.emit('conflicts:updated', { repoId, report });
  }

  // ---- check ----

  /** Build (or reuse) the report; concurrent calls share one run. */
  check(repoId: RepoId, opts: { force?: boolean } = {}): Promise<ConflictReport> {
    const e = this.entry(repoId);
    if (e.inflight) {
      if (opts.force) e.again = true;
      return e.inflight;
    }
    const run = (async (): Promise<ConflictReport> => {
      let report = await this.build(repoId, !!opts.force);
      while (e.again) {
        e.again = false;
        report = await this.build(repoId, false);
      }
      return report;
    })();
    e.inflight = run;
    return run.finally(() => {
      e.inflight = undefined;
    });
  }

  private async overlapsFor(
    repoId: RepoId,
    headSha: string,
    target: { ref: string; sha: string | null },
  ): Promise<{ list: TeammateOverlap[]; ignored: number } | null> {
    const team = this.d.team;
    if (!team?.isActive()) return null;
    team.ensurePolled(repoId);
    const all = await team.overlaps(repoId, headSha, target).catch((err) => {
      this.d.log?.('[conflicts] overlaps failed', err);
      return [] as TeammateOverlap[];
    });
    const cd = this.commonDir(repoId);
    const list = all.filter(
      (o) => !this.ignores.matches(cd, 'file', o.path) && !this.ignores.matches(cd, 'branch', o.branchHash),
    );
    return { list, ignored: all.length - list.length };
  }

  private async build(repoId: RepoId, force: boolean): Promise<ConflictReport> {
    const e = this.entry(repoId);
    const svc = this.d.repos.get(repoId);
    const info = await svc.refreshRepoInfo();
    const wipSetting = this.d.settings.get('conflicts.includeWip');
    const base = {
      repoId,
      checkedAt: new Date(this.now()).toISOString(),
      targetConflicts: [],
      teammateOverlaps: [],
      wip: false,
      ignoredCount: 0,
    };
    let ignoredOverlaps = 0;
    const finish = (r: ConflictReport): ConflictReport => {
      e.report = r;
      e.ignoredOverlaps = ignoredOverlaps;
      this.d.emit('conflicts:updated', { repoId, report: r });
      return r;
    };
    if (info.isBare || info.head.kind !== 'branch' || !info.head.sha) {
      e.tree = null;
      return finish({ ...base, branch: '', target: '', state: 'hidden' });
    }
    const branch = info.head.name;
    const headSha = info.head.sha;
    const target = await this.targetFor(repoId, branch, force);
    if (!target) {
      e.tree = null;
      return finish({ ...base, branch, target: '', headSha, state: 'no-target' });
    }
    const withTarget = {
      ...base,
      branch,
      target: target.ref,
      targetSource: target.source,
      headSha,
      ...(target.sha ? { targetSha: target.sha } : {}),
    };
    const overlaps = target.sha ? await this.overlapsFor(repoId, headSha, target) : null;
    ignoredOverlaps = overlaps?.ignored ?? 0;
    const withOverlaps = {
      ...withTarget,
      teammateOverlaps: overlaps?.list ?? [],
      ignoredCount: ignoredOverlaps,
    };
    const cd = this.commonDir(repoId);
    if (!this.d.settings.get('conflicts.detectTarget')) {
      e.tree = null;
      return finish({ ...withOverlaps, state: 'disabled' });
    }
    if (this.ignores.matches(cd, 'target', target.ref)) {
      e.tree = null;
      return finish({ ...withOverlaps, state: 'ignored' });
    }
    if (!target.sha) {
      e.tree = null;
      return finish({ ...withOverlaps, state: 'target-missing' });
    }

    let ours = headSha;
    let wipTree = '';
    let wip = false;
    try {
      if (wipSetting && info.worktreeRoot) {
        const snap = await wipSnapshot(svc, headSha, this.d.timeoutMs ?? CHECK_TIMEOUT_MS);
        const headTree = await svc.runRead(['rev-parse', `${headSha}^{tree}`]);
        if (snap.tree !== String(headTree.stdout).trim()) {
          ours = snap.commit;
          wipTree = snap.tree;
          wip = true;
        }
      }
      const key = `${repoId}:${headSha}:${target.sha}:${wipTree}`;
      let result = force ? undefined : this.mergeCache.get(key);
      if (!result) {
        result = await mergeTreeCheck(svc, ours, target.sha, this.d.timeoutMs ?? CHECK_TIMEOUT_MS);
        this.mergeCache.set(key, result);
        while (this.mergeCache.size > MERGE_CACHE_MAX)
          this.mergeCache.delete(this.mergeCache.keys().next().value!);
      }
      e.tree = result.tree;
      if (!result.supported) return finish({ ...withOverlaps, wip, state: 'unsupported' });
      const files = result.conflicts.filter((p) => !this.ignores.matches(cd, 'file', p));
      return finish({
        ...withOverlaps,
        wip,
        targetConflicts: files.map((path) => ({ path })),
        ignoredCount: withOverlaps.ignoredCount + (result.conflicts.length - files.length),
        state: files.length ? 'conflicts' : 'ok',
      });
    } catch (err) {
      e.tree = null;
      const msg = err instanceof Error ? err.message : String(err);
      return finish({ ...withOverlaps, wip, state: 'error', error: msg.split('\n')[0] });
    }
  }

  /** Hunk ranges of one conflicted file of the last check (conflict markers in the merge-tree result). */
  async hunks(repoId: RepoId, filePath: string): Promise<ConflictHunk[]> {
    let e = this.entries.get(repoId);
    if (!e?.report) {
      await this.check(repoId);
      e = this.entries.get(repoId);
    }
    const tree = e?.tree;
    if (!tree || !e?.report?.targetConflicts.some((c) => c.path === filePath)) return [];
    const key = `${tree}:${filePath}`;
    const hit = this.hunkCache.get(key);
    if (hit) return hit;
    const hunks = await hunksFromTree(this.d.repos.get(repoId), tree, filePath);
    this.hunkCache.set(key, hunks);
    while (this.hunkCache.size > MERGE_CACHE_MAX) this.hunkCache.delete(this.hunkCache.keys().next().value!);
    return hunks;
  }
}
