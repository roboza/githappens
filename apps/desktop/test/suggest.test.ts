import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sha256Hex,
  type Me,
  type PatchCreate,
  type PatchMeta,
  type Suggestion,
  type SuggestionCreate,
} from '@githappens/cloud-api';
import {
  createExtrasRegistry,
  createOpRegistry,
  findOnPath,
  GitProcessRunner,
  GitService,
  OperationQueue,
  type RepoId,
} from '@githappens/git';
import type { HostingProvider, IntegrationId, RepoRef, TimelineItem } from '@githappens/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CloudError, type CloudHttp } from '../src/main/cloud/cloud-http';
import { PatchService } from '../src/main/cloud/patches';
import {
  coAuthorFromLogin,
  filterPatch,
  formatSuggestionComment,
  parseSuggestionComment,
  splitPatchByFile,
  suggestionCommitMessage,
  SuggestService,
} from '../src/main/cloud/suggest';
import { createSuggestHandlers } from '../src/main/ipc/suggest-handlers';
import { SUGGEST_INVOKE_CHANNELS, type SuggestPr } from '../src/shared/ipc/suggest-contract';

const SERVER = 'https://cloud.test';
const PATCH_ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('Code Suggest text helpers', () => {
  it('formats a comment the author side can parse back (with and without a server record)', () => {
    const key = 'k'.repeat(43);
    const id = '0f8e6c1a-1111-4222-8333-944455556666';
    const body = formatSuggestionComment({
      title: 'Use *safe* paths',
      fileCount: 2,
      id,
      patchId: PATCH_ID,
      webUrl: `${SERVER}/p/${PATCH_ID}`,
      key,
    });
    expect(body).toContain(`githappens://suggestion/${id}#k=${key}`);
    expect(body).toContain(`${SERVER}/p/${PATCH_ID}#k=${key}`);
    expect(parseSuggestionComment(body)).toEqual({
      id,
      patchId: PATCH_ID,
      key,
      server: SERVER,
      webUrl: `${SERVER}/p/${PATCH_ID}`,
      title: 'Use *safe* paths',
    });
    const noServer = formatSuggestionComment({
      title: 'x',
      fileCount: 1,
      patchId: PATCH_ID,
      webUrl: `${SERVER}/p/${PATCH_ID}`,
    });
    expect(parseSuggestionComment(noServer)).toMatchObject({ patchId: PATCH_ID });
    expect(parseSuggestionComment(noServer)?.id).toBeUndefined();
    expect(parseSuggestionComment('LGTM, see https://example.com/p/short')).toBeNull();
  });

  it('splits and filters patches by file', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      '',
    ].join('\n');
    expect(splitPatchByFile(patch)).toHaveLength(2);
    const only = filterPatch(patch, new Set([1]));
    expect(only).toContain('b/b.txt');
    expect(only).not.toContain('a/a.txt');
  });

  it('builds co-author trailers', () => {
    expect(suggestionCommitMessage('Fix it\n', { name: 'Rita <x>', email: 'r@x.io' })).toBe(
      'Apply code suggestion: Fix it\n\nCo-authored-by: Rita x <r@x.io>',
    );
    expect(coAuthorFromLogin('rita', 'github.com')).toEqual({
      name: 'rita',
      email: 'rita@users.noreply.github.com',
    });
  });

  it('handlers cover the contract', () => {
    expect(Object.keys(createSuggestHandlers({} as never)).sort()).toEqual(
      [...SUGGEST_INVOKE_CHANNELS].sort(),
    );
  });
});

// ---- end to end with real git ----------------------------------------------------------------

const gitPath = findOnPath('git');
const describeGit = gitPath ? describe : describe.skip;

const ME: Me = { id: 'u-rev', name: 'Rita', email: 'rita@example.com', orgs: [] };

/** Patches + suggestions routes of GitHappens Cloud, in memory. */
class FakeCloud implements CloudHttp {
  me_: Me | null = ME;
  readonly metas = new Map<string, PatchMeta>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly suggestions = new Map<string, Suggestion>();
  readonly sent: string[] = [];
  private seq = 0;
  serverUrl(): string | null {
    return SERVER;
  }
  me(): Me | null {
    return this.me_;
  }
  activeOrgId(): string | null {
    return null;
  }
  onSessionChange(): () => void {
    return () => undefined;
  }
  async request<T>(
    method: string,
    p: string,
    opts: { body?: unknown } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    this.sent.push(`${method} ${p} ${JSON.stringify(opts.body ?? null)}`);
    const ok = (data: unknown) => ({ status: 200, data: data as T, headers: new Headers() });
    if (p === '/.well-known/githappens-cloud')
      return ok({ limits: { patchMaxBytes: 25 << 20, patchMaxExpiryDays: null } });
    if (method === 'POST' && p === '/v1/patches') {
      const b = opts.body as PatchCreate;
      const id = `Sugg${String(++this.seq).padStart(4, '0')}abcdefghijklmn`;
      this.metas.set(id, {
        id,
        title: b.title,
        kind: b.kind,
        author: { id: this.me_!.id, name: this.me_!.name },
        baseSha: b.baseSha,
        e2e: b.e2e,
        size: b.size,
        sha256: b.sha256,
        visibility: b.visibility,
        createdAt: new Date(Date.now() + this.seq).toISOString(),
        webUrl: `${SERVER}/p/${id}`,
      });
      return ok({ id, uploadUrl: `${SERVER}/upload/${id}`, webUrl: `${SERVER}/p/${id}` });
    }
    const pm = /^\/v1\/patches\/([A-Za-z0-9]+)(\/complete)?$/.exec(p);
    if (pm) {
      const meta = this.metas.get(pm[1]!);
      if (!meta) throw new CloudError('not_found', 'nope', 404);
      if (pm[2]) {
        const blob = this.blobs.get(meta.id)!;
        if ((await sha256Hex(blob)) !== meta.sha256) throw new CloudError('validation', 'bad', 422);
        return ok(meta);
      }
      return ok({ ...meta, downloadUrl: `${SERVER}/blob/${meta.id}` });
    }
    if (method === 'POST' && p === '/v1/suggestions') {
      const b = opts.body as SuggestionCreate;
      expect(this.metas.get(b.patchId)?.kind).toBe('suggestion');
      const id = `0f8e6c1a-1111-4222-8333-${String(++this.seq).padStart(12, '0')}`;
      const s: Suggestion = {
        ...b,
        id,
        author: { id: this.me_!.id, name: this.me_!.name },
        status: 'open',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        webUrl: `${SERVER}/p/${b.patchId}`,
        deepLink: `githappens://suggestion/${id}`,
      };
      this.suggestions.set(id, s);
      return ok(s);
    }
    if (method === 'GET' && p.startsWith('/v1/suggestions?')) return ok([...this.suggestions.values()]);
    const sm = /^\/v1\/suggestions\/([0-9a-f-]+)$/.exec(p);
    if (sm) {
      const s = this.suggestions.get(sm[1]!);
      if (!s) throw new CloudError('not_found', 'nope', 404);
      if (method === 'PATCH') Object.assign(s, opts.body);
      return ok(s);
    }
    throw new CloudError('not_found', `no route ${method} ${p}`, 404);
  }
  async upload(url: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(url.split('/').pop()!, bytes);
  }
  async download(url: string): Promise<Uint8Array> {
    const b = this.blobs.get(url.split('/').pop()!);
    if (!b) throw new CloudError('gone', 'gone', 410);
    return b;
  }
}

const INTEGRATION: IntegrationId = { kind: 'github', host: 'github.com', accountId: '1' };
const REF: RepoRef = { integration: INTEGRATION, owner: 'acme', name: 'app' };

function fakeProvider(comments: TimelineItem[], labels: string[]): HostingProvider {
  return {
    kind: 'github',
    capabilities: { prRefspec: null },
    async addComment(_ref: RepoRef, _n: number, body: string) {
      const item: TimelineItem = {
        kind: 'comment',
        id: `IC_${comments.length + 1}`,
        author: { id: '7', login: 'rita' },
        body,
        createdAt: new Date().toISOString(),
        editable: true,
      };
      comments.push(item);
      return item;
    },
    async getTimeline() {
      return { items: comments };
    },
    async getPullRequest() {
      return { labels: labels.map((name) => ({ name })) };
    },
    async updatePullRequest(_r: RepoRef, _n: number, patch: { labels?: string[] }) {
      labels.splice(0, labels.length, ...(patch.labels ?? []));
      return {};
    },
  } as unknown as HostingProvider;
}

describeGit('Code Suggest end to end (spec 14 §6.4)', () => {
  let root = '';
  let runner: GitProcessRunner;
  let env: NodeJS.ProcessEnv;
  const services = new Map<RepoId, GitService>();
  const registry = { ...createOpRegistry(), ...createExtrasRegistry() };

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-suggest-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Rita\n\temail = rita@example.com\n');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
    };
    runner = new GitProcessRunner({ context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }) });
  });
  afterAll(() => {
    for (const s of services.values()) s.dispose();
    runner?.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows handles */
    }
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(gitPath!, args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  async function open(dir: string): Promise<RepoId> {
    const svc = await GitService.open(runner, dir);
    services.set(svc.repo.id, svc);
    return svc.repo.id;
  }

  it('reviewer suggests in an isolated worktree; author applies per file and commits & pushes', async () => {
    // origin (bare) with main + feature (the PR head)
    const bare = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    const dir = path.join(root, 'work');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'switch', '-q', '-c', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nfeature\n');
    git(dir, 'commit', '-q', '-am', 'feature work');
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    const headSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'switch', '-q', 'main');
    // the user's own uncommitted work must survive untouched
    fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\nmy wip\n');

    const repoId = await open(dir);
    const runOp = (id: RepoId, op: Parameters<OperationQueue['enqueue']>[0]) =>
      new OperationQueue(services.get(id)!, registry).enqueue(op).done;
    const repos = {
      get: (id: RepoId) => services.get(id)!,
      list: () => [...services.values()],
      runOp,
      open,
      close: async (id: RepoId) => {
        services.get(id)?.dispose();
        services.delete(id);
      },
    };
    const cloud = new FakeCloud();
    const userData = path.join(root, 'userData');
    const patches = new PatchService({
      cloud,
      repos,
      resolveRepoIdentity: async () => ({
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'app',
      }),
      appVersion: 'test',
      cacheDir: () => path.join(userData, 'cloud'),
    });
    const comments: TimelineItem[] = [];
    const labels: string[] = ['bug'];
    const provider = fakeProvider(comments, labels);
    const svc = new SuggestService({
      cloud,
      patches,
      repos,
      integrations: {
        provider: () => provider,
        resolveRemotes: async () => [
          {
            remote: 'origin',
            url: bare,
            kind: 'github',
            host: 'github.com',
            owner: 'acme',
            name: 'app',
            ref: REF,
          },
        ],
      },
      userDataDir: () => userData,
    });
    const pr: SuggestPr = {
      ref: REF,
      number: 42,
      title: 'Feature',
      headSha,
      headBranch: 'feature',
      baseBranch: 'main',
      isCrossRepository: false,
    };
    const statusBefore = git(dir, 'status', '--porcelain');

    // ---- reviewer ----
    const session = await svc.start(repoId, pr);
    expect(session.worktreePath.startsWith(path.join(userData, 'suggest'))).toBe(true);
    expect(git(session.worktreePath, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(svc.sessions().map((s) => s.sessionId)).toEqual([session.sessionId]);
    fs.writeFileSync(path.join(session.worktreePath, 'a.txt'), 'alpha\nfeature\nsuggested\n');
    // a file outside the PR diff; same size, same second as the checkout (racy-clean for git's stat check)
    fs.writeFileSync(path.join(session.worktreePath, 'b.txt'), 'BETA\n');
    fs.writeFileSync(path.join(session.worktreePath, 'new.txt'), 'brand new\n');
    expect((await svc.changes(session.sessionId)).files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'b.txt',
      'new.txt',
    ]);
    const submitted = await svc.submit({ sessionId: session.sessionId, title: 'Tidy up', addLabel: true });
    expect(submitted.commentPosted).toBe(true);
    expect(submitted.warnings).toEqual([]);
    expect(submitted.suggestion.id).toBeDefined();
    expect(fs.existsSync(session.worktreePath)).toBe(false);
    expect(svc.sessions()).toEqual([]);
    expect(labels).toEqual(['bug', 'code-suggestion']);
    expect(comments).toHaveLength(1);
    const body = (comments[0] as { body: string }).body;
    expect(body).toMatch(/#k=[A-Za-z0-9_-]+/); // e2e link with the key in the fragment
    // the key never reached the server
    const key = /#k=([A-Za-z0-9_-]+)/.exec(body)![1]!;
    expect(cloud.sent.join('\n')).not.toContain(key);
    const rec = [...cloud.suggestions.values()][0]!;
    expect(rec).toMatchObject({ prNumber: 42, prHeadSha: headSha, commentId: 'IC_1' });
    expect(rec.coAuthor).toEqual({ name: 'Rita', email: 'rita@example.com' });
    // main checkout untouched
    expect(git(dir, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // ---- author (comment discovery works without the server record) ----
    const listed = await svc.list(repoId, pr);
    expect(listed.serverAvailable).toBe(true);
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0]!;
    expect(item).toMatchObject({ source: 'both', status: 'open', title: 'Tidy up', missingKey: false });
    const opened = await svc.open({ info: item, prHeadSha: headSha });
    expect(opened.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
    expect(opened.outdated).toBeUndefined();

    // apply only a.txt + new.txt to a new branch (reject b.txt)
    git(dir, 'stash', '-q'); // author starts clean
    const toBranch = await svc.apply({
      repoId,
      patchId: item.patchId,
      paths: ['a.txt', 'new.txt'],
      target: { kind: 'new-branch', name: 'suggestion-try' },
      title: item.title,
    });
    expect(toBranch).toMatchObject({ applied: true, branch: 'suggestion-try' });
    expect(git(dir, 'show', 'suggestion-try:a.txt')).toBe('alpha\nfeature\nsuggested');
    expect(git(dir, 'show', 'suggestion-try:b.txt')).toBe('beta');
    git(dir, 'switch', '-q', 'main');

    // commit & push to the PR branch with the co-author trailer
    const pushed = await svc.apply({
      repoId,
      patchId: item.patchId,
      paths: ['a.txt', 'b.txt', 'new.txt'],
      target: { kind: 'pr-branch', pr },
      suggestionId: item.id!,
      title: item.title,
      coAuthor: rec.coAuthor!,
    });
    expect(pushed).toMatchObject({ applied: true, branch: 'feature', pushed: true });
    const msg = git(bare, 'log', '-1', '--format=%B', 'feature');
    expect(msg).toContain('Apply code suggestion: Tidy up');
    expect(msg).toContain('Co-authored-by: Rita <rita@example.com>');
    expect(git(bare, 'show', 'feature:b.txt')).toBe('BETA');
    expect(cloud.suggestions.get(item.id!)!.status).toBe('applied');
  });

  it('discard removes the worktree', async () => {
    const dir = path.join(root, 'work');
    const repoId =
      [...services.entries()].find(([, s]) => s.repo.worktreeRoot === dir)?.[0] ?? (await open(dir));
    const userData = path.join(root, 'userData2');
    const cloud = new FakeCloud();
    const repos = {
      get: (id: RepoId) => services.get(id)!,
      list: () => [...services.values()],
      runOp: (id: RepoId, op: Parameters<OperationQueue['enqueue']>[0]) =>
        new OperationQueue(services.get(id)!, registry).enqueue(op).done,
      open,
      close: async () => undefined,
    };
    const svc = new SuggestService({
      cloud,
      patches: new PatchService({
        cloud,
        repos,
        resolveRepoIdentity: async () => undefined,
        appVersion: 't',
        cacheDir: () => userData,
      }),
      repos,
      integrations: { provider: () => fakeProvider([], []), resolveRemotes: async () => [] },
      userDataDir: () => userData,
    });
    const head = git(dir, 'rev-parse', 'main');
    const s = await svc.start(repoId, {
      ref: REF,
      number: 1,
      title: 't',
      headSha: head,
      headBranch: 'main',
      baseBranch: 'main',
      isCrossRepository: false,
    });
    expect(fs.existsSync(s.worktreePath)).toBe(true);
    await svc.discard(s.sessionId);
    expect(fs.existsSync(s.worktreePath)).toBe(false);
    expect(git(dir, 'worktree', 'list')).not.toContain(s.sessionId);
  });
});
