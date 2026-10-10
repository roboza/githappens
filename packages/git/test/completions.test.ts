import { describe, expect, it } from 'vitest';

import { generate, parseHelperOutput } from '../scripts/gen-completions';
import {
  completionTable,
  parseGitLine,
  suggestGit,
  tokenize,
  type CompletionTable,
} from '../src/completions';
import { describeGit, gitPath } from './ops-harness';

const table: CompletionTable = {
  gitVersion: 'test',
  commands: {
    status: { description: 'Show the working tree status', flags: ['--short', '--branch', '-s'] },
    stash: { flags: ['-u', '--message='], subcommands: ['push', 'pop', 'list'] },
    switch: { flags: ['--create=', '--detach', '-c'] },
    checkout: { flags: ['--track', '-b'] },
    commit: { flags: ['--amend', '--message=', '-m'], negations: ['--no-verify', '--no-edit'] },
    add: { flags: ['--patch', '-p'] },
    stage: { flags: [] },
  },
};

describe('tokenize', () => {
  it('handles quotes, escapes and trailing space', () => {
    const r = tokenize(`git commit -m "fix: a \\"b\\"" 'x y'\\ z `);
    expect(r.tokens.map((t) => t.value)).toEqual(['git', 'commit', '-m', 'fix: a "b"', 'x y z']);
    expect(r.trailingSpace).toBe(true);
  });
  it('reports an open quote on the last token', () => {
    const r = tokenize(`git add "my fi`);
    expect(r.tokens.at(-1)).toMatchObject({ value: 'my fi', openQuote: '"', start: 8 });
    expect(r.trailingSpace).toBe(false);
  });
  it('keeps --opt=value together and resets after ; && |', () => {
    expect(tokenize('ls && git log --author=me').tokens.map((t) => t.value)).toEqual([
      'git',
      'log',
      '--author=me',
    ]);
  });
});

describe('parseGitLine', () => {
  it('needs `git ` and skips global options', () => {
    expect(parseGitLine('git')).toBeNull();
    expect(parseGitLine('npm run')).toBeNull();
    expect(parseGitLine('git ')).toMatchObject({ atSubcommand: true, prefix: '' });
    expect(parseGitLine('git -C "my dir" sw')).toMatchObject({ atSubcommand: true, prefix: 'sw' });
    expect(parseGitLine('git -C ')).toBeNull(); // typing the -C value
    expect(parseGitLine('GIT_TRACE=1 git -c a=b --no-pager log --one')).toMatchObject({
      subcommand: 'log',
      prefix: '--one',
    });
    expect(parseGitLine('git checkout -- sr')).toMatchObject({
      subcommand: 'checkout',
      afterDoubleDash: true,
    });
  });
});

describe('suggestGit', () => {
  it('suggests subcommands and aliases with descriptions', () => {
    const r = suggestGit('git st', {
      table,
      aliases: [
        { name: 'st', expansion: 'status -sb' },
        { name: 'sync', expansion: '!git pull && git push' },
      ],
    });
    expect(r.map((i) => i.label)).toEqual(['stage', 'stash', 'status']);
    expect(r.find((i) => i.label === 'status')).toMatchObject({ insert: 'atus', deleteBefore: 0 });
    expect(
      suggestGit('git s', { table, aliases: [{ name: 'sy', expansion: 'status' }] }).find(
        (i) => i.label === 'sy',
      ),
    ).toMatchObject({ kind: 'alias' });
    expect(suggestGit('git ', { table }).length).toBeLessThanOrEqual(8);
  });

  it('suggests flags, negations only after --no, nothing while typing a value', () => {
    expect(suggestGit('git commit --am', { table }).map((i) => i.label)).toEqual(['--amend']);
    expect(suggestGit('git commit --no', { table }).map((i) => i.label)).toEqual([
      '--no-edit',
      '--no-verify',
    ]);
    expect(suggestGit('git commit --message=x', { table })).toEqual([]);
    expect(suggestGit('git status -', { table }).map((i) => i.label)[0]).toBe('-s');
  });

  it('resolves aliases; shell aliases get no hints', () => {
    const aliases = [
      { name: 'st', expansion: 'status -sb' },
      { name: 'sync', expansion: '!git pull' },
    ];
    expect(suggestGit('git st --br', { table, aliases }).map((i) => i.label)).toEqual(['--branch']);
    expect(suggestGit('git sync --', { table, aliases })).toEqual([]);
  });

  it('offers sub-subcommands, refs and changed paths', () => {
    expect(suggestGit('git stash p', { table }).map((i) => i.label)).toEqual(['push', 'pop']);
    const refs = ['main', 'feature/x', 'origin/main', 'v1.0'];
    expect(suggestGit('git switch fe', { table, refs }).map((i) => i.label)).toEqual(['feature/x']);
    const paths = ['src/a.ts', 'src/My File.ts', 'README.md'];
    expect(suggestGit('git add src/', { table, refs, paths }).map((i) => i.label)).toEqual([
      'src/a.ts',
      'src/My File.ts',
    ]);
    // a path needing quotes replaces the typed token
    expect(suggestGit('git add src/M', { table, paths })[0]).toEqual({
      label: 'src/My File.ts',
      insert: `'src/My File.ts'`,
      deleteBefore: 5,
      kind: 'path',
    });
    // inside an open quote the remainder is typed as-is
    expect(suggestGit('git add "src/M', { table, paths })[0]).toMatchObject({
      insert: 'y File.ts',
      deleteBefore: 0,
    });
    // checkout: refs, then paths after --
    expect(suggestGit('git checkout -- R', { table, refs, paths }).map((i) => i.label)).toEqual([
      'README.md',
    ]);
    // case-insensitive path fallback
    expect(suggestGit('git add readme', { table, paths })[0]).toMatchObject({
      label: 'README.md',
      insert: 'README.md',
      deleteBefore: 6,
    });
  });

  it('caps the list at 8 items', () => {
    const refs = Array.from({ length: 20 }, (_, i) => `b${i}`);
    expect(suggestGit('git switch b', { table, refs })).toHaveLength(8);
  });
});

describe('completions.json', () => {
  it('is generated for the porcelain set with flags and descriptions', () => {
    const c = completionTable.commands;
    for (const cmd of ['add', 'commit', 'checkout', 'switch', 'rebase', 'push', 'status', 'stash', 'log'])
      expect(c[cmd], cmd).toBeDefined();
    expect(c.commit!.flags).toContain('--amend');
    expect(c.commit!.flags).toContain('-m');
    expect(c.commit!.negations).toContain('--no-edit');
    expect(c.status!.description).toBeTruthy();
    expect(c.gui).toBeUndefined();
  });

  it('parses --git-completion-helper output', () => {
    expect(parseHelperOutput('--quiet --file= -- --no-quiet --no-file\n')).toEqual({
      flags: ['--quiet', '--file='],
      negations: ['--no-quiet', '--no-file'],
    });
    expect(parseHelperOutput('')).toEqual({ flags: [], negations: [] });
  });
});

describeGit('gen-completions against a real git', () => {
  it('produces flags for core commands', () => {
    const t = generate(gitPath!);
    expect(t.gitVersion).toMatch(/^\d+\.\d+/);
    expect(t.commands.commit!.flags).toContain('--amend');
    expect(t.commands.switch!.flags.some((f) => f.startsWith('--create'))).toBe(true);
    expect(Object.keys(t.commands).length).toBeGreaterThan(30);
  });
});
