import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The slice of the OS the external-tools code looks at (spec 12 §6.10). Injected so detection and launch
 * construction can be tested per platform with a fake file system and PATH.
 */
export interface ToolEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  isFile(p: string): boolean;
  isDir(p: string): boolean;
  listDir(p: string): string[];
}

export function nodeToolEnv(): ToolEnv {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        // App execution aliases (WindowsApps\wt.exe) are reparse points that stat cannot follow.
        try {
          return fs.lstatSync(p).isSymbolicLink() || process.platform === 'win32';
        } catch {
          return false;
        }
      }
    },
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
  };
}

export const pathFor = (platform: NodeJS.Platform): typeof path.posix =>
  platform === 'win32' ? path.win32 : path.posix;

/** Environment lookup; case-insensitive on Windows (`Path`, `PATH`, `ProgramFiles`…). */
export function envVar(e: ToolEnv, name: string): string | undefined {
  if (e.env[name] !== undefined) return e.env[name];
  if (e.platform !== 'win32') return undefined;
  const k = Object.keys(e.env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? e.env[k] : undefined;
}

/** Expand `%VAR%` (Windows) and a leading `~` in a known install path; null when a variable is unset. */
export function expandPath(p: string, e: ToolEnv): string | null {
  let missing = false;
  let out = p.replace(/%([A-Za-z0-9_()]+)%/g, (_m, name: string) => {
    const v = envVar(e, name);
    if (v === undefined || v === '') missing = true;
    return v ?? '';
  });
  if (missing) return null;
  if (out === '~' || out.startsWith('~/')) out = e.homedir + out.slice(1);
  return out;
}

/**
 * Expand one `*` wildcard per path segment (`…\JetBrains\IntelliJ IDEA*\bin\idea64.exe`). Matches are sorted so
 * the last one is the newest-looking version.
 */
export function expandGlob(pattern: string, e: ToolEnv): string[] {
  const P = pathFor(e.platform);
  if (!pattern.includes('*')) return [pattern];
  const parts = pattern.split(/[\\/]/);
  let bases = [parts[0] === '' ? P.sep : `${parts[0]}${P.sep}`];
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    if (!seg.includes('*')) {
      bases = bases.map((b) => P.join(b, seg));
      continue;
    }
    const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    bases = bases.flatMap((b) =>
      e
        .listDir(b)
        .filter((n) => re.test(n))
        .sort()
        .map((n) => P.join(b, n)),
    );
  }
  return bases;
}

/** Find an executable on PATH (with PATHEXT on Windows). `name` may already carry an extension. */
export function findExe(name: string, e: ToolEnv): string | null {
  const P = pathFor(e.platform);
  const win = e.platform === 'win32';
  const dirs = (envVar(e, 'PATH') ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts =
    win && !P.extname(name)
      ? (envVar(e, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const raw of dirs) {
    const dir = raw.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const cand = P.join(dir, name + ext.toLowerCase());
      if (e.isFile(cand)) return cand;
    }
  }
  return null;
}

/** Whether `p` names an existing file, trying PATHEXT on Windows when it has no extension. */
export function existingFile(p: string, e: ToolEnv): string | null {
  if (e.isFile(p)) return p;
  if (e.platform === 'win32' && !path.win32.extname(p)) {
    for (const ext of (envVar(e, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) {
      if (e.isFile(p + ext.toLowerCase())) return p + ext.toLowerCase();
    }
  }
  return null;
}
