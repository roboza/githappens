import { describe, expect, it, vi } from 'vitest';

import { AiService, type AiSettingKey } from '../src/main/ai/ai-service';
import { ContextBuilder } from '../src/main/ai/context-builder';
import { featureInstructions, resolveEffort } from '../src/main/ai/feature-settings';
import { systemPrompt } from '../src/main/ai/prompts';
import type { AiProvider, ProviderStreamOptions } from '../src/main/ai/providers/types';
import {
  AI_FEATURE_GROUP_OF,
  AI_FEATURE_GROUPS,
  type AiFeature,
  type AiStreamEvent,
} from '../src/shared/ipc/ai-contract';
import { defaultValues, validateSetting } from '../src/shared/settings/registry';
import { gitPath, useTestRepos } from './ai-test-repo';

const ALL_FEATURES = Object.keys(AI_FEATURE_GROUP_OF) as AiFeature[];

describe('per-feature effort resolution', () => {
  it('uses the feature defaults when nothing is set (auto)', () => {
    const got = Object.fromEntries(ALL_FEATURES.map((f) => [f, resolveEffort(f, 'auto', {})]));
    expect(got).toEqual({
      commitMessage: 'low',
      stashMessage: 'low',
      explainCommits: 'medium',
      explainBranch: 'medium',
      explainWip: 'medium',
      prDraft: 'medium',
      changelog: 'medium',
      conflictResolve: 'high',
      composeCommits: 'high',
    });
    expect(resolveEffort('commitMessage', undefined, undefined)).toBe('low');
  });

  it('a global effort beats the defaults; a per-feature override beats both', () => {
    expect(resolveEffort('conflictResolve', 'low', {})).toBe('low');
    expect(resolveEffort('conflictResolve', 'low', { conflicts: 'medium' })).toBe('medium');
    expect(resolveEffort('commitMessage', 'auto', { commit: 'high' })).toBe('high');
    // groups: one override covers every explain variant, and does not leak to other groups
    const o = { explain: 'low' } as const;
    expect(
      ['explainCommits', 'explainBranch', 'explainWip'].map((f) => resolveEffort(f as AiFeature, 'auto', o)),
    ).toEqual(['low', 'low', 'low']);
    expect(resolveEffort('prDraft', 'auto', o)).toBe('medium');
  });

  it('feature instructions are looked up by group and trimmed', () => {
    const map = { explain: '  Mention risks first. ', composer: '' };
    expect(featureInstructions('explainBranch', map)).toBe('Mention risks first.');
    expect(featureInstructions('composeCommits', map)).toBe('');
    expect(featureInstructions('commitMessage', map)).toBe('');
    expect(featureInstructions('commitMessage', undefined)).toBe('');
  });
});

describe('per-feature settings in the registry', () => {
  it('defaults to empty objects and validates group keys and values', () => {
    const d = defaultValues();
    expect(d['ai.effortOverrides']).toEqual({});
    expect(d['ai.featureInstructions']).toEqual({});
    expect(validateSetting('ai.effortOverrides', { commit: 'high', conflicts: 'low' }).ok).toBe(true);
    expect(validateSetting('ai.effortOverrides', { commit: 'auto' }).ok).toBe(false);
    expect(validateSetting('ai.effortOverrides', { nope: 'low' }).ok).toBe(false);
    expect(validateSetting('ai.featureInstructions', { pr: 'Link the issue.' }).ok).toBe(true);
    expect(validateSetting('ai.featureInstructions', { pr: 'x'.repeat(9000) }).ok).toBe(false);
    for (const g of AI_FEATURE_GROUPS)
      expect(validateSetting('ai.featureInstructions', { [g]: 'ok' }).ok).toBe(true);
  });
});

describe('system prompt instruction order', () => {
  it('merges global, then feature, then repository instructions (spec 12 §6.5)', () => {
    const p = systemPrompt('commitMessage', {
      commitStyle: 'free',
      language: '',
      instructions: 'GLOBAL-RULE',
      featureInstructions: 'FEATURE-RULE',
      repoInstructions: 'REPO-RULE',
    });
    const g = p.indexOf('GLOBAL-RULE');
    const f = p.indexOf('FEATURE-RULE');
    const r = p.indexOf('REPO-RULE');
    expect(g).toBeGreaterThan(0);
    expect(f).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(f);
    expect(p).toMatch(/for this feature/);
  });

  it('omits the feature section when empty', () => {
    const p = systemPrompt('prDraft', {
      commitStyle: 'free',
      language: '',
      instructions: '',
      featureInstructions: ' ',
    });
    expect(p).not.toMatch(/for this feature/);
  });
});

(gitPath ? describe : describe.skip)('commit message for an existing commit (Reword with AI)', () => {
  const repos = useTestRepos('aifeat');

  it("builds the context from that commit's diff with its message as a hint, ignoring staged changes", async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('b.txt', 'brand new file\nconst token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'wip stuff', '-m', 'old body');
    const sha = r.git('rev-parse', 'HEAD').trim();
    r.write('c.txt', 'staged later\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Add c');
    r.write('a.txt', 'staged change\n');
    r.git('add', '-A');
    const b = new ContextBuilder(r.svc, { maxChars: 120_000, excludeGlobs: [] });
    const ctx = await b.build({ requestId: 'x', repoId: r.svc.repo.id, feature: 'commitMessage', sha });
    const all = ctx.sections.map((s) => s.content).join('\n');
    expect(all).toContain('brand new file');
    expect(all).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(all).not.toContain('staged change');
    expect(all).not.toContain('staged later');
    expect(ctx.sections.find((s) => s.tag === 'current-message')?.content).toBe('wip stuff\n\nold body');
    expect(ctx.sections.find((s) => s.tag === 'recent-subjects')?.content).toBe('Initial commit');
    expect(ctx.task).toMatch(/being reworded/);

    // an edited message in the row wins over the commit's own; root commits have no recent subjects
    const root = r.git('rev-list', '--max-parents=0', 'HEAD').trim();
    const ctx2 = await b.build({
      requestId: 'y',
      repoId: r.svc.repo.id,
      feature: 'commitMessage',
      sha: root,
      current: 'Edited message',
      hint: 'shorter',
    });
    expect(ctx2.sections.find((s) => s.tag === 'current-message')?.content).toBe('Edited message');
    expect(ctx2.sections.some((s) => s.tag === 'recent-subjects')).toBe(false);
    expect(ctx2.task).toMatch(/shorter/);

    await expect(
      b.build({ requestId: 'z', repoId: r.svc.repo.id, feature: 'commitMessage', sha: '--output=x' }),
    ).rejects.toMatchObject({ code: 'provider' });
  });

  it('AiService applies the per-feature effort and instructions', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'changed\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Change a');
    const sha = r.git('rev-parse', 'HEAD').trim();
    const calls: ProviderStreamOptions[] = [];
    const provider: AiProvider = {
      id: 'anthropic',
      guaranteesSchema: true,
      async stream(o) {
        calls.push(o);
        return { text: '{"summary":"Update a","description":""}' };
      },
      test: vi.fn(async () => undefined),
    };
    const values = {
      ...defaultValues(),
      'ai.consent': 'anthropic|https://api.anthropic.com',
      'ai.instructions': 'GLOBAL-RULE',
      'ai.effortOverrides': { commit: 'high' },
      'ai.featureInstructions': { commit: 'COMMIT-RULE', pr: 'PR-RULE' },
    } as Record<string, unknown>;
    const events: AiStreamEvent[] = [];
    const svc = new AiService({
      settings: ((k: AiSettingKey) => values[k]) as never,
      secrets: { available: true, get: () => 'sk-ant-secret-1234', set: () => undefined, delete: () => true },
      profileId: () => 'p1',
      git: () => r.svc,
      emit: (e) => events.push(e),
      clientFactory: () => provider,
    });
    svc.run({ requestId: 'q1', repoId: r.svc.repo.id, feature: 'commitMessage', sha });
    await vi.waitFor(
      () => {
        if (!events.some((e) => e.kind !== 'delta')) throw new Error('pending');
      },
      { timeout: 15_000, interval: 20 },
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done', result: { summary: 'Update a' } });
    const o = calls[0]!;
    expect(o.effort).toBe('high');
    expect(o.system).toContain('GLOBAL-RULE');
    expect(o.system).toContain('COMMIT-RULE');
    expect(o.system).not.toContain('PR-RULE');
    expect(o.system.indexOf('COMMIT-RULE')).toBeGreaterThan(o.system.indexOf('GLOBAL-RULE'));
    expect(o.user).toContain('changed');
  });
});
