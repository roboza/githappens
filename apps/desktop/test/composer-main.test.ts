import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOpRegistry,
  HOOK_OUTPUT_PHASE,
  OperationQueue,
  readCommitTemplate,
  type GitService,
  type ProgressEvent,
} from '@githappens/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commitContext,
  createCommitServices,
  DRAFT_MAX_AGE_MS,
  DraftStore,
  draftKey,
  filterCoAuthors,
  hookOutputEvent,
  isRunnableHook,
  parseLsFilesEol,
  parseShortlog,
  sanitizeDraft,
  ShortlogCache,
  stagedEolIssues,
} from '../src/main/commit';
import { createCommitHandlers, type CommitHandlerDeps } from '../src/main/ipc/commit-handlers';
import { COMMIT_EVENT_CHANNELS, COMMIT_INVOKE_CHANNELS } from '../src/shared/ipc/commit-contract';
import { gitPath, useTestRepos } from './ai-test-repo';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('composer drafts store (spec 06 §4.5)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-drafts-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists per repo + branch and survives a restart', () => {
    let now = 1_000_000;
    const store = new DraftStore(
      () => dir,
      () => now,
    );
    const repo = path.join(dir, 'proj');
    store.set(repo, 'main', { summary: 'WIP main', description: 'body', coAuthors: [] });
    store.set(repo, 'feature', {
      summary: 'WIP feature',
      description: '',
      coAuthors: [{ name: 'Ada', email: 'ada@x.io' }],
    });
    store.set(repo, null, { summary: 'detached', description: '', coAuthors: [] });
    now += 10;
    const reopened = new DraftStore(
      () => dir,
      () => now,
    );
    expect(reopened.get(repo, 'main')).toMatchObject({ summary: 'WIP main', description: 'body' });
    expect(reopened.get(repo, 'feature')?.coAuthors).toEqual([{ name: 'Ada', email: 'ada@x.io' }]);
    expect(reopened.get(repo, null)?.summary).toBe('detached');
    expect(reopened.get(path.join(dir, 'other'), 'main')).toBeNull();
  });

  it('clears with null or an empty draft, prunes stale drafts, tolerates corrupt files', () => {
    let now = 5_000_000_000;
    const store = new DraftStore(
      () => dir,
      () => now,
    );
    store.set('/r', 'main', { summary: 'x', description: '', coAuthors: [] });
    store.set('/r', 'main', null);
    expect(store.get('/r', 'main')).toBeNull();
    store.set('/r', 'b', { summary: 'x', description: '', coAuthors: [] });
    store.set('/r', 'b', { summary: '  ', description: '', coAuthors: [] });
    expect(store.get('/r', 'b')).toBeNull();

    store.set('/r', 'old', { summary: 'old', description: '', coAuthors: [] });
    now += DRAFT_MAX_AGE_MS + 1;
    expect(
      new DraftStore(
        () => dir,
        () => now,
      ).get('/r', 'old'),
    ).toBeNull();

    fs.writeFileSync(path.join(dir, 'commit-drafts.json'), '{not json');
    expect(new DraftStore(() => dir).get('/r', 'main')).toBeNull();
  });

  it('sanitizes untrusted drafts', () => {
    expect(sanitizeDraft(null)).toBeNull();
    expect(sanitizeDraft({ summary: 1, description: [] })).toBeNull();
    const d = sanitizeDraft(
      {
        summary: 'S'.repeat(10_000),
        description: 'D',
        coAuthors: [{ name: 'A', email: 'a@x.io' }, { name: 'no email' }, 'junk'],
        updatedAt: 9e15,
      },
      100,
    )!;
    expect(d.summary).toHaveLength(4096);
    expect(d.coAuthors).toEqual([{ name: 'A', email: 'a@x.io' }]);
    expect(d.updatedAt).toBe(100);
    expect(draftKey('C:\\Repo', 'main', 'win32')).toBe(draftKey('c:\\repo\\', 'main', 'win32'));
  });
});

describe('co-author suggestions', () => {
  it('parses shortlog -sne and ranks / filters / dedupes', () => {
    const history = parseShortlog(
      '    3\tBob Builder <bob@x.io>\n   12\tAda Lovelace <ada@x.io>\n    1\tNo Mail <>\n    2\tme <me@x.io>\n',
    );
    expect(history.map((h) => h.email)).toEqual(['ada@x.io', 'bob@x.io', 'me@x.io']);
    const provider = [
      { name: 'Ada (GitHub)', email: 'ADA@x.io' },
      { name: 'Carol', email: 'carol@x.io' },
    ];
    expect(filterCoAuthors([history, provider], '', { exclude: ['ME@x.io'] }).map((c) => c.name)).toEqual([
      'Ada Lovelace',
      'Bob Builder',
      'Carol',
    ]);
    // prefix matches (name word or email) rank before substring matches
    expect(filterCoAuthors([history, provider], 'b').map((c) => c.email)).toEqual(['bob@x.io']);
    expect(filterCoAuthors([history, provider], 'lo').map((c) => c.email)).toEqual(['ada@x.io']);
    expect(filterCoAuthors([history, provider], 'x.io', { limit: 2 })).toHaveLength(2);
  });

  it('caches shortlog per repository with a TTL and retries after failures', async () => {
    let now = 0;
    const cache = new ShortlogCache(1000, () => now);
    const load = vi.fn(async () => [{ name: 'A', email: 'a@x.io' }]);
    await cache.get('r', load);
    await cache.get('r', load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1001;
    await cache.get('r', load);
    expect(load).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('commit IPC handlers', () => {
  const deps = (): CommitHandlerDeps & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      coAuthors: async (...a) => (calls.push(['coAuthors', ...a]), []),
      template: async () => ({}),
      context: async () => ({
        hooks: [],
        signByDefault: false,
        signingConfigured: false,
        headPushed: null,
        unborn: false,
      }),
      eolCheck: async () => [],
      checkIgnore: async (...a) => (calls.push(['checkIgnore', ...a]), { ignored: true }),
      getDraft: (...a) => (calls.push(['getDraft', ...a]), null),
      setDraft: (...a) => void calls.push(['setDraft', ...a]),
    };
  };

  it('covers every channel and validates input', async () => {
    const d = deps();
    const h = createCommitHandlers(d);
    expect(Object.keys(h).sort()).toEqual([...COMMIT_INVOKE_CHANNELS].sort());
    expect(COMMIT_EVENT_CHANNELS).toEqual(['commit:hookOutput']);
    const ctx = { senderId: 1 };
    await h['commit:coAuthorSuggestions']({ repoId: 'r', q: 'a', limit: 10_000 }, ctx);
    await h['commit:coAuthorSuggestions']({ repoId: 'r', q: 'a' }, ctx);
    expect(d.calls.slice(0, 2)).toEqual([
      ['coAuthors', 'r', 'a', 100],
      ['coAuthors', 'r', 'a', 20],
    ]);
    expect(await h['commit:checkIgnore']({ repoId: 'r', path: '--force' }, ctx)).toEqual({ ignored: false });
    await h['commit:checkIgnore']({ repoId: 'r', path: 'a\\b.txt' }, ctx);
    expect(d.calls.at(-1)).toEqual(['checkIgnore', 'r', 'a/b.txt']);
    h['commit:draft:get']({ repoId: 'r', branch: 'bad\nname' }, ctx);
    expect(d.calls.at(-1)).toEqual(['getDraft', 'r', null]);
  });

  it('maps hook-output progress to commit:hookOutput', () => {
    expect(hookOutputEvent('r', 'op1', { phase: HOOK_OUTPUT_PHASE, text: 'lint…\n' })).toEqual({
      repoId: 'r',
      opId: 'op1',
      chunk: 'lint…\n',
      stream: 'err',
    });
    expect(hookOutputEvent('r', 'op1', { phase: 'Receiving objects', text: 'x' })).toBeNull();
  });
});

describe('hooks / EOL parsing', () => {
  it('recognises runnable hooks', () => {
    const file = { isFile: () => true, mode: 0o755 } as fs.Stats;
    const plain = { isFile: () => true, mode: 0o644 } as fs.Stats;
    expect(isRunnableHook('/h/pre-commit', 'linux', () => file)).toBe(true);
    expect(isRunnableHook('/h/pre-commit', 'linux', () => plain)).toBe(false);
    expect(isRunnableHook('C:/h/pre-commit', 'win32', () => plain)).toBe(true);
    expect(isRunnableHook('/h/pre-commit.sample', 'linux', () => file)).toBe(false);
    expect(isRunnableHook('/h/missing', 'linux', () => null)).toBe(false);
  });

  it('parses ls-files --eol records', () => {
    expect(
      parseLsFilesEol(
        'i/lf    w/crlf  attr/                 \ta.txt\0i/crlf  w/crlf  attr/\tdir/b c.txt\0i/-text w/-text attr/\tbin\0',
      ),
    ).toEqual([
      { path: 'a.txt', index: 'lf', worktree: 'crlf' },
      { path: 'dir/b c.txt', index: 'crlf', worktree: 'crlf' },
      { path: 'bin', index: '-text', worktree: '-text' },
    ]);
  });
});

const describeGit = gitPath ? describe : describe.skip;

describeGit('commit services against real git', () => {
  const repos = useTestRepos('composer');
  const run = (
    svc: GitService,
    op: Parameters<OperationQueue['enqueue']>[0],
    onProgress?: (p: ProgressEvent) => void,
  ) =>
    new OperationQueue(
      svc,
      createOpRegistry(),
      onProgress ? { onProgress: (_id, p) => onProgress(p) } : {},
    ).enqueue(op).done;

  it('streams hook output, then reports HookFailed with the output and keeps HEAD', async () => {
    const r = await repos.make();
    const hook = path.join(r.dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "checking style"\necho "bad file" >&2\nexit 1\n', {
      mode: 0o755,
    });
    r.write('a.txt', 'a\n');
    r.git('add', 'a.txt');
    const head = r.git('rev-parse', 'HEAD').trim();
    const ctx = await commitContext(r.svc);
    expect(ctx.hooks).toContain('pre-commit');
    const chunks: string[] = [];
    const op = {
      type: 'commit.create' as const,
      summary: 'add a',
      description: '',
      coAuthors: [],
      amend: false,
      skipHooks: false,
      allowEmpty: false,
      sign: 'config' as const,
      cleanup: 'strip' as const,
    };
    const err = await run(r.svc, op, (p) => {
      if (p.phase === HOOK_OUTPUT_PHASE) chunks.push(p.text);
    }).catch((e: { serialized?: { code: string; details?: Record<string, unknown> } }) => e.serialized);
    expect(err?.code).toBe('HookFailed');
    expect(String(err?.details?.output)).toContain('bad file');
    expect(chunks.join('')).toContain('checking style');
    expect(r.git('rev-parse', 'HEAD').trim()).toBe(head);

    // "Commit skipping hooks" succeeds and adds co-author trailers once
    const ok = await run(r.svc, {
      ...op,
      skipHooks: true,
      description: 'Body\n\nCo-authored-by: Ada <ada@x.io>',
      coAuthors: [{ name: 'Bob', email: 'bob@x.io' }],
    });
    expect(ok.data).toMatchObject({ sha: expect.any(String) });
    const msg = r.git('log', '-1', '--format=%B');
    expect(msg).toContain('Co-authored-by: Ada <ada@x.io>\nCo-authored-by: Bob <bob@x.io>');
  });

  it('reads / saves the commit template and reports HEAD pushed + staged CRLF files', async () => {
    const r = await repos.make();
    expect(await readCommitTemplate(r.svc)).toEqual({});
    await run(r.svc, { type: 'commit.saveTemplate', scope: 'repo', text: 'feat: \r\n\r\n# Why?\r\n' });
    const t = await readCommitTemplate(r.svc);
    expect(t.text).toBe('feat: \n\n# Why?\n');
    expect(r.git('config', '--local', 'commit.template').trim()).toBe(t.path);
    // an existing commit.template is overwritten in place
    await run(r.svc, { type: 'commit.saveTemplate', scope: 'repo', text: 'fix: ' });
    expect((await readCommitTemplate(r.svc)).text).toBe('fix: \n');

    // HEAD pushed: a bare "remote" whose branch contains HEAD
    const remote = `${r.dir}-remote.git`;
    r.git('init', '--bare', remote);
    r.git('remote', 'add', 'origin', remote);
    r.git('push', '-u', 'origin', 'HEAD');
    await r.svc.refreshRepoInfo();
    expect((await commitContext(r.svc)).headPushed?.upstream).toMatch(/^origin\//);
    r.write('n.txt', 'n\n');
    r.git('add', 'n.txt');
    r.git('commit', '-m', 'local');
    expect((await commitContext(r.svc)).headPushed).toBeNull();

    // staged EOL issues (autocrlf off so CRLF reaches the index)
    r.git('config', 'core.autocrlf', 'false');
    r.write('crlf.txt', 'a\r\nb\r\n');
    r.write('mixed.txt', 'a\r\nb\n');
    r.write('lf.txt', 'a\n');
    r.git('add', 'crlf.txt', 'mixed.txt', 'lf.txt');
    expect((await stagedEolIssues(r.svc)).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'crlf.txt', eol: 'crlf' },
      { path: 'mixed.txt', eol: 'mixed' },
    ]);
  });

  it('createCommitServices wires drafts, suggestions and check-ignore', async () => {
    const r = await repos.make();
    r.git('commit', '--allow-empty', '-m', 'x', '--author', 'Ada Lovelace <ada@x.io>');
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cs-'));
    try {
      const svcs = createCommitServices({
        userDataDir: () => user,
        repos: { get: () => r.svc },
        collaborators: async () => [{ name: 'Carol', email: 'carol@x.io' }],
      });
      const ctx = { senderId: 1 };
      const list = await svcs.handlers['commit:coAuthorSuggestions']({ repoId: 'r', q: '' }, ctx);
      expect(list.map((c) => c.email)).toEqual(expect.arrayContaining(['ada@x.io', 'carol@x.io']));
      expect(list.map((c) => c.email)).not.toContain('t@example.com'); // the committer
      await svcs.handlers['commit:draft:set'](
        {
          repoId: 'r',
          branch: 'main',
          draft: { summary: 'S', description: '', coAuthors: [], updatedAt: 0 },
        },
        ctx,
      );
      expect((await svcs.handlers['commit:draft:get']({ repoId: 'r', branch: 'main' }, ctx))?.summary).toBe(
        'S',
      );
      r.write('.gitignore', '# top\n*.log\n');
      expect(await svcs.handlers['commit:checkIgnore']({ repoId: 'r', path: 'x.log' }, ctx)).toEqual({
        ignored: true,
        source: '.gitignore',
        line: 2,
        pattern: '*.log',
      });
      expect(await svcs.handlers['commit:checkIgnore']({ repoId: 'r', path: 'x.txt' }, ctx)).toEqual({
        ignored: false,
      });
    } finally {
      fs.rmSync(user, { recursive: true, force: true });
    }
  });
});
