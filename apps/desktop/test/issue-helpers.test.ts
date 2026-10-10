import type { Issue } from '@githappens/providers/types';
import { describe, expect, it } from 'vitest';

import {
  defaultTransition,
  htmlToText,
  issueBodyText,
  issueRefOf,
  parseLabels,
  pillBranchName,
  supportsIssueType,
  trackerInfo,
  validateBranchName,
} from '../src/renderer/src/integrations/issue-helpers';

const issue = (over: Partial<Issue> = {}): Issue => ({
  tracker: {
    kind: 'jira-cloud',
    integration: { kind: 'jira-cloud', host: 'x.atlassian.net', accountId: 'u1' },
    scope: 'site/ABC',
  },
  key: 'ABC-12',
  id: '1012',
  title: 'Fix login',
  body: '',
  bodyFormat: 'markdown',
  state: 'To Do',
  stateCategory: 'todo',
  assignees: [],
  labels: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  webUrl: 'https://x.atlassian.net/browse/ABC-12',
  ...over,
});

describe('validateBranchName', () => {
  it('accepts normal names', () => {
    expect(validateBranchName('ABC-12-fix-login')).toBeNull();
    expect(validateBranchName('feature/ABC-12')).toBeNull();
    expect(validateBranchName('  42-trim  ')).toBeNull();
  });
  it.each([
    [''],
    ['   '],
    ['has space'],
    ['a..b'],
    ['a@{b'],
    ['@'],
    ['x.lock'],
    ['x/'],
    ['/x'],
    ['x.'],
    ['a//b'],
    ['-x'],
    ['a/.hidden'],
    ['a~1'],
    ['a^'],
    ['a:b'],
    ['a?'],
    ['a*'],
    ['a[b'],
    ['a\\b'],
    ['tab\there'],
  ])('rejects %j', (name) => {
    expect(validateBranchName(name)).toEqual(expect.any(String));
  });
});

describe('htmlToText', () => {
  it('strips tags, keeps line structure and decodes entities', () => {
    expect(htmlToText('<div>Hello <b>world</b></div><p>a &amp; b &lt;c&gt; &#65;&#x42;</p>')).toBe(
      'Hello world\na & b <c> AB',
    );
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('• one\n• two');
    expect(htmlToText('line<br/>next')).toBe('line\nnext');
  });
  it('drops scripts and styles entirely', () => {
    expect(htmlToText('<script>alert(1)</script><style>p{}</style>ok')).toBe('ok');
  });
  it('leaves unknown entities alone', () => {
    expect(htmlToText('&bogus; &nbsp;x')).toBe('&bogus;  x');
  });
});

describe('issueBodyText', () => {
  it('only strips html bodies', () => {
    expect(issueBodyText({ body: '**md** <b>', bodyFormat: 'markdown' })).toBe('**md** <b>');
    expect(issueBodyText({ body: '<p>x</p>', bodyFormat: 'html' })).toBe('x');
  });
});

describe('defaultTransition', () => {
  it('picks the first in-progress transition', () => {
    const ts = [
      { id: '1', name: 'Close', toCategory: 'done' as const },
      { id: '2', name: 'Start', toCategory: 'in_progress' as const },
      { id: '3', name: 'Review', toCategory: 'in_progress' as const },
    ];
    expect(defaultTransition(ts)?.id).toBe('2');
    expect(defaultTransition([ts[0]!])).toBeUndefined();
    expect(defaultTransition(undefined)).toBeUndefined();
  });
});

describe('trackerInfo', () => {
  it('maps every tracker kind', () => {
    expect(trackerInfo('github').icon).toBe('github');
    expect(trackerInfo('gitlab').label).toBe('GitLab');
    expect(trackerInfo('jira-cloud').icon).toBe('jira');
    expect(trackerInfo('jira-dc').icon).toBe('jira');
    expect(trackerInfo('trello').icon).toBe('trello');
    expect(trackerInfo('azure-boards').icon).toBe('azure');
    expect(trackerInfo('???').label).toBe('Issue tracker');
  });
});

describe('issueRefOf', () => {
  it('builds the IPC ref', () => {
    expect(issueRefOf(issue(), 'jira-cloud:x')).toEqual({
      trackerKind: 'jira-cloud',
      integrationKey: 'jira-cloud:x',
      scope: 'site/ABC',
      key: 'ABC-12',
      webUrl: 'https://x.atlassian.net/browse/ABC-12',
    });
  });
});

describe('parseLabels / supportsIssueType / pillBranchName', () => {
  it('parses comma-separated labels', () => {
    expect(parseLabels(' bug, ui ,, bug ,docs ')).toEqual(['bug', 'ui', 'docs']);
    expect(parseLabels('')).toEqual([]);
  });
  it('knows which trackers have types', () => {
    expect(supportsIssueType('jira-cloud')).toBe(true);
    expect(supportsIssueType('github')).toBe(false);
  });
  it('extracts local branch names from pills', () => {
    expect(pillBranchName({ kind: 'local', label: 'x', hasLocal: true, local: { shortName: 'ABC-1' } })).toBe(
      'ABC-1',
    );
    expect(pillBranchName({ kind: 'head', label: 'main', hasLocal: true })).toBe('main');
    expect(pillBranchName({ kind: 'remote', label: 'origin/x', hasLocal: false })).toBeNull();
    expect(pillBranchName({ kind: 'tag', label: 'v1', hasLocal: false })).toBeNull();
  });
});
