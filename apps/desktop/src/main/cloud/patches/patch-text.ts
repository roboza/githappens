import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GitError, makeError, withPathspec, type GitService, type Sha } from '@githappens/git';
import type { PatchFile, PatchKind } from '@githappens/cloud-api';

import type { PatchSource } from '../../../shared/ipc/patches-contract';

/**
 * Patch text for Cloud Patches (spec 14 §6.3 "Create" step 1). Every command is a read: the WIP "all
 * changes" variant goes through a temporary index file (`GIT_INDEX_FILE`), so the user's index is never
 * touched.
 */

export interface BuiltPatch {
  kind: PatchKind;
  text: string;
  baseSha: Sha;
  baseBranch?: string;
  files: PatchFile[];
  warnings: string[];
  /** Suggested title (branch + first file, commit subject, stash message). */
  title: string;
  /** Bytes of the raw patch text. */
  size: number;
}

/** Spec 14 §6.3: warn on binaries > 1 MB. */
export const BINARY_WARN_BYTES = 1024 * 1024;
const MAX_PATCH_TEXT = 512 * 1024 * 1024;
const TIMEOUT = 5 * 60_000;

/** Diff flags that make the output independent of user config (prefixes, colors, external diff tools). */
const DIFF_FLAGS = [
  '--binary',
  '--full-index',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

const err = (message: string): GitError => new GitError(makeError('Unknown', { argv: [] }, message));

async function readText(
  svc: GitService,
  args: string[],
  o: { env?: Record<string, string>; expected?: number[] } = {},
): Promise<{ text: string; exitCode: number; nonUtf8: boolean }> {
  const r = await svc.runRead(args, {
    env: o.env,
    maxBuffer: MAX_PATCH_TEXT,
    timeoutMs: TIMEOUT,
    expectedExitCodes: o.expected ?? [0],
  });
  // invalid UTF-8 byte sequences decode to U+FFFD: such files may not round-trip exactly
  return { text: r.stdout, exitCode: r.exitCode, nonUtf8: r.stdout.includes(String.fromCharCode(0xfffd)) };
}

async function out(svc: GitService, args: string[], expected = [0]): Promise<string | null> {
  const r = await svc.runRead(args, { expectedExitCodes: expected });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** Temporary index file next to the repo's own (removed afterwards). */
async function withTempIndex<T>(
  svc: GitService,
  seed: 'copy' | 'head',
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = path.join(svc.repo.gitDir, 'githappens');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `patch-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: file };
  try {
    const real = path.join(svc.repo.gitDir, 'index');
    // copying keeps the stat cache, so `add -A` only re-hashes files that actually changed
    if (seed === 'copy' && fs.existsSync(real)) fs.copyFileSync(real, file);
    else await svc.runRead(['read-tree', 'HEAD'], { env });
    return await fn(env);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.lock`, { force: true });
  }
}

async function wipPatch(
  svc: GitService,
  source: Extract<PatchSource, { kind: 'wip' }>,
): Promise<{ text: string; nonUtf8: boolean }> {
  const paths = source.paths ?? [];
  if (source.stagedOnly) {
    // diff has no --pathspec-from-file; batches are separate diffs of disjoint paths
    const args = ['diff', '--cached', ...DIFF_FLAGS, 'HEAD'];
    if (!paths.length) return readText(svc, args);
    let text = '';
    let nonUtf8 = false;
    for (let i = 0; i < paths.length; i += 50) {
      const r = await readText(svc, [...args, '--', ...paths.slice(i, i + 50)], {
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      text += r.text;
      nonUtf8 ||= r.nonUtf8;
    }
    return { text, nonUtf8 };
  }
  // all working changes incl. untracked: stage everything into a throwaway index, diff it against HEAD
  return withTempIndex(svc, paths.length ? 'head' : 'copy', async (env) => {
    const add = withPathspec(['add', '-A'], paths);
    await svc.runRead(add.args, {
      env: { ...env, ...add.env },
      stdin: add.stdin,
      timeoutMs: TIMEOUT,
    });
    return readText(svc, ['diff', '--cached', ...DIFF_FLAGS, 'HEAD'], { env });
  });
}

async function emptyTree(svc: GitService): Promise<string> {
  const r = await svc.runRead(['hash-object', '-t', 'tree', '--stdin'], { stdin: '' });
  return r.stdout.trim();
}

async function stashPatch(svc: GitService, sha: Sha): Promise<{ text: string; nonUtf8: boolean }> {
  // Diff the stash commits directly instead of `stash show -p --include-untracked`: that command mangles
  // --src-prefix/--dst-prefix for the untracked part (e.g. `diff --git eu.txt u.txt`) with a clean config,
  // and it only exists on git ≥ 2.32. Tracked changes = stash^1..stash; untracked files = stash^3.
  const tracked = await readText(svc, ['diff', ...DIFF_FLAGS, `${sha}^1`, sha]);
  const untracked = await out(svc, ['rev-parse', '-q', '--verify', `${sha}^3`], [0, 1, 128]);
  if (!untracked) return tracked;
  const extra = await readText(svc, ['diff', ...DIFF_FLAGS, await emptyTree(svc), untracked]);
  return { text: tracked.text + extra.text, nonUtf8: tracked.nonUtf8 || extra.nonUtf8 };
}

/** Build the patch for a WIP / commit / stash source (spec 14 §6.3). */
export async function buildPatch(svc: GitService, source: PatchSource): Promise<BuiltPatch> {
  const info = await svc.refreshRepoInfo();
  const branch = info.head.kind === 'branch' && info.head.name ? info.head.name : undefined;
  let kind: PatchKind;
  let text: string;
  let nonUtf8: boolean;
  let baseSha: Sha | null;
  let baseBranch: string | undefined;
  let title: string;

  if (source.kind === 'wip') {
    baseSha = await svc.revParse('HEAD');
    if (!baseSha) throw err('Make a first commit before sharing changes as a Cloud Patch.');
    ({ text, nonUtf8 } = await wipPatch(svc, source));
    kind = 'wip';
    baseBranch = branch;
    title = '';
  } else if (source.kind === 'commit') {
    if (!/^[0-9a-f]{4,64}$/i.test(source.sha)) throw err('Invalid commit.');
    const parents = (await out(svc, ['rev-list', '--parents', '-n', '1', source.sha])) ?? '';
    const n = parents.split(' ').length - 1;
    if (n === 0) throw err('The first commit of a repository cannot be shared as a patch.');
    if (n > 1) throw err('Merge commits cannot be shared as a patch.');
    baseSha = await svc.revParse(`${source.sha}^`);
    ({ text, nonUtf8 } = await readText(svc, [
      'format-patch',
      '-1',
      '--stdout',
      '--no-signature',
      ...DIFF_FLAGS,
      source.sha,
    ]));
    kind = 'commit';
    baseBranch = branch;
    title = (await out(svc, ['log', '-1', '--format=%s', source.sha])) ?? '';
  } else {
    if (!/^[0-9a-f]{4,64}$/i.test(source.ref)) throw err('Invalid stash.');
    baseSha = await svc.revParse(`${source.ref}^1`);
    ({ text, nonUtf8 } = await stashPatch(svc, source.ref));
    kind = 'stash';
    title = ((await out(svc, ['log', '-1', '--format=%s', source.ref])) ?? '').replace(
      /^(?:WIP on|On) [^:]+:\s*/,
      '',
    );
  }
  if (!baseSha) throw err('The base commit of these changes could not be resolved.');

  const { files, warnings } = summarizePatch(text);
  if (!files.length) throw err('There are no changes to share.');
  if (nonUtf8) warnings.push('Some files are not UTF-8 text; their changes may not apply exactly.');
  if (!title) title = branch ? `${branch}: ${files[0]!.path}` : files[0]!.path;
  return {
    kind,
    text,
    baseSha,
    ...(baseBranch ? { baseBranch } : {}),
    files,
    warnings,
    title,
    size: Buffer.byteLength(text),
  };
}

// ---- pure patch summary ----

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

/** `a/x` / `b/x` / `"a/x"` → `x`; `/dev/null` → null. */
function headerPath(raw: string): string | null {
  const p = unquote(raw.replace(/\t.*$/, '').trim());
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/** Path from `diff --git a/P b/P` when both halves are equal (no rename). */
function gitLinePath(line: string): string {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length && !(rest[i] === '"' && rest[i - 1] !== '\\')) i++;
    return unquote(rest.slice(0, i + 1)).replace(/^a\//, '');
  }
  return rest.slice(2, (rest.length - 1) / 2);
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Files, line counts and warnings of a `git diff` / `format-patch` text (pure). Hunk bodies are consumed by
 * their line counts, so a format-patch signature or a `-- ` line can't be miscounted.
 */
export function summarizePatch(text: string): { files: PatchFile[]; warnings: string[] } {
  const files: PatchFile[] = [];
  const warnings: string[] = [];
  const lines = text.split('\n');
  let i = 0;
  let lfs = 0;
  let submodules = 0;
  const bigBinaries: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith('diff --git ')) {
      i++;
      continue;
    }
    let status: PatchFile['status'] = 'M';
    let oldP: string | null | undefined;
    let newP: string | null | undefined;
    let renameTo: string | undefined;
    let binary = false;
    let binaryBytes = 0;
    let additions = 0;
    let deletions = 0;
    const fallback = gitLinePath(line);
    i++;
    while (i < lines.length && !lines[i]!.startsWith('diff --git ')) {
      const l = lines[i]!;
      const m = HUNK_RE.exec(l);
      if (m) {
        let oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        let newLeft = m[2] === undefined ? 1 : Number(m[2]);
        i++;
        while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]!.startsWith('\\'))) {
          const h = lines[i]!;
          if (h.startsWith('+')) {
            additions++;
            newLeft--;
            if (h.startsWith('+version https://git-lfs.github.com/spec/')) lfs++;
            if (h.startsWith('+Subproject commit ')) submodules++;
          } else if (h.startsWith('-')) {
            deletions++;
            oldLeft--;
          } else if (!h.startsWith('\\')) {
            oldLeft--;
            newLeft--;
          }
          i++;
        }
        continue;
      }
      if (l.startsWith('new file mode')) status = 'A';
      else if (l.startsWith('deleted file mode')) status = 'D';
      else if (l.startsWith('rename to ')) {
        status = 'R';
        renameTo = unquote(l.slice('rename to '.length));
      } else if (l.startsWith('--- ')) oldP = headerPath(l.slice(4));
      else if (l.startsWith('+++ ')) newP = headerPath(l.slice(4));
      else if (l === 'GIT binary patch' || l.startsWith('Binary files ')) binary = true;
      else if (binary && /^(literal|delta) \d+$/.test(l)) binaryBytes += Number(l.split(' ')[1]);
      i++;
    }
    const p = renameTo ?? newP ?? oldP ?? fallback;
    const f: PatchFile = { path: p, status, additions, deletions };
    if (binary) f.binary = true;
    if (binary && binaryBytes > BINARY_WARN_BYTES) bigBinaries.push(p);
    files.push(f);
  }
  if (bigBinaries.length)
    warnings.push(
      `Large binary file${bigBinaries.length === 1 ? '' : 's'} (> 1 MB): ${bigBinaries.slice(0, 5).join(', ')}`,
    );
  if (lfs)
    warnings.push('Git LFS files are shared as pointers only; recipients need the LFS objects pushed.');
  if (submodules) warnings.push('Submodule changes are shared as commit pointers only.');
  return { files, warnings };
}
