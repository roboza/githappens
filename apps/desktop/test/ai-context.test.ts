import { describe, expect, it } from 'vitest';

import {
  ContextBuilder,
  fitDiff,
  globToRegExp,
  makeExcluder,
  readRepoInstructions,
  redactSecrets,
  repoAiDisabled,
  TRUNCATED,
} from '../src/main/ai/context-builder';
import { AiProviderError } from '../src/main/ai/providers/types';
import { gitPath, useTestRepos } from './ai-test-repo';

const DEFAULT_GLOBS = ['**/*.lock', '**/pnpm-lock.yaml', '**/*.min.js', '**/dist/**', '**/.env*'];
const text = (s: { content: string }[]): string => s.map((x) => x.content).join('\n');

describe('AI context helpers', () => {
  it('matches exclude globs at any depth', () => {
    expect(globToRegExp('**/dist/**').test('pkg/dist/a.js')).toBe(true);
    expect(globToRegExp('*.lock').test('deep/yarn.lock')).toBe(true);
    const ex = makeExcluder(DEFAULT_GLOBS);
    expect(ex('.env.local')).toBe(true);
    expect(ex('web/app.min.js')).toBe(true);
    expect(ex('src/app.ts')).toBe(false);
  });

  it('redacts secrets, private key blocks and .env values', () => {
    const diff = [
      '+const k = "AKIAABCDEFGHIJKLMNOP";',
      '+api_key = "abcdef1234567890"',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEpAIBAAKCAQEA',
      '+-----END RSA PRIVATE KEY-----',
      ' const token = process.env.TOKEN;',
    ].join('\n');
    const out = redactSecrets(diff);
    expect(out).not.toMatch(/AKIA|abcdef1234567890|MIIEpA/);
    expect(out.split('\n')).toHaveLength(6);
    expect(out.split('\n')[2]).toBe('+[REDACTED]');
    expect(out).toContain(' const token = process.env.TOKEN;');
    expect(redactSecrets('+DB_PASSWORD=hunter2\n+# comment', 'config/.env.production')).toBe(
      '+DB_PASSWORD=[REDACTED]\n+# comment',
    );
  });

  it('budgets a diff: drops excluded/binary files, truncates patches, then fails as too-large', () => {
    const file = (p: string, n: number): string =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,${n} +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')}`;
    const raw = [
      file('src/a.ts', 300),
      file('yarn.lock', 50),
      'diff --git a/img.png b/img.png\nindex 1..2\nBinary files a/img.png and b/img.png differ',
    ].join('\n');
    const ex = makeExcluder(DEFAULT_GLOBS);
    const full = fitDiff(raw, 1_000_000, ex);
    expect(full.truncated).toBe(false);
    expect(full.omitted).toEqual(['yarn.lock', 'img.png (binary)']);
    expect(full.text).not.toContain('yarn.lock');
    const cut = fitDiff(raw, 1500, ex);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain(TRUNCATED);
    expect(cut.text.length).toBeLessThanOrEqual(1500);
    expect(() => fitDiff(raw, 50, ex)).toThrow(AiProviderError);
  });
});

(gitPath ? describe : describe.skip)('ContextBuilder on a repository', () => {
  const repos = useTestRepos('aictx');

  it('builds the commit message context from staged changes only, with exclusions and redaction', async () => {
    const r = await repos.make({ 'src/app.ts': 'export const a = 1;\n', 'pnpm-lock.yaml': 'v: 1\n' });
    r.write('src/app.ts', 'export const a = 2;\nconst secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";\n');
    r.write('pnpm-lock.yaml', 'v: 2\n');
    r.write('unstaged.txt', 'not staged\n');
    r.git('add', 'src/app.ts', 'pnpm-lock.yaml');
    r.git('switch', '-q', '-c', 'feature/ABC-123-thing');
    const b = new ContextBuilder(r.svc, { maxChars: 120_000, excludeGlobs: DEFAULT_GLOBS });
    const ctx = await b.build({ requestId: 'x', repoId: r.svc.repo.id, feature: 'commitMessage' });
    const all = text(ctx.sections);
    expect(all).toContain('export const a = 2;');
    expect(all).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz');
    expect(all).toContain('[REDACTED]');
    expect(all).not.toContain('not staged');
    expect(all).not.toContain('v: 2');
    expect(ctx.omitted).toEqual(['pnpm-lock.yaml']);
    expect(ctx.notes.join('\n')).toMatch(/issue key ABC-123/);
    expect(ctx.sections.find((s) => s.tag === 'recent-subjects')?.content).toBe('Initial commit');
  });

  it('reports nothing staged, truncates to the budget, and too-large when it cannot fit', async () => {
    const r = await repos.make({ 'big.txt': 'x\n' });
    const b = (maxChars: number) => new ContextBuilder(r.svc, { maxChars, excludeGlobs: [] });
    const req = { requestId: 'x', repoId: r.svc.repo.id, feature: 'commitMessage' as const };
    await expect(b(120_000).build(req)).rejects.toMatchObject({ code: 'nothing' });
    r.write('big.txt', Array.from({ length: 3000 }, (_, i) => `line number ${i}`).join('\n'));
    r.git('add', '-A');
    const ctx = await b(10_000).build(req);
    expect(ctx.truncated).toBe(true);
    expect(text(ctx.sections)).toContain(TRUNCATED);
    await expect(b(300).build(req)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('explains a branch against its merge base and reports the range', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.git('switch', '-q', '-c', 'topic');
    r.write('b.txt', 'b\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Add b');
    r.write('c.txt', 'c\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Add c');
    r.git('switch', '-q', 'main');
    r.write('main.txt', 'm\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'Main moves on');
    const b = new ContextBuilder(r.svc, { maxChars: 120_000, excludeGlobs: [] });
    const ctx = await b.build({
      requestId: 'x',
      repoId: r.svc.repo.id,
      feature: 'explainBranch',
      branch: 'topic',
    });
    expect(ctx.range).toMatchObject({ baseRef: 'main', commits: 2, files: 2 });
    const all = text(ctx.sections);
    expect(all).toContain('Add c');
    expect(all).not.toContain('main.txt');
  });

  it('builds compose hunks with stable ids and honors githappens.ai / repo instructions', async () => {
    const r = await repos.make({ 'a.txt': 'a\n' });
    r.write('a.txt', 'a2\n');
    r.write('n.txt', 'n\n');
    r.git('add', '-A');
    const b = new ContextBuilder(r.svc, { maxChars: 120_000, excludeGlobs: [] });
    const ctx = await b.build({
      requestId: 'x',
      repoId: r.svc.repo.id,
      feature: 'composeCommits',
      source: { kind: 'staged' },
    });
    expect(ctx.compose!.hunks.map((h) => h.hunkId)).toEqual(['a.txt#0', 'n.txt#0']);
    expect(ctx.sections.map((s) => s.attrs?.id)).toEqual(['a.txt#0', 'n.txt#0']);
    expect(await repoAiDisabled(r.svc)).toBe(false);
    r.git('config', 'githappens.ai', 'false');
    expect(await repoAiDisabled(r.svc)).toBe(true);
    r.write('.githappens/ai-instructions.md', 'Use scope "core".');
    expect(readRepoInstructions(r.svc)).toBe('Use scope "core".');
  });
});
