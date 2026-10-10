import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GitError, makeError } from '../errors/classify';
import type { GitProcessRunner, GitRunResult } from '../process/runner';
import type { GitService } from '../service/git-service';
import type { Sha } from '../types';
import type { RefName, RepoSnapshot, SnapshotHead, SnapshotScope, StashListEntry } from './types';

/** Identity for the internal keep-alive commits (never shown; only wraps trees so refs point at commits). */
const PIN_IDENTITY = {
  GIT_AUTHOR_NAME: 'GitHappens',
  GIT_AUTHOR_EMAIL: 'undo@githappens.invalid',
  GIT_COMMITTER_NAME: 'GitHappens',
  GIT_COMMITTER_EMAIL: 'undo@githappens.invalid',
};

export const PIN_NAMESPACE = 'refs/githappens/undo/';

/** Empty tree object ids (SHA-1, SHA-256). */
const EMPTY_TREES = new Set([
  '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function undoError(message: string): GitError {
  return new GitError(makeError('Unknown', { argv: [] }, message));
}

interface RunOpts {
  env?: Record<string, string>;
  stdin?: string | Buffer;
  expected?: number[];
  readOnly?: boolean;
}

/**
 * Thin git helper for the journal: every command goes through the service's GitProcessRunner with the
 * service's cwd (spec 02 §5.4). Writes run with `readOnly: false`.
 */
export class UndoGit {
  readonly zeroOid: string;

  constructor(
    private readonly service: GitService,
    private readonly runner: GitProcessRunner,
  ) {
    this.zeroOid = '0'.repeat(service.repo.objectFormat === 'sha256' ? 64 : 40);
  }

  run(args: string[], o: RunOpts = {}): Promise<GitRunResult<string>> {
    return this.runner.run({
      cwd: this.service.cwd,
      args,
      readOnly: o.readOnly ?? false,
      env: o.env,
      stdin: o.stdin,
      expectedExitCodes: o.expected,
    });
  }

  async out(args: string[], o: RunOpts = {}): Promise<string> {
    return (await this.run(args, o)).stdout.trim();
  }

  get bare(): boolean {
    return this.service.repo.isBare;
  }

  // ---- HEAD & refs ----

  async head(): Promise<{ head: SnapshotHead; headSha: Sha | null }> {
    const [sym, verify] = await Promise.all([
      this.run(['symbolic-ref', '-q', 'HEAD'], { expected: [0, 1], readOnly: true }),
      this.run(['rev-parse', '-q', '--verify', 'HEAD'], { expected: [0, 1], readOnly: true }),
    ]);
    const headSha = verify.exitCode === 0 ? verify.stdout.trim() : null;
    if (sym.exitCode === 0) {
      return { head: { kind: 'branch', name: sym.stdout.trim().replace(/^refs\/heads\//, '') }, headSha };
    }
    return { head: { kind: 'detached', sha: headSha ?? '' }, headSha };
  }

  /** Current values of exactly these refs (`HEAD` is read without dereferencing a branch). */
  async readRefs(refs: RefName[]): Promise<Record<RefName, Sha | null>> {
    const out: Record<RefName, Sha | null> = {};
    for (const r of refs) out[r] = null;
    const named = refs.filter((r) => r !== 'HEAD');
    if (named.length) {
      const r = await this.run(['for-each-ref', '--format=%(refname)%00%(objectname)', ...named], {
        readOnly: true,
      });
      for (const line of r.stdout.split('\n')) {
        const [name, sha] = line.split('\0');
        if (name && sha && name in out) out[name] = sha.trim();
      }
    }
    if (refs.includes('HEAD')) {
      const r = await this.run(['rev-parse', '-q', '--verify', 'HEAD'], { expected: [0, 1], readOnly: true });
      out.HEAD = r.exitCode === 0 ? r.stdout.trim() : null;
    }
    return out;
  }

  /**
   * Apply ref changes atomically. Each change carries the expected old value, so a ref that moved
   * meanwhile makes the whole transaction fail.
   */
  async updateRefs(
    changes: { ref: RefName; from: Sha | null; to: Sha | null }[],
    message: string,
  ): Promise<void> {
    const lines: string[] = [];
    for (const c of changes) {
      if (c.from === c.to) continue;
      if (c.ref === 'HEAD') lines.push('option no-deref');
      if (c.to === null) lines.push(`delete ${c.ref} ${c.from}`);
      else lines.push(`update ${c.ref} ${c.to} ${c.from ?? this.zeroOid}`);
    }
    if (!lines.length) return;
    await this.run(['update-ref', '-m', message, '--stdin'], { stdin: lines.join('\n') + '\n' });
  }

  async setHead(head: SnapshotHead, message: string): Promise<void> {
    if (head.kind === 'branch')
      await this.run(['symbolic-ref', '-m', message, 'HEAD', `refs/heads/${head.name}`]);
    else await this.run(['update-ref', '--no-deref', '-m', message, 'HEAD', head.sha]);
  }

  // ---- branch config ----

  async branchConfig(name: string): Promise<[string, string][]> {
    const prefix = `branch.${name}.`;
    const re = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    const r = await this.run(['config', '--local', '-z', '--get-regexp', re], {
      expected: [0, 1],
      readOnly: true,
    });
    const out: [string, string][] = [];
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue;
      const nl = rec.indexOf('\n');
      const key = nl >= 0 ? rec.slice(0, nl) : rec;
      const value = nl >= 0 ? rec.slice(nl + 1) : '';
      if (!key.startsWith(prefix) || key.slice(prefix.length).includes('.')) continue;
      out.push([key, value]);
    }
    return out;
  }

  async setBranchConfig(name: string, entries: [string, string][]): Promise<void> {
    const current = await this.branchConfig(name);
    if (JSON.stringify(current) === JSON.stringify(entries)) return;
    if (current.length)
      await this.run(['config', '--local', '--remove-section', `branch.${name}`], { expected: [0, 128] });
    for (const [k, v] of entries) await this.run(['config', '--local', '--add', k, v]);
  }

  // ---- remotes & raw config (remote-remove) ----

  private async configRegexp(re: string): Promise<[string, string][]> {
    const r = await this.run(['config', '--local', '-z', '--get-regexp', re], {
      expected: [0, 1],
      readOnly: true,
    });
    const out: [string, string][] = [];
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue;
      const nl = rec.indexOf('\n');
      out.push(nl >= 0 ? [rec.slice(0, nl), rec.slice(nl + 1)] : [rec, '']);
    }
    return out;
  }

  async remoteSnapshot(name: string): Promise<{ config: [string, string][]; refs: Record<RefName, Sha> }> {
    const prefix = `remote.${name}.`;
    const config = (await this.configRegexp(`^${escapeRe(prefix)}`)).filter(
      ([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('.'),
    );
    const r = await this.run(
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', `refs/remotes/${name}/`],
      { readOnly: true },
    );
    const refs: Record<RefName, Sha> = {};
    for (const line of r.stdout.split('\n')) {
      const [ref, sha, symref] = line.split('\0');
      // symbolic refs (origin/HEAD) come back with `git remote set-head`; only real tips are restored
      if (ref && sha && !symref?.trim()) refs[ref] = sha.trim();
    }
    return { config, refs };
  }

  async setRemoteConfig(name: string, entries: [string, string][]): Promise<void> {
    const prefix = `remote.${name}.`;
    const current = (await this.configRegexp(`^${escapeRe(prefix)}`)).filter(([k]) => k.startsWith(prefix));
    if (JSON.stringify(current) === JSON.stringify(entries)) return;
    if (current.length)
      await this.run(['config', '--local', '--remove-section', `remote.${name}`], { expected: [0, 128] });
    for (const [k, v] of entries) await this.run(['config', '--local', '--add', k, v]);
  }

  /** Every `branch.<name>.<var>` entry, grouped by branch name (names may contain dots). */
  async allBranchConfig(): Promise<Record<string, [string, string][]>> {
    const out: Record<string, [string, string][]> = {};
    for (const [k, v] of await this.configRegexp('^branch\\.')) {
      const last = k.lastIndexOf('.');
      if (last <= 'branch.'.length) continue;
      const name = k.slice('branch.'.length, last);
      (out[name] ??= []).push([k, v]);
    }
    return out;
  }

  // ---- raw index entries (mark-resolved) ----

  /** `ls-files -s -z` records of `paths` (all stages), sorted. */
  async indexEntries(paths: string[]): Promise<string> {
    if (!paths.length) return '';
    const r = await this.run(['ls-files', '-s', '-z', '--', ...paths], {
      readOnly: true,
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    return r.stdout.split('\0').filter(Boolean).sort().join('\0');
  }

  /** Replace every index entry of `paths` with the `ls-files -s` records in `entries`. */
  async setIndexEntries(paths: string[], entries: string): Promise<void> {
    const lines = [...paths.map((p) => `0 ${this.zeroOid}\t${p}`), ...entries.split('\0').filter(Boolean)];
    await this.run(['update-index', '-z', '--index-info'], { stdin: lines.join('\0') + '\0' });
  }

  // ---- stash ----

  async stashList(): Promise<StashListEntry[]> {
    const r = await this.run(['stash', 'list', '--format=%H%x1f%gs'], { readOnly: true });
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('\x1f');
        return { sha: l.slice(0, i), message: l.slice(i + 1) };
      });
  }

  /** Turn the stash list `from` (must be current) into `to`, keeping their common (older) tail in place. */
  async reconcileStash(from: StashListEntry[], to: StashListEntry[]): Promise<void> {
    let k = 0;
    while (
      k < from.length &&
      k < to.length &&
      from[from.length - 1 - k]!.sha === to[to.length - 1 - k]!.sha &&
      // a renamed entry (stash-rename) keeps its sha but must be re-stored with the other message
      from[from.length - 1 - k]!.message === to[to.length - 1 - k]!.message
    ) {
      k++;
    }
    for (let i = 0; i < from.length - k; i++) await this.run(['stash', 'drop', '-q', 'stash@{0}']);
    for (let i = to.length - k - 1; i >= 0; i--) {
      const e = to[i]!;
      await this.run(['stash', 'store', '-q', '-m', e.message, e.sha]);
    }
  }

  // ---- index & worktree trees ----

  private tmpDir(): string {
    const dir = path.join(this.service.repo.gitDir, 'githappens');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async withTempIndex<T>(
    seed: 'copy' | 'empty',
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const file = path.join(this.tmpDir(), `index-${randomUUID()}`);
    if (seed === 'copy') {
      const real = path.join(this.service.repo.gitDir, 'index');
      if (fs.existsSync(real)) fs.copyFileSync(real, file);
    }
    try {
      return await fn({ GIT_INDEX_FILE: file });
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.lock`, { force: true });
    }
  }

  async indexTree(): Promise<Sha> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.run(['write-tree'], { expected: [0, 128] });
      if (r.exitCode !== 0) {
        throw undoError(
          'The index has unresolved conflicts; resolve them before this action can be journaled or undone.',
        );
      }
      const tree = r.stdout.trim();
      // Another git (e.g. `git status` in a terminal) replacing the index can make it briefly
      // unreadable on Windows, which git reads as an empty index. Journaling that would make undo
      // unstage everything, so re-read while HEAD has files.
      if (!EMPTY_TREES.has(tree) || attempt >= 3 || !(await this.headHasFiles())) return tree;
      await new Promise((res) => setTimeout(res, 40));
    }
  }

  private async headHasFiles(): Promise<boolean> {
    const r = await this.run(['rev-parse', '-q', '--verify', 'HEAD^{tree}'], {
      expected: [0, 1, 128],
      readOnly: true,
    });
    return r.exitCode === 0 && !EMPTY_TREES.has(r.stdout.trim());
  }

  /** Tree of the whole worktree (tracked + untracked, minus ignored). */
  worktreeTree(): Promise<Sha> {
    return this.withTempIndex('copy', async (env) => {
      await this.run(['add', '-A'], { env });
      return this.out(['write-tree'], { env });
    });
  }

  async diffNames(a: Sha, b: Sha): Promise<string[]> {
    if (a === b) return [];
    const r = await this.run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b], {
      readOnly: true,
    });
    return r.stdout.split('\0').filter(Boolean);
  }

  /** Make the given worktree paths match `target`: write files present there, delete those absent. */
  async restoreWorktree(current: Sha, target: Sha, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.withTempIndex('empty', async (env) => {
      await this.run(['read-tree', current], { env });
      await this.run(
        [
          'restore',
          `--source=${target}`,
          '--staged',
          '--worktree',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { env: { ...env, GIT_LITERAL_PATHSPECS: '1' }, stdin: paths.join('\0') },
      );
    });
  }

  /** Make the given index entries match `target` (worktree untouched). */
  async restoreIndex(target: Sha, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.run(
      ['restore', `--source=${target}`, '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'],
      {
        env: { GIT_LITERAL_PATHSPECS: '1' },
        stdin: paths.join('\0'),
      },
    );
    await this.run(['update-index', '-q', '--refresh'], { expected: [0, 1] });
  }

  // ---- keep-alive refs ----

  async wrapTree(tree: Sha, what: string): Promise<Sha> {
    return this.out(['commit-tree', tree, '-m', `githappens undo ${what}`], { env: PIN_IDENTITY });
  }

  async createPins(pins: { ref: RefName; sha: Sha }[]): Promise<void> {
    if (!pins.length) return;
    const lines = pins.map((p) => `update ${p.ref} ${p.sha}`);
    await this.run(['update-ref', '--stdin'], { stdin: lines.join('\n') + '\n' });
  }

  async deletePins(refs: RefName[]): Promise<void> {
    if (!refs.length) return;
    const lines = refs.map((r) => `delete ${r}`);
    await this.run(['update-ref', '--stdin'], { stdin: lines.join('\n') + '\n' });
  }

  async listPins(prefix = PIN_NAMESPACE): Promise<RefName[]> {
    const r = await this.run(['for-each-ref', '--format=%(refname)', prefix], { readOnly: true });
    return r.stdout.split('\n').filter(Boolean);
  }

  // ---- snapshot ----

  async snapshot(scope: SnapshotScope): Promise<RepoSnapshot> {
    const { head, headSha } = await this.head();
    const snap: RepoSnapshot = { head, headSha, touchedRefs: await this.readRefs(scope.refs) };
    if (scope.trees && !this.bare) {
      snap.indexTree = await this.indexTree();
      snap.worktreeTree = await this.worktreeTree();
    }
    if (scope.stash) snap.stash = await this.stashList();
    if (scope.remotes?.length) {
      snap.remotes = {};
      for (const n of scope.remotes) snap.remotes[n] = await this.remoteSnapshot(n);
      snap.allBranchConfig = await this.allBranchConfig();
    }
    if (scope.indexEntries?.length) snap.indexEntries = await this.indexEntries(scope.indexEntries);
    if (scope.configBranches.length) {
      snap.branchConfig = {};
      for (const b of scope.configBranches) snap.branchConfig[b] = await this.branchConfig(b);
    }
    return snap;
  }
}
