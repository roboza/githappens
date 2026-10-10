import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findOnPath } from '@githappens/git';

import { windowsOpenSshDir } from './ssh-command';

export type SshToolName = 'ssh' | 'ssh-keygen';

export interface LocateOptions {
  platform?: NodeJS.Platform;
  /** Bundled portable git (dugite layout). It ships `usr/bin/ssh.exe` but not `ssh-keygen` on Windows. */
  bundledGitDir?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/**
 * Find an OpenSSH tool. Windows: bundled git's `usr/bin`, Git for Windows' `usr/bin`, Windows OpenSSH
 * (`System32\OpenSSH`), then PATH. Elsewhere: PATH (bundled git on macOS/Linux has no ssh).
 */
export function locateSshTool(name: SshToolName, o: LocateOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  if (platform === 'win32') {
    const exe = `${name}.exe`;
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const candidates = [
      o.bundledGitDir && path.win32.join(o.bundledGitDir, 'usr', 'bin', exe),
      path.win32.join(pf, 'Git', 'usr', 'bin', exe),
      path.win32.join(windowsOpenSshDir(env), exe),
    ].filter((c): c is string => !!c);
    for (const c of candidates) if (exists(c)) return c;
  }
  return findOnPath(name, env, platform) ?? null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a tool with argv only (never a shell). Resolves on exit, including non-zero codes. */
export function execTool(
  file: string,
  args: string[],
  o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        env: o.env,
        cwd: o.cwd,
        timeout: o.timeoutMs ?? 30_000,
        windowsHide: true,
        shell: false,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const e = err as
          (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const timedOut = !!e?.killed && e.signal === 'SIGTERM';
        const exitCode = e ? (typeof e.code === 'number' ? e.code : (child.exitCode ?? -1)) : 0;
        resolve({
          exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || (e && typeof e.code === 'string' ? e.message : '')),
          timedOut,
        });
      },
    );
    child.stdin?.end();
  });
}
