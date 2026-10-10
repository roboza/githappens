/**
 * Shell families and argument quoting for the integrated terminal (spec 12 §4.2): drag-and-drop
 * inserts shell-quoted paths, and agent sessions type their setup / agent command lines into the
 * user's shell. Pure (no Node / DOM) so both processes share it.
 */

export type ShellKind = 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'cmd' | 'wsl' | 'other';

const base = (shell: string): string =>
  (shell.replace(/\\/g, '/').split('/').pop() ?? shell).replace(/\.exe$/i, '').toLowerCase();

/** Shell family of an executable path (`C:\…\pwsh.exe`, `/bin/zsh`, `wsl.exe`). */
export function shellKindOf(shell: string | undefined): ShellKind {
  if (!shell) return 'other';
  const b = base(shell);
  if (b === 'bash') {
    // System32\bash.exe is the WSL launcher, not Git Bash.
    return /[\\/]system32[\\/]bash(\.exe)?$/i.test(shell) ? 'wsl' : 'bash';
  }
  if (b === 'zsh') return 'zsh';
  if (b === 'sh' || b === 'dash' || b === 'ksh' || b === 'mksh' || b === 'ash') return 'sh';
  if (b === 'fish') return 'fish';
  if (b === 'pwsh' || b === 'powershell') return 'pwsh';
  if (b === 'cmd') return 'cmd';
  if (b === 'wsl') return 'wsl';
  return 'other';
}

/** Chars that never need quoting in any POSIX shell. */
const POSIX_SAFE = /^[A-Za-z0-9_\-.,:/@%+=]+$/;
const PWSH_SAFE = /^[A-Za-z0-9_\-.:/\\]+$/;
const CMD_SAFE = /^[A-Za-z0-9_\-.:\\/]+$/;

/** `C:\Users\me` → `/mnt/c/Users/me` (WSL); other paths only get forward slashes. */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  const rest = m[2]!.replace(/\\/g, '/');
  return `/mnt/${m[1]!.toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Quotes one argument for `kind` so the shell passes it through literally. */
export function quoteArg(arg: string, kind: ShellKind): string {
  switch (kind) {
    case 'pwsh':
      if (arg && PWSH_SAFE.test(arg) && !/^[-@#]/.test(arg)) return arg;
      // Single-quoted strings: only quote chars (incl. typographic ones PowerShell honours) need doubling.
      return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
    case 'cmd':
      if (arg && CMD_SAFE.test(arg)) return arg;
      // cmd has no escape inside quotes; `"` cannot occur in Windows file names. `%` / `!` stay literal
      // only when no such variable exists — the best cmd.exe allows.
      return `"${arg.replace(/"/g, '""')}"`;
    case 'fish':
      if (arg && POSIX_SAFE.test(arg)) return arg;
      return `'${arg.replace(/[\\']/g, (c) => `\\${c}`)}'`;
    default:
      if (arg && POSIX_SAFE.test(arg)) return arg;
      return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
}

/** Shell-quoted path for drag-and-drop insertion (WSL paths are translated to `/mnt/<drive>`). */
export function quotePath(p: string, kind: ShellKind): string {
  return quoteArg(kind === 'wsl' ? toWslPath(p) : p, kind);
}

/** A command line that runs `command args…` in `kind` (PowerShell needs `&` for a quoted command). */
export function quoteCommandLine(command: string, args: readonly string[], kind: ShellKind): string {
  const cmd = quoteArg(command, kind);
  const parts = [cmd, ...args.map((a) => quoteArg(a, kind))];
  if (kind === 'pwsh' && cmd.startsWith("'")) parts.unshift('&');
  return parts.join(' ');
}
