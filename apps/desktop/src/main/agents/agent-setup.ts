import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ShellEvent } from '../terminal/osc';

/**
 * Per-repo agent setup commands (spec 12 §4.12, spec 13 `RepoSettings.agentSetupCommands`).
 * Stored in the repo's git config as the multi-valued key `githappens.agentSetup`; run once per
 * worktree, visibly, by typing them into the new agent tab's shell before the agent command.
 * Nothing runs hidden: the user configured the commands and sees each one execute.
 */

export const AGENT_SETUP_KEY = 'githappens.agentSetup';

/** `git args` in `cwd` → exit code + stdout (`code` -1 when git could not run). */
export type GitExec = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const pathGitExec: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : -1
          : 0;
        resolve({ code, stdout: stdout ?? '' });
      },
    );
  });

/** Normalises user input: one command per non-empty line, trimmed. */
export function normalizeSetupCommands(commands: readonly string[]): string[] {
  return commands
    .flatMap((c) => c.split(/\r?\n/))
    .map((c) => c.trim())
    .filter(Boolean);
}

export async function readSetupCommands(git: GitExec, repoPath: string): Promise<string[]> {
  const r = await git(['config', '-z', '--get-all', AGENT_SETUP_KEY], repoPath);
  if (r.code === 1) return []; // key not set
  if (r.code !== 0) throw new Error('Could not read the agent setup commands (is this a git repository?)');
  return r.stdout.split('\0').filter((c) => c.trim());
}

export async function writeSetupCommands(
  git: GitExec,
  repoPath: string,
  commands: readonly string[],
): Promise<string[]> {
  const list = normalizeSetupCommands(commands);
  const unset = await git(['config', '--local', '--unset-all', AGENT_SETUP_KEY], repoPath);
  // 5 = key not present: nothing to remove.
  if (unset.code !== 0 && unset.code !== 5) throw new Error('Could not update the agent setup commands');
  for (const c of list) {
    const r = await git(['config', '--local', '--add', AGENT_SETUP_KEY, c], repoPath);
    if (r.code !== 0) throw new Error('Could not save the agent setup commands');
  }
  return list;
}

const hashOf = (commands: readonly string[]): string =>
  crypto.createHash('sha1').update(commands.join('\n')).digest('hex');

/** Marker `<worktree git dir>/githappens/agent-setup` holding the hash of the commands that ran. */
async function markerPath(git: GitExec, worktree: string): Promise<string | null> {
  const r = await git(['rev-parse', '--absolute-git-dir'], worktree);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return path.join(r.stdout.trim(), 'githappens', 'agent-setup');
}

/** True when these exact commands already ran in this worktree. */
export async function setupAlreadyRan(
  git: GitExec,
  worktree: string,
  commands: readonly string[],
): Promise<boolean> {
  const p = await markerPath(git, worktree);
  if (!p) return false;
  try {
    return fs.readFileSync(p, 'utf8').trim() === hashOf(commands);
  } catch {
    return false;
  }
}

export async function markSetupRan(
  git: GitExec,
  worktree: string,
  commands: readonly string[],
): Promise<void> {
  const p = await markerPath(git, worktree);
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${hashOf(commands)}\n`);
  } catch {
    // best effort: the commands will just run again next time
  }
}

// ---- sequencing ----

/** The pty side of a setup run (PtyService in production, a fake in tests). */
export interface SetupTerminal {
  write(data: string): void;
  onShellEvent(listener: (e: ShellEvent) => void): () => void;
  /** Shell integration was injected: OSC 133 marks are expected. */
  integrated: boolean;
}

export interface SetupRunResult {
  /** All setup commands succeeded and the agent command was typed. */
  ok: boolean;
  /** Index of the failed setup command (non-zero exit). */
  failedAt?: number;
  exitCode?: number;
}

export interface SetupRunOptions {
  /** Max wait for the first prompt (default 15 s); afterwards typing starts anyway. */
  promptTimeoutMs?: number;
  /** Max wait per command when the shell is integrated (default: none). */
  commandTimeoutMs?: number;
  /** Line terminator typed after each command (default CR, like the Enter key). */
  enter?: string;
}

/**
 * Types `setup` commands, then `agentLine`, into the shell. With shell integration each command
 * waits for its OSC 133;D and a non-zero exit stops the sequence (the agent is not started);
 * without it the lines are typed ahead and the shell runs them in order.
 */
export function runSetupSequence(
  t: SetupTerminal,
  setup: readonly string[],
  agentLine: string,
  o: SetupRunOptions = {},
): Promise<SetupRunResult> {
  const enter = o.enter ?? '\r';
  if (!t.integrated) {
    // No prompt marks: wait for the shell's first output (its prompt) is not observable either;
    // type-ahead is buffered by the tty and read by the shell in order.
    for (const c of setup) t.write(c + enter);
    t.write(agentLine + enter);
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    let step = -1; // -1: waiting for the first prompt
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (r: SetupRunResult): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsub();
      resolve(r);
    };
    const arm = (ms: number | undefined, onTimeout: () => void): void => {
      if (timer) clearTimeout(timer);
      timer = ms ? setTimeout(onTimeout, ms) : null;
    };
    const next = (): void => {
      step++;
      if (step < setup.length) {
        t.write(setup[step]! + enter);
        arm(o.commandTimeoutMs, () => finish({ ok: false, failedAt: step }));
        return;
      }
      t.write(agentLine + enter);
      finish({ ok: true });
    };
    const unsub = t.onShellEvent((e) => {
      if (done) return;
      if (step < 0) {
        if (e.kind === 'promptEnd' || e.kind === 'promptStart') next();
        return;
      }
      if (e.kind === 'commandEnd') {
        if (e.exitCode !== undefined && e.exitCode !== 0) {
          finish({ ok: false, failedAt: step, exitCode: e.exitCode });
          return;
        }
        next();
      }
    });
    arm(o.promptTimeoutMs ?? 15_000, () => {
      if (step < 0) next();
    });
  });
}
