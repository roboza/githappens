import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findOnPath, GitProcessRunner } from '@githappens/git';
import type { HostingProvider, RemoteRepo } from '@githappens/providers/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CliInstaller } from '../src/main/cli/install';
import { createRepos2Handlers, type Repos2Deps } from '../src/main/ipc/repos2-handlers';
import { TemplateStore, templatesDir } from '../src/main/repos/templates';
import { RepoRegistry } from '../src/main/services/repo-registry';

const gitPath = findOnPath('git');
const describeGit = gitPath ? describe : describe.skip;
const TEMPLATES = path.join(__dirname, '..', 'resources', 'templates');
const ctx = { senderId: 1 };

describe('TemplateStore (bundled resources)', () => {
  const t = new TemplateStore(TEMPLATES);

  it('resolves the templates dir for dev and packaged builds', () => {
    expect(templatesDir({ isPackaged: true, resourcesPath: '/r', appPath: '/a' })).toBe(
      path.join('/r', 'templates'),
    );
    expect(templatesDir({ isPackaged: false, resourcesPath: '/r', appPath: '/a' })).toBe(
      path.join('/a', 'resources', 'templates'),
    );
  });

  it('lists and combines .gitignore templates with headers, rejecting unknown names', () => {
    const names = t.gitignoreNames();
    expect(names).toEqual(expect.arrayContaining(['Node', 'Python', 'macOS', 'Windows', 'VisualStudio']));
    const text = t.gitignore(['Node', 'macOS', 'Node']);
    expect(text.startsWith('### Node ###\n')).toBe(true);
    expect(text).toContain('\n### macOS ###\n');
    expect(text.match(/### Node ###/g)).toHaveLength(1);
    expect(text).toContain('node_modules/');
    expect(() => t.gitignore(['../../etc/passwd'])).toThrow(/Unknown/);
  });

  it('lists the 7 licenses and renders placeholders', () => {
    expect(t.licenses().map((l) => l.spdxId)).toEqual([
      'MIT',
      'Apache-2.0',
      'GPL-3.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'MPL-2.0',
      'Unlicense',
    ]);
    const mit = t.renderLicense({ spdxId: 'MIT', author: 'Ada Lovelace', year: 2026 });
    expect(mit).toContain('Copyright (c) 2026 Ada Lovelace');
    expect(mit).not.toMatch(/\{\{/);
    const apache = t.renderLicense({ spdxId: 'Apache-2.0', author: 'Ada', year: 2026 });
    expect(apache).toContain('Copyright 2026 Ada');
    expect(t.renderLicense({ spdxId: 'GPL-3.0', author: 'x', year: 2026 })).toContain(
      'GNU GENERAL PUBLIC LICENSE',
    );
    expect(() => t.renderLicense({ spdxId: 'WTFPL', author: 'x', year: 2026 })).toThrow(/Unknown/);
  });
});

describeGit('clone2 / init2 handlers (real git)', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let runner: GitProcessRunner;
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(gitPath!, args, { cwd, env, encoding: 'utf8', windowsHide: true });

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-clone-init-')));
    const g = path.join(root, 'global.gitconfig');
    fs.writeFileSync(g, '[user]\n\tname = T\n\temail = t@e\n[uploadpack]\n\tallowFilter = true\n');
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: g,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    runner = new GitProcessRunner({ context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }) });
  });
  afterAll(() => {
    runner.killAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const handlers = (provider?: Partial<HostingProvider>) => {
    const progress: string[] = [];
    const deps: Repos2Deps = {
      runner: () => runner,
      registry: () => new RepoRegistry(path.join(root, 'repos.json')),
      repos: { list: () => [], close: async () => undefined, get: () => null as never },
      templates: new TemplateStore(TEMPLATES),
      integrations: { provider: () => provider as HostingProvider },
      credentials: { envFor: () => ({}), finish: () => undefined, wasCancelled: () => false },
      progress: (e) => progress.push(e.phase),
      cli: {} as CliInstaller,
    };
    return { h: createRepos2Handlers(deps), progress };
  };

  it('init2 combines templates + license and publishes to a provider-created remote', async () => {
    const remoteDir = path.join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remoteDir);
    const created: RemoteRepo = {
      ref: { integration: 'github:github.com:1', owner: 'me', name: 'proj' } as RemoteRepo['ref'],
      fullName: 'me/proj',
      isPrivate: true,
      isFork: false,
      defaultBranch: 'main',
      httpsUrl: pathToFileURL(remoteDir).href,
      sshUrl: 'git@github.com:me/proj.git',
      webUrl: 'https://github.com/me/proj',
      updatedAt: new Date().toISOString(),
    };
    const calls: unknown[] = [];
    const { h } = handlers({
      createRepo: async (o) => {
        calls.push(o);
        return created;
      },
    });
    const r = await h['repos:init2'](
      {
        parentDir: path.join(root, 'work'),
        name: 'proj',
        defaultBranch: 'main',
        gitignoreTemplates: ['Node', 'macOS'],
        license: { spdxId: 'MIT', author: 'Ada', year: 2026 },
        createReadme: true,
        initialCommit: true,
        bare: false,
        remote: { integrationKey: 'k', name: 'proj', visibility: 'private', protocol: 'https' },
      },
      ctx,
    );
    expect(r.pushError).toBeUndefined();
    expect(r.remote?.fullName).toBe('me/proj');
    expect(calls).toEqual([{ owner: undefined, name: 'proj', private: true, description: undefined }]);
    const gi = fs.readFileSync(path.join(r.path, '.gitignore'), 'utf8');
    expect(gi).toContain('### Node ###');
    expect(gi).toContain('### macOS ###');
    expect(fs.readFileSync(path.join(r.path, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 Ada');
    expect(git(remoteDir, 'log', '--format=%s', 'main').trim()).toBe('Initial commit');

    // bare init through the handler
    const bare = await h['repos:init2'](
      {
        parentDir: path.join(root, 'work'),
        name: 'b.git',
        defaultBranch: 'main',
        gitignoreTemplates: ['Node'],
        createReadme: true,
        initialCommit: true,
        bare: true,
      },
      ctx,
    );
    expect(git(bare.path, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
  });

  it('init2 refuses remote init for bare repos', async () => {
    const { h } = handlers({ createRepo: async () => ({}) as RemoteRepo });
    await expect(
      h['repos:init2'](
        {
          parentDir: path.join(root, 'work'),
          name: 'nope',
          defaultBranch: 'main',
          gitignoreTemplates: [],
          createReadme: false,
          initialCommit: true,
          bare: true,
          remote: { integrationKey: 'k', name: 'nope', visibility: 'public', protocol: 'https' },
        },
        ctx,
      ),
    ).rejects.toThrow(/non-bare/);
  });

  it('clone2 runs shallow + sparse clones and reports progress', async () => {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'app'), { recursive: true });
    fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
    git(src, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(src, 'app', 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(src, 'docs', 'd.txt'), 'd\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(src, 'app', 'b.txt'), 'b\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'two');
    const { h, progress } = handlers();
    const r = await h['repos:clone2'](
      {
        opId: 'op1',
        url: pathToFileURL(src).href,
        parentDir: path.join(root, 'clones'),
        folderName: 'c',
        shallow: { depth: 1, customFlags: '--no-tags' },
        sparse: { paths: ['app'], blobless: true },
        recurseSubmodules: true,
      },
      ctx,
    );
    expect(r.sparse).toBe(true);
    expect(git(r.path, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(fs.existsSync(path.join(r.path, 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(r.path, 'app', 'b.txt'))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    await expect(
      h['repos:clone2'](
        {
          opId: 'op2',
          url: pathToFileURL(src).href,
          parentDir: path.join(root, 'clones'),
          folderName: 'bad',
          shallow: { customFlags: '--upload-pack=calc.exe' },
          recurseSubmodules: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/not allowed/);
  });
});
