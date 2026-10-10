import type { GitService } from '../../service/git-service';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { ComposeSource, OpOf, OpResult } from '../types';
import { requireIdle } from './history-util';
import { assertSafeName, define, fail, git, plural, read } from './util';

/**
 * AI Commit Composer apply (spec 12 §6.6): split one diff (the staged changes, or the combined diff of a
 * contiguous range ending at HEAD) into N commits by hunk. The proposal identifies hunks by the ids
 * `composeUnits()` assigns, and both the AI context builder (main) and this executor compute them from the
 * same `readComposeDiff()` output, guarded by `diffHash`.
 */

/** One assignable piece of the compose diff: a single hunk, or a whole file (new/deleted/binary/mode). */
export interface ComposeUnit {
  /** `<path>#<n>`: n is the hunk index within the file (0 for whole-file units). */
  hunkId: string;
  path: string;
  kind: 'hunk' | 'file';
  status: 'A' | 'D' | 'M';
  binary: boolean;
  /** The `@@ … @@` line (hunk units) or a short description (file units). */
  header: string;
  additions: number;
  deletions: number;
  /** File header lines (diff --git, mode, ---/+++), without the `index` line for hunk units. */
  fileHeader: string;
  /** Hunk body including its `@@` line, or the whole file patch body for file units. */
  body: string;
}

export interface ComposeDiff {
  /** Revision the diff is taken against (HEAD for staged, `<from>^` for a range). */
  base: Sha;
  text: string;
  hash: string;
  units: ComposeUnit[];
}

const DIFF_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-relative',
  '--binary',
  '--full-index',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-U3',
];
const MAX_DIFF_BYTES = 256 * 1024 * 1024;

/** FNV-1a 32-bit (twice, different seeds) over the diff text; stable across processes. */
export function composeHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Unquote a C-style quoted git path (`"a/caf\303\251"`). */
function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path of a `diff --git a/P b/P` line (renames are disabled, so both sides are equal). */
function pathOf(line: string): string {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length && !(rest[i] === '"' && rest[i - 1] !== '\\')) i++;
    return unquote(rest.slice(0, i + 1)).slice(2);
  }
  return rest.slice(2, (rest.length - 1) / 2);
}

/** Split a compose diff into units (pure; exported for tests and the AI context builder). */
export function composeUnits(text: string): ComposeUnit[] {
  const units: ComposeUnit[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ')) {
      i++;
      continue;
    }
    const start = i++;
    while (i < lines.length && !lines[i]!.startsWith('diff --git ')) i++;
    const chunk = lines.slice(start, i);
    const p = pathOf(chunk[0]!);
    const firstHunk = chunk.findIndex((l) => l.startsWith('@@ '));
    const headerEnd = firstHunk < 0 ? chunk.length : firstHunk;
    const header = chunk.slice(0, headerEnd);
    const isNew = header.some((l) => l.startsWith('new file mode'));
    const isDel = header.some((l) => l.startsWith('deleted file mode'));
    const modeChange = header.some((l) => l.startsWith('old mode'));
    const binary = chunk.some((l) => l === 'GIT binary patch' || l.startsWith('Binary files '));
    const status: ComposeUnit['status'] = isNew ? 'A' : isDel ? 'D' : 'M';
    const count = (ls: string[], c: string): number => ls.filter((l) => l.startsWith(c)).length;
    if (isNew || isDel || modeChange || binary || firstHunk < 0) {
      const body = chunk.slice(headerEnd);
      units.push({
        hunkId: `${p}#0`,
        path: p,
        kind: 'file',
        status,
        binary,
        header: binary
          ? 'Binary file'
          : isNew
            ? 'New file'
            : isDel
              ? 'Deleted file'
              : modeChange
                ? 'Mode change'
                : 'File change',
        additions: count(body, '+'),
        deletions: count(body, '-'),
        fileHeader: header.join('\n') + '\n',
        body: body.length ? body.join('\n') + '\n' : '',
      });
      continue;
    }
    const fileHeader = header.filter((l) => !l.startsWith('index ')).join('\n') + '\n';
    let n = 0;
    let j = headerEnd;
    while (j < chunk.length) {
      const hs = j++;
      while (j < chunk.length && !chunk[j]!.startsWith('@@ ')) j++;
      const hunk = chunk.slice(hs, j);
      units.push({
        hunkId: `${p}#${n++}`,
        path: p,
        kind: 'hunk',
        status,
        binary: false,
        header: hunk[0]!,
        additions: count(hunk.slice(1), '+'),
        deletions: count(hunk.slice(1), '-'),
        fileHeader,
        body: hunk.join('\n') + '\n',
      });
    }
  }
  return units;
}

/** The diff a compose proposal is made from and applied to (read-only). */
export async function readComposeDiff(service: GitService, source: ComposeSource): Promise<ComposeDiff> {
  let base: Sha | null;
  let args: string[];
  if (source.kind === 'staged') {
    base = await service.revParse('HEAD');
    if (!base) throw fail('UnbornBranch', 'Make a first commit before composing commits.');
    args = [...DIFF_ARGS, '--cached', base, '--'];
  } else {
    assertSafeName(source.from, 'range start');
    assertSafeName(source.to, 'range end');
    base = await service.revParse(`${source.from}^`);
    const to = await service.revParse(source.to);
    if (!base || !to) throw fail('Unknown', 'The first commit of the range has no parent.');
    args = [...DIFF_ARGS, base, to, '--'];
  }
  const r = await read(service, args, { maxBuffer: MAX_DIFF_BYTES });
  return { base, text: r.stdout, hash: composeHash(r.stdout), units: composeUnits(r.stdout) };
}

/** Patch for a set of units: one file section per path (original order), hunks in original order. */
export function composePatch(units: ComposeUnit[]): string {
  const byPath = new Map<string, ComposeUnit[]>();
  for (const u of units) {
    const list = byPath.get(u.path) ?? [];
    list.push(u);
    byPath.set(u.path, list);
  }
  let out = '';
  for (const list of byPath.values()) {
    out += list[0]!.fileHeader;
    for (const u of list) out += u.body;
  }
  return out;
}

export interface ComposeOutcome {
  head: Sha;
  /** New commits, oldest first. */
  commits: Sha[];
  /** Hunks that were not assigned and stay staged. */
  unassigned: number;
}

async function writeTree(ctx: OpContext): Promise<Sha> {
  return (await git(ctx, ['write-tree'])).stdout.trim();
}

async function applyCached(ctx: OpContext, units: ComposeUnit[]): Promise<void> {
  if (!units.length) return;
  await git(ctx, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], {
    stdin: composePatch(units),
  });
}

async function compose(
  ctx: OpContext,
  op: OpOf<'ai.compose'>,
): Promise<Omit<OpResult<ComposeOutcome>, 'opId'>> {
  const svc = ctx.service;
  const info = await requireIdle(ctx, 'compose commits');
  if (!info.head.sha) throw fail('UnbornBranch', 'Make a first commit before composing commits.');
  if (!op.commits.length) throw fail('Unknown', 'The proposal has no commits.');
  const origHead = info.head.sha;

  // ---- validate against the current repository state ----
  if (op.source.kind === 'range') {
    const src = op.source;
    const to = await svc.revParse(src.to);
    if (to !== origHead) throw fail('Unknown', 'Recomposing needs a range that ends at HEAD.');
    const anc = await read(svc, ['merge-base', '--is-ancestor', src.from, origHead], {
      expectedExitCodes: [0, 1, 128],
    });
    if (anc.exitCode !== 0) throw fail('Unknown', 'The range start is not an ancestor of HEAD.');
    const merges = await read(svc, ['rev-list', '--merges', `${src.from}^..${origHead}`, '--']);
    if (merges.stdout.trim()) throw fail('Unknown', 'Ranges with merge commits cannot be recomposed.');
    const dirty = await read(svc, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.stdout.trim())
      throw fail('Unknown', 'Commit or stash your changes before recomposing commits.');
  }
  const diff = await readComposeDiff(svc, op.source);
  if (diff.hash !== op.diffHash)
    throw fail(
      'Unknown',
      'The changes have changed since the proposal was made. Regenerate it and try again.',
    );
  if (!diff.units.length) throw fail('NothingToCommit', 'There are no changes to compose.');
  const byId = new Map(diff.units.map((u) => [u.hunkId, u]));
  const seen = new Set<string>();
  const plan = op.commits.map((c, i) => {
    if (!c.message.trim()) throw fail('EmptyCommitMessage', `Commit ${i + 1} has no message.`);
    if (!c.hunks.length) throw fail('Unknown', `Commit ${i + 1} has no changes.`);
    const units = c.hunks.map((h) => {
      const u = byId.get(h.hunkId);
      if (!u) throw fail('Unknown', `Unknown change "${h.hunkId}". Regenerate the proposal.`);
      if (seen.has(h.hunkId)) throw fail('Unknown', `"${h.hunkId}" is assigned to more than one commit.`);
      seen.add(h.hunkId);
      return u;
    });
    // apply in diff order, whatever order the user dragged chips in
    units.sort((a, b) => diff.units.indexOf(a) - diff.units.indexOf(b));
    return { message: c.message, units };
  });
  const unassigned = diff.units.filter((u) => !seen.has(u.hunkId));

  // ---- run ----
  const origIndex = await writeTree(ctx);
  const created: Sha[] = [];
  try {
    if (op.source.kind === 'range') await git(ctx, ['reset', '--soft', '-q', diff.base]);
    const target = await writeTree(ctx); // T0: the full result tree
    for (const step of plan) {
      ctx.signal.throwIfAborted();
      await git(ctx, ['read-tree', 'HEAD']);
      await applyCached(ctx, step.units);
      const args = ['commit', '-q', '-F', '-', '--cleanup=strip'];
      if (op.skipHooks !== false) args.push('--no-verify');
      await git(ctx, args, { stdin: step.message.endsWith('\n') ? step.message : `${step.message}\n` });
      created.push((await svc.revParse('HEAD'))!);
    }
    await git(ctx, ['read-tree', 'HEAD']);
    await applyCached(ctx, unassigned);
    if ((await writeTree(ctx)) !== target)
      throw fail('Unknown', 'The composed commits do not reproduce the original changes.');
  } catch (e) {
    // full rollback: branch back to the original commit, index back to the original tree
    await git(ctx, ['reset', '--soft', '-q', origHead]).catch(() => undefined);
    await git(ctx, ['read-tree', origIndex]).catch(() => undefined);
    await svc.refreshRepoInfo().catch(() => undefined);
    throw e;
  }
  await svc.refreshRepoInfo();
  const head = created.at(-1)!;
  const rest = unassigned.length ? `; ${plural(unassigned.length, 'change')} left staged` : '';
  return {
    summary: `Created ${plural(created.length, 'commit')}${rest}`,
    data: { head, commits: created, unassigned: unassigned.length },
    ...(unassigned.length ? { warnings: [`${plural(unassigned.length, 'change')} left staged`] } : {}),
  };
}

export const composeOps = {
  'ai.compose': define(
    'ai.compose',
    {
      label: (op) =>
        op.source.kind === 'range'
          ? 'Recompose commits with AI'
          : `Compose ${plural(op.commits.length, 'commit')}`,
      touches: ['status', 'refs', 'graph'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => compose(ctx, op),
  ),
};
