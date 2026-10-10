import type { CheckRun, CheckStatus, ProviderKind, ProviderUser } from '@githappens/providers/types';

/**
 * Pure helpers for the Pull Request view (spec 10 §4.7): provider capability table, quote replies,
 * linked-issue parsing, check summaries. No React / IPC here so they can be unit-tested.
 */

/** Subset of `ProviderCapabilities` the PR view needs (mirrors `packages/providers/src/*` constants). */
export interface PrViewCaps {
  prDraft: boolean;
  prLabels: boolean;
  prAssignees: boolean;
  prMilestone: boolean;
  prTeamsAsReviewers: boolean;
  prAutoMerge: boolean;
  reviewThreadsResolve: boolean;
  ciRerun: boolean;
}

/**
 * Renderer-safe mirror of the provider capability constants (`GITHUB_CAPABILITIES`, …); `@githappens/providers`
 * itself pulls Node code. Keep in sync with packages/providers/src/{github,gitlab,azure,bitbucket}.
 */
export const PR_VIEW_CAPS: Record<ProviderKind, PrViewCaps> = {
  github: {
    prDraft: true,
    prLabels: true,
    prAssignees: true,
    prMilestone: true,
    prTeamsAsReviewers: true,
    prAutoMerge: true,
    reviewThreadsResolve: true,
    ciRerun: true,
  },
  gitlab: {
    prDraft: true,
    prLabels: true,
    prAssignees: true,
    prMilestone: true,
    prTeamsAsReviewers: false,
    prAutoMerge: true,
    reviewThreadsResolve: true,
    ciRerun: true,
  },
  'azure-devops': {
    prDraft: true,
    prLabels: true,
    prAssignees: false,
    prMilestone: false,
    prTeamsAsReviewers: true,
    prAutoMerge: true,
    reviewThreadsResolve: true,
    ciRerun: true,
  },
  bitbucket: {
    prDraft: true,
    prLabels: false,
    prAssignees: false,
    prMilestone: false,
    prTeamsAsReviewers: false,
    prAutoMerge: false,
    reviewThreadsResolve: true,
    ciRerun: false,
  },
  'bitbucket-dc': {
    prDraft: false,
    prLabels: false,
    prAssignees: false,
    prMilestone: false,
    prTeamsAsReviewers: false,
    prAutoMerge: false,
    reviewThreadsResolve: false,
    ciRerun: false,
  },
};

const NO_CAPS: PrViewCaps = PR_VIEW_CAPS['bitbucket-dc'];

export function prViewCaps(kind: string | undefined): PrViewCaps {
  return (kind && PR_VIEW_CAPS[kind as ProviderKind]) || NO_CAPS;
}

/**
 * Identifier `pr:update` expects for a reviewer / assignee: GitHub and GitLab take logins (GitLab resolves
 * them to ids); Bitbucket Cloud and Azure DevOps take the account id / uuid.
 */
export function userIdent(kind: string | undefined, u: Pick<ProviderUser, 'id' | 'login'>): string {
  return kind === 'bitbucket' || kind === 'azure-devops' ? u.id || u.login : u.login;
}

/** `> `-quote a markdown body (blank lines become a bare `>`). */
export function quoteMarkdown(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

/** Append a quote of `body` to a composer draft: quoted lines followed by a blank line. */
export function appendQuote(draft: string, body: string, author?: string): string {
  const head = author ? `> **@${author}** wrote:\n>\n` : '';
  const quote = `${head}${quoteMarkdown(body)}\n\n`;
  if (!draft.trim()) return quote;
  return `${draft.replace(/\s+$/, '')}\n\n${quote}`;
}

// ---- linked issues ----

export type LinkedRef =
  { kind: 'number'; number: number; repo?: string; closing: boolean } | { kind: 'jira'; key: string };

const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;
const CROSS_RE = /(?:^|[^\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const JIRA_RE = /(?:^|[^A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})(?!\w)/g;
/** Look-alikes that are not issue keys (UTF-8, SHA-256, …). */
const JIRA_DENY = new Set([
  'UTF',
  'ISO',
  'SHA',
  'AES',
  'RFC',
  'CVE',
  'MD',
  'RSA',
  'TLS',
  'SSL',
  'HTTP',
  'ES',
  'ECMA',
  'GPT',
  'WIN',
  'X86',
  'ARM',
  'PEP',
]);

/**
 * Linked issues of a PR: closing references (`closes #12`, `fixes owner/repo#3`) and cross-repo references
 * (`owner/repo#3`) from the body, plus Jira-style keys (`ABC-123`) in the title, body and head branch.
 */
export function parseLinkedIssues(title: string, body: string, branch: string): LinkedRef[] {
  const out: LinkedRef[] = [];
  const seen = new Map<string, LinkedRef>();
  const add = (r: LinkedRef): void => {
    const k = r.kind === 'jira' ? `j:${r.key}` : `n:${(r.repo ?? '').toLowerCase()}#${r.number}`;
    const cur = seen.get(k);
    if (cur) {
      if (cur.kind === 'number' && r.kind === 'number' && r.closing) cur.closing = true;
      return;
    }
    seen.set(k, r);
    out.push(r);
  };
  const text = body ?? '';
  for (const m of text.matchAll(CLOSING_RE)) {
    const [repo, num] = m[1]!.split('#');
    add({ kind: 'number', number: Number(num), ...(repo ? { repo } : {}), closing: true });
  }
  for (const m of text.matchAll(CROSS_RE)) {
    add({ kind: 'number', number: Number(m[2]), repo: m[1]!, closing: false });
  }
  for (const src of [title ?? '', text, branch ?? '']) {
    for (const m of src.matchAll(JIRA_RE)) {
      const key = m[1]!;
      if (JIRA_DENY.has(key.split('-')[0]!)) continue;
      add({ kind: 'jira', key });
    }
  }
  return out;
}

/** Repo web URL from a PR web URL (strips `/pull/<n>`, `/-/merge_requests/<n>`, `/pull-requests/<n>`, …). */
export function repoWebUrlFromPr(prWebUrl: string): string | null {
  const m = /^(.*?)(?:\/-\/merge_requests|\/pull-requests|\/pullrequest|\/pulls?)\/\d+(?:[/?#].*)?$/.exec(
    prWebUrl,
  );
  return m ? m[1]! : null;
}

/** Web URL of issue `#n` (optionally in another `owner/repo`) — GitHub / GitLab only, else null. */
export function issueWebUrl(
  kind: string | undefined,
  prWebUrl: string,
  number: number,
  repo?: string,
): string | null {
  if (kind !== 'github' && kind !== 'gitlab') return null;
  let base = repoWebUrlFromPr(prWebUrl);
  if (!base) return null;
  if (repo) {
    try {
      base = `${new URL(base).origin}/${repo}`;
    } catch {
      return null;
    }
  }
  return kind === 'gitlab' ? `${base}/-/issues/${number}` : `${base}/issues/${number}`;
}

// ---- checks ----

export function isFailure(st: CheckStatus): boolean {
  return st === 'failure' || st === 'timed_out' || st === 'action_required' || st === 'cancelled';
}

export function checkCounts(checks: CheckRun[]): {
  passed: number;
  failed: number;
  pending: number;
  other: number;
} {
  const r = { passed: 0, failed: 0, pending: 0, other: 0 };
  for (const c of checks) {
    if (c.status === 'success') r.passed++;
    else if (isFailure(c.status)) r.failed++;
    else if (c.status === 'queued' || c.status === 'in_progress') r.pending++;
    else r.other++;
  }
  return r;
}

export function checkDuration(c: Pick<CheckRun, 'startedAt' | 'completedAt'>): string {
  if (!c.startedAt || !c.completedAt) return '';
  const secs = Math.max(0, Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

/** `1 commit`, `2 commits`. */
export const pluralize = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
