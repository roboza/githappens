import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { CliInstallResult, CliInstallStatus } from '../../shared/ipc/repos2-contract';

/**
 * `githappens` shell command (spec 03 §7 step 4, spec 15 §6.4). The app writes a launcher script into
 * `<userData>/bin` and then, with the user's consent:
 *  - macOS: symlinks `/usr/local/bin/githappens` to it (permission denied → we show the `sudo ln` command);
 *  - Linux: symlinks `~/.local/bin/githappens` to it;
 *  - Windows: appends `<userData>\bin` to the *user* PATH (`HKCU\Environment`, via `reg.exe`, argv only).
 *    Running terminals keep their old environment (no WM_SETTINGCHANGE broadcast without native code).
 * The launcher forwards `.`, `<path>`, `-p <path>`, `--path <path>`, `--path=<path>` to the app, which
 * parses them in the first instance or via `second-instance` (`services/cli-args.ts`).
 */

export const CLI_NAME = 'githappens';

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** POSIX launcher: makes path arguments absolute (the app may already run with another cwd) and detaches. */
export function posixLauncher(exe: string, appArgs: string[] = []): string {
  const fixed = [exe, ...appArgs].map(shQuote).join(' ');
  return posixScript('GitHappens command-line launcher', '', fixed);
}

/**
 * Launcher shipped inside Linux packages at `resources/bin/githappens` (`build/bin/githappens`); deb/rpm
 * link `/usr/bin/githappens` to it (build/linux/after-install.sh). It finds the app binary relative to
 * itself, following the /usr/bin → /etc/alternatives → /opt/… symlink chain.
 */
export function packagedPosixLauncher(): string {
  const setup = [
    `self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")`,
    `exe="$(cd "$(dirname "$self")/../.." && pwd)/${CLI_NAME}"`,
    '',
  ].join('\n');
  return posixScript('GitHappens command-line launcher (installed by the deb/rpm package)', setup, '"$exe"');
}

/**
 * `resources\bin\githappens.cmd` shipped with the Windows installer (`build/bin/githappens.cmd`); NSIS adds
 * that directory to the user PATH (build/installer.nsh). `%~dp0` is the script's own directory.
 */
export function packagedWindowsLauncher(): string {
  return [
    '@echo off',
    'rem GitHappens command-line launcher (on the user PATH via the installer):',
    'rem githappens [.|<path>] [-p|--path <path>] [--path=<path>]',
    'start "" "%~dp0..\\..\\GitHappens.exe" %*',
    '',
  ].join('\r\n');
}

/** Files in `build/bin` (extraResources → `resources/bin`); test/cli-shims.test.ts keeps them in sync. */
export const PACKAGED_SHIMS: Readonly<Record<string, () => string>> = {
  [CLI_NAME]: packagedPosixLauncher,
  [`${CLI_NAME}.cmd`]: packagedWindowsLauncher,
};

/** Shared POSIX launcher body: `setup` locates the app, `command` is the quoted app invocation. */
function posixScript(title: string, setup: string, command: string): string {
  return `#!/bin/sh
# ${title}: githappens [.|<path>] [-p|--path <path>] [--path=<path>]
${setup}abs() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}
n=$#
expect=0
while [ "$n" -gt 0 ]; do
  a=$1
  shift
  n=$((n - 1))
  if [ "$expect" = 1 ]; then
    a=$(abs "$a")
    expect=0
  else
    case "$a" in
      -p | --path) expect=1 ;;
      --path=*) a="--path=$(abs "\${a#--path=}")" ;;
      -*) ;;
      *) a=$(abs "$a") ;;
    esac
  fi
  set -- "$@" "$a"
done
if [ -n "$GITHAPPENS_CLI_FOREGROUND" ]; then
  exec ${command} "$@"
fi
nohup ${command} "$@" >/dev/null 2>&1 &
`;
}

/** Windows launcher (`githappens.cmd`): `start` detaches the GUI process; relative paths resolve against the inherited cwd. */
export function windowsLauncher(exe: string, appArgs: string[] = []): string {
  const fixed = [exe, ...appArgs].map((a) => `"${a.replace(/"/g, '')}"`).join(' ');
  return [
    '@echo off',
    'rem GitHappens command-line launcher: githappens [.|<path>] [-p|--path <path>] [--path=<path>]',
    `start "" ${fixed} %*`,
    '',
  ].join('\r\n');
}

/** `reg query HKCU\Environment /v Path` output → the value and its type. */
export function parseRegQuery(out: string): { type: string; value: string } | null {
  const m = /^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/im.exec(out);
  return m ? { type: m[1]!, value: m[2]!.trim() } : null;
}

/** PATH value with `dir` appended (case-insensitive, trailing-slash-insensitive dedupe). */
export function withPathEntry(current: string, dir: string): { value: string; changed: boolean } {
  const norm = (s: string): string =>
    s
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  const parts = current.split(';').filter((p) => p.trim());
  if (parts.some((p) => norm(p) === norm(dir))) return { value: current, changed: false };
  return { value: [...parts, dir].join(';'), changed: true };
}

export interface CliInstallerDeps {
  platform: NodeJS.Platform;
  /** The app executable (process.execPath). */
  exe: string;
  /** Extra leading args (dev: the app directory for electron). */
  appArgs?: string[];
  userDataDir: string;
  homeDir: string;
  /** Run a program with argv (no shell). */
  run?(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

const defaultRun: NonNullable<CliInstallerDeps['run']> = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({
        code: err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
  });

export class CliInstaller {
  private readonly run: NonNullable<CliInstallerDeps['run']>;

  constructor(private readonly d: CliInstallerDeps) {
    this.run = d.run ?? defaultRun;
  }

  get binDir(): string {
    return path.join(this.d.userDataDir, 'bin');
  }

  get shimPath(): string {
    return path.join(this.binDir, this.d.platform === 'win32' ? `${CLI_NAME}.cmd` : CLI_NAME);
  }

  get target(): string {
    if (this.d.platform === 'win32') return this.binDir;
    if (this.d.platform === 'darwin') return `/usr/local/bin/${CLI_NAME}`;
    return path.join(this.d.homeDir, '.local', 'bin', CLI_NAME);
  }

  private description(): string {
    switch (this.d.platform) {
      case 'win32':
        return `Writes ${this.shimPath} and adds ${this.binDir} to your user PATH (HKCU\\Environment).`;
      case 'darwin':
        return `Writes ${this.shimPath} and links ${this.target} to it.`;
      default:
        return `Writes ${this.shimPath} and links ${this.target} to it (make sure ~/.local/bin is on your PATH).`;
    }
  }

  private async userPath(): Promise<{ type: string; value: string } | null> {
    const r = await this.run('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']);
    return r.code === 0 ? parseRegQuery(r.stdout) : null;
  }

  async status(): Promise<CliInstallStatus> {
    let installed: boolean;
    try {
      if (this.d.platform === 'win32') {
        const p = await this.userPath();
        installed = fs.existsSync(this.shimPath) && !!p && !withPathEntry(p.value, this.binDir).changed;
      } else {
        installed =
          fs.lstatSync(this.target).isSymbolicLink() && fs.readlinkSync(this.target) === this.shimPath;
      }
    } catch {
      installed = false;
    }
    return {
      platform: this.d.platform,
      installed,
      shimPath: this.shimPath,
      target: this.target,
      description: this.description(),
    };
  }

  /** Write (or refresh) the launcher script. */
  writeShim(): string {
    fs.mkdirSync(this.binDir, { recursive: true });
    const text =
      this.d.platform === 'win32'
        ? windowsLauncher(this.d.exe, this.d.appArgs)
        : posixLauncher(this.d.exe, this.d.appArgs);
    fs.writeFileSync(this.shimPath, text, { mode: 0o755 });
    if (this.d.platform !== 'win32') fs.chmodSync(this.shimPath, 0o755);
    return this.shimPath;
  }

  /** Install after the renderer got the user's consent. */
  async install(): Promise<CliInstallResult> {
    this.writeShim();
    if (this.d.platform === 'win32') return this.installWindows();
    return this.installSymlink();
  }

  private async installWindows(): Promise<CliInstallResult> {
    const current = await this.userPath();
    const { value, changed } = withPathEntry(current?.value ?? '', this.binDir);
    if (!changed) return { ok: true, message: `${CLI_NAME} is already on your PATH.` };
    const r = await this.run('reg.exe', [
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      current?.type ?? 'REG_EXPAND_SZ',
      '/d',
      value,
      '/f',
    ]);
    if (r.code !== 0) {
      return {
        ok: false,
        message: `Could not update your PATH: ${r.stderr.trim() || `reg.exe exited with ${r.code}`}`,
        manualCommand: `Add "${this.binDir}" to your user PATH (System Properties › Environment Variables).`,
      };
    }
    return {
      ok: true,
      restartTerminals: true,
      message: `Added ${this.binDir} to your user PATH. Open a new terminal (or restart it) to use \`${CLI_NAME} .\`.`,
    };
  }

  private installSymlink(): CliInstallResult {
    const target = this.target;
    const manual =
      this.d.platform === 'darwin'
        ? `sudo mkdir -p /usr/local/bin && sudo ln -sf ${shQuote(this.shimPath)} ${shQuote(target)}`
        : `mkdir -p ~/.local/bin && ln -sf ${shQuote(this.shimPath)} ${shQuote(target)}`;
    try {
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(target);
      } catch {
        st = null;
      }
      if (st && !st.isSymbolicLink()) {
        return {
          ok: false,
          message: `${target} already exists and is not a link created by GitHappens. Remove it first.`,
          manualCommand: manual,
        };
      }
      if (this.d.platform !== 'darwin') fs.mkdirSync(path.dirname(target), { recursive: true });
      if (st) fs.unlinkSync(target);
      fs.symlinkSync(this.shimPath, target);
      const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(path.dirname(target));
      return {
        ok: true,
        message: onPath
          ? `Installed. Run \`${CLI_NAME} .\` in a repository to open it.`
          : `Installed ${target}. Add ${path.dirname(target)} to your PATH to use \`${CLI_NAME}\`.`,
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
        return {
          ok: false,
          message: `Permission denied while creating ${target}. Run this command in a terminal:`,
          manualCommand: manual,
        };
      }
      throw e;
    }
  }
}
