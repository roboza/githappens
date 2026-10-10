import type { PrIndexEntry, RepoRef } from '@githappens/providers/types';
import { describe, expect, it } from 'vitest';

import {
  branchNameForIssue,
  buildPrIndex,
  defaultMergeCommit,
  defaultPrSides,
  describeProviderError,
  entryMatches,
  humanizeBranch,
  INTEGRATION_CATALOG,
  mergeabilitySummary,
  normalizeHost,
  parseInline,
  parseMarkdown,
  pickRefForPr,
  prBadgeTitle,
  prFilterKey,
  slugify,
} from '../src/renderer/src/integrations/helpers';

const NOW = Date.UTC(2026, 0, 1, 10, 0, 0);

describe('branchNameForIssue', () => {
  it('uses Jira keys verbatim with a slug of the title', () => {
    expect(branchNameForIssue({ key: 'ABC-12', title: 'Add login form' })).toBe('ABC-12-add-login-form');
  });

  it('strips the # of GitHub/GitLab issue numbers', () => {
    expect(branchNameForIssue({ key: '#42', title: 'Crash on start!' })).toBe('42-crash-on-start');
  });

  it('folds diacritics and drops emoji / punctuation', () => {
    expect(branchNameForIssue({ key: 'ABC-1', title: 'Café ☕ — “naïve” fix…' })).toBe(
      'ABC-1-cafe-naive-fix',
    );
  });

  it('never produces forbidden ref sequences', () => {
    const name = branchNameForIssue({ key: '#7', title: 'foo..bar @{u} x.lock' });
    expect(name).toBe('7-foo-bar-u-x-lock');
    expect(name).not.toMatch(/\.\.|@\{|\.lock$|[~^:?*[\\\s]/);
  });

  it('caps at 60 chars on a word boundary without a trailing dash', () => {
    const name = branchNameForIssue({
      key: 'PROJ-1234',
      title: 'Implement the extremely long feature description that keeps going and going',
    });
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.startsWith('PROJ-1234-implement-')).toBe(true);
    expect(name.endsWith('-')).toBe(false);
    expect(name).toBe('PROJ-1234-implement-the-extremely-long-feature-description');
  });

  it('falls back to the key, or "issue" when nothing is usable', () => {
    expect(branchNameForIssue({ key: 'ABC-9', title: '!!!' })).toBe('ABC-9');
    expect(branchNameForIssue({ key: '#', title: '' })).toBe('issue');
  });

  it('keeps Trello / Azure keys', () => {
    expect(branchNameForIssue({ key: 'aBc123', title: 'Card' })).toBe('aBc123-card');
    expect(branchNameForIssue({ key: '5012', title: 'Work item' })).toBe('5012-work-item');
  });
});

describe('slugify', () => {
  it('lowercases and collapses separators', () => {
    expect(slugify('  Hello,   World__Again ')).toBe('hello-world-again');
  });
});

describe('humanizeBranch', () => {
  it('formats issue-key branches', () => {
    expect(humanizeBranch('feature/ABC-12-add-login')).toBe('ABC-12 Add login');
  });
  it('formats plain branches', () => {
    expect(humanizeBranch('fix/crash_on-start')).toBe('Crash on start');
    expect(humanizeBranch('main')).toBe('Main');
  });
  it('handles a bare key', () => {
    expect(humanizeBranch('abc-12')).toBe('ABC-12');
  });
});

describe('normalizeHost', () => {
  it('strips scheme, credentials, path and case', () => {
    expect(normalizeHost('https://user@GHE.Acme.com/some/path/')).toBe('ghe.acme.com');
    expect(normalizeHost('gitlab.acme.com:8443')).toBe('gitlab.acme.com:8443');
  });
  it('rejects garbage', () => {
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('not a host')).toBeNull();
    expect(normalizeHost('-bad.com')).toBeNull();
  });
});

describe('entryMatches', () => {
  const byId = (id: string) => INTEGRATION_CATALOG.find((e) => e.id === id)!;
  it('separates cloud from self-hosted accounts of the same kind', () => {
    expect(entryMatches(byId('github'), { kind: 'github', host: 'github.com' })).toBe(true);
    expect(entryMatches(byId('github'), { kind: 'github', host: 'ghe.acme.com' })).toBe(false);
    expect(entryMatches(byId('github-enterprise'), { kind: 'github', host: 'ghe.acme.com' })).toBe(true);
    expect(entryMatches(byId('jira-cloud'), { kind: 'jira-cloud', host: 'acme.atlassian.net' })).toBe(true);
    expect(entryMatches(byId('jira-dc'), { kind: 'jira-cloud', host: 'acme.atlassian.net' })).toBe(false);
  });
});

describe('describeProviderError', () => {
  it('maps auth_required to a reconnect action', () => {
    const f = describeProviderError({ message: '401', details: { providerCode: 'auth_required' } }, NOW);
    expect(f).toMatchObject({ code: 'auth_required', title: 'Reconnect account', action: 'reconnect' });
  });
  it('shows the retry time for rate limits', () => {
    const f = describeProviderError(
      { message: 'rate', details: { providerCode: 'rate_limited', retryAt: NOW + 4 * 60_000 } },
      NOW,
    );
    expect(f.title).toBe('Rate limit reached');
    expect(f.detail).toMatch(/^Try again in 4 min/);
    expect(f.retryAt).toBe(NOW + 4 * 60_000);
  });
  it('lists missing scopes', () => {
    const f = describeProviderError(
      {
        message: 'scope',
        details: { providerCode: 'insufficient_scope', missingScopes: ['repo', 'read:org'] },
      },
      NOW,
    );
    expect(f.detail).toBe('Reconnect to grant: repo, read:org');
  });
  it('keeps the message for non-provider errors', () => {
    expect(describeProviderError({ message: 'boom' }, NOW)).toEqual({ title: 'boom', action: 'retry' });
    expect(
      describeProviderError({ message: 'x', details: { providerCode: 'weird' } }, NOW).code,
    ).toBeUndefined();
  });
});

const entry = (
  remote: string,
  branch: string,
  number: number,
  state: PrIndexEntry['pr']['state'],
): PrIndexEntry => ({
  remote,
  branch,
  pr: {
    number,
    title: `PR ${number}`,
    state,
    rollup: 'success',
    webUrl: `https://github.com/o/r/pull/${number}`,
  },
});

describe('buildPrIndex', () => {
  it('indexes by remote/branch and bare branch', () => {
    const m = buildPrIndex([entry('origin', 'feature/x', 1, 'open')]);
    expect(m.get('origin/feature/x')?.pr.number).toBe(1);
    expect(m.get('feature/x')?.pr.number).toBe(1);
  });
  it('prefers open over merged/closed for the same branch', () => {
    const m = buildPrIndex([
      entry('origin', 'x', 1, 'closed'),
      entry('origin', 'x', 2, 'open'),
      entry('upstream', 'x', 3, 'merged'),
    ]);
    expect(m.get('x')?.pr.number).toBe(2);
    expect(m.get('upstream/x')?.pr.number).toBe(3);
  });
  it('strips refs/heads/', () => {
    expect(buildPrIndex([entry('origin', 'refs/heads/y', 4, 'draft')]).has('origin/y')).toBe(true);
  });
});

describe('prBadgeTitle', () => {
  it('includes stack position and check summary', () => {
    expect(
      prBadgeTitle({
        number: 9,
        title: 'Add login',
        state: 'open',
        rollup: 'success',
        webUrl: '',
        stack: { position: 2, size: 3 },
      }),
    ).toBe('#9 Add login (2 of 3 in stack) — open, checks passing');
  });
});

const ref = (owner: string, name: string): RepoRef => ({
  integration: { kind: 'github', host: 'github.com', accountId: '1' },
  owner,
  name,
});

describe('pickRefForPr', () => {
  const remotes = [
    { remote: 'origin', ref: ref('me', 'repo') },
    { remote: 'upstream', ref: ref('acme', 'repo') },
    { remote: 'other' },
  ];
  it('picks the repo that hosts the PR (fork PRs live on the parent)', () => {
    expect(pickRefForPr(remotes, 'https://github.com/acme/repo/pull/5', 'origin')?.owner).toBe('acme');
  });
  it('falls back to the head remote', () => {
    expect(pickRefForPr(remotes, 'https://example.com/x', 'origin')?.owner).toBe('me');
    expect(pickRefForPr(remotes, 'nope', 'other')).toBeNull();
  });
});

describe('defaultPrSides', () => {
  const refs = [
    {
      type: 'local',
      shortName: 'feature/x',
      fullName: 'refs/heads/feature/x',
      upstream: { fullName: 'refs/remotes/fork/feature/x' },
    },
    { type: 'remote', shortName: 'fork/feature/x', fullName: 'refs/remotes/fork/feature/x' },
    { type: 'remote', shortName: 'origin/develop', fullName: 'refs/remotes/origin/develop' },
    {
      type: 'remote',
      shortName: 'origin/HEAD',
      fullName: 'refs/remotes/origin/HEAD',
      symrefTarget: 'refs/remotes/origin/develop',
    },
    { type: 'remote', shortName: 'upstream/master', fullName: 'refs/remotes/upstream/master' },
  ];
  it('uses the upstream remote of the branch and origin HEAD as base', () => {
    expect(defaultPrSides(['origin', 'fork'], refs, 'feature/x')).toEqual({
      headRemote: 'fork',
      headBranch: 'feature/x',
      baseRemote: 'origin',
      baseBranch: 'develop',
    });
    expect(defaultPrSides(['origin', 'fork'], refs, 'feature/x', 'origin/develop')).toEqual({
      headRemote: 'fork',
      headBranch: 'feature/x',
      baseRemote: 'origin',
      baseBranch: 'develop',
    });
  });
  it('prefers upstream as base in fork workflows and splits remote-tracking names', () => {
    expect(defaultPrSides(['origin', 'upstream', 'fork'], refs, 'fork/feature/x')).toEqual({
      headRemote: 'fork',
      headBranch: 'feature/x',
      baseRemote: 'upstream',
      baseBranch: 'master',
    });
  });
  it('defaults the base from the remote HEAD', () => {
    expect(defaultPrSides(['origin'], refs, 'topic').baseBranch).toBe('develop');
  });
});

describe('merge helpers', () => {
  const pr = { number: 7, title: 'Add x', body: '', head: { branch: 'feat', repo: ref('me', 'r') } };
  it('prefills commit messages per method', () => {
    expect(defaultMergeCommit(pr, 'squash')).toEqual({ title: 'Add x (#7)', message: '' });
    expect(defaultMergeCommit(pr, 'merge')?.title).toBe('Merge pull request #7 from me/feat');
    expect(defaultMergeCommit(pr, 'rebase')).toBeNull();
  });
  it('summarizes mergeability', () => {
    expect(
      mergeabilitySummary({ state: 'open', mergeable: 'conflicting', checksRollup: 'success' }).blocked,
    ).toBe(true);
    expect(mergeabilitySummary({ state: 'open', mergeable: 'mergeable', checksRollup: 'failure' }).tone).toBe(
      'red',
    );
    expect(
      mergeabilitySummary({
        state: 'open',
        mergeable: 'mergeable',
        checksRollup: 'success',
        reviewDecision: 'approved',
      }).tone,
    ).toBe('green');
    expect(mergeabilitySummary({ state: 'draft', checksRollup: 'none' }).blocked).toBe(true);
  });
});

describe('prFilterKey', () => {
  it('is stable and distinguishes presets', () => {
    expect(prFilterKey({ preset: 'mine', state: 'open' })).toBe(
      prFilterKey({ state: 'open', preset: 'mine' }),
    );
    expect(prFilterKey({ preset: 'mine' })).not.toBe(prFilterKey({ preset: 'all' }));
  });
});

describe('markdown parser', () => {
  it('parses headings, lists, tasks, code and quotes', () => {
    const blocks = parseMarkdown(
      '# Title\n\nSome **bold** and `code`.\n\n- [x] done\n- [ ] todo\n\n```ts\nconst a = 1;\n```\n\n> quoted\n\n---\n1. one\n2. two',
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'list', 'code', 'quote', 'rule', 'list']);
    const tasks = blocks[2] as Extract<(typeof blocks)[number], { t: 'list' }>;
    expect(tasks.items.map((i) => i.checked)).toEqual([true, false]);
    expect((blocks[3] as { v: string }).v).toBe('const a = 1;');
    expect((blocks[6] as { ordered: boolean }).ordered).toBe(true);
  });

  it('drops HTML comments (PR templates) and unsafe links', () => {
    expect(parseMarkdown('<!-- hidden -->\nVisible')).toEqual([
      { t: 'para', v: [{ t: 'text', v: 'Visible' }] },
    ]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { t: 'text', v: 'x' },
      { t: 'text', v: ')' },
    ]);
  });

  it('autolinks bare URLs without trailing punctuation', () => {
    expect(parseInline('see https://x.dev/a.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://x.dev/a', v: [{ t: 'text', v: 'https://x.dev/a' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('does not treat snake_case as italics', () => {
    expect(parseInline('a snake_case_name here')).toEqual([{ t: 'text', v: 'a snake_case_name here' }]);
  });

  it('never stalls on odd input', () => {
    expect(() => parseMarkdown('####### seven\n```\nunterminated')).not.toThrow();
  });
});
