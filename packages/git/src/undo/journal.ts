import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { JournalHooks } from '../ops/queue';
import type { GitOperation, OpResult, UndoPeek } from '../ops/types';
import type { GitProcessRunner } from '../process/runner';
import type { GitService } from '../service/git-service';
import { gitflowPlan } from '../service/gitflow';
import type { SerializedGitError, Sha } from '../types';
import { PIN_NAMESPACE, UndoGit, undoError } from './git';
import { barrierFor, planFor } from './plan';
import type { JournalEntry, RefName, RepoSnapshot, SnapshotHead } from './types';

export interface UndoJournalOptions {
  service: GitService;
  /** Runner used for the journal's own git commands; defaults to the service's runner. */
  runner?: GitProcessRunner;
  /** JSON file the journal is persisted to (loaded on construct; corruption tolerated). */
  persistFile?: string;
  /** Max entries kept (oldest are dropped and their keep-alive refs deleted). Default 100. */
  maxEntries?: number;
  /** Entries older than this are dropped on load (spec 05 §6.11: 30 days). */
  maxAgeMs?: number;
  /** Called after every change of the undo/redo stacks (drives the `undo:changed` event). */
  onChange?: (peek: UndoPeek) => void;
}

interface PersistedJournal {
  version: 1;
  repoId: string;
  entries: JournalEntry[];
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATUSES = new Set<JournalEntry['status']>(['pending', 'done', 'undone', 'failed']);

const shortSha = (s: Sha | null | undefined): string => (s ? s.slice(0, 7) : 'nothing');

function describeHead(head: SnapshotHead): string {
  return head.kind === 'branch' ? head.name : `detached ${shortSha(head.sha)}`;
}

function describeRef(ref: RefName): string {
  if (ref === 'HEAD') return 'HEAD';
  if (ref.startsWith('refs/heads/')) return `branch ${ref.slice('refs/heads/'.length)}`;
  if (ref.startsWith('refs/tags/')) return `tag ${ref.slice('refs/tags/'.length)}`;
  return ref;
}

function sameHeadName(a: SnapshotHead, b: SnapshotHead): boolean {
  return a.kind === b.kind && (a.kind !== 'branch' || a.name === (b as { name: string }).name);
}

function isEntry(v: unknown): v is JournalEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<JournalEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.label === 'string' &&
    typeof e.ts === 'number' &&
    !!e.before &&
    typeof e.before === 'object' &&
    !!e.scope &&
    typeof e.scope === 'object' &&
    Array.isArray(e.pins) &&
    STATUSES.has(e.status as JournalEntry['status'])
  );
}

/**
 * Per-repo undo/redo journal (spec 05 §5 "Undo journal", §6.11). Implements the queue's JournalHooks:
 * `begin()` snapshots the state an op may change and pins every object the undo needs under
 * `refs/githappens/undo/<entryId>/<n>`; `commit()` records the after state; undo/redo restore one or the
 * other after verifying the repo is still in the expected state. Network ops are recorded as barriers.
 */
export class UndoJournal implements JournalHooks {
  private entries: JournalEntry[] = []; // oldest first
  private readonly git: UndoGit;
  private readonly idPrefix: string;
  private readonly maxEntries: number;
  private readyPromise: Promise<void> | null = null;
  /** Background pin deletions (barrier() is synchronous). */
  private chores: Promise<void> = Promise.resolve();

  constructor(private readonly o: UndoJournalOptions) {
    const runner = o.runner ?? (o.service['runner'] as GitProcessRunner);
    this.git = new UndoGit(o.service, runner);
    this.idPrefix = o.service.repo.id.slice(0, 8);
    this.maxEntries = Math.max(1, o.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.load();
  }

  /** Sweeps keep-alive refs of entries this journal no longer knows (crash, corruption, age). Idempotent. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      const live = new Set(
        this.entries.filter((e) => e.status === 'done' || e.status === 'undone').map((e) => e.id),
      );
      // for-each-ref patterns match whole path components, so filter on the id prefix here
      const refs = await this.git.listPins(PIN_NAMESPACE).catch(() => [] as string[]);
      const mine = refs.filter((r) => r.startsWith(`${PIN_NAMESPACE}${this.idPrefix}-`));
      const entryOf = (r: string): string => r.slice(PIN_NAMESPACE.length).split('/')[0]!;
      const stale = mine.filter((r) => !live.has(entryOf(r)));
      await this.git.deletePins(stale).catch(() => undefined);
      for (const e of this.entries) if (e.status === 'failed') e.pins = [];
    })();
    return this.readyPromise;
  }

  /** Wait for background pin cleanup (tests, shutdown). */
  async settle(): Promise<void> {
    await this.ready();
    await this.chores;
  }

  // ---- JournalHooks ----

  async begin(op: GitOperation, _opId: string): Promise<string | null> {
    await this.ready();
    const { head } = await this.git.head();
    // Git Flow plans depend on the repo's gitflow config / paused-finish state
    const plan = op.type.startsWith('gitflow.')
      ? await gitflowPlan(this.o.service, op, head)
      : planFor(op, head);
    if (!plan) return null;
    if (plan.scope.trees && this.git.bare) return null;
    const before = plan.before ?? (await this.git.snapshot(plan.scope));
    const entry: JournalEntry = {
      id: `${this.idPrefix}-${randomUUID()}`,
      repoId: this.o.service.repo.id,
      ts: Date.now(),
      kind: plan.kind,
      label: plan.label,
      op,
      scope: plan.scope,
      before,
      pins: [],
      undoable: true,
      status: 'pending',
    };
    await this.pinSnapshot(entry, before, []);
    this.entries.push(entry);
    this.persist();
    return entry.id;
  }

  async commit(entryId: string, _op: GitOperation, _result: Omit<OpResult, 'opId'>): Promise<void> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry || entry.status !== 'pending') return;
    try {
      const after = await this.git.snapshot(entry.scope);
      entry.after = after;
      const { before } = entry;
      if (
        entry.scope.trees &&
        before.indexTree &&
        after.indexTree &&
        before.worktreeTree &&
        after.worktreeTree
      ) {
        entry.extra = {
          indexPaths: await this.git.diffNames(before.indexTree, after.indexTree),
          worktreePaths: await this.git.diffNames(before.worktreeTree, after.worktreeTree),
        };
      }
      if (JSON.stringify(before) === JSON.stringify(after)) {
        // nothing changed (e.g. checkout of the current branch): not worth an undo step
        await this.drop([entry]);
        this.persist();
        return;
      }
      const beforeStash = new Set((before.stash ?? []).map((s) => s.sha));
      const afterStash = new Set((after.stash ?? []).map((s) => s.sha));
      const changedStash = [
        ...[...beforeStash].filter((s) => !afterStash.has(s)),
        ...[...afterStash].filter((s) => !beforeStash.has(s)),
      ];
      await this.pinSnapshot(entry, after, changedStash);
      entry.status = 'done';
      await this.clearRedo(entry);
      await this.trim();
    } catch {
      entry.status = 'failed';
      await this.git.deletePins(entry.pins).catch(() => undefined);
      entry.pins = [];
    }
    this.persist();
    this.emit();
  }

  async fail(entryId: string, _op: GitOperation, _error: SerializedGitError): Promise<void> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry || entry.status !== 'pending') return;
    entry.status = 'failed';
    const pins = entry.pins;
    entry.pins = [];
    await this.git.deletePins(pins).catch(() => undefined);
    this.persist();
  }

  // ---- barriers ----

  /**
   * Record a network op (fetch/pull/push…) as a non-undoable barrier: undo stops there ("Cannot undo past
   * Push"). Clears the redo stack. Consecutive barriers collapse into one, so auto-fetch can't flood the
   * journal.
   */
  barrier(op: GitOperation): void {
    const { kind, label } = barrierFor(op);
    const undone = this.entries.filter((e) => e.status === 'undone');
    this.entries = this.entries.filter((e) => e.status !== 'undone');
    this.background(undone.flatMap((e) => e.pins));
    const top = [...this.entries].reverse().find((e) => e.status === 'done');
    if (top && !top.undoable) {
      Object.assign(top, { kind, label, op, ts: Date.now() });
    } else {
      const head = this.o.service.repo.head;
      this.entries.push({
        id: `${this.idPrefix}-${randomUUID()}`,
        repoId: this.o.service.repo.id,
        ts: Date.now(),
        kind,
        label,
        op,
        scope: { head: 'none', refs: [], trees: false, stash: false, configBranches: [] },
        before: {
          head:
            head.kind === 'branch'
              ? { kind: 'branch', name: head.name }
              : { kind: 'detached', sha: head.sha },
          headSha: head.sha,
          touchedRefs: {},
        },
        pins: [],
        undoable: false,
        status: 'done',
      });
      this.background(this.trimSync());
    }
    this.persist();
    this.emit();
  }

  // ---- queries ----

  peek(): UndoPeek {
    const out: UndoPeek = {};
    const u = this.undoTarget();
    if (u?.undoable) out.undo = this.brief(u);
    else if (u) out.blockedBy = `Cannot undo past ${u.label}`;
    const r = this.redoTarget();
    if (r) out.redo = this.brief(r);
    return out;
  }

  /** Newest first. */
  list(limit = Infinity): JournalEntry[] {
    return this.entries
      .slice()
      .reverse()
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  // ---- undo / redo ----

  async undo(): Promise<JournalEntry> {
    await this.ready();
    const e = this.undoTarget();
    if (!e) throw undoError('Nothing to undo.');
    if (!e.undoable) throw undoError(`Cannot undo past ${e.label}.`);
    await this.apply(e, 'undo');
    e.status = 'undone';
    this.persist();
    this.emit();
    return structuredClone(e);
  }

  async redo(): Promise<JournalEntry> {
    await this.ready();
    const e = this.redoTarget();
    if (!e) throw undoError('Nothing to redo.');
    await this.apply(e, 'redo');
    e.status = 'done';
    this.persist();
    this.emit();
    return structuredClone(e);
  }

  private undoTarget(): JournalEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.status === 'done') return e;
    }
    return undefined;
  }

  /** The most recently undone entry: the lowest `undone` one above the newest `done` entry. */
  private redoTarget(): JournalEntry | undefined {
    let found: JournalEntry | undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.status === 'done') break;
      if (e.status === 'undone') found = e;
    }
    return found;
  }

  private async apply(e: JournalEntry, dir: 'undo' | 'redo'): Promise<void> {
    if (!e.after) throw undoError(`Cannot ${dir} ${e.label}: the journal entry is incomplete.`);
    const from = dir === 'undo' ? e.after : e.before;
    const to = dir === 'undo' ? e.before : e.after;
    const { scope } = e;
    const what = `Can't ${dir} ${e.label}`;
    const cur = await this.git.snapshot({ ...scope, configBranches: [] });

    // ---- drift checks (spec 05 §6.11): never force-apply ----
    if (scope.head !== 'none') {
      const shaMatters = scope.head !== 'check';
      if (!sameHeadName(cur.head, from.head) || (shaMatters && cur.headSha !== from.headSha)) {
        throw undoError(
          `${what}: HEAD is now ${describeHead(cur.head)} at ${shortSha(cur.headSha)}, ` +
            `expected ${describeHead(from.head)} at ${shortSha(from.headSha)}.`,
        );
      }
    }
    for (const ref of scope.refs) {
      const want = from.touchedRefs[ref] ?? null;
      const have = cur.touchedRefs[ref] ?? null;
      if (want === have) continue;
      const name = describeRef(ref);
      if (have === null) throw undoError(`${what}: ${name} was deleted since.`);
      if (want === null) throw undoError(`${what}: ${name} exists again (at ${shortSha(have)}).`);
      throw undoError(
        `${what}: ${name} has moved since (expected ${shortSha(want)}, now ${shortSha(have)}).`,
      );
    }
    if (scope.stash) {
      const a = (from.stash ?? []).map((s) => s.sha).join();
      const b = (cur.stash ?? []).map((s) => s.sha).join();
      if (a !== b) throw undoError(`${what}: the stash list has changed since.`);
    }
    if (scope.remotes?.length) {
      for (const n of scope.remotes) {
        const want = JSON.stringify(from.remotes?.[n]?.config ?? []);
        if (want !== JSON.stringify(cur.remotes?.[n]?.config ?? [])) {
          throw undoError(`${what}: remote ${n} has changed since.`);
        }
      }
    }
    if (scope.indexEntries?.length) {
      // mark-resolved is only reversible while the merge/rebase/cherry-pick/revert is still in progress
      const state = (await this.o.service.refreshRepoInfo()).state;
      if (state === 'clean' || state === 'bisecting') {
        throw undoError(`${what}: the operation it belonged to has finished.`);
      }
      if ((cur.indexEntries ?? '') !== (from.indexEntries ?? '')) {
        throw undoError(`${what}: the files were staged or changed since.`);
      }
    }
    const indexPaths = e.extra?.indexPaths ?? [];
    const worktreePaths = e.extra?.worktreePaths ?? [];
    if (scope.trees && from.indexTree && from.worktreeTree && cur.indexTree && cur.worktreeTree) {
      const idx = new Set(await this.git.diffNames(from.indexTree, cur.indexTree));
      const wt = new Set(await this.git.diffNames(from.worktreeTree, cur.worktreeTree));
      const changed = [
        ...new Set([...indexPaths.filter((p) => idx.has(p)), ...worktreePaths.filter((p) => wt.has(p))]),
      ];
      if (changed.length) {
        const list = changed.slice(0, 5).join(', ') + (changed.length > 5 ? ', …' : '');
        throw undoError(`${what}: ${changed.length} file(s) changed since: ${list}.`);
      }
    }

    // ---- apply ----
    const msg = `githappens: ${dir} ${e.label}`;
    const changes = scope.refs.map((ref) => ({
      ref,
      from: from.touchedRefs[ref] ?? null,
      to: to.touchedRefs[ref] ?? null,
    }));
    if (scope.rename) {
      const [a, b] =
        dir === 'undo' ? [scope.rename.to, scope.rename.from] : [scope.rename.from, scope.rename.to];
      await this.git.run(['branch', '-m', a, b]);
    } else if (scope.head === 'switch') {
      // create/move refs first so the switch target exists, delete after switching away
      await this.git.updateRefs(
        changes.filter((c) => c.to !== null),
        msg,
      );
      if (!sameHeadName(cur.head, to.head) || cur.headSha !== to.headSha) {
        if (to.head.kind === 'branch') await this.git.run(['switch', '--no-guess', to.head.name]);
        else await this.git.run(['switch', '--detach', to.head.sha]);
      }
      await this.git.updateRefs(
        changes.filter((c) => c.to === null),
        msg,
      );
    } else {
      await this.git.updateRefs(changes, msg);
    }
    if (scope.head === 'set' && (!sameHeadName(cur.head, to.head) || cur.headSha !== to.headSha)) {
      await this.git.setHead(to.head, msg);
    }
    if (scope.stash) await this.git.reconcileStash(cur.stash ?? [], to.stash ?? []);
    if (scope.trees && cur.worktreeTree && to.worktreeTree && to.indexTree) {
      await this.git.restoreWorktree(cur.worktreeTree, to.worktreeTree, worktreePaths);
      await this.git.restoreIndex(to.indexTree, indexPaths);
    }
    for (const b of scope.configBranches) {
      const cfg = to.branchConfig?.[b];
      if (cfg) await this.git.setBranchConfig(b, cfg);
    }
    if (scope.remotes?.length) {
      for (const n of scope.remotes) {
        const target = to.remotes?.[n] ?? { config: [], refs: {} };
        const now = cur.remotes?.[n]?.refs ?? {};
        await this.git.setRemoteConfig(n, target.config);
        const names = new Set([...Object.keys(now), ...Object.keys(target.refs)]);
        await this.git.updateRefs(
          [...names].map((ref) => ({ ref, from: now[ref] ?? null, to: target.refs[ref] ?? null })),
          msg,
        );
      }
      // removing a remote also drops the upstream config of branches tracking it
      const a = from.allBranchConfig ?? {};
      const b = to.allBranchConfig ?? {};
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[name] ?? []) !== JSON.stringify(b[name] ?? [])) {
          await this.git.setBranchConfig(name, b[name] ?? []);
        }
      }
    }
    if (scope.indexEntries?.length) await this.git.setIndexEntries(scope.indexEntries, to.indexEntries ?? '');
  }

  // ---- pins, trimming, persistence ----

  private async pinSnapshot(entry: JournalEntry, snap: RepoSnapshot, extra: Sha[]): Promise<void> {
    const shas: Sha[] = [];
    if (snap.headSha) shas.push(snap.headSha);
    for (const v of Object.values(snap.touchedRefs)) if (v) shas.push(v);
    for (const r of Object.values(snap.remotes ?? {})) shas.push(...Object.values(r.refs));
    if (snap.indexTree) shas.push(await this.git.wrapTree(snap.indexTree, 'index'));
    if (snap.worktreeTree) shas.push(await this.git.wrapTree(snap.worktreeTree, 'worktree'));
    shas.push(...extra);
    const pins: { ref: RefName; sha: Sha }[] = [];
    let n = entry.pins.length;
    for (const sha of new Set(shas)) pins.push({ ref: `${PIN_NAMESPACE}${entry.id}/${n++}`, sha });
    await this.git.createPins(pins);
    entry.pins.push(...pins.map((p) => p.ref));
  }

  /** A new successful undoable op clears the redo stack. */
  private async clearRedo(except: JournalEntry): Promise<void> {
    const undone = this.entries.filter((e) => e.status === 'undone' && e !== except);
    if (undone.length) await this.drop(undone);
  }

  private async trim(): Promise<void> {
    const pins = this.trimSync();
    await this.git.deletePins(pins).catch(() => undefined);
  }

  /** Drop the oldest entries beyond `maxEntries`; returns their pins (to delete). */
  private trimSync(): RefName[] {
    const pins: RefName[] = [];
    while (this.entries.length > this.maxEntries) {
      const idx = this.entries.findIndex((e) => e.status !== 'pending');
      if (idx < 0) break;
      const [e] = this.entries.splice(idx, 1);
      pins.push(...e!.pins);
    }
    return pins;
  }

  private async drop(list: JournalEntry[]): Promise<void> {
    const set = new Set(list);
    this.entries = this.entries.filter((e) => !set.has(e));
    await this.git.deletePins(list.flatMap((e) => e.pins)).catch(() => undefined);
  }

  private background(pins: RefName[]): void {
    if (!pins.length) return;
    this.chores = this.chores.then(() => this.git.deletePins(pins)).catch(() => undefined);
  }

  private brief(e: JournalEntry): NonNullable<UndoPeek['undo']> {
    return { id: e.id, label: e.label, kind: e.kind, ts: e.ts };
  }

  private emit(): void {
    try {
      this.o.onChange?.(this.peek());
    } catch {
      /* listener errors must not break ops */
    }
  }

  private load(): void {
    const file = this.o.persistFile;
    if (!file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // no journal yet
    }
    try {
      const data = JSON.parse(raw) as Partial<PersistedJournal>;
      const minTs = Date.now() - (this.o.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
      const entries = Array.isArray(data.entries) ? data.entries.filter(isEntry) : [];
      this.entries = entries
        .filter((e) => e.ts >= minTs)
        .map((e) => (e.status === 'pending' ? { ...e, status: 'failed' as const } : e));
      this.trimSync(); // pins of trimmed entries are swept by ready()
    } catch {
      // corrupt journal: start empty, keep the broken file for diagnosis
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {
        /* ignore */
      }
      this.entries = [];
    }
  }

  private persist(): void {
    const file = this.o.persistFile;
    if (!file) return;
    const data: PersistedJournal = { version: 1, repoId: this.o.service.repo.id, entries: this.entries };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch {
      /* persistence is best effort; the in-memory journal keeps working */
    }
  }
}
