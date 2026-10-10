import { describe, expect, it } from 'vitest';

import {
  appendQuote,
  checkCounts,
  checkDuration,
  issueWebUrl,
  parseLinkedIssues,
  prViewCaps,
  quoteMarkdown,
  repoWebUrlFromPr,
  userIdent,
} from '../src/renderer/src/views/pr/pr-view-helpers';

describe('pr-view-helpers', () => {
  it('quotes markdown and appends to a draft', () => {
    expect(quoteMarkdown('a\n\nb\n')).toBe('> a\n>\n> b');
    expect(appendQuote('', 'hi')).toBe('> hi\n\n');
    expect(appendQuote('', 'hi', 'bob')).toBe('> **@bob** wrote:\n>\n> hi\n\n');
    expect(appendQuote('first  \n', 'x')).toBe('first\n\n> x\n\n');
  });

  it('parses closing refs, cross-repo refs and Jira keys', () => {
    const refs = parseLinkedIssues(
      'ABC-12: fix login',
      'Fixes #4, closes acme/api#9.\nSee other/repo#3. Uses UTF-8 and SHA-256.\nresolved #4',
      'feature/XYZ-7-thing',
    );
    expect(refs).toEqual([
      { kind: 'number', number: 4, closing: true },
      { kind: 'number', number: 9, repo: 'acme/api', closing: true },
      { kind: 'number', number: 3, repo: 'other/repo', closing: false },
      { kind: 'jira', key: 'ABC-12' },
      { kind: 'jira', key: 'XYZ-7' },
    ]);
    expect(parseLinkedIssues('', '', '')).toEqual([]);
  });

  it('derives repo and issue web urls', () => {
    expect(repoWebUrlFromPr('https://github.com/o/r/pull/12')).toBe('https://github.com/o/r');
    expect(repoWebUrlFromPr('https://gitlab.com/g/s/p/-/merge_requests/3')).toBe('https://gitlab.com/g/s/p');
    expect(repoWebUrlFromPr('https://example.com/nothing')).toBeNull();
    expect(issueWebUrl('github', 'https://github.com/o/r/pull/12', 4)).toBe(
      'https://github.com/o/r/issues/4',
    );
    expect(issueWebUrl('github', 'https://github.com/o/r/pull/12', 9, 'acme/api')).toBe(
      'https://github.com/acme/api/issues/9',
    );
    expect(issueWebUrl('gitlab', 'https://gitlab.com/g/p/-/merge_requests/3', 2)).toBe(
      'https://gitlab.com/g/p/-/issues/2',
    );
    expect(issueWebUrl('bitbucket', 'https://bitbucket.org/w/r/pull-requests/1', 2)).toBeNull();
  });

  it('capabilities and identifiers per provider', () => {
    expect(prViewCaps('github').prAutoMerge).toBe(true);
    expect(prViewCaps('bitbucket').prLabels).toBe(false);
    expect(prViewCaps('unknown').prDraft).toBe(false);
    expect(userIdent('github', { id: '1', login: 'bob' })).toBe('bob');
    expect(userIdent('bitbucket', { id: '{u}', login: 'bob' })).toBe('{u}');
  });

  it('summarises checks', () => {
    const base = { id: 'x', name: 'n', canRerun: false, provider: 'actions' as const };
    expect(
      checkCounts([
        { ...base, status: 'success' },
        { ...base, status: 'failure' },
        { ...base, status: 'in_progress' },
        { ...base, status: 'skipped' },
      ]),
    ).toEqual({ passed: 1, failed: 1, pending: 1, other: 1 });
    expect(checkDuration({ startedAt: '2024-01-01T00:00:00Z', completedAt: '2024-01-01T00:01:05Z' })).toBe(
      '1m 5s',
    );
  });
});
