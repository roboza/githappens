import type { RefInfo, RemoteInfo } from '@githappens/git/types';
import type { ListPage, RemoteRepo, RepoRef } from '@githappens/providers/types';
import { describe, expect, it } from 'vitest';

import {
  forkChoices,
  groupRemotes,
  normalizeRemoteUrl,
  parseShallowFlags,
  remoteWebUrl,
  splitRemoteBranch,
  suggestRemoteName,
  validateRemoteName,
  validateRemoteUrl,
} from '../src/renderer/src/views/remotes/remote-model';

const remote = (name: string, fetchUrl: string, pushUrl = fetchUrl): RemoteInfo => ({
  name,
  fetchUrl,
  pushUrl,
  fetchRefspecs: [`+refs/heads/*:refs/remotes/${name}/*`],
});
const rref = (short: string, extra: Partial<RefInfo> = {}): RefInfo => ({
  fullName: `refs/remotes/${short}`,
  shortName: short,
  type: 'remote',
  sha: 'b'.repeat(40),
  isHead: false,
  ...extra,
});

describe('remote name / URL validation', () => {
  it('validates names as one refname component', () => {
    expect(validateRemoteName('upstream', ['origin'])).toBeNull();
    expect(validateRemoteName('', [])).toMatch(/Enter/);
    expect(validateRemoteName('origin', ['origin'])).toMatch(/already exists/);
    expect(validateRemoteName('origin', ['origin'], 'origin')).toBeNull(); // editing, unchanged
    for (const bad of [
      'a b',
      'a/b',
      '-x',
      '.x',
      'x.',
      'x.lock',
      'a..b',
      'a:b',
      'a@{b',
      'a~1',
      'a^',
      'a*',
      'a?',
      'a[b',
    ])
      expect(validateRemoteName(bad, []), bad).toMatch(/not a valid/);
  });

  it('accepts https / ssh / scp / local URLs and rejects junk', () => {
    for (const ok of [
      'https://github.com/acme/api.git',
      'http://host:8080/x',
      'ssh://git@github.com:22/acme/api.git',
      'git@github.com:acme/api.git',
      'host:path/repo',
      'file:///tmp/repo',
      '/srv/git/repo.git',
      '../sibling',
      'C:\\repos\\x',
    ])
      expect(validateRemoteUrl(ok), ok).toBeNull();
    expect(validateRemoteUrl('')).toMatch(/Enter/);
    expect(validateRemoteUrl('', true)).toBeNull();
    expect(validateRemoteUrl('--upload-pack=evil')).toMatch(/start/);
    expect(validateRemoteUrl('https://x/y z')).toMatch(/spaces/);
    expect(validateRemoteUrl('just-words')).toMatch(/URL like/);
  });

  it('validates shallow fetch flags against the allowlist', () => {
    expect(parseShallowFlags(' --no-tags  --filter=blob:none ')).toEqual({
      flags: ['--no-tags', '--filter=blob:none'],
    });
    expect(parseShallowFlags('')).toEqual({ flags: [] });
    expect(parseShallowFlags('--upload-pack=x')).toHaveProperty('error');
  });
});

describe('remote URL helpers', () => {
  it('normalizes URLs across protocols', () => {
    const want = 'github.com/acme/api';
    for (const u of [
      'https://github.com/acme/api.git',
      'https://user:tok@github.com/acme/api/',
      'git@github.com:acme/api.git',
      'ssh://git@GitHub.com:22/acme/API',
    ])
      expect(normalizeRemoteUrl(u), u).toBe(want);
  });

  it('derives provider web URLs ("Open on provider")', () => {
    expect(remoteWebUrl('git@github.com:acme/api.git')).toBe('https://github.com/acme/api');
    expect(remoteWebUrl('https://tok@gitlab.com/g/sub/p.git')).toBe('https://gitlab.com/g/sub/p');
    expect(remoteWebUrl('ssh://git@bitbucket.org:22/ws/repo.git')).toBe('https://bitbucket.org/ws/repo');
    expect(remoteWebUrl('git@ssh.dev.azure.com:v3/org/proj/repo')).toBe(
      'https://dev.azure.com/org/proj/_git/repo',
    );
    expect(remoteWebUrl('/srv/git/repo.git')).toBeNull();
    expect(remoteWebUrl('C:\\repos\\x')).toBeNull();
  });
});

describe('fork picker (fake integration)', () => {
  const integration = { kind: 'github' as const, host: 'github.com' };
  const repo = (owner: string, extra: Partial<RemoteRepo> = {}): RemoteRepo => ({
    ref: { integration, owner, name: 'api' } as RepoRef,
    fullName: `${owner}/api`,
    isPrivate: false,
    isFork: true,
    defaultBranch: 'main',
    httpsUrl: `https://github.com/${owner}/api.git`,
    sshUrl: `git@github.com:${owner}/api.git`,
    webUrl: `https://github.com/${owner}/api`,
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  });

  /** Stand-in for `provider:listForks` paging (spec 10 §5.5). */
  async function listAllForks(pages: ListPage<RemoteRepo>[]): Promise<RemoteRepo[]> {
    const fake = async (cursor?: string): Promise<ListPage<RemoteRepo>> =>
      pages[cursor ? Number(cursor) : 0]!;
    const out: RemoteRepo[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await fake(cursor);
      out.push(...p.items);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  it('maps forks to choices: protocol URL, owner name, already-added state', async () => {
    const forks = await listAllForks([
      { items: [repo('zed'), repo('alice')], nextCursor: '1' },
      { items: [repo('Bob-Dev'), repo('origin')] },
    ]);
    const remotes = [
      remote('origin', 'git@github.com:acme/api.git'),
      remote('alice', 'https://github.com/alice/api'),
    ];
    const https = forkChoices(forks, remotes, 'https', repo('acme', { isFork: false }));
    expect(https.map((c) => c.fullName)).toEqual([
      'acme/api',
      'alice/api',
      'Bob-Dev/api',
      'origin/api',
      'zed/api',
    ]);
    expect(https[0]).toMatchObject({ isParent: true, addedAs: 'origin' });
    expect(https.find((c) => c.owner === 'alice')).toMatchObject({ addedAs: 'alice' });
    expect(https.find((c) => c.owner === 'Bob-Dev')).toMatchObject({
      addedAs: null,
      suggestedName: 'bob-dev',
      url: 'https://github.com/Bob-Dev/api.git',
    });
    // a fork owned by "origin" must not clash with the existing remote name
    expect(https.find((c) => c.owner === 'origin')!.suggestedName).toBe('origin-2');
    const ssh = forkChoices(forks, remotes, 'ssh');
    expect(ssh.find((c) => c.owner === 'zed')!.url).toBe('git@github.com:zed/api.git');
  });

  it('suggests unique remote names', () => {
    expect(suggestRemoteName('Alice', [])).toBe('alice');
    expect(suggestRemoteName('alice', ['alice', 'alice-2'])).toBe('alice-3');
    expect(suggestRemoteName('org/sub group', [])).toBe('sub-group');
    expect(suggestRemoteName('...', [])).toBe('fork');
  });
});

describe('REMOTE section grouping', () => {
  it('lists remotes without branches and skips HEAD symrefs', () => {
    const remotes = [remote('origin', 'u1'), remote('upstream', 'u2'), remote('team/fork', 'u3')];
    const refs = [
      rref('origin/main'),
      rref('origin/HEAD', { symrefTarget: 'refs/remotes/origin/main' }),
      rref('origin/feature/x'),
      rref('team/fork/topic'),
      rref('gone/old'),
    ];
    const groups = groupRemotes(remotes, refs);
    expect(groups.map((g) => [g.name, g.refs.map((r) => r.shortName), !!g.remote])).toEqual([
      ['origin', ['origin/main', 'origin/feature/x'], true],
      ['upstream', [], true],
      ['team/fork', ['team/fork/topic'], true],
      ['gone', ['gone/old'], false],
    ]);
    expect(groupRemotes(remotes, refs, true).map((g) => g.name)).toEqual(['origin', 'team/fork', 'gone']);
  });
});

describe('splitRemoteBranch', () => {
  it('uses configured remote names (which may contain /)', () => {
    expect(splitRemoteBranch('origin/feature/x', ['origin'])).toEqual(['origin', 'feature/x']);
    expect(splitRemoteBranch('team/fork/topic', ['team', 'team/fork'])).toEqual(['team/fork', 'topic']);
    expect(splitRemoteBranch('other/b', [])).toEqual(['other', 'b']);
    expect(splitRemoteBranch('nobranch', [])).toBeNull();
  });
});
