import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `GIT_SSH_COMMAND` construction (spec 09 §6.7, spec 13 SSH section).
 *
 * Git runs `GIT_SSH_COMMAND` through its own POSIX shell (`sh -c` — Git for Windows ships one), so every
 * value is POSIX single-quoted on all platforms. Windows paths are written with forward slashes, which both
 * the bundled MSYS ssh and Windows OpenSSH accept.
 *
 * Modes:
 * - **Key file** (`ssh.privateKeyPath`, agent off): `ssh -i '<key>' -o IdentitiesOnly=yes`.
 * - **Local agent**, macOS/Linux: no `GIT_SSH_COMMAND`; ssh uses `SSH_AUTH_SOCK` from the resolved shell env.
 * - **Local agent**, Windows + OpenSSH agent: Windows' own `System32\OpenSSH\ssh.exe` (the bundled MSYS ssh
 *   cannot reach the `\\.\pipe\openssh-ssh-agent` pipe). `SSH_AUTH_SOCK` is removed so an MSYS socket from
 *   a login shell can't shadow the pipe.
 * - **Local agent**, Windows + Pageant: Windows OpenSSH with `-o IdentityAgent=//./pipe/pageant.<user>.<hash>`
 *   (Pageant ≥ 0.75 serves the OpenSSH agent protocol on that pipe; verified with Win32-OpenSSH 9.5).
 *   plink is not used: it can't route host-key prompts through askpass.
 * - `ssh.useSshConfig` off adds `-F none` (no config files; supported by OpenSSH ≥ 7 incl. Win32-OpenSSH).
 */

export interface SshPrefs {
  useLocalAgent: boolean;
  privateKeyPath: string;
  useSshConfig: boolean;
  windowsAgent: 'openssh' | 'pageant';
}

export interface SshHostInfo {
  platform: NodeJS.Platform;
  homedir: string;
  /** Windows OpenSSH client (`%SystemRoot%\System32\OpenSSH\ssh.exe`) if present. */
  windowsSsh: string | null;
  /** Named pipes matching an agent (Windows); null when listing is unavailable. */
  agentPipes: { openssh: boolean; pageant: string | null } | null;
  /** HOME/USERPROFILE of the app process (MSYS ssh reads `%HOME%/.ssh`). */
  env: NodeJS.ProcessEnv;
}

export interface SshInvocation {
  /** Env additions for git; `null` removes a variable. */
  env: Record<string, string | null>;
  /** The ssh flavour that will run (for status display). */
  client: 'default' | 'windows-openssh';
  /** The same command as argv, for running ssh directly (Test connection); `exe: null` = `ssh` on PATH. */
  argv: { exe: string | null; args: string[] };
  /** Effective mode. */
  mode: 'key' | 'agent' | 'default';
  warnings: string[];
}

/** POSIX single-quote one argument for the `sh -c` git uses to run GIT_SSH_COMMAND. */
export function shQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Expand a leading `~` and normalize for the target platform's ssh (forward slashes on Windows). */
export function sshPath(p: string, host: Pick<SshHostInfo, 'platform' | 'homedir'>): string {
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = host.homedir + out.slice(1);
  return host.platform === 'win32' ? out.replace(/\\/g, '/') : out;
}

/** Reject values that ssh would read as options or that can't be a path. */
function validKeyPath(p: string): boolean {
  return !!p && !p.startsWith('-') && !/[\0\r\n]/.test(p);
}

export function buildSshInvocation(prefs: SshPrefs, host: SshHostInfo): SshInvocation {
  const env: Record<string, string | null> = {};
  const warnings: string[] = [];
  const win = host.platform === 'win32';
  // Both ssh flavours on Windows should share ~/.ssh (known_hosts, keys) — spec 09 §8.
  if (win && !host.env.HOME && host.env.USERPROFILE) env.HOME = host.env.USERPROFILE;

  const configArgs = prefs.useSshConfig ? [] : ['-F', 'none'];
  const command = (exe: string, args: string[]): string => [exe, ...args].map(shQuote).join(' ');

  if (prefs.useLocalAgent) {
    if (!win) {
      if (!host.env.SSH_AUTH_SOCK) warnings.push('SSH_AUTH_SOCK is not set; is ssh-agent running?');
      if (configArgs.length) env.GIT_SSH_COMMAND = command('ssh', configArgs);
      return { env, client: 'default', argv: { exe: null, args: configArgs }, mode: 'agent', warnings };
    }
    if (!host.windowsSsh) {
      warnings.push(
        'Windows OpenSSH (ssh.exe) was not found; install the "OpenSSH Client" optional feature to use the agent.',
      );
      if (configArgs.length) env.GIT_SSH_COMMAND = command('ssh', configArgs);
      return { env, client: 'default', argv: { exe: null, args: configArgs }, mode: 'agent', warnings };
    }
    const exe = host.windowsSsh.replace(/\\/g, '/');
    const args = [...configArgs];
    if (prefs.windowsAgent === 'pageant') {
      const pipe = host.agentPipes?.pageant;
      if (pipe) args.push('-o', `IdentityAgent=//./pipe/${pipe}`);
      else warnings.push('Pageant is not running (no pageant named pipe found).');
    } else if (host.agentPipes && !host.agentPipes.openssh) {
      warnings.push(
        'The OpenSSH Authentication Agent service is not running. Start it in Services (ssh-agent) and add your key with ssh-add.',
      );
    }
    env.SSH_AUTH_SOCK = null;
    env.GIT_SSH_COMMAND = command(exe, args);
    return { env, client: 'windows-openssh', argv: { exe: host.windowsSsh, args }, mode: 'agent', warnings };
  }

  const key = prefs.privateKeyPath.trim();
  if (key) {
    if (!validKeyPath(key)) {
      warnings.push('The SSH private key path is invalid and was ignored.');
    } else {
      const args = [...configArgs, '-i', sshPath(key, host), '-o', 'IdentitiesOnly=yes'];
      env.GIT_SSH_COMMAND = command('ssh', args);
      return { env, client: 'default', argv: { exe: null, args }, mode: 'key', warnings };
    }
  }
  if (configArgs.length) env.GIT_SSH_COMMAND = command('ssh', configArgs);
  return { env, client: 'default', argv: { exe: null, args: configArgs }, mode: 'default', warnings };
}

// ---- host probing ----------------------------------------------------------------------------

const PIPE_DIR = '//./pipe/';

/** Agent pipes on Windows (`openssh-ssh-agent`, `pageant.<user>.<hash>`); null elsewhere or on error. */
export function listAgentPipes(
  platform: NodeJS.Platform = process.platform,
  readdir: (dir: string) => string[] = (d) => fs.readdirSync(d),
): SshHostInfo['agentPipes'] {
  if (platform !== 'win32') return null;
  try {
    const names = readdir(PIPE_DIR);
    const user = (os.userInfo().username || '').toLowerCase();
    const pageants = names.filter((n) => n.toLowerCase().startsWith('pageant.'));
    const pageant =
      pageants.find((n) => n.toLowerCase().startsWith(`pageant.${user}.`)) ?? pageants[0] ?? null;
    return { openssh: names.some((n) => n.toLowerCase() === 'openssh-ssh-agent'), pageant };
  } catch {
    return null;
  }
}

export function windowsOpenSshDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'OpenSSH');
}

/** Probe the current machine (cheap; cache the result for a few seconds — it runs per git spawn). */
export function probeSshHost(env: NodeJS.ProcessEnv = process.env): SshHostInfo {
  const platform = process.platform;
  let windowsSsh: string | null = null;
  if (platform === 'win32') {
    const p = path.win32.join(windowsOpenSshDir(env), 'ssh.exe');
    windowsSsh = fs.existsSync(p) ? p : null;
  }
  return {
    platform,
    homedir: os.homedir(),
    windowsSsh,
    agentPipes: listAgentPipes(platform),
    env,
  };
}
