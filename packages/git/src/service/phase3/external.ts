import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath } from '../../locator/shell-env';
import type { GitService } from '../git-service';
import { stagesOf, worktreePath } from './load';
import { gitFail, hasConflictMarkers, rawBlob } from './shared';

/**
 * Split a command template into argv like a shell would for quoting purposes only: whitespace separates
 * words, `"…"` and `'…'` group, and (outside Windows) a backslash escapes the next character. Nothing is
 * expanded, so substituted paths can never inject arguments (spec 08 §6.8 "no shell").
 */
export function splitCommandTemplate(
  template: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && platform !== 'win32' && /["\\$`]/.test(template[i + 1] ?? '')) {
        cur += template[++i];
      } else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else if (c === '\\' && platform !== 'win32' && i + 1 < template.length) {
      cur += template[++i];
      inWord = true;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw gitFail('Unbalanced quote in the merge tool command.');
  if (inWord) out.push(cur);
  return out;
}

/** Replace `$BASE` `$LOCAL` `$REMOTE` `$MERGED` (also `${NAME}`) inside one argv word. */
export function substituteVars(word: string, vars: Record<string, string>): string {
  return word.replace(
    /\$(?:\{(BASE|LOCAL|REMOTE|MERGED)\}|(BASE|LOCAL|REMOTE|MERGED)\b)/g,
    (_m, a, b) => vars[a ?? b] ?? '',
  );
}

function hashFile(p: string): string | null {
  try {
    return createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function resolveCommand(cmd: string): string {
  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return cmd;
  return findOnPath(cmd) ?? cmd;
}

const winQuote = (a: string): string => `"${a}"`;
/** cmd.exe re-parses `.cmd` / `.bat` command lines; refuse anything it would interpret, even inside quotes. */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

function run(argv: string[], cwd: string): Promise<number | null> {
  const exe = resolveCommand(argv[0]!);
  const args = argv.slice(1);
  if (
    process.platform === 'win32' &&
    /\.(cmd|bat)$/i.test(exe) &&
    [exe, ...args].some((a) => CMD_UNSAFE.test(a))
  ) {
    return Promise.reject(gitFail(`Cannot pass these arguments safely to ${path.basename(exe)}.`));
  }
  return new Promise((resolve, reject) => {
    // .cmd/.bat shims (e.g. VS Code's `code`) can only run through cmd.exe: quote every argument
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    const child = viaCmd
      ? spawn(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${[exe, ...args].map(winQuote).join(' ')}"`],
          {
            cwd,
            windowsHide: false,
            windowsVerbatimArguments: true,
            stdio: 'ignore',
          },
        )
      : spawn(exe, args, { cwd, shell: false, windowsHide: false, stdio: 'ignore' });
    child.once('error', (e) => reject(gitFail(`Could not start the merge tool "${argv[0]}": ${e.message}`)));
    child.once('close', (code) => resolve(code));
  });
}

export type MergeToolVars = Record<'BASE' | 'LOCAL' | 'REMOTE' | 'MERGED', string>;

export interface ExternalMergeResult {
  /** Tool exit code; null when it was killed or the wait was cancelled. */
  exitCode: number | null;
  /** The worktree file's bytes changed while the tool ran. */
  changed: boolean;
  hasMarkers: boolean;
  /** `<file>.orig` written before the tool ran (only with `keepBackup`). */
  backupPath?: string;
}

export interface ExternalMergeOptions {
  /** Runs argv and resolves with the exit code. Default: spawn without a shell and wait for exit. */
  launch?: (argv: string[], cwd: string) => Promise<number | null>;
  /** Keep the conflicted worktree file as `<file>.orig` (git's `mergetool.keepBackup`). */
  keepBackup?: boolean;
}

/**
 * `conflict:openExternal`, strategy B (spec 08 §6.8): write the BASE/LOCAL/REMOTE stages to temp files,
 * substitute `$BASE $LOCAL $REMOTE $MERGED` into the template's words, spawn the tool without a shell and
 * wait. `changed` compares the worktree file before/after; the caller decides whether to `git add`.
 */
export async function openExternalMergeTool(
  service: GitService,
  file: string,
  commandTemplate: string,
  o: ExternalMergeOptions = {},
): Promise<ExternalMergeResult> {
  const words = splitCommandTemplate(commandTemplate.trim());
  if (!words.length) throw gitFail('The merge tool command is empty.');
  return openExternalMergeToolArgv(service, file, (vars) => words.map((w) => substituteVars(w, vars)), o);
}

/** Strategy B with a caller-built argv (presets / detected executables; spec 08 §6.8). */
export async function openExternalMergeToolArgv(
  service: GitService,
  file: string,
  buildArgv: (vars: MergeToolVars) => string[],
  o: ExternalMergeOptions = {},
): Promise<ExternalMergeResult> {
  const merged = worktreePath(service, file);
  const stages = await stagesOf(service, file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mergetool-'));
  const ext = path.extname(file);
  const stem = path.basename(file, ext) || 'file';
  const id = randomUUID().slice(0, 6);
  const tmp = (side: string): string => path.join(dir, `${stem}_${side}_${id}${ext}`);
  try {
    const vars: MergeToolVars = { MERGED: merged, BASE: '', LOCAL: '', REMOTE: '' };
    for (const [side, key] of [
      ['BASE', 'base'],
      ['LOCAL', 'ours'],
      ['REMOTE', 'theirs'],
    ] as const) {
      const st = stages[key];
      const buf = st && st.mode !== '160000' ? await rawBlob(service, st.sha) : Buffer.alloc(0);
      fs.writeFileSync(tmp(side), buf);
      vars[side] = tmp(side);
    }
    const argv = buildArgv(vars);
    if (!argv.length || !argv[0]) throw gitFail('The merge tool command is empty.');
    let backupPath: string | undefined;
    if (o.keepBackup && fs.existsSync(merged)) {
      backupPath = `${merged}.orig`;
      fs.copyFileSync(merged, backupPath);
    }
    const before = hashFile(merged);
    const exitCode = await (o.launch ?? run)(argv, service.repo.worktreeRoot!);
    const after = hashFile(merged);
    let hasMarkers = false;
    try {
      hasMarkers = hasConflictMarkers(fs.readFileSync(merged, 'utf8'));
    } catch {
      /* tool deleted the file */
    }
    return { exitCode, changed: before !== after, hasMarkers, ...(backupPath ? { backupPath } : {}) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
