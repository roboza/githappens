import type { BlameCommitInfo, BlameLine, BlameResult, Sha } from '../../types';
import type { GitService } from '../git-service';
import { assertSafeRev } from '../rev-set';
import { unquoteCPath } from './cquote';

/** Blame options beyond the required (path, rev) pair (spec 07 §4.10). */
export interface BlameOptions {
  /** `-w`: ignore whitespace changes. */
  ignoreWhitespace?: boolean;
  /** `-M`: detect moved lines within the file. */
  detectMoves?: boolean;
  /** `-C`: detect lines copied from other files of the same commit. */
  detectCopies?: boolean;
  /** `-L a,b` (1-based, inclusive). */
  range?: { start: number; end: number };
  signal?: AbortSignal;
}

const BLAME_TIMEOUT_MS = 5 * 60_000;
const BLAME_MAX_BUFFER = 512 * 1024 * 1024;
const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/** True for the all-zero sha git uses for uncommitted (working tree / index) lines. */
export const isUncommittedSha = (sha: string): boolean => /^0+$/.test(sha);

function emptyCommit(sha: Sha): BlameCommitInfo {
  return {
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
}

/**
 * Parse `git blame --porcelain` output (spec 02 §6.10). `--incremental` entries (no content lines) are
 * tolerated: their commit headers are parsed, but they yield no `lines`.
 * Commit headers are only emitted the first time a sha is seen; later groups reuse them. Uncommitted
 * lines (all-zero sha) keep git's synthetic "Not Committed Yet" author.
 */
export function parseBlamePorcelain(stdout: string): BlameResult {
  const commits: Record<Sha, BlameCommitInfo> = {};
  const lines: BlameLine[] = [];
  const rows = stdout.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  let cur: { sha: Sha; orig: number; final: number } | null = null;
  for (const row of rows) {
    if (cur === null) {
      const m = HEADER.exec(row);
      if (!m) continue; // tolerate stray output
      const sha = m[1]!;
      cur = { sha, orig: Number(m[2]), final: Number(m[3]) };
      commits[sha] ??= emptyCommit(sha);
      continue;
    }
    if (row.startsWith('\t')) {
      let content = row.slice(1);
      if (content.endsWith('\r')) content = content.slice(0, -1);
      lines.push({ sha: cur.sha, origLine: cur.orig, finalLine: cur.final, content });
      cur = null;
      continue;
    }
    // --incremental: a new header right after `filename` (no content lines)
    const header = HEADER.exec(row);
    if (header && commits[cur.sha]?.filename) {
      const sha = header[1]!;
      cur = { sha, orig: Number(header[2]), final: Number(header[3]) };
      commits[sha] ??= emptyCommit(sha);
      continue;
    }
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const value = sp < 0 ? '' : row.slice(sp + 1);
    const c = commits[cur.sha]!;
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
      case 'filename':
        c.filename = unquoteCPath(value);
        break;
      default:
        break; // committer-mail, committer-tz, unknown future keys
    }
  }
  lines.sort((a, b) => a.finalLine - b.finalLine);
  return { commits, lines };
}

/**
 * Blame one file (spec 02 §6.10, spec 07 §4.10). `rev` undefined blames the working tree version, so
 * uncommitted lines appear with the all-zero sha. `path` is relative to the worktree root.
 */
export async function blameFile(
  service: GitService,
  path: string,
  rev?: string,
  options: BlameOptions = {},
): Promise<BlameResult> {
  const file = path.replace(/\\/g, '/');
  // argv-safe: unicode, tabs and newlines are fine after `--`; only NUL can't be passed (spec 07 §9)
  if (!file || file.includes('\0')) throw new Error(`Invalid path: ${JSON.stringify(path)}`);
  const args = ['blame', '--porcelain'];
  if (options.ignoreWhitespace) args.push('-w');
  if (options.detectMoves) args.push('-M');
  if (options.detectCopies) args.push('-C');
  if (options.range) {
    const start = Math.max(1, Math.floor(options.range.start));
    const end = Math.max(start, Math.floor(options.range.end));
    args.push(`-L${start},${end}`);
  }
  if (rev !== undefined) {
    assertSafeRev(rev);
    args.push(rev);
  }
  args.push('--', file);
  const r = await service.runRead(args, {
    maxBuffer: BLAME_MAX_BUFFER,
    timeoutMs: BLAME_TIMEOUT_MS,
    signal: options.signal,
  });
  return parseBlamePorcelain(r.stdout);
}
