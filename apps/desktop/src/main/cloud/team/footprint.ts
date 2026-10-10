import type { GitService } from '@githappens/git';

/** Per-branch cap (spec 14 §6.5). */
export const MAX_FOOTPRINT_FILES = 500;

export type LineRange = [number, number];

/** One changed file in BASE-file coordinates; empty ranges = whole file / unknown (binary, untracked). */
export interface OwnFootprintFile {
  path: string;
  ranges: LineRange[];
}

export interface OwnFootprint {
  files: OwnFootprintFile[];
  truncated: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/** `@@ -a,b +c,d @@` → base range `[a, a+b-1]`; pure insertions (`b == 0`) → `[a, a]`. */
export function hunkBaseRange(line: string): LineRange | null {
  const m = HUNK.exec(line);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? 1 : Number(m[2]);
  return b === 0 ? [a, a] : [a, a + b - 1];
}

/** Sort and merge touching/overlapping ranges. */
export function normalizeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Undo git's C-style path quoting (`"a\tb"`, octal escapes for non-ASCII bytes). */
export function unquoteGitPath(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESC[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string {
  const u = unquoteGitPath(p);
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Path of a `diff --git a/P b/P` header (renames are disabled, so both sides are equal). */
function headerPath(header: string): string {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return stripPrefix(end > 0 ? rest.slice(0, end + 1) : rest, 'a/');
  }
  return rest.slice(2, (rest.length - 1) / 2);
}

/**
 * Parse `git diff --unified=0 --no-renames` output into per-file base ranges. Files with no hunks count
 * only when binary (whole file); whitespace-only (with `-b`) and mode-only changes are skipped.
 */
export function parseUnifiedZero(diff: string): OwnFootprintFile[] {
  const out: OwnFootprintFile[] = [];
  const blocks = diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.replace(/\r$/, ''));
    let file = headerPath(lines[0]!);
    let minus: string | null = null;
    let plus: string | null = null;
    let binary = false;
    const ranges: LineRange[] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) {
        const r = hunkBaseRange(line);
        if (r) ranges.push(r);
      } else if (!ranges.length) {
        if (line.startsWith('--- ')) minus = line.slice(4);
        else if (line.startsWith('+++ ')) plus = line.slice(4);
        else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      }
    }
    if (minus && minus !== '/dev/null') file = stripPrefix(minus, 'a/');
    else if (plus && plus !== '/dev/null') file = stripPrefix(plus, 'b/');
    if (ranges.length) out.push({ path: file, ranges: normalizeRanges(ranges) });
    else if (binary) out.push({ path: file, ranges: [] });
  }
  return out;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0'];

/**
 * Footprint of `rev` (or the working tree incl. untracked files when `rev` is null) against `base`
 * (normally merge-base(target, branch)). Capped at 500 files. Paths only — contents never leave here.
 */
export async function computeFootprint(
  svc: GitService,
  base: string,
  rev: string | null,
  opts: { ignoreSpaceChange?: boolean } = {},
): Promise<OwnFootprint> {
  const args = ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS];
  if (opts.ignoreSpaceChange !== false) args.push('--ignore-space-change');
  args.push(base);
  if (rev) args.push(rev);
  args.push('--');
  const r = await svc.runRead(args, { priority: 'background', maxBuffer: 256 * 1024 * 1024 });
  const files = parseUnifiedZero(String(r.stdout));
  if (rev === null && svc.repo.worktreeRoot) {
    const u = await svc.runRead(['ls-files', '--others', '--exclude-standard', '-z'], {
      priority: 'background',
    });
    const seen = new Set(files.map((f) => f.path));
    for (const p of String(u.stdout).split('\0')) {
      if (p && !seen.has(p)) files.push({ path: p, ranges: [] });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, MAX_FOOTPRINT_FILES), truncated: files.length > MAX_FOOTPRINT_FILES };
}
