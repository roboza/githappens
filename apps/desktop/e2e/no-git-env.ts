import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An environment in which no git executable can be found (spec 15 §3: "no prerequisites (git bundled)"),
 * for launching the app as if on a machine without git:
 *  - every PATH entry containing a git executable is removed (Windows), or replaced by a "shadow" copy of
 *    the directory that symlinks everything except git* (macOS/Linux, where git shares /usr/bin with the
 *    tools a login session needs);
 *  - SHELL is removed so the app does not re-read PATH from a login shell (spec 02 shell-env resolution);
 *  - all GIT_* variables are cleared (GIT_EXEC_PATH, GIT_DIR, …), then GIT_CONFIG_GLOBAL points at a
 *    temp identity and GIT_CONFIG_NOSYSTEM=1 isolates from machine config.
 */
export interface NoGitEnv {
  env: Record<string, string>;
  /** Temp dir holding the shadow PATH dirs and the global gitconfig; remove when done. */
  root: string;
  /** PATH entries that were dropped or shadowed. */
  removed: string[];
}

const isWin = process.platform === 'win32';
const exeNames = isWin
  ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
      .map((e) => `git${e.toLowerCase()}`)
  : ['git'];

function hasGit(dir: string): boolean {
  for (const name of exeNames) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** First git executable on `pathValue`, or null. */
export function findGitOnPath(pathValue: string): string | null {
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const clean = dir.replace(/^"|"$/g, '');
    for (const name of exeNames) {
      const p = path.join(clean, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function makeNoGitEnv(): NoGitEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-nogit-env-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^GIT_/i.test(k) || k === 'SHELL') continue;
    env[k] = v;
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const removed: string[] = [];
  const kept: string[] = [];
  let shadowN = 0;
  for (const raw of (env[pathKey] ?? '').split(path.delimiter)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!dir || !hasGit(dir)) {
      if (dir) kept.push(raw);
      continue;
    }
    removed.push(dir);
    if (isWin) continue;
    const shadow = path.join(root, `shadow-${shadowN++}`);
    fs.mkdirSync(shadow);
    for (const name of fs.readdirSync(dir)) {
      if (/^git(-|$)/.test(name)) continue;
      try {
        fs.symlinkSync(path.join(dir, name), path.join(shadow, name));
      } catch {
        /* unreadable entry — skip */
      }
    }
    kept.push(shadow);
  }
  env[pathKey] = kept.join(path.delimiter);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = No Git E2E\n\temail = nogit@example.com\n');
  env.GIT_CONFIG_GLOBAL = gitconfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { env, root, removed };
}
