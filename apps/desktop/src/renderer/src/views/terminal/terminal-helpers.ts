/**
 * Pure helpers of the integrated terminal view (spec 12 §4.2 / §4.3): `path:line` link detection,
 * repo-relative path resolution, the keystroke-based input-line fallback, and drag-and-drop text.
 */
import { quotePath, type ShellKind } from '../../../../shared/terminal/shell-quote';

export interface PathLink {
  /** 0-based offsets in the line text. */
  start: number;
  end: number;
  path: string;
  line: number;
  column?: number;
}

/** `src/a.ts:12`, `src/a.ts:12:5`, `.\x\y.cs(12,5)`, `C:\x\y.py:3` — a line number is required. */
const PATH_LINE =
  /(?<![\w/\\.-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+~-]+[\\/])*[\w.@+~-]*[\w@+~-]\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))/g;

export function findPathLinks(text: string): PathLink[] {
  const out: PathLink[] = [];
  for (const m of text.matchAll(PATH_LINE)) {
    const path = m[1]!;
    if (/^v?\d+(\.\d+)+$/.test(path)) continue; // version numbers like v1.2.3:4
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(Math.max(0, m.index! - 10), m.index! + path.length)))
      continue;
    const line = Number(m[2] ?? m[4]);
    const col = m[3] ?? m[5];
    if (!line) continue;
    const link: PathLink = { start: m.index!, end: m.index! + m[0].length, path, line };
    if (col) link.column = Number(col);
    out.push(link);
  }
  return out;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const isAbs = (p: string): boolean => /^([A-Za-z]:)?[\\/]/.test(p);

/** Joins and normalises `.` / `..` segments (string-only; the renderer has no `path`). */
export function joinPath(base: string, rel: string): string {
  const all = isAbs(rel) ? norm(rel) : `${norm(base)}/${norm(rel)}`;
  const drive = /^[A-Za-z]:/.exec(all)?.[0] ?? '';
  const parts: string[] = [];
  for (const seg of all.slice(drive.length).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `${drive}/${parts.join('/')}`;
}

/**
 * Repo-relative path of `p` (relative to the shell's `cwd`, or absolute), or null when it lies
 * outside the repo. Comparison ignores case on Windows-style paths.
 */
export function repoRelative(p: string, cwd: string, repoRoot: string): string | null {
  const abs = joinPath(cwd, p);
  const root = joinPath(repoRoot, '.');
  const ci = /^[A-Za-z]:/.test(root);
  const a = ci ? abs.toLowerCase() : abs;
  const r = ci ? root.toLowerCase() : root;
  if (a === r) return null;
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return a.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

/**
 * Paths of `files` (repo-relative) as seen from `cwd`: files below the shell's folder lose that
 * prefix; others are dropped (git paths are relative to the cwd).
 */
export function pathsFromCwd(files: string[], cwd: string, repoRoot: string): string[] {
  const sub = repoRelative(cwd, cwd, repoRoot) ?? '';
  if (!sub) return files;
  const prefix = `${sub}/`;
  const lower = prefix.toLowerCase();
  return files.filter((f) => f.toLowerCase().startsWith(lower)).map((f) => f.slice(prefix.length));
}

/**
 * Fallback input tracking from keystrokes (shells without OSC 133): printable text is appended,
 * Backspace removes, Enter / Ctrl+C / Ctrl+U reset; cursor movement or history recall makes the
 * line unknown until the next Enter.
 */
export class KeystrokeLine {
  private text = '';
  private known = true;

  /** Current input, or null when it cannot be tracked reliably. */
  get value(): string | null {
    return this.known ? this.text : null;
  }

  reset(): void {
    this.text = '';
    this.known = true;
  }

  feed(data: string): void {
    if (data === '\r' || data === '\x03' || data === '\x15') return this.reset();
    if (data === '\x7f' || data === '\b') {
      this.text = this.text.slice(0, -1);
      return;
    }
    if (data.startsWith('\x1b')) {
      this.known = false; // arrows, history, word moves
      return;
    }
    if (data.includes('\r')) {
      // pasted multi-line text: the shell executes it
      this.text = data.slice(data.lastIndexOf('\r') + 1);
      this.known = true;
      return;
    }
    if (/[\x00-\x1f]/.test(data)) {
      this.known = false; // Tab completion by the shell, Ctrl+W, …
      return;
    }
    this.text += data;
  }
}

/** Text inserted for dropped files: shell-quoted, space-separated, with a trailing space. */
export function dropText(paths: string[], kind: ShellKind): string {
  return paths.length ? `${paths.map((p) => quotePath(p, kind)).join(' ')} ` : '';
}
