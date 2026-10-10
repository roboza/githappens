import { GitError, makeError } from '@githappens/git';

import { splitArgs } from '../../shared/settings/external-tools';
import type { ToolKind } from '../../shared/ipc/tools-contract';
import type { LineStyle } from './catalog';
import { envVar, existingFile, findExe, pathFor, type ToolEnv } from './env';

/**
 * Launch construction for external tools (spec 12 §6.10): always an argv array, never a shell string built from
 * paths. Windows `.cmd` / `.bat` shims (VS Code's `code.cmd`, JetBrains Toolbox scripts) can only run through
 * cmd.exe, so their arguments are checked for anything cmd would interpret and refused instead of escaped.
 */

export interface Launch {
  file: string;
  args: string[];
  /** Pass the command line to CreateProcess untouched (the cmd.exe shim case). */
  verbatim?: boolean;
}

const NOT_FOUND: Record<ToolKind, string> = {
  editor: 'Editor not found — configure in Preferences',
  terminal: 'Terminal not found — configure in Preferences',
  diff: 'Diff tool not found — configure in Preferences',
  merge: 'Merge tool not found — configure in Preferences',
};

/** A "configure it in Preferences" error the renderer can recognise (`details.toolNotFound`). */
export function toolNotFound(kind: ToolKind, detail?: string): GitError {
  return new GitError(
    makeError('Unknown', { argv: [] }, detail ? `${NOT_FOUND[kind]} (${detail})` : NOT_FOUND[kind], {
      toolNotFound: kind,
    }),
  );
}

export function toolError(message: string): GitError {
  return new GitError(makeError('Unknown', { argv: [] }, message));
}

/** cmd.exe re-parses `.cmd` / `.bat` arguments; refuse anything it would interpret, even inside quotes. */
export const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

/**
 * Resolve `argv[0]` (PATH / PATHEXT lookup unless it is a path) and wrap Windows batch shims as
 * `cmd.exe /d /s /c ""shim" "arg" …"` with metacharacter-free arguments.
 */
export function resolveLaunch(argv: readonly string[], e: ToolEnv, kind: ToolKind): Launch {
  const [cmd, ...args] = argv;
  const resolved = resolveExe(cmd, e, kind);
  if (e.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    if ([resolved, ...args].some((a) => CMD_UNSAFE.test(a))) {
      throw toolError(
        `Cannot pass this path safely to ${pathFor('win32').basename(resolved)} (it contains characters such as & % ! ^ or quotes). Configure the tool's .exe instead of its .cmd script.`,
      );
    }
    const comspec = envVar(e, 'ComSpec') ?? 'cmd.exe';
    const line = [resolved, ...args].map((a) => `"${a}"`).join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: resolved, args };
}

/** `cmd` as given (a path, checked) or looked up on PATH / PATHEXT. */
export function resolveExe(cmd: string | undefined, e: ToolEnv, kind: ToolKind): string {
  if (!cmd) throw toolNotFound(kind);
  const resolved = /[\\/]/.test(cmd) ? existingFile(cmd, e) : findExe(cmd, e);
  if (!resolved) throw toolNotFound(kind, cmd);
  return resolved;
}

/**
 * Windows console programs (PowerShell, cmd, custom terminal commands) need a console window of their own, which a
 * detached process does not get: run `cmd /d /s /c "start "" "exe" "arg"…"` with the directory as the spawn `cwd`
 * (spec 12 §6.10). Arguments are refused, not escaped, when cmd would interpret them.
 */
export function windowsStartLaunch(resolvedExe: string, args: readonly string[], e: ToolEnv): Launch {
  if ([resolvedExe, ...args].some((a) => CMD_UNSAFE.test(a))) {
    throw toolError(
      'Cannot start this terminal safely: the command contains characters such as & % ! ^ or quotes.',
    );
  }
  const comspec = envVar(e, 'ComSpec') ?? 'cmd.exe';
  const line = [resolvedExe, ...args].map((a) => `"${a}"`).join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"start "" ${line}"`], verbatim: true };
}

/** Editor argv after the executable: VS Code `-g file:line`, JetBrains `--line N file`, Sublime/Zed `file:line`. */
export function editorArgs(style: LineStyle, file: string, line?: number): string[] {
  const n = line && Number.isInteger(line) && line > 0 ? line : undefined;
  if (!n) return [file];
  switch (style) {
    case 'goto':
      return ['-g', `${file}:${n}`];
    case 'colon':
      return [`${file}:${n}`];
    case 'jetbrains':
      return ['--line', String(n), file];
    default:
      return [file];
  }
}

/** A terminal launch: argv plus the working directory the process starts in. */
export interface TerminalLaunch {
  argv: string[];
  cwd: string;
}

/**
 * Terminal argv for a detected terminal (spec 12 §6.10). Where a terminal has no directory flag the process is
 * simply started with `cwd` set — the directory is never interpolated into a command string.
 */
export function terminalArgv(
  id: string,
  exe: string,
  cwd: string,
  platform: NodeJS.Platform,
): TerminalLaunch {
  if (platform === 'darwin' && /\.app$/i.test(exe)) return { argv: ['/usr/bin/open', '-a', exe, cwd], cwd };
  switch (id) {
    case 'windows-terminal':
      return { argv: [exe, '-d', cwd], cwd };
    case 'powershell':
      return { argv: [exe, '-NoExit'], cwd };
    case 'cmd':
      return { argv: [exe, '/K'], cwd };
    case 'git-bash':
      return { argv: [exe, `--cd=${cwd}`], cwd };
    case 'gnome-terminal':
      return { argv: [exe, `--working-directory=${cwd}`], cwd };
    case 'konsole':
      return { argv: [exe, '--workdir', cwd], cwd };
    case 'kitty':
      return { argv: [exe, '--directory', cwd], cwd };
    case 'alacritty':
      return { argv: [exe, '--working-directory', cwd], cwd };
    case 'ghostty':
      return { argv: [exe, `--working-directory=${cwd}`], cwd };
    default:
      return { argv: [exe], cwd };
  }
}

/** `tools.terminalCommand`: split like a shell (quotes only), `%d` → the directory inside any word. */
export function customTerminalArgv(template: string, cwd: string): TerminalLaunch {
  const words = splitArgs(template.trim());
  if (!words.length) throw toolNotFound('terminal', 'the custom terminal command is empty');
  return { argv: words.map((w) => w.split('%d').join(cwd)), cwd };
}
