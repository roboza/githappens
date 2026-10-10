/**
 * Build-time generator for the terminal git autocomplete table (spec 12 §4.3 / §6.2).
 *
 *   pnpm --filter @githappens/git gen:completions            # bundled git (dugite) if present
 *   GITHAPPENS_GIT=/path/to/git pnpm --filter @githappens/git gen:completions
 *
 * Runs `git <cmd> --git-completion-helper` (the option list git ships for its bash completion)
 * for every porcelain command and writes `src/completions.json`. The generated file is committed;
 * re-run it when the bundled git is upgraded.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CompletionTable } from '../src/completions';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

/** Hand-written descriptions (git's own one-line summaries, shortened). */
export const DESCRIPTIONS: Record<string, string> = {
  add: 'Add file contents to the index',
  am: 'Apply a series of patches from a mailbox',
  archive: 'Create an archive of files from a tree',
  bisect: 'Find the commit that introduced a bug',
  blame: 'Show who last changed each line of a file',
  branch: 'List, create, or delete branches',
  bundle: 'Move objects and refs by archive',
  'cherry-pick': 'Apply the changes of existing commits',
  checkout: 'Switch branches or restore files',
  clean: 'Remove untracked files',
  clone: 'Clone a repository into a new directory',
  commit: 'Record changes to the repository',
  config: 'Get and set repository or global options',
  describe: 'Name a commit from the most recent tag',
  diff: 'Show changes between commits, index and worktree',
  fetch: 'Download objects and refs from a remote',
  'format-patch': 'Prepare patches for e-mail submission',
  gc: 'Clean up and optimize the repository',
  grep: 'Print lines matching a pattern',
  init: 'Create an empty Git repository',
  log: 'Show commit logs',
  maintenance: 'Run tasks to optimize repository data',
  merge: 'Join two or more development histories',
  mv: 'Move or rename a file or directory',
  notes: 'Add or inspect object notes',
  pull: 'Fetch and integrate with another branch',
  push: 'Update remote refs and their objects',
  'range-diff': 'Compare two commit ranges',
  rebase: 'Reapply commits on top of another base',
  reflog: 'Manage reflog information',
  remote: 'Manage tracked repositories',
  reset: 'Reset current HEAD to the specified state',
  restore: 'Restore working tree files',
  revert: 'Revert some existing commits',
  rm: 'Remove files from the worktree and the index',
  shortlog: "Summarize 'git log' output",
  show: 'Show various types of objects',
  'sparse-checkout': 'Reduce the worktree to a subset of files',
  stash: 'Stash the changes in a dirty working directory',
  status: 'Show the working tree status',
  submodule: 'Initialize, update or inspect submodules',
  switch: 'Switch branches',
  tag: 'Create, list, delete or verify tags',
  worktree: 'Manage multiple working trees',
  'rev-parse': 'Pick out and massage parameters',
  'ls-files': 'Show information about files in the index',
  'cat-file': 'Show content or type of repository objects',
  'merge-base': 'Find common ancestors for a merge',
  cherry: 'Find commits yet to be applied upstream',
  lfs: 'Git Large File Storage',
};

/** Short options and revision options that `--git-completion-helper` does not list. */
export const EXTRA_FLAGS: Record<string, string[]> = {
  add: ['-A', '-p', '-u', '-f', '-n', '-N'],
  branch: ['-a', '-d', '-D', '-m', '-M', '-r', '-u', '-v', '-vv', '-c'],
  checkout: ['-b', '-B', '-f', '-p', '-q', '-t'],
  'cherry-pick': ['-n', '-x', '-e', '-m', '--continue', '--abort', '--skip', '--quit'],
  clean: ['-d', '-f', '-n', '-x', '-X', '-i'],
  commit: ['-a', '-m', '-p', '-s', '-S', '-v', '-n', '-C', '-c', '-F', '-e', '-q'],
  diff: [
    '--cached',
    '--staged',
    '--stat',
    '--name-only',
    '--name-status',
    '--word-diff',
    '--color-words',
    '--check',
    '-w',
    '-p',
    '-U',
  ],
  fetch: ['-p', '-t', '-v', '-q'],
  log: [
    '--oneline',
    '--graph',
    '--all',
    '--stat',
    '--patch',
    '--follow',
    '--reverse',
    '--first-parent',
    '--no-merges',
    '--merges',
    '--author=',
    '--committer=',
    '--grep=',
    '--since=',
    '--until=',
    '--pretty=',
    '--format=',
    '--name-only',
    '--name-status',
    '--date=',
    '-n',
    '-p',
    '-S',
    '-G',
  ],
  merge: ['--continue', '--abort', '--quit', '-m', '-s', '-X', '-n', '-q', '-v'],
  pull: ['-r', '-v', '-q'],
  push: ['-u', '-f', '-d', '-n', '-v', '-q'],
  rebase: ['-i', '--continue', '--abort', '--skip', '--quit', '--edit-todo', '-x', '-s', '-X', '-q', '-v'],
  reset: ['-p', '-q', '-N'],
  restore: ['-s', '-p', '-W', '-S', '-q'],
  revert: ['-n', '-e', '-m', '--continue', '--abort', '--skip', '--quit'],
  rm: ['-r', '-f', '-n', '-q'],
  show: ['--stat', '--name-only', '--name-status', '--oneline', '--format=', '--pretty=', '-s', '-p', '-w'],
  stash: [
    'push',
    'pop',
    'apply',
    'drop',
    'list',
    'show',
    'branch',
    'clear',
    'create',
    'store',
    '-u',
    '-a',
    '-m',
    '-p',
    '-k',
    '-S',
  ],
  status: ['-s', '-b', '-u', '-v', '-z'],
  switch: ['-c', '-C', '-d', '-f', '-m', '-t', '-q'],
  tag: ['-a', '-d', '-f', '-l', '-m', '-n', '-s', '-u', '-v', '-F'],
  worktree: ['add', 'list', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'],
  remote: ['add', 'remove', 'rename', 'show', 'prune', 'get-url', 'set-url', 'set-head', 'update', '-v'],
  submodule: [
    'add',
    'status',
    'init',
    'deinit',
    'update',
    'set-branch',
    'set-url',
    'summary',
    'foreach',
    'sync',
    'absorbgitdirs',
  ],
  bisect: [
    'start',
    'bad',
    'good',
    'new',
    'old',
    'terms',
    'skip',
    'reset',
    'visualize',
    'replay',
    'log',
    'run',
  ],
  notes: ['list', 'add', 'copy', 'append', 'edit', 'show', 'merge', 'remove', 'prune', 'get-ref'],
  'sparse-checkout': ['init', 'list', 'set', 'add', 'reapply', 'disable', 'check-rules'],
  maintenance: ['run', 'start', 'stop', 'register', 'unregister'],
  reflog: ['show', 'expire', 'delete', 'exists'],
  config: [
    '--global',
    '--local',
    '--system',
    '--worktree',
    '--file',
    '--list',
    '--get',
    '--get-all',
    '--get-regexp',
    '--unset',
    '--unset-all',
    '--add',
    '--edit',
    '-l',
    '-e',
  ],
};

/** Commands offered as the first token besides the porcelain list. */
const ALSO: string[] = [
  'config',
  'remote',
  'reflog',
  'blame',
  'cherry',
  'rev-parse',
  'ls-files',
  'cat-file',
  'merge-base',
  'lfs',
];
/** Porcelain entries that are GUI launchers, not useful in a terminal popup. */
const SKIP = new Set(['citool', 'gui', 'gitk', 'scalar', 'survey']);

function resolveGit(): string {
  if (process.env.GITHAPPENS_GIT) return process.env.GITHAPPENS_GIT;
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const p of [
    path.join(repoRoot, 'apps', 'desktop', 'node_modules', 'dugite', 'git', 'cmd', exe),
    path.join(repoRoot, 'apps', 'desktop', 'node_modules', 'dugite', 'git', 'bin', exe),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return 'git';
}

function run(git: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(git, args, {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      // completion helpers need no repository; keep user config out of the generated table
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(pkgRoot, '.no-gitconfig'),
      },
      timeout: 15_000,
    });
  } catch {
    return null;
  }
}

/** Splits helper output into flags and their `--no-…` negations (listed after the `--` marker). */
export function parseHelperOutput(out: string): { flags: string[]; negations: string[] } {
  const words = out.split(/\s+/).filter(Boolean);
  const cut = words.indexOf('--');
  const flags = cut < 0 ? words : words.slice(0, cut);
  const negations = cut < 0 ? [] : words.slice(cut + 1);
  return { flags, negations };
}

export function generate(git: string): CompletionTable {
  const version = (run(git, ['--version']) ?? '').trim().replace(/^git version\s*/, '');
  const listed = (run(git, ['--list-cmds=list-mainporcelain']) ?? '').split(/\s+/).filter(Boolean);
  const names = [...new Set([...listed, ...ALSO])].filter((n) => !SKIP.has(n)).sort();
  const commands: CompletionTable['commands'] = {};
  // Some commands (commit, switch, …) need a repository even for --git-completion-helper. Use a fresh
  // one we own: the surrounding checkout may be refused as "dubious ownership" (CI containers), and
  // the isolated config above drops any safe.directory exemption.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-completions-'));
  run(git, ['init', '-q'], scratch);
  try {
    for (const name of names) {
      const out = run(git, [name, '--git-completion-helper'], scratch);
      const { flags, negations } = parseHelperOutput(out ?? '');
      const extra = EXTRA_FLAGS[name] ?? [];
      const all = [...new Set([...extra.filter((f) => f.startsWith('-')), ...flags])];
      const subcommands = extra.filter((f) => !f.startsWith('-'));
      commands[name] = {
        ...(DESCRIPTIONS[name] ? { description: DESCRIPTIONS[name] } : {}),
        flags: all,
        ...(negations.length ? { negations } : {}),
        ...(subcommands.length ? { subcommands } : {}),
      };
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
  return { gitVersion: version, commands };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const git = resolveGit();
  const table = generate(git);
  const out = path.join(pkgRoot, 'src', 'completions.json');
  fs.writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(table.commands).length} commands (git ${table.gitVersion}) to ${out}`);
}
