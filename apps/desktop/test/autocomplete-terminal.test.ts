import { suggestGit } from '@githappens/git/completions';
import { describe, expect, it } from 'vitest';

import {
  dropText,
  findPathLinks,
  joinPath,
  KeystrokeLine,
  pathsFromCwd,
  repoRelative,
} from '../src/renderer/src/views/terminal/terminal-helpers';
import {
  quoteArg,
  quoteCommandLine,
  quotePath,
  shellKindOf,
  toWslPath,
} from '../src/shared/terminal/shell-quote';

describe('shell quoting', () => {
  it('detects shell kinds', () => {
    expect(shellKindOf('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash');
    expect(shellKindOf('C:\\Windows\\System32\\bash.exe')).toBe('wsl');
    expect(shellKindOf('pwsh.exe')).toBe('pwsh');
    expect(shellKindOf('powershell')).toBe('pwsh');
    expect(shellKindOf('/usr/bin/fish')).toBe('fish');
    expect(shellKindOf(undefined)).toBe('other');
  });

  it('quotes per shell', () => {
    expect(quoteArg('src/a.ts', 'bash')).toBe('src/a.ts');
    expect(quoteArg("it's here", 'bash')).toBe(`'it'\\''s here'`);
    expect(quoteArg("it's here", 'zsh')).toBe(`'it'\\''s here'`);
    expect(quoteArg("it's \\x", 'fish')).toBe(`'it\\'s \\\\x'`);
    expect(quoteArg("C:\\it's here", 'pwsh')).toBe(`'C:\\it''s here'`);
    expect(quoteArg('C:\\plain\\x.txt', 'pwsh')).toBe('C:\\plain\\x.txt');
    expect(quoteArg('-dash', 'pwsh')).toBe(`'-dash'`);
    expect(quoteArg('C:\\a b&c', 'cmd')).toBe('"C:\\a b&c"');
    expect(quoteArg('', 'bash')).toBe(`''`);
  });

  it('translates WSL paths and builds command lines', () => {
    expect(toWslPath('C:\\Users\\me\\a b.txt')).toBe('/mnt/c/Users/me/a b.txt');
    expect(quotePath('D:\\x y', 'wsl')).toBe(`'/mnt/d/x y'`);
    expect(quoteCommandLine('claude', ['--model', 'x y'], 'bash')).toBe(`claude --model 'x y'`);
    expect(quoteCommandLine('C:\\Program Files\\x.exe', ['a'], 'pwsh')).toBe(
      `& 'C:\\Program Files\\x.exe' a`,
    );
    expect(dropText(['/tmp/a b', '/tmp/c'], 'bash')).toBe(`'/tmp/a b' /tmp/c `);
    expect(dropText([], 'bash')).toBe('');
  });
});

describe('path:line links', () => {
  it('finds path:line(:col) and path(line,col)', () => {
    const text = 'src/app.ts:12:5 error, see ./lib/x.cs(3,7) and C:\\r\\y.py:9 http://a.b/c.js:4 v1.2.3:4';
    const links = findPathLinks(text);
    expect(links.map((l) => [l.path, l.line, l.column])).toEqual([
      ['src/app.ts', 12, 5],
      ['./lib/x.cs', 3, 7],
      ['C:\\r\\y.py', 9, undefined],
    ]);
    expect(text.slice(links[0]!.start, links[0]!.end)).toBe('src/app.ts:12:5');
    expect(findPathLinks('no links here: foo.ts')).toEqual([]);
  });

  it('resolves repo-relative paths', () => {
    expect(joinPath('/r/sub', '../a/./b.ts')).toBe('/r/a/b.ts');
    expect(joinPath('C:\\r', 'x\\y.ts')).toBe('C:/r/x/y.ts');
    expect(repoRelative('src/a.ts', '/repo/pkg', '/repo')).toBe('pkg/src/a.ts');
    expect(repoRelative('/elsewhere/a.ts', '/repo', '/repo')).toBeNull();
    expect(repoRelative('C:\\Repo\\A.ts', 'c:\\other', 'c:\\repo')).toBe('A.ts');
    expect(pathsFromCwd(['pkg/a.ts', 'pkg/b/c.ts', 'top.ts'], '/repo/pkg', '/repo')).toEqual([
      'a.ts',
      'b/c.ts',
    ]);
    expect(pathsFromCwd(['a', 'b'], '/repo', '/repo')).toEqual(['a', 'b']);
  });
});

describe('input line fallback', () => {
  it('tracks typed text and gives up on cursor movement', () => {
    const k = new KeystrokeLine();
    for (const c of 'git sw') k.feed(c);
    k.feed('\x7f');
    expect(k.value).toBe('git s');
    k.feed('\x1b[A'); // history recall
    expect(k.value).toBeNull();
    k.feed('\r');
    expect(k.value).toBe('');
    k.feed('git add ');
    expect(k.value).toBe('git add ');
    k.feed('\t');
    expect(k.value).toBeNull();
    k.feed('\x03');
    expect(k.value).toBe('');
  });
});

describe('autocomplete sources', () => {
  it('combines aliases, refs from the repo store and WIP paths first', () => {
    const refs = ['main', 'feature/login', 'origin/main', 'v1.0.0'];
    const paths = ['src/changed.ts', 'src/other.ts'];
    expect(suggestGit('git checkout fea', { refs, paths }).map((i) => i.label)).toEqual(['feature/login']);
    expect(suggestGit('git restore src/', { refs, paths }).map((i) => i.label)).toEqual(paths);
    expect(
      suggestGit('git co', { aliases: [{ name: 'co', expansion: 'checkout' }] }).find(
        (i) => i.label === 'commit',
      ),
    ).toBeDefined();
    expect(suggestGit('git -C ../other switch ma', { refs }).map((i) => i.label)).toEqual(['main']);
    // real generated table
    expect(suggestGit('git commit --am').map((i) => i.label)).toContain('--amend');
    expect(suggestGit('echo git ')).toEqual([]);
  });
});
