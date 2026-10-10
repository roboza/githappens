import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findPathKey } from '../process/env';

/** Keys merged from the user's login shell (spec 02 §6.1 "Shell environment resolution"). */
const MERGE_KEYS =
  /^(PATH|SSH_AUTH_SOCK|GNUPGHOME|https?_proxy|no_proxy|all_proxy|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|GIT_.*|NVM_.*)$/;

export function parseEnvNul(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of output.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export function pickShellEnv(shellEnv: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [k, v] of Object.entries(shellEnv)) if (MERGE_KEYS.test(k)) picked[k] = v;
  return picked;
}

/**
 * On macOS/Linux apps launched from the Dock/desktop miss the login-shell env
 * (PATH for hooks/npx, SSH_AUTH_SOCK, gpg). Spawn `$SHELL -ilc 'env -0'` once.
 * Windows returns `{}` (GUI apps inherit the full user env there).
 */
export async function resolveShellEnv(
  platform: NodeJS.Platform = process.platform,
  shell = process.env.SHELL,
  timeoutMs = 5000,
): Promise<Record<string, string>> {
  if (platform === 'win32' || !shell) return {};
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GITHAPPENS_RESOLVING_ENVIRONMENT: '1' },
      detached: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({});
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s: string) => (out += s));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(pickShellEnv(parseEnvNul(out)));
    });
  });
}

/** PATH lookup without spawning `where`/`which`. Honors PATHEXT on Windows. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (env[findPathKey(env)] ?? '').split(delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
