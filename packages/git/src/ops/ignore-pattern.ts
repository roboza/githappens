/**
 * `.gitignore` pattern construction for the Ignore menu (spec 06 §6.7). Pure (renderer-safe).
 *
 * gitignore syntax: `\` escapes the next character; `*`, `?`, `[` are glob metacharacters; a leading
 * `#` starts a comment and a leading `!` negates; trailing spaces are ignored unless escaped.
 */

export type IgnoreKind = 'file' | 'extension' | 'folder';

/** Escape a literal path fragment so it matches itself in a gitignore pattern. */
export function escapeIgnoreLiteral(s: string): string {
  let out = s.replace(/[\\*?[]/g, (c) => `\\${c}`);
  if (out.startsWith('#') || out.startsWith('!')) out = `\\${out}`;
  // trailing spaces are stripped by git unless backslash-escaped
  out = out.replace(/( +)$/, (m) => m.replace(/ /g, '\\ '));
  return out;
}

/** Inverse of `escapeIgnoreLiteral` (drops backslash escapes). */
export function unescapeIgnoreLiteral(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** File extension (without the dot) of a path's base name, or null for none / dotfiles. */
export function extensionOf(p: string): string | null {
  const base = norm(p).split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 && i < base.length - 1 ? base.slice(i + 1) : null;
}

/**
 * Pattern for "Ignore ▸ this file / all *.ext files / folder/". Files and folders are anchored to the
 * root `.gitignore` (`/path/to/file`, `/path/to/folder/`). Returns null when the kind does not apply
 * (no extension, no folder).
 */
export function ignorePatternFor(kind: IgnoreKind, filePath: string): string | null {
  const p = norm(filePath);
  if (!p) return null;
  if (kind === 'file') return `/${p.split('/').map(escapeIgnoreLiteral).join('/')}`;
  if (kind === 'extension') {
    const ext = extensionOf(p);
    return ext ? `*.${escapeIgnoreLiteral(ext)}` : null;
  }
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  return dir ? `/${dir.split('/').map(escapeIgnoreLiteral).join('/')}/` : null;
}

/** The repository path an anchored pattern names (`/a/b` → `a/b`, `/dir/` → `dir/`), else null. */
export function pathOfAnchoredPattern(pattern: string): string | null {
  if (!pattern.startsWith('/') || pattern.length < 2) return null;
  const body = pattern.slice(1);
  // patterns with unescaped glob characters do not name a single path
  if (/(^|[^\\])[*?[]/.test(body)) return null;
  return unescapeIgnoreLiteral(body);
}

/** Parse one `git check-ignore -v` line: `<source>:<line>:<pattern>\t<path>`. */
export function parseCheckIgnore(
  line: string,
): { source: string; line: number; pattern: string; path: string } | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const head = line.slice(0, tab);
  const m = /^(.*):(\d+):(.*)$/.exec(head);
  if (!m) return null;
  return { source: m[1]!, line: Number(m[2]), pattern: m[3]!, path: line.slice(tab + 1) };
}
