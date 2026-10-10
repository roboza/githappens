import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepoSettingsHandlers } from '../src/main/ipc/repo-settings-handlers';
import {
  createRepoGitConfig,
  execGit,
  parseConfigList,
  validateRepoGitConfigValue,
} from '../src/main/repo-settings/repo-git-config';
import { repoKey, RepoSettingsStore } from '../src/main/repo-settings/repo-settings-store';
import { REPO_GITCONFIG_KEYS } from '../src/shared/ipc/repo-settings-contract';

let dir: string;
let repo: string;
let profileDir: string;
const ctx = { senderId: 1 };

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-repo-settings-')));
  repo = path.join(dir, 'repo');
  profileDir = path.join(dir, 'profiles', 'p1');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const localConfig = (): string => fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');

describe('gitconfig channels (real git, --local only)', () => {
  it('set / get / list / unset write only the repository config', async () => {
    const h = createRepoSettingsHandlers({ profileDir: () => profileDir, run: execGit, broadcast: vi.fn() });
    await h['gitconfig:set']({ repoPath: repo, key: 'user.email', value: ' me@work.io ' }, ctx);
    await h['gitconfig:set']({ repoPath: repo, key: 'core.hooksPath', value: '.githooks' }, ctx);
    await h['gitconfig:set'](
      { repoPath: repo, key: 'githappens.agentSetup', value: 'pnpm install\r\npnpm build\n' },
      ctx,
    );
    expect(await h['gitconfig:get']({ repoPath: repo, key: 'user.email' }, ctx)).toBe('me@work.io');
    expect(localConfig()).toMatch(/hooksPath = \.githooks/);
    const list = await h['gitconfig:list']({ repoPath: repo }, ctx);
    expect(list.local).toMatchObject({
      'user.email': 'me@work.io',
      'core.hooksPath': '.githooks',
      'githappens.agentSetup': 'pnpm install\npnpm build',
    });
    expect(list.effective['user.email']).toBe('me@work.io');
    await h['gitconfig:unset']({ repoPath: repo, key: 'user.email' }, ctx);
    await h['gitconfig:unset']({ repoPath: repo, key: 'user.email' }, ctx); // missing → no error
    expect(await h['gitconfig:get']({ repoPath: repo, key: 'user.email' }, ctx)).toBeNull();
  });

  it('rejects keys outside the allowlist, invalid values and non-repositories', async () => {
    const cfg = createRepoGitConfig(execGit);
    await expect(cfg.set(repo, 'core.sshCommand', 'evil')).rejects.toThrow(/Refusing/);
    await expect(cfg.get(repo, 'remote.origin.url')).rejects.toThrow(/Refusing/);
    await expect(cfg.set(repo, 'user.email', 'not an email')).rejects.toThrow(/email/);
    await expect(cfg.set(repo, 'commit.gpgsign', 'yes')).rejects.toThrow(/true or false/);
    await expect(cfg.set(repo, 'commit.template', 'a\nb')).rejects.toThrow(/single line/);
    await expect(cfg.set(repo, 'user.name', '')).rejects.toThrow(/unset/);
    await expect(cfg.set('relative/path', 'user.name', 'x')).rejects.toThrow(/repository path/);
    const notRepo = path.join(dir, 'plain');
    fs.mkdirSync(notRepo);
    await expect(cfg.list(notRepo)).rejects.toThrow(/Not a git repository/);
    expect(localConfig()).not.toMatch(/sshCommand/);
  });

  it('validates values per key', () => {
    expect(validateRepoGitConfigValue('gpg.format', 'ssh')).toBe('ssh');
    expect(() => validateRepoGitConfigValue('gpg.format', 'pgp')).toThrow();
    expect(validateRepoGitConfigValue('i18n.commitEncoding', 'ISO-8859-1')).toBe('ISO-8859-1');
    expect(() => validateRepoGitConfigValue('i18n.commitEncoding', 'klingon-8')).toThrow();
    expect(() => validateRepoGitConfigValue('user.name', 'Ann <a@b>')).toThrow();
    expect(REPO_GITCONFIG_KEYS).toContain('githappens.agentSetup');
  });

  it('parses -z config lists (keys case-folded, multi-line values)', () => {
    const m = parseConfigList('user.email\na@b.c\0githappens.agentsetup\nx\ny\0core.bare\0');
    expect(m.get('user.email')).toBe('a@b.c');
    expect(m.get('githappens.agentsetup')).toBe('x\ny');
    expect(m.get('core.bare')).toBe('true');
  });
});

describe('repo settings store', () => {
  it('persists per profile + repo and broadcasts changes', async () => {
    const broadcast = vi.fn();
    const h = createRepoSettingsHandlers({ profileDir: () => profileDir, run: execGit, broadcast });
    expect(await h['repoSettings:get']({ repoPath: repo }, ctx)).toEqual({
      encoding: 'utf-8',
      issueTracker: null,
    });
    const tracker = { integrationKey: 'jira:acme.atlassian.net', kind: 'jira', projectKey: 'KL' };
    const r = await h['repoSettings:set'](
      { repoPath: repo, patch: { encoding: 'Windows-1252', issueTracker: tracker } },
      ctx,
    );
    expect(r).toEqual({ encoding: 'windows-1252', issueTracker: tracker });
    expect(broadcast).toHaveBeenCalledWith('repoSettings:changed', { repoPath: repo, settings: r });
    const file = path.join(profileDir, 'repo-settings', `${repoKey(repo)}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // another profile does not see it
    expect(new RepoSettingsStore(() => path.join(dir, 'profiles', 'p2')).get(repo).encoding).toBe('utf-8');
    await expect(
      h['repoSettings:set']({ repoPath: repo, patch: { encoding: 'nope-encoding' } }, ctx),
    ).rejects.toThrow(/encoding/i);
    await expect(
      h['repoSettings:set']({ repoPath: repo, patch: { secret: 'x' } as never }, ctx),
    ).rejects.toThrow(/Invalid/);
    expect(
      (await h['repoSettings:set']({ repoPath: repo, patch: { issueTracker: null } }, ctx)).issueTracker,
    ).toBeNull();
  });

  it.runIf(process.platform === 'win32')('keys repositories case-insensitively on Windows', () => {
    expect(repoKey('C:\\Repo\\X')).toBe(repoKey('c:/repo/x/'));
  });

  it.runIf(process.platform === 'linux')('keys repositories case-sensitively on Linux', () => {
    expect(repoKey('/a/B')).not.toBe(repoKey('/a/b'));
  });
});
