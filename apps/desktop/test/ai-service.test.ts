import { describe, expect, it, vi } from 'vitest';

import { AiService, type AiServiceDeps, type AiSettingKey } from '../src/main/ai/ai-service';
import { AiProviderError, type AiProvider, type ProviderStreamOptions } from '../src/main/ai/providers/types';
import type { AiRequest, AiStreamEvent, ComposeResult } from '../src/shared/ipc/ai-contract';
import { defaultValues } from '../src/shared/settings/registry';
import { gitPath, useTestRepos, type TestRepo } from './ai-test-repo';

/** Generous: context building runs real git, which is slow when the whole monorepo tests in parallel. */
const WAIT = { timeout: 15_000, interval: 20 };

type Script = (o: ProviderStreamOptions, call: number) => Promise<string>;

/** Provider whose behavior is a script; records every call. */
function fakeProvider(script: Script, guaranteesSchema = true) {
  const calls: ProviderStreamOptions[] = [];
  const provider: AiProvider = {
    id: 'anthropic',
    guaranteesSchema,
    async stream(o) {
      calls.push(o);
      const text = await script(o, calls.length);
      return { text, usage: { inputTokens: 1, outputTokens: 2 } };
    },
    test: vi.fn(async () => undefined),
  };
  return { provider, calls };
}

function setup(
  repo: TestRepo | null,
  provider: AiProvider,
  over: Partial<Record<AiSettingKey, unknown>> = {},
) {
  const values = {
    ...defaultValues(),
    'ai.consent': 'anthropic|https://api.anthropic.com',
    ...over,
  } as Record<string, unknown>;
  const store = new Map<string, string>([['p1/ai/anthropic', 'sk-ant-secret-1234']]);
  const events: AiStreamEvent[] = [];
  const deps: AiServiceDeps = {
    settings: ((k: AiSettingKey) => values[k]) as AiServiceDeps['settings'],
    secrets: {
      available: true,
      get: (a) => store.get(a) ?? null,
      set: (a, s) => void store.set(a, s),
      delete: (a) => store.delete(a),
    },
    profileId: () => 'p1',
    git: () => {
      if (!repo) throw new Error('no repo');
      return repo.svc;
    },
    emit: (e) => events.push(e),
    clientFactory: () => provider,
  };
  const svc = new AiService(deps);
  /** Run a request and resolve with its events once done/error arrives. */
  const run = async (req: Omit<AiRequest, 'requestId' | 'repoId'> & { requestId?: string }) => {
    const requestId = req.requestId ?? `r${Math.random()}`;
    svc.run({ repoId: repo?.svc.repo.id ?? 'none', ...req, requestId } as AiRequest, 7);
    await vi.waitFor(() => {
      if (!events.some((e) => e.requestId === requestId && e.kind !== 'delta')) throw new Error('pending');
    }, WAIT);
    return events.filter((e) => e.requestId === requestId);
  };
  return { svc, events, store, values, run };
}

describe('AiService state checks', () => {
  const never = fakeProvider(async () => {
    throw new Error('must not be called');
  });

  it('reports status and never exposes the key', async () => {
    const { svc } = setup(null, never.provider);
    const st = await svc.status();
    expect(st).toMatchObject({
      enabled: true,
      configured: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      needsConsent: false,
    });
    expect(JSON.stringify(st)).not.toContain('sk-ant');
    expect(svc.keyStatus()).toEqual({ hasKey: true, last4: '1234' });
    expect(svc.setKey('openai', '  sk-openai-abcd  ')).toEqual({ hasKey: true, last4: 'abcd' });
    expect(() => svc.setKey('openai', 'two words')).toThrow();
    expect(svc.clearKey('openai')).toEqual({ hasKey: false });
  });

  it('fails fast when disabled, without consent or without a key', async () => {
    const disabled = setup(null, never.provider, { 'ai.enabled': false });
    expect((await disabled.run({ feature: 'explainWip' })).at(-1)?.error?.code).toBe('disabled');
    const consent = setup(null, never.provider, { 'ai.consent': '' });
    expect((await consent.run({ feature: 'explainWip' })).at(-1)?.error?.code).toBe('consent');
    expect((await consent.svc.status()).needsConsent).toBe(true);
    const nokey = setup(null, never.provider);
    nokey.store.clear();
    expect((await nokey.run({ feature: 'explainWip' })).at(-1)?.error?.code).toBe('no-key');
    expect(never.calls).toHaveLength(0);
  });

  it('testConnection reports ok/latency or the mapped error', async () => {
    const { svc } = setup(null, never.provider);
    expect(await svc.testConnection({})).toMatchObject({ ok: true });
    (never.provider.test as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new AiProviderError('auth', 'bad key'),
    );
    expect(await svc.testConnection({})).toMatchObject({ ok: false, error: { code: 'auth' } });
  });
});

(gitPath ? describe : describe.skip)('AiService requests', () => {
  const repos = useTestRepos('aisvc');

  it('streams a commit message: partial fills, then the post-processed result', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'b\n');
    r.git('add', '-A');
    const json = '{"summary":"Update a.txt.","description":"Because reasons."}';
    const f = fakeProvider(async (o) => {
      for (const ch of json.match(/.{1,6}/g)!) o.onText(ch);
      return json;
    });
    const { run } = setup(r, f.provider);
    const ev = await run({ feature: 'commitMessage' });
    const partials = ev.filter((e) => e.partial).map((e) => (e.partial as { summary: string }).summary);
    expect(partials.length).toBeGreaterThan(1);
    expect(partials.at(-1)).toBe('Update a.txt.');
    expect(ev.at(-1)).toMatchObject({
      kind: 'done',
      result: { summary: 'Update a.txt', description: 'Because reasons.' },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const o = f.calls[0]!;
    expect(o.effort).toBe('low');
    expect(o.maxTokens).toBe(2000);
    expect(o.model).toBe('claude-sonnet-5-5');
    expect(o.user).toContain('<diff>');
    expect(o.system).toMatch(/data from the user's repository/);
  });

  it('streams markdown deltas for explain and honors githappens.ai=false', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'changed\n');
    const f = fakeProvider(async (o) => {
      o.onText('## Summary\n');
      o.onText('Changes a.');
      return '## Summary\nChanges a.';
    });
    const { run } = setup(r, f.provider);
    const ev = await run({ feature: 'explainWip' });
    expect(ev.filter((e) => e.kind === 'delta').map((e) => e.text)).toEqual(['## Summary\n', 'Changes a.']);
    expect(ev.at(-1)?.result).toEqual({ markdown: '## Summary\nChanges a.' });
    expect(f.calls[0]!.effort).toBe('medium');
    r.git('config', 'githappens.ai', 'false');
    expect((await run({ feature: 'explainWip' })).at(-1)?.error?.code).toBe('repo-disabled');
  });

  it('cancels a running request and limits concurrency to 2 per window', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'changed\n');
    let started = 0;
    const f = fakeProvider(
      (o) =>
        new Promise((_res, rej) => {
          started++;
          o.signal.addEventListener('abort', () => rej(new AiProviderError('cancelled', 'Cancelled.')));
        }),
    );
    const { svc, events } = setup(r, f.provider);
    for (const id of ['c1', 'c2', 'c3'])
      svc.run({ requestId: id, repoId: r.svc.repo.id, feature: 'explainWip' }, 1);
    await vi.waitFor(() => expect(started).toBe(2), WAIT);
    svc.cancel('c3'); // queued
    svc.cancel('c1'); // running
    await vi.waitFor(() => {
      expect(events.find((e) => e.requestId === 'c1')?.error?.code).toBe('cancelled');
      expect(events.find((e) => e.requestId === 'c3')?.error?.code).toBe('cancelled');
    }, WAIT);
    svc.cancelAll(1);
    await vi.waitFor(
      () => expect(events.find((e) => e.requestId === 'c2')?.error?.code).toBe('cancelled'),
      WAIT,
    );
    expect(started).toBe(2);
  });

  it('maps provider errors and repairs invalid JSON once for non-schema providers', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'b\n');
    r.git('add', '-A');
    const limited = fakeProvider(async () => {
      throw new AiProviderError('rate-limit', 'slow', 3000);
    });
    expect((await setup(r, limited.provider).run({ feature: 'commitMessage' })).at(-1)?.error).toEqual({
      code: 'rate-limit',
      message: 'slow',
      retryAfterMs: 3000,
    });

    const flaky = fakeProvider(
      async (_o, n) => (n === 1 ? 'Here you go: summary = oops' : '{"summary":"Fix","description":""}'),
      false,
    );
    const ev = await setup(r, flaky.provider).run({ feature: 'commitMessage' });
    expect(ev.some((e) => e.reset)).toBe(true);
    expect(ev.at(-1)?.result).toEqual({ summary: 'Fix', description: '' });
    expect(flaky.calls[1]!.user).toMatch(/could not be used/);

    const bad = fakeProvider(async () => 'not json', false);
    expect((await setup(r, bad.provider).run({ feature: 'commitMessage' })).at(-1)?.error?.code).toBe(
      'invalid-output',
    );
  });

  it('returns a validated compose proposal with hunk catalog and diff hash', async () => {
    const r = await repos.make({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.write('a.txt', 'a2\n');
    r.write('b.txt', 'b2\n');
    r.write('c.txt', 'c\n');
    r.git('add', '-A');
    const f = fakeProvider(async () =>
      JSON.stringify({
        commits: [
          { summary: 'Touch a', description: '', hunkIds: ['a.txt#0', 'ghost#9'] },
          { summary: 'Add c.', description: '', hunkIds: ['c.txt#0', 'a.txt#0'] },
        ],
      }),
    );
    const ev = await setup(r, f.provider).run({ feature: 'composeCommits', source: { kind: 'staged' } });
    const res = ev.at(-1)?.result as ComposeResult;
    expect(res.commits.map((c) => [c.summary, c.hunks.map((h) => h.hunkId)])).toEqual([
      ['Touch a', ['a.txt#0']],
      ['Add c', ['c.txt#0']],
    ]);
    expect(res.unassigned).toEqual([{ path: 'b.txt', hunkId: 'b.txt#0' }]);
    expect(res.hunks.map((h) => h.hunkId)).toEqual(['a.txt#0', 'b.txt#0', 'c.txt#0']);
    expect(res.diffHash).toMatch(/^[0-9a-f]{16}$/);
    expect(f.calls[0]!.effort).toBe('high');
    expect(f.calls[0]!.maxTokens).toBe(16000);
  });

  it('prepends generated markdown to CHANGELOG.md', async () => {
    const r = await repos.make({ 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n- First\n' });
    const { svc } = setup(r, fakeProvider(async () => '').provider);
    svc.saveChangelog(r.svc.repo.id, '## 1.1.0\n- Second');
    const fs = await import('node:fs');
    const path = await import('node:path');
    expect(fs.readFileSync(path.join(r.dir, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## 1.1.0\n- Second\n\n## 1.0.0\n- First\n',
    );
  });
});
