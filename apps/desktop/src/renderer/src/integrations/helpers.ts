import type {
  Issue,
  PrIndexEntry,
  PrRollupStatus,
  PrState,
  ProviderErrorCode,
  ProviderKind,
  PrFilter,
  RepoRef,
} from '@githappens/providers/types';

import type { IntegrationKind } from '../../../shared/ipc/integrations-contract';

/**
 * Pure helpers for the integrations UI (spec 10 §4). No React, no window — unit-tested in
 * `test/integrations-helpers.test.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Provider catalog (Preferences → Integrations, spec 10 §4.1)
// ---------------------------------------------------------------------------------------------

export interface IntegrationEntry {
  id: string;
  label: string;
  kind: IntegrationKind;
  /** Fixed host for cloud services; undefined when the user types it. */
  host?: string;
  selfHosted: boolean;
  hostPlaceholder?: string;
  /** PAT flow needs a username / e-mail (Bitbucket app passwords, Jira API tokens). */
  usernameLabel?: string;
  tokenLabel: string;
}

export const INTEGRATION_CATALOG: IntegrationEntry[] = [
  {
    id: 'github',
    label: 'GitHub',
    kind: 'github',
    host: 'github.com',
    selfHosted: false,
    tokenLabel: 'Personal access token',
  },
  {
    id: 'github-enterprise',
    label: 'GitHub Enterprise',
    kind: 'github',
    selfHosted: true,
    hostPlaceholder: 'github.acme.com',
    tokenLabel: 'Personal access token',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    kind: 'gitlab',
    host: 'gitlab.com',
    selfHosted: false,
    tokenLabel: 'Personal access token',
  },
  {
    id: 'gitlab-self',
    label: 'GitLab Self-Managed',
    kind: 'gitlab',
    selfHosted: true,
    hostPlaceholder: 'gitlab.acme.com',
    tokenLabel: 'Personal access token',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    kind: 'bitbucket',
    host: 'bitbucket.org',
    selfHosted: false,
    usernameLabel: 'Bitbucket username',
    tokenLabel: 'App password / API token',
  },
  {
    id: 'bitbucket-dc',
    label: 'Bitbucket Data Center',
    kind: 'bitbucket-dc',
    selfHosted: true,
    hostPlaceholder: 'bitbucket.acme.com',
    tokenLabel: 'HTTP access token',
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps',
    kind: 'azure-devops',
    host: 'dev.azure.com',
    selfHosted: false,
    tokenLabel: 'Personal access token',
  },
  {
    id: 'jira-cloud',
    label: 'Jira Cloud',
    kind: 'jira-cloud',
    selfHosted: false,
    hostPlaceholder: 'acme.atlassian.net',
    usernameLabel: 'Atlassian account e-mail',
    tokenLabel: 'API token',
  },
  {
    id: 'jira-dc',
    label: 'Jira Data Center',
    kind: 'jira-dc',
    selfHosted: true,
    hostPlaceholder: 'jira.acme.com',
    tokenLabel: 'Personal access token',
  },
  {
    // Power-Up API key (trello.com/power-ups/admin) + a token generated for it (spec 10/11 Trello).
    id: 'trello',
    label: 'Trello',
    kind: 'trello',
    host: 'trello.com',
    selfHosted: false,
    usernameLabel: 'Power-Up API key',
    tokenLabel: 'API token',
  },
];

/** Default public host per hosting kind (used to tell cloud from self-hosted accounts). */
export const CLOUD_HOSTS: Partial<Record<IntegrationKind, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  'azure-devops': 'dev.azure.com',
};

/** Does a connected account (kind + host) belong under this catalog entry? */
export function entryMatches(entry: IntegrationEntry, account: { kind: string; host: string }): boolean {
  if (account.kind !== entry.kind) return false;
  const cloud = CLOUD_HOSTS[entry.kind];
  if (!cloud) return true; // jira-cloud / jira-dc / bitbucket-dc: kind is enough
  const isCloud = account.host.toLowerCase() === cloud;
  return entry.selfHosted ? !isCloud : isCloud;
}

/** Normalize a typed host: strip scheme, path, trailing slashes; lowercase. Null when invalid. */
export function normalizeHost(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^@/]*@/, ''); // user@host
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.toLowerCase().replace(/\.+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(s)) return null;
  return s;
}

export const providerLabel = (kind: string): string =>
  ({
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
    'bitbucket-dc': 'Bitbucket Data Center',
    'azure-devops': 'Azure DevOps',
    'jira-cloud': 'Jira Cloud',
    'jira-dc': 'Jira Data Center',
    trello: 'Trello',
    'azure-boards': 'Azure Boards',
  })[kind] ?? kind;

export const refKey = (ref: RepoRef): string =>
  `${ref.integration.kind}:${ref.integration.host}:${ref.integration.accountId}`;

// ---------------------------------------------------------------------------------------------
// Errors (spec 10 §5.5)
// ---------------------------------------------------------------------------------------------

export interface FriendlyError {
  code?: ProviderErrorCode;
  title: string;
  detail?: string;
  /** Suggested UI action. */
  action?: 'reconnect' | 'retry' | 'help';
  helpUrl?: string;
  retryAt?: number;
}

const PROVIDER_CODES = new Set<ProviderErrorCode>([
  'auth_required',
  'token_expired',
  'insufficient_scope',
  'rate_limited',
  'not_found',
  'forbidden_org_policy',
  'network',
  'conflict',
  'validation',
  'unsupported',
  'server',
]);

/** "in 4 min (10:42)" style hint for rate-limit resets. */
export function formatRetry(retryAt: number, now: number): string {
  const secs = Math.max(0, Math.round((retryAt - now) / 1000));
  const at = new Date(retryAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (secs < 60) return `in ${secs}s`;
  const mins = Math.ceil(secs / 60);
  return mins < 90 ? `in ${mins} min (${at})` : `at ${at}`;
}

/**
 * Turn an IPC error (`{ message, details: { providerCode, retryAt, missingScopes, helpUrl } }`)
 * into a short, friendly message. Accepts anything; non-provider errors keep their message.
 */
export function describeProviderError(
  err: { message?: string; details?: Record<string, unknown> } | null | undefined,
  now: number,
): FriendlyError {
  const details = err?.details ?? {};
  const raw = details.providerCode;
  const code =
    typeof raw === 'string' && PROVIDER_CODES.has(raw as ProviderErrorCode)
      ? (raw as ProviderErrorCode)
      : undefined;
  const message = err?.message ?? 'Something went wrong';
  const helpUrl = typeof details.helpUrl === 'string' ? details.helpUrl : undefined;
  const retryAt =
    typeof details.retryAt === 'number' ? details.retryAt : Number(details.retryAt) || undefined;
  const missing = Array.isArray(details.missingScopes)
    ? details.missingScopes.map(String)
    : typeof details.missingScopes === 'string'
      ? details.missingScopes.split(/[,\s]+/).filter(Boolean)
      : [];
  switch (code) {
    case 'auth_required':
    case 'token_expired':
      return {
        code,
        title: 'Reconnect account',
        detail:
          code === 'token_expired' ? 'Your access token expired.' : 'The account needs to be reconnected.',
        action: 'reconnect',
      };
    case 'insufficient_scope':
      return {
        code,
        title: 'Missing permissions',
        detail: missing.length
          ? `Reconnect to grant: ${missing.join(', ')}`
          : 'The token lacks a required scope. Reconnect to grant it.',
        action: 'reconnect',
      };
    case 'rate_limited':
      return {
        code,
        title: 'Rate limit reached',
        detail: retryAt ? `Try again ${formatRetry(retryAt, now)}.` : 'Try again in a few minutes.',
        action: 'retry',
        retryAt,
      };
    case 'forbidden_org_policy':
      return {
        code,
        title: 'Blocked by organization policy',
        detail: 'The organization restricts third-party apps. Request access from an owner.',
        action: helpUrl ? 'help' : undefined,
        helpUrl,
      };
    case 'not_found':
      return { code, title: 'Not found', detail: 'It may have been deleted, or this account cannot see it.' };
    case 'network':
      return {
        code,
        title: 'Network error',
        detail: 'Check your connection or proxy settings.',
        action: 'retry',
      };
    case 'conflict':
      return { code, title: 'Out of date', detail: message, action: 'retry' };
    case 'validation':
      return { code, title: 'Rejected by provider', detail: message };
    case 'unsupported':
      return { code, title: 'Not supported', detail: message };
    case 'server':
      return { code, title: 'Provider error', detail: message, action: 'retry' };
    default:
      return { title: message, action: 'retry' };
  }
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

export type PrPreset = NonNullable<PrFilter['preset']>;
export const PR_PRESETS: Array<{ id: PrPreset; label: string }> = [
  { id: 'mine', label: 'Mine' },
  { id: 'review-requested', label: 'Review requested' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'all', label: 'All open' },
];

/** Stable key for a filter, used in `['pr','list',repoId,filterKey]`. */
export function prFilterKey(f: PrFilter): string {
  return [f.preset ?? '', f.state ?? '', f.query ?? '', f.author ?? '', f.head ?? ''].join('|');
}

/**
 * Default PR title from a branch name (spec 10 §4.4): `feature/ABC-12-add-login` → `ABC-12 Add login`,
 * `fix/12-crash-on-start` → `12 Crash on start`, `add_dark_mode` → `Add dark mode`.
 */
export function humanizeBranch(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  const key = /^([A-Za-z][A-Za-z0-9]+-\d+)[-_ ]?(.*)$/.exec(last);
  const rest = (key ? key[2]! : last).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sentence = rest ? rest[0]!.toUpperCase() + rest.slice(1) : '';
  if (key) return sentence ? `${key[1]!.toUpperCase()} ${sentence}` : key[1]!.toUpperCase();
  return sentence || branch;
}

const STATE_RANK: Record<PrState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

/**
 * Branch → PR lookup for graph badges. Keys: `remote/branch` (remote-tracking label) and the bare
 * `branch` (local branch of the same name). When several PRs share a branch, open beats draft beats
 * merged beats closed; ties keep the first (most recently updated, as sent by main).
 */
export function buildPrIndex(entries: PrIndexEntry[]): Map<string, PrIndexEntry> {
  const map = new Map<string, PrIndexEntry>();
  const put = (k: string, e: PrIndexEntry): void => {
    const cur = map.get(k);
    if (!cur || STATE_RANK[e.pr.state] < STATE_RANK[cur.pr.state]) map.set(k, e);
  };
  for (const e of entries) {
    const branch = e.branch.replace(/^refs\/heads\//, '');
    put(`${e.remote}/${branch}`, e);
    put(branch, e);
  }
  return map;
}

interface RefLike {
  type: string;
  shortName: string;
  fullName: string;
  upstream?: { fullName: string };
  symrefTarget?: string;
}

/**
 * Create-PR defaults (spec 10 §4.4, §8 fork workflow): head remote = the branch's upstream remote, else
 * `origin`; base remote = `upstream` when linked, else `origin`, else the head remote; base branch = the given one
 * (remote prefix stripped), else the base remote's HEAD, else main/master.
 */
export function defaultPrSides(
  linkedRemotes: string[],
  refs: RefLike[],
  headInput: string,
  baseInput?: string,
): { headRemote: string; headBranch: string; baseRemote: string; baseBranch: string } {
  const pickFirst = (...names: Array<string | undefined>): string =>
    names.find((n): n is string => !!n && linkedRemotes.includes(n)) ?? linkedRemotes[0] ?? 'origin';
  const splitRemote = (name: string): [string | undefined, string] => {
    const r = linkedRemotes.find((rm) => name.startsWith(`${rm}/`));
    const isRemoteRef = r && refs.some((x) => x.type === 'remote' && x.shortName === name);
    return isRemoteRef ? [r, name.slice(r.length + 1)] : [undefined, name];
  };

  const [headPrefix, headBranch] = splitRemote(headInput);
  const local = refs.find((r) => r.type === 'local' && r.shortName === headBranch);
  const upstreamRemote = local?.upstream
    ? linkedRemotes.find((rm) => local.upstream!.fullName.startsWith(`refs/remotes/${rm}/`))
    : undefined;
  const headRemote = pickFirst(headPrefix, upstreamRemote, 'origin');
  const [basePrefix, baseFromInput] = baseInput ? splitRemote(baseInput) : [undefined, ''];
  const baseRemote = pickFirst(basePrefix, 'upstream', 'origin', headRemote);

  let baseBranch = baseFromInput;
  if (!baseBranch) {
    const head = refs.find((r) => r.fullName === `refs/remotes/${baseRemote}/HEAD`)?.symrefTarget;
    const prefix = `refs/remotes/${baseRemote}/`;
    if (head?.startsWith(prefix)) baseBranch = head.slice(prefix.length);
    else {
      const has = (b: string): boolean => refs.some((r) => r.shortName === `${baseRemote}/${b}`);
      baseBranch = has('main') ? 'main' : has('master') ? 'master' : 'main';
    }
  }
  return { headRemote, headBranch, baseRemote, baseBranch };
}

/**
 * Which repo hosts a PR from the index: the remote whose `owner/name` appears in the PR web URL
 * (fork PRs live on the parent), else the head remote itself.
 */
export function pickRefForPr<T extends { remote: string; ref?: RepoRef }>(
  remotes: T[],
  webUrl: string,
  headRemote: string,
): RepoRef | null {
  let path = webUrl.toLowerCase();
  try {
    path = decodeURIComponent(new URL(webUrl).pathname).toLowerCase();
  } catch {
    /* not a URL: match on the raw string */
  }
  const withRef = remotes.filter((r): r is T & { ref: RepoRef } => !!r.ref);
  const hit = withRef
    .filter((r) => path.includes(`/${r.ref.owner}/${r.ref.name}/`.toLowerCase()))
    .sort((a, b) => b.ref.owner.length + b.ref.name.length - (a.ref.owner.length + a.ref.name.length))[0];
  return hit?.ref ?? withRef.find((r) => r.remote === headRemote)?.ref ?? null;
}

/** Badge tooltip (spec 10 §4.6): `#123 Add login (2 of 3 in stack) — checks passing`. */
export function prBadgeTitle(pr: PrIndexEntry['pr']): string {
  const stack = pr.stack ? ` (${pr.stack.position} of ${pr.stack.size} in stack)` : '';
  const checks = {
    success: 'checks passing',
    pending: 'checks pending',
    failure: 'checks failing or changes requested',
    none: 'no checks',
  }[pr.rollup];
  return `#${pr.number} ${pr.title}${stack} — ${STATE_LABEL[pr.state].toLowerCase()}, ${checks}`;
}

export type Tone = 'green' | 'yellow' | 'red' | 'grey' | 'purple' | 'blue';

export function rollupTone(r: PrRollupStatus): Tone {
  return r === 'success' ? 'green' : r === 'pending' ? 'yellow' : r === 'failure' ? 'red' : 'grey';
}

export function stateTone(s: PrState): Tone {
  return s === 'open' ? 'green' : s === 'draft' ? 'grey' : s === 'merged' ? 'purple' : 'red';
}

export const STATE_LABEL: Record<PrState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

export const MERGE_METHOD_LABEL: Record<string, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
  'rebase-merge': 'Rebase and merge (merge commit)',
  'semi-linear': 'Semi-linear merge',
  'fast-forward': 'Fast-forward',
};

/** Prefilled merge commit title/message per method (GitHub-style defaults). */
export function defaultMergeCommit(
  pr: { number: number; title: string; head: { branch: string; repo: RepoRef | null }; body: string },
  method: string,
): { title: string; message: string } | null {
  if (method === 'squash') return { title: `${pr.title} (#${pr.number})`, message: '' };
  if (method === 'merge' || method === 'rebase-merge' || method === 'semi-linear') {
    const owner = pr.head.repo?.owner;
    return {
      title: `Merge pull request #${pr.number}${owner ? ` from ${owner}/${pr.head.branch}` : ` from ${pr.head.branch}`}`,
      message: pr.title,
    };
  }
  return null; // rebase / fast-forward: no new commit message
}

/** One-line mergeability summary for the merge box (spec 10 §4.7). */
export function mergeabilitySummary(pr: {
  state: PrState;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required' | null;
  checksRollup: PrRollupStatus;
}): { tone: Tone; text: string; blocked: boolean } {
  if (pr.state === 'draft')
    return { tone: 'grey', text: 'This pull request is still a draft', blocked: true };
  if (pr.mergeable === 'conflicting')
    return { tone: 'red', text: 'Conflicts must be resolved', blocked: true };
  if (pr.mergeable === 'unknown') return { tone: 'yellow', text: 'Checking mergeability…', blocked: false };
  if (pr.reviewDecision === 'changes_requested')
    return { tone: 'red', text: 'Changes requested', blocked: false };
  if (pr.checksRollup === 'failure')
    return { tone: 'red', text: 'Some checks were not successful', blocked: false };
  if (pr.checksRollup === 'pending') return { tone: 'yellow', text: 'Checks in progress', blocked: false };
  if (pr.reviewDecision === 'review_required')
    return { tone: 'yellow', text: 'Review required', blocked: false };
  return { tone: 'green', text: 'No conflicts — ready to merge', blocked: false };
}

/** Which Create-PR fields a provider supports (spec 10 §4.4 — unsupported fields are hidden). */
export function prFieldSupport(kind: ProviderKind): {
  draft: boolean;
  labels: boolean;
  assignees: boolean;
  deleteSourceBranch: boolean;
  squash: boolean;
} {
  switch (kind) {
    case 'github':
      return { draft: true, labels: true, assignees: true, deleteSourceBranch: false, squash: false };
    case 'gitlab':
      return { draft: true, labels: true, assignees: true, deleteSourceBranch: true, squash: true };
    case 'bitbucket':
      return { draft: true, labels: false, assignees: false, deleteSourceBranch: true, squash: false };
    case 'bitbucket-dc':
      return { draft: false, labels: false, assignees: false, deleteSourceBranch: true, squash: false };
    case 'azure-devops':
      return { draft: true, labels: true, assignees: false, deleteSourceBranch: true, squash: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

const MAX_BRANCH = 60;

/** `"Add login form!"` → `add-login-form` (ASCII only, diacritics folded). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Default branch name for an issue (spec 10 §4.9): `{key}-{title-slug}`; GitHub/GitLab issue keys
 * like `#12` become `12-…`. Jira key casing is preserved; max 60 chars, cut at a word boundary.
 */
export function branchNameForIssue(issue: Pick<Issue, 'key' | 'title'>): string {
  const key = issue.key
    .replace(/^#/, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = slugify(issue.title);
  let name = [key, slug].filter(Boolean).join('-');
  if (name.length > MAX_BRANCH) {
    const cut = name.slice(0, MAX_BRANCH);
    const dash = cut.lastIndexOf('-');
    name = dash > key.length ? cut.slice(0, dash) : cut;
  }
  name = name.replace(/-+$/g, '');
  return name || 'issue';
}

export const ISSUE_PRESETS: Array<{ id: 'assigned' | 'created' | 'mentioned' | 'all-open'; label: string }> =
  [
    { id: 'assigned', label: 'My issues' },
    { id: 'created', label: 'Created by me' },
    { id: 'mentioned', label: 'Mentioned' },
    { id: 'all-open', label: 'All open' },
  ];

export const ISSUE_TRACKER_KINDS = new Set([
  'github',
  'gitlab',
  'jira-cloud',
  'jira-dc',
  'trello',
  'azure-devops',
]);

// ---------------------------------------------------------------------------------------------
// Markdown-ish rendering (descriptions and comments). Parsed to a tiny AST; rendered as React
// elements so no HTML is ever injected.
// ---------------------------------------------------------------------------------------------

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: Inline[] }
  | { t: 'italic'; v: Inline[] }
  | { t: 'strike'; v: Inline[] }
  | { t: 'link'; href: string; v: Inline[] };

export type Block =
  | { t: 'heading'; level: number; v: Inline[] }
  | { t: 'para'; v: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; v: Block[] }
  | { t: 'list'; ordered: boolean; items: Array<{ checked?: boolean; v: Inline[] }> }
  | { t: 'rule' };

const SAFE_URL = /^(https?:|mailto:)/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      if (SAFE_URL.test(m[2]!)) out.push({ t: 'link', href: m[2]!, v: parseInline(m[1]!) });
      else out.push({ t: 'text', v: m[1]! });
    } else if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      flush();
      out.push({ t: 'bold', v: parseInline(m[2]!) });
    } else if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush();
      out.push({ t: 'strike', v: parseInline(m[1]!) });
    } else if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![A-Za-z0-9])/.exec(rest)) && !/[A-Za-z0-9]$/.test(text)) {
      flush();
      out.push({ t: 'italic', v: parseInline(m[2]!) });
    } else if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest))) {
      flush();
      out.push({ t: 'link', href: m[0], v: [{ t: 'text', v: m[0] }] });
    } else {
      text += src[i];
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ t: 'heading', level: h[1]!.length, v: parseInline(h[2]!) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'rule' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', v: parseMarkdown(body.join('\n')) });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/;
    if (li.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: Array<{ checked?: boolean; v: Inline[] }> = [];
      while (i < lines.length && lines[i]!.trim()) {
        const l = lines[i]!;
        if (li.test(l)) {
          const body = l.replace(li, '');
          const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
          items.push(
            task ? { checked: task[1] !== ' ', v: parseInline(task[2]!) } : { v: parseInline(body) },
          );
        } else if (items.length) {
          const last = items[items.length - 1]!;
          last.v = [...last.v, { t: 'text', v: ' ' }, ...parseInline(l.trim())];
        }
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    if (!para.length) para.push(lines[i++]!.trim()); // never stall on an unmatched line
    blocks.push({ t: 'para', v: parseInline(para.join('\n')) });
  }
  return blocks;
}
