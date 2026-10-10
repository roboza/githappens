import fs from 'node:fs';
import path from 'node:path';

import { parseLsFilesUnmerged } from '../parsers/ls-files';
import type { BlameCommitInfo, BlameLine, ConflictFile, FileDiff, Sha } from '../types';
import { unquoteCPath } from './extras/cquote';
import type { GitService } from './git-service';
import { WORKTREE_REV } from './git-service';
import { argvPathspecs, displayPath, isRawPathKey } from './pathspec';
import { assertSafeRev } from './rev-set';

export { sha1Hex, writeFileAtomic, type AtomicWriteOptions } from './atomic-write';

/**
 * Spec 07 reads that sit on top of GitService: file history with rename markers, combined (`--cc`) merge
 * diffs, submodule commit lists, `ls-tree` for "View all files", blob metadata (sizes, LFS pointers),
 * streaming `blame --incremental` and single-file patches.
 */

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

/** Paths may hold unicode, tabs and newlines (passed as argv after `--`); only NUL is impossible. */
export function assertRepoPath(p: string): string {
  const file = p.replace(/\\/g, '/');
  if (!file || file.includes('\0') || file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
    throw new Error(`Invalid path: ${JSON.stringify(p)}`);
  }
  if (file.split('/').some((seg) => seg === '..')) throw new Error(`Invalid path: ${JSON.stringify(p)}`);
  return file;
}

// ---- file history (spec 07 §4.9, §6.7) ----

export interface FileHistoryEntry {
  sha: Sha;
  parents: Sha[];
  /** Path of the file at this commit. */
  path: string;
  /** Previous path when this commit renamed/copied the file. */
  oldPath?: string;
  status: FileDiff['status'];
  similarity?: number;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
}

export interface FileHistoryQuery {
  path: string;
  /** Start revision (default HEAD). */
  rev?: string;
  /** `--follow` (default true). */
  follow?: boolean;
  skip?: number;
  /** Page size (default 200). */
  limit?: number;
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  hasMore: boolean;
}

const HISTORY_FORMAT = '%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00';

/** Parse `git log -z --format=<HISTORY_FORMAT> --name-status` output. */
export function parseFileHistory(stdout: string, fallbackPath: string): FileHistoryEntry[] {
  const out: FileHistoryEntry[] = [];
  let current = fallbackPath;
  for (const rec of stdout.split('\x1e')) {
    if (!rec) continue;
    const fields: string[] = [];
    let pos = 0;
    for (let i = 0; i < 6; i++) {
      const end = rec.indexOf('\0', pos);
      if (end < 0) break;
      fields.push(rec.slice(pos, end));
      pos = end + 1;
    }
    if (fields.length < 6) continue;
    const [sha, parents, an, ae, at, subject] = fields as [string, string, string, string, string, string];
    // `\0` terminator of the format + `-z` separator + `\n`, then the name-status entries
    while (pos < rec.length && (rec[pos] === '\0' || rec[pos] === '\n')) pos++;
    const tokens = rec.slice(pos).split('\0');
    let status: FileDiff['status'] = 'M';
    let similarity: number | undefined;
    let filePath = current;
    let oldPath: string | undefined;
    const code = tokens[0] ?? '';
    if (/^[ACDMRTUX]\d*$/.test(code)) {
      status = (code[0] === 'X' ? 'M' : code[0]) as FileDiff['status'];
      if (status === 'R' || status === 'C') {
        similarity = Number(code.slice(1)) || undefined;
        oldPath = tokens[1];
        filePath = tokens[2] ?? current;
      } else filePath = tokens[1] ?? current;
    }
    out.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      path: filePath,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      ...(similarity !== undefined ? { similarity } : {}),
      authorName: an,
      authorEmail: ae,
      authorTime: Number(at) || 0,
      subject,
    });
    // older commits know the file under its old name
    current = oldPath ?? filePath;
  }
  return out;
}

export async function fileHistory(svc: GitService, q: FileHistoryQuery): Promise<FileHistoryPage> {
  // a raw (non-UTF-8, spec 02 §8) path: a `:(glob)` pathspec, which `--follow` does not accept
  const raw = isRawPathKey(q.path);
  const file = raw ? q.path : assertRepoPath(q.path);
  const rev = q.rev ?? 'HEAD';
  assertSafeRev(rev);
  if (rev === 'HEAD' && (await svc.revParse('HEAD')) === null) return { entries: [], hasMore: false };
  const limit = Math.max(1, Math.min(q.limit ?? 200, 5000));
  const skip = Math.max(0, Math.floor(q.skip ?? 0));
  const args = ['log', '-z', `--format=${HISTORY_FORMAT}`, '--name-status', '-M', '--no-color'];
  const follow = q.follow !== false && !raw;
  // `--skip` breaks `--follow` (git applies it before tracking the rename), so following pages re-read
  // the skipped prefix and slice it off
  if (follow) args.push('--follow', `-n${skip + limit + 1}`);
  else args.push(`--skip=${skip}`, `-n${limit + 1}`);
  const ps = argvPathspecs([file]);
  args.push(rev, '--', ...ps.paths);
  const r = await svc.runRead(args, { env: ps.env, maxBuffer: 256 * 1024 * 1024 });
  const entries = parseFileHistory(r.stdout, displayPath(file)).slice(follow ? skip : 0);
  return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
}

// ---- combined merge diff (spec 07 §4.2 parent selector, `--cc`) ----

export interface CombinedLine {
  /** One prefix char per parent (`+`, `-` or space). */
  prefix: string;
  content: string;
}
export interface CombinedHunk {
  header: string;
  lines: CombinedLine[];
}
export interface CombinedFile {
  path: string;
  hunks: CombinedHunk[];
  binary: boolean;
}

/** Parse `git show --cc --format=` output (one `diff --cc <path>` block per file). */
export function parseCombinedDiff(stdout: string): CombinedFile[] {
  const files: CombinedFile[] = [];
  let file: CombinedFile | null = null;
  let hunk: CombinedHunk | null = null;
  let parents = 2;
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      const p = line.slice(line.indexOf(' ', 5) + 1);
      file = { path: unquoteCPath(p), hunks: [], binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const hh = /^(@{3,}) /.exec(line);
    if (hh) {
      parents = hh[1]!.length - 1;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files /.test(line)) file.binary = true;
      continue;
    }
    if (raw === '') continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    hunk.lines.push({ prefix: raw.slice(0, parents), content: raw.slice(parents).replace(/\r$/, '') });
  }
  return files;
}

export async function combinedDiff(svc: GitService, sha: Sha, paths: string[] = []): Promise<CombinedFile[]> {
  assertSafeRev(sha);
  const args = ['show', '--cc', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', sha, '--'];
  args.push(...paths.map(assertRepoPath));
  const r = await svc.runRead(args, { env: LITERAL, maxBuffer: 256 * 1024 * 1024 });
  return parseCombinedDiff(r.stdout);
}

// ---- submodule commit list (spec 07 §4.7) ----

export interface SubmoduleLog {
  initialized: boolean;
  /** Commits in `new` not in `old` / in `old` not in `new`. */
  ahead: number;
  behind: number;
  /** Up to 100 commits (newest first) of the dominant direction. */
  commits: { sha: Sha; subject: string }[];
  /** The submodule is checked out but lacks one of the commits (not fetched). */
  unavailable?: boolean;
}

export async function submoduleLog(
  svc: GitService,
  subPath: string,
  from: string | undefined,
  to: string | undefined,
): Promise<SubmoduleLog> {
  const p = assertRepoPath(subPath);
  const root = svc.repo.worktreeRoot;
  const empty: SubmoduleLog = { initialized: false, ahead: 0, behind: 0, commits: [] };
  if (!root || !fs.existsSync(path.join(root, p, '.git'))) return empty;
  if (!from || !to) return { ...empty, initialized: true };
  for (const s of [from, to]) if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new Error('Invalid submodule sha');
  try {
    const count = await svc.runRead(['-C', p, 'rev-list', '--left-right', '--count', `${from}...${to}`]);
    const [behind, ahead] = count.stdout.trim().split(/\s+/).map(Number) as [number, number];
    const range = ahead >= behind ? `${from}..${to}` : `${to}..${from}`;
    const log = await svc.runRead(['-C', p, 'log', '-z', '--format=%H%x00%s', '-n100', range]);
    const parts = log.stdout.split('\0');
    const commits: SubmoduleLog['commits'] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      commits.push({ sha: parts[i]!.replace(/^\n/, ''), subject: parts[i + 1]! });
    }
    return { initialized: true, ahead: ahead || 0, behind: behind || 0, commits };
  } catch {
    return { ...empty, initialized: true, unavailable: true };
  }
}

// ---- three-dot base (spec 07 §4.8) ----

/** `git merge-base a b` (null for unrelated histories: three-dot falls back to two-dot). */
/**
 * `git:mergeBase` (spec 02 §6.8): exit 1 with no output = no common ancestor (null). `fork-point` runs
 * `merge-base --fork-point <a> <b>` (a = upstream ref, using its reflog).
 */
export async function mergeBase(
  svc: GitService,
  a: string,
  b: string,
  mode: 'default' | 'fork-point' = 'default',
): Promise<Sha | null> {
  assertSafeRev(a);
  const other = b === WORKTREE_REV ? 'HEAD' : b;
  assertSafeRev(other);
  const flags = mode === 'fork-point' ? ['--fork-point'] : [];
  const r = await svc.runRead(['merge-base', ...flags, a, other], { expectedExitCodes: [0, 1] });
  return r.exitCode === 0 ? r.stdout.trim() || null : null;
}

/** `git:conflicts` (spec 02 §5.3, §6.11): unmerged paths with their index stages. */
export async function listConflicts(svc: GitService): Promise<ConflictFile[]> {
  if (svc.repo.isBare) return [];
  const r = await svc.runRead(['ls-files', '-u', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  return parseLsFilesUnmerged(r.stdout);
}

// ---- View all files (spec 07 §6.2) ----

export async function lsTree(svc: GitService, rev: string): Promise<string[]> {
  assertSafeRev(rev);
  const r = await svc.runRead(['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.stdout.split('\0').filter(Boolean);
}

// ---- blob metadata, LFS (spec 07 §4.7, §6.3) ----

export interface LfsPointer {
  oid: string;
  size: number;
}

/** `version https://git-lfs.github.com/spec/v1` pointer files (< 1 KiB). */
export function parseLfsPointer(text: string | null | undefined): LfsPointer | null {
  if (!text || text.length > 1024 || !text.startsWith('version https://git-lfs.github.com/spec/v1')) {
    return null;
  }
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}

export interface BlobInfo {
  exists: boolean;
  size: number;
  lfs?: LfsPointer & { available: boolean };
}

/** Absolute path of a local LFS object, or null when it isn't downloaded. */
export function lfsObjectPath(svc: GitService, oid: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(oid)) return null;
  const p = path.join(svc.repo.commonDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  return fs.existsSync(p) ? p : null;
}

/** Resolve a worktree-relative path, refusing escapes and `.git/` (spec 07 §5 path validation). */
export function resolveWorktreePath(root: string, rel: string): string {
  const file = assertRepoPath(rel);
  const abs = path.resolve(root, file);
  const relative = path.relative(root, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the working tree.');
  }
  if (relative.split(path.sep)[0]!.toLowerCase() === '.git') throw new Error('Path is inside .git.');
  return abs;
}

export async function blobInfo(svc: GitService, rev: string, file: string): Promise<BlobInfo> {
  const p = assertRepoPath(file);
  if (!rev) return { exists: false, size: 0 };
  let text: string | null = null;
  let size: number;
  if (rev === WORKTREE_REV) {
    const root = svc.repo.worktreeRoot;
    if (!root) return { exists: false, size: 0 };
    const abs = resolveWorktreePath(root, p);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return { exists: false, size: 0 };
      size = st.size;
      if (size <= 1024) text = await fs.promises.readFile(abs, 'utf8');
    } catch {
      return { exists: false, size: 0 };
    }
  } else {
    const r = await svc.showFile(rev === ':index' ? ':0' : rev, p, 1024);
    if (r.missing) return { exists: false, size: 0 };
    size = r.size;
    text = r.encoding === 'utf8' ? r.content : null;
  }
  const ptr = parseLfsPointer(text);
  return {
    exists: true,
    size,
    ...(ptr ? { lfs: { ...ptr, available: lfsObjectPath(svc, ptr.oid) !== null } } : {}),
  };
}

// ---- single-file patch (spec 07 §2.3 "Create patch from file") ----

/** `git format-patch` limited to the given paths: an `am`-able mail patch for one commit. */
export async function filePatch(svc: GitService, sha: Sha, paths: string[]): Promise<string> {
  assertSafeRev(sha);
  const args = ['format-patch', '-1', '--stdout', '--no-color', '--binary', '--root', sha, '--'];
  args.push(...paths.map(assertRepoPath));
  const r = await svc.runRead(args, { env: LITERAL, maxBuffer: 512 * 1024 * 1024 });
  return r.stdout;
}

// ---- streaming blame (spec 07 §6.8) ----

export interface BlameStreamOptions {
  ignoreWhitespace?: boolean;
  detectMoves?: boolean;
  detectCopies?: boolean;
  signal?: AbortSignal;
}

export interface BlameChunk {
  /** Lines without content (the renderer has the file text). */
  lines: BlameLine[];
  /** Commits first seen in this chunk. */
  commits: Record<Sha, BlameCommitInfo>;
}

const INC_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+) (\d+)$/;

/** Stateful parser for `git blame --incremental` output fed in arbitrary chunks. */
export class IncrementalBlameParser {
  private buf = '';
  private readonly known = new Map<Sha, BlameCommitInfo>();
  private cur: { sha: Sha; orig: number; final: number; count: number; info: BlameCommitInfo } | null = null;
  private pending: BlameChunk = { lines: [], commits: {} };

  push(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const row = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.line(row);
    }
  }

  /** Lines/commits parsed since the last take (empty when nothing new). */
  take(): BlameChunk {
    const c = this.pending;
    this.pending = { lines: [], commits: {} };
    return c;
  }

  private line(row: string): void {
    if (!this.cur) {
      const m = INC_HEADER.exec(row);
      if (!m) return;
      const sha = m[1]!;
      let info = this.known.get(sha);
      if (!info) {
        info = {
          sha,
          author: '',
          authorMail: '',
          authorTime: 0,
          authorTz: '',
          committer: '',
          committerTime: 0,
          summary: '',
          filename: '',
          boundary: false,
        };
        this.known.set(sha, info);
        this.pending.commits[sha] = info;
      }
      this.cur = { sha, orig: Number(m[2]), final: Number(m[3]), count: Number(m[4]), info };
      return;
    }
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const value = sp < 0 ? '' : row.slice(sp + 1);
    const c = this.cur.info;
    switch (key) {
      case 'author':
        c.author = value;
        break;
      case 'author-mail':
        c.authorMail = value.replace(/^<(.*)>$/, '$1');
        break;
      case 'author-time':
        c.authorTime = Number(value) || 0;
        break;
      case 'author-tz':
        c.authorTz = value;
        break;
      case 'committer':
        c.committer = value;
        break;
      case 'committer-time':
        c.committerTime = Number(value) || 0;
        break;
      case 'summary':
        c.summary = value;
        break;
      case 'boundary':
        c.boundary = true;
        break;
      case 'previous': {
        const s2 = value.indexOf(' ');
        if (s2 > 0) c.previous = { sha: value.slice(0, s2), path: unquoteCPath(value.slice(s2 + 1)) };
        break;
      }
      case 'filename': {
        c.filename ||= unquoteCPath(value);
        const { sha, orig, final, count } = this.cur;
        for (let i = 0; i < count; i++) {
          this.pending.lines.push({ sha, origLine: orig + i, finalLine: final + i, content: '' });
        }
        this.cur = null;
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Run `git blame --incremental` and report parsed chunks as they arrive (at most every `intervalMs`).
 * `rev` undefined blames the working tree file (uncommitted lines get the all-zero sha).
 */
export async function blameIncremental(
  svc: GitService,
  file: string,
  rev: string | undefined,
  o: BlameStreamOptions,
  onChunk: (c: BlameChunk) => void,
  intervalMs = 50,
): Promise<void> {
  const p = assertRepoPath(file);
  const args = ['blame', '--incremental'];
  if (o.ignoreWhitespace) args.push('-w');
  if (o.detectMoves) args.push('-M');
  if (o.detectCopies) args.push('-C');
  if (rev !== undefined && rev !== WORKTREE_REV) {
    assertSafeRev(rev);
    args.push(rev);
  }
  args.push('--', p);
  const stream = svc.streamRead(args, { signal: o.signal, timeoutMs: 5 * 60_000 });
  stream.done.catch(() => undefined); // surfaced through the stdout iterator below
  const parser = new IncrementalBlameParser();
  const decoder = new TextDecoder('utf-8');
  let last = 0;
  const flush = (force: boolean): void => {
    if (!force && Date.now() - last < intervalMs) return;
    const c = parser.take();
    if (c.lines.length || Object.keys(c.commits).length) {
      last = Date.now();
      onChunk(c);
    }
  };
  try {
    for await (const b of stream.stdout) {
      parser.push(decoder.decode(b, { stream: true }));
      flush(false);
    }
  } finally {
    parser.push(decoder.decode());
  }
  await stream.done;
  flush(true);
}
