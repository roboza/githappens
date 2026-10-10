import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { TerminalShell } from '../../shared/ipc/terminal-contract';

/**
 * Shell detection for the terminal's shell picker (spec 12 §4.2, `pty:listShells`): PowerShell 7,
 * Windows PowerShell, cmd, Git Bash and every WSL distro on Windows; `/etc/shells` plus `$SHELL`
 * elsewhere. Only existing executables are listed.
 */

export interface ShellProbeEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  findOnPath(exe: string): string | null;
  isFile(p: string): boolean;
  readFile(p: string): string | null;
  /** Installed WSL distro names (`wsl.exe -l -q`); empty when WSL is absent. */
  wslDistros(): Promise<string[]>;
}

const nameOf = (p: string): string =>
  path
    .basename(p.replace(/\\/g, '/'))
    .replace(/\.exe$/i, '')
    .toLowerCase();

/** `wsl.exe -l -q` prints UTF-16LE (with NULs / BOM on some builds); returns the distro names. */
export function parseWslList(out: Buffer | string): string[] {
  const text =
    typeof out === 'string'
      ? out
      : out.length >= 2 && out[1] === 0
        ? out.toString('utf16le')
        : out.toString('utf8');
  return text
    .replace(/\0/g, '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^windows subsystem for linux/i.test(l));
}

export async function detectShells(e: ShellProbeEnv): Promise<TerminalShell[]> {
  const out: TerminalShell[] = [];
  const seen = new Set<string>();
  const add = (s: TerminalShell): void => {
    const key = `${s.path.toLowerCase()}\0${(s.args ?? []).join('\0')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  if (e.platform === 'win32') {
    const pf = e.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = e.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = e.env.LOCALAPPDATA;
    const sysRoot = e.env.SystemRoot ?? e.env.SYSTEMROOT ?? 'C:\\Windows';
    const first = (cands: (string | null | undefined)[]): string | null =>
      cands.find((c): c is string => !!c && e.isFile(c)) ?? null;

    const pwsh = first([e.findOnPath('pwsh.exe'), path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe')]);
    if (pwsh) add({ id: 'pwsh', name: 'PowerShell 7', path: pwsh });
    const winPs = first([
      path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      e.findOnPath('powershell.exe'),
    ]);
    if (winPs) add({ id: 'powershell', name: 'Windows PowerShell', path: winPs });
    const cmd = first([e.env.ComSpec ?? e.env.COMSPEC, path.win32.join(sysRoot, 'System32', 'cmd.exe')]);
    if (cmd) add({ id: 'cmd', name: 'Command Prompt', path: cmd });

    // Git Bash: next to the git on PATH (<git>\cmd\git.exe → <git>\bin\bash.exe) or a standard install.
    const git = e.findOnPath('git.exe');
    const gitRoot = git ? path.win32.dirname(path.win32.dirname(git)) : null;
    const bash = first([
      gitRoot && path.win32.join(gitRoot, 'bin', 'bash.exe'),
      path.win32.join(pf, 'Git', 'bin', 'bash.exe'),
      path.win32.join(pf86, 'Git', 'bin', 'bash.exe'),
      local && path.win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
    ]);
    if (bash) add({ id: 'git-bash', name: 'Git Bash', path: bash, args: ['--login', '-i'] });

    const wsl = first([path.win32.join(sysRoot, 'System32', 'wsl.exe'), e.findOnPath('wsl.exe')]);
    if (wsl) {
      const distros = await e.wslDistros().catch(() => [] as string[]);
      if (!distros.length) add({ id: 'wsl', name: 'WSL', path: wsl });
      for (const d of distros) add({ id: `wsl:${d}`, name: `WSL: ${d}`, path: wsl, args: ['-d', d] });
    }
    return out;
  }

  const listed = (e.readFile('/etc/shells') ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'));
  const login = e.env.SHELL;
  for (const p of [login, ...listed]) {
    if (!p || !e.isFile(p)) continue;
    const n = nameOf(p);
    if (n === 'nologin' || n === 'false') continue;
    // /etc/shells often lists /bin/bash and /usr/bin/bash (same shell on merged-/usr systems).
    if (out.some((s) => s.name === n && realpathOr(s.path) === realpathOr(p))) continue;
    add({ id: p, name: n, path: p });
  }
  return out;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Real-system probe for `detectShells`. */
export function systemShellProbe(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  findOnPath: (exe: string) => string | null,
): ShellProbeEnv {
  return {
    platform,
    env,
    findOnPath,
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    wslDistros: () =>
      new Promise((resolve) => {
        execFile(
          'wsl.exe',
          ['-l', '-q'],
          { encoding: 'buffer', timeout: 4000, windowsHide: true },
          (err, stdout) => resolve(err ? [] : parseWslList(stdout)),
        );
      }),
  };
}
