import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TerminalCompletionContext } from '../../shared/ipc/terminal-contract';

/**
 * Main-side inputs of the terminal git autocomplete (spec 12 §4.3 / §6.2): the repo's git aliases
 * and detection of completion tools that fight over the same keystrokes (Fig / Amazon Q /
 * Kiro-style inline completion layers). Refs and paths come from the renderer's repo store.
 */

/** Runs `git args` in `cwd`; resolves stdout, or null when git failed / is missing. */
export type GitReader = (args: string[], cwd: string) => Promise<string | null>;

export const pathGitReader: GitReader = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });

/** Parses `git config -z --get-regexp ^alias\.` (`alias.<name>\n<value>\0` records). */
export function parseAliases(out: string): { name: string; expansion: string }[] {
  const res: { name: string; expansion: string }[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? '' : rec.slice(nl + 1);
    if (!key.toLowerCase().startsWith('alias.')) continue;
    const name = key.slice('alias.'.length);
    if (name && !res.some((a) => a.name === name)) res.push({ name, expansion: value });
  }
  return res;
}

export interface ConflictProbe {
  env: NodeJS.ProcessEnv;
  home: string;
  exists(p: string): boolean;
}

/** Heuristic: env markers and install folders of shell completion overlays. */
export function detectCompletionConflict(p: ConflictProbe): string | null {
  const e = p.env;
  if (e.FIG_TERM || e.FIG_PID || e.FIGTERM_SESSION_ID || /fig/i.test(e.TERM_PROGRAM ?? ''))
    return 'Fig shell completion is active';
  if (e.Q_TERM || e.QTERM_SESSION_ID || e.Q_SET_PARENT_CHECK)
    return 'Amazon Q (CodeWhisperer) shell completion is active';
  if (e.KIRO_TERM || e.KIRO_SESSION_ID) return 'Kiro shell completion is active';
  if (p.exists(path.join(p.home, '.fig', 'bin'))) return 'Fig is installed (~/.fig)';
  if (
    p.exists(path.join(p.home, '.local', 'share', 'amazon-q', 'shell')) ||
    p.exists(path.join(p.home, 'Library', 'Application Support', 'amazon-q', 'shell'))
  )
    return 'Amazon Q shell integration is installed';
  return null;
}

export interface CompletionContextOptions {
  git?: GitReader;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?(p: string): boolean;
  /** Alias cache lifetime in ms (default 30 s). */
  ttlMs?: number;
  now?: () => number;
}

/** Cached per cwd; aliases change rarely and the popup asks on every `git ` line. */
export function createCompletionContextProvider(
  o: CompletionContextOptions = {},
): (cwd: string) => Promise<TerminalCompletionContext> {
  const git = o.git ?? pathGitReader;
  const ttl = o.ttlMs ?? 30_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; value: TerminalCompletionContext }>();
  const conflict = detectCompletionConflict({
    env: o.env ?? process.env,
    home: o.home ?? os.homedir(),
    exists:
      o.exists ??
      ((p) => {
        try {
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      }),
  });
  return async (cwd) => {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ttl) return hit.value;
    const out = await git(['config', '-z', '--get-regexp', '^alias\\.'], cwd);
    const value: TerminalCompletionContext = { aliases: out ? parseAliases(out) : [], conflict };
    cache.set(cwd, { at: now(), value });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return value;
  };
}
