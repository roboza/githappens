import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shellKindOf, type ShellKind } from '../../shared/terminal/shell-quote';

/**
 * Shell integration (spec 12 §6.1): bash (`--rcfile`), zsh (`ZDOTDIR` shim) and PowerShell
 * (`-NoExit -Command`) load a small snippet that emits OSC 7 (cwd) and OSC 133 A/B/C/D (prompt
 * and command boundaries + exit code). The user's own startup files are still sourced first.
 * Anything else (cmd, fish, WSL, custom args) runs unmodified — the terminal then falls back to
 * idle heuristics.
 */

export const BASH_SCRIPT = `# GitHappens shell integration (bash): OSC 7 cwd + OSC 133 prompt/command marks.
if [ -n "$GITHAPPENS_SHELL_LOGIN" ]; then
  unset GITHAPPENS_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
  fi
else
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi
if [ -z "$__KL_SI_LOADED" ] && [[ $- == *i* ]]; then
  __KL_SI_LOADED=1
  __kl_in_cmd=
  __kl_ready=
  __kl_pre() {
    local ec=$?
    __kl_ready=
    if [ -n "$__kl_in_cmd" ]; then printf '\\033]133;D;%s\\007' "$ec"; fi
    __kl_in_cmd=
    printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "$PWD"
    return $ec
  }
  __kl_post() {
    case "$PS1" in
      *'133;B'*) ;;
      *) PS1='\\[\\033]133;A\\007\\]'"$PS1"'\\[\\033]133;B\\007\\]' ;;
    esac
    __kl_ready=1
  }
  __kl_start() {
    __kl_ready=
    __kl_in_cmd=1
    printf '\\033]133;C\\007'
  }
  __kl_debug() {
    [ -n "$COMP_LINE" ] && return
    [ -z "$__kl_ready" ] && return
    case "$BASH_COMMAND" in __kl_pre*) return ;; esac
    __kl_start
  }
  __kl_preexec() { __kl_start; }
  PROMPT_COMMAND=$'__kl_pre\\n'"$PROMPT_COMMAND"$'\\n__kl_post'
  if declare -F __bp_install >/dev/null 2>&1; then
    preexec_functions+=(__kl_preexec)
  elif [ -z "$(trap -p DEBUG)" ]; then
    trap '__kl_debug' DEBUG
  fi
fi
`;

/** `.zshenv` of the shim: sources the user's, keeping the shim active for `.zprofile` / `.zshrc`. */
export const ZSH_ENV = `# GitHappens shell integration (zsh shim)
__kl_shim="$ZDOTDIR"
ZDOTDIR="\${GITHAPPENS_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
GITHAPPENS_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__kl_shim"
`;

export const ZSH_PROFILE = `# GitHappens shell integration (zsh shim)
ZDOTDIR="$GITHAPPENS_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
GITHAPPENS_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__kl_shim"
`;

/** `.zshrc` of the shim: restores the user's ZDOTDIR (so `.zlogin` is theirs), then adds hooks. */
export const ZSH_RC = `# GitHappens shell integration (zsh shim)
ZDOTDIR="$GITHAPPENS_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
unset GITHAPPENS_USER_ZDOTDIR __kl_shim
if [[ -z "$__KL_SI_LOADED" && -o interactive ]]; then
  __KL_SI_LOADED=1
  __kl_in_cmd=
  __kl_precmd() {
    local ec=$?
    [[ -n "$__kl_in_cmd" ]] && printf '\\033]133;D;%s\\007' "$ec"
    __kl_in_cmd=
    printf '\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "$PWD"
  }
  __kl_prompt() {
    [[ "$PS1" == *'133;B'* ]] || PS1=$'%{\\033]133;A\\007%}'"$PS1"$'%{\\033]133;B\\007%}'
  }
  __kl_preexec() {
    __kl_in_cmd=1
    printf '\\033]133;C\\007'
  }
  precmd_functions=(__kl_precmd $precmd_functions __kl_prompt)
  preexec_functions+=(__kl_preexec)
fi
`;

/**
 * PowerShell (5.1 and 7): wraps the user's `prompt` (already defined by their profile). A new
 * history entry since the last prompt means a command ran → 133;D with its exit code.
 */
export const PWSH_SCRIPT = `# GitHappens shell integration (PowerShell): OSC 7 cwd + OSC 133 prompt/command marks.
if ($Global:__KlShellIntegration) { return }
$Global:__KlShellIntegration = $true
$Global:__KlLastHistoryId = -1
$Global:__KlFirstPrompt = $true
$Global:__KlOrigPrompt = $function:prompt
function Global:__KlOsc([string]$s) { "$([char]27)]$s$([char]7)" }
function Global:prompt {
  $ok = $global:?
  $ec = $global:LASTEXITCODE
  $out = ''
  $h = Get-History -Count 1
  if ($Global:__KlFirstPrompt) {
    $Global:__KlFirstPrompt = $false
    if ($h) { $Global:__KlLastHistoryId = $h.Id }
  } elseif ($h -and $h.Id -ne $Global:__KlLastHistoryId) {
    $Global:__KlLastHistoryId = $h.Id
    $code = if ($ok) { 0 } elseif ($ec -is [int] -and $ec -ne 0) { $ec } else { 1 }
    $out += __KlOsc "133;D;$code"
  }
  $loc = $executionContext.SessionState.Path.CurrentLocation
  if ($loc.Provider.Name -eq 'FileSystem') {
    $p = $loc.ProviderPath -replace '\\\\', '/'
    if (-not $p.StartsWith('/')) { $p = '/' + $p }
    $out += __KlOsc "7;file://$env:COMPUTERNAME$p"
  }
  $out += __KlOsc '133;A'
  if ($Global:__KlOrigPrompt) { $out += (& $Global:__KlOrigPrompt) -join '' } else { $out += "PS $loc> " }
  $out += __KlOsc '133;B'
  $global:LASTEXITCODE = $ec
  $out
}
`;

export interface ScriptFiles {
  bash: string;
  zshDir: string;
  pwsh: string;
}

/** Writes the scripts into `dir` (created if needed) and returns their paths. */
export function writeScripts(dir: string): ScriptFiles {
  const zshDir = path.join(dir, 'zsh');
  fs.mkdirSync(zshDir, { recursive: true, mode: 0o700 });
  const files: [string, string][] = [
    [path.join(dir, 'bash-integration.sh'), BASH_SCRIPT],
    [path.join(zshDir, '.zshenv'), ZSH_ENV],
    [path.join(zshDir, '.zprofile'), ZSH_PROFILE],
    [path.join(zshDir, '.zshrc'), ZSH_RC],
    [path.join(dir, 'pwsh-integration.ps1'), PWSH_SCRIPT],
  ];
  for (const [f, text] of files) fs.writeFileSync(f, text, { mode: 0o600 });
  return { bash: files[0]![0], zshDir, pwsh: files[4]![0] };
}

/**
 * A private (0700, unpredictable name) scripts folder for this process: a fixed path under a
 * shared temp dir could be pre-created by another user and would run their code in our shells.
 */
export function createScriptsDir(tmp: string = os.tmpdir()): ScriptFiles & { dir: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'githappens-si-'));
  return { dir, ...writeScripts(dir) };
}

export const scriptsHash = (): string =>
  crypto
    .createHash('sha1')
    .update(BASH_SCRIPT + ZSH_ENV + ZSH_PROFILE + ZSH_RC + PWSH_SCRIPT)
    .digest('hex')
    .slice(0, 8);

export interface IntegrationInput {
  shell: string;
  args: string[];
  /** The args are the shell's defaults (user-customised args are never rewritten). */
  defaultArgs: boolean;
  platform: NodeJS.Platform;
  env: Record<string, string>;
  scripts: ScriptFiles;
}

export interface IntegrationResult {
  args: string[];
  env: Record<string, string>;
  /** Integration was injected (else the spawn is unchanged). */
  injected: boolean;
  kind: ShellKind;
}

const isLoginArg = (a: string): boolean => a === '-l' || a === '--login';

/** Rewrites args / env so the shell loads our snippet; a no-op for unsupported shells or custom args. */
export function applyShellIntegration(i: IntegrationInput): IntegrationResult {
  const kind = shellKindOf(i.shell);
  const env = { ...i.env };
  const none: IntegrationResult = { args: i.args, env, injected: false, kind };
  if (!i.defaultArgs) return none;
  switch (kind) {
    case 'bash': {
      // `--rcfile` only applies to interactive non-login shells: emulate the login part in the script.
      if (i.args.some(isLoginArg)) env.GITHAPPENS_SHELL_LOGIN = '1';
      const rc = i.platform === 'win32' ? i.scripts.bash.replace(/\\/g, '/') : i.scripts.bash;
      return { args: ['--rcfile', rc, '-i'], env, injected: true, kind };
    }
    case 'zsh': {
      if (i.platform === 'win32') return none;
      env.GITHAPPENS_USER_ZDOTDIR = i.env.ZDOTDIR || i.env.HOME || os.homedir();
      env.ZDOTDIR = i.scripts.zshDir;
      return { args: i.args, env, injected: true, kind };
    }
    case 'pwsh': {
      if (i.args.some((a) => /^-(c|command|f|file|noexit|encodedcommand|ec)$/i.test(a))) return none;
      const p = i.scripts.pwsh.replace(/'/g, "''");
      // A script block from the file's text is not subject to the execution policy (a .ps1 would be).
      const cmd = `try { . ([ScriptBlock]::Create([IO.File]::ReadAllText('${p}'))) } catch {}`;
      return { args: [...i.args, '-NoExit', '-Command', cmd], env, injected: true, kind };
    }
    default:
      return none;
  }
}
