import type { ClassifiedItem, LaunchpadPr } from './types';

/**
 * Pull request notifications (spec 13 `notifications.prEvents`): after every personal Launchpad
 * refresh the classified items are diffed against the previous snapshot and three transitions
 * become events:
 *
 * - `review-requested` — a PR newly needs the viewer's review;
 * - `approved` — one of the viewer's PRs became approved;
 * - `checks-failed` — one of the viewer's PRs' checks newly failed (per head commit).
 *
 * Rules:
 * - The first snapshot of an account is a silent baseline (also after connecting a new account),
 *   so neither the first run nor a restart replays everything that is already true.
 * - Sources that failed this refresh keep their previous facts (no events from stale data).
 * - Snoozed items never notify; their facts are still recorded so un-snoozing doesn't replay them.
 * - Each event fires at most once per PR + event + head sha (`notified`), even when the condition
 *   flips off and on again.
 * - The caller suppresses everything (setting off, offline) by passing `silent`: facts are updated
 *   but no events come out, so turning notifications back on doesn't produce a backlog.
 *
 * Pure: no I/O. The service persists `PrNotifyState` per profile.
 */

export type PrEventKind = 'review-requested' | 'approved' | 'checks-failed';

/** The notifiable conditions of one PR at one refresh. */
export interface PrFacts {
  /** Integration account the PR came from. */
  acct: string;
  sha: string;
  /** Needs the viewer's review. */
  rr?: boolean;
  /** Viewer's PR is approved. */
  ap?: boolean;
  /** Viewer's PR has failing checks. */
  cf?: boolean;
}

export interface PrNotifyState {
  version: 1;
  /** Accounts that have a baseline snapshot. */
  accounts: string[];
  /** PR uid → facts at the last refresh. */
  prs: Record<string, PrFacts>;
  /** Dedupe keys (`uid|kind|sha`) → epoch ms they were notified. */
  notified: Record<string, number>;
}

export interface PrEvent {
  /** Dedupe key `uid|kind|sha`. */
  key: string;
  uid: string;
  kind: PrEventKind;
  item: ClassifiedItem;
}

/** One OS notification / toast: a single event, or a batch when many happen at once. */
export interface PrNotification {
  id: string;
  kind: PrEventKind | 'batch';
  title: string;
  body?: string;
  /** The PR to open on click (single events). */
  item?: ClassifiedItem;
  /** Number of events (1 for single notifications). */
  count: number;
}

/** More events than this in one refresh are batched into one "N pull requests need attention". */
export const PR_NOTIFY_MAX_INDIVIDUAL = 3;
/** Dedupe keys of PRs no longer listed are forgotten after this long. */
export const PR_NOTIFY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Hard cap on remembered dedupe keys (oldest dropped first). */
export const PR_NOTIFY_MAX_KEYS = 2000;

export const emptyPrNotifyState = (): PrNotifyState => ({ version: 1, accounts: [], prs: {}, notified: {} });

/** Validate a persisted state (anything malformed → null = start over with a silent baseline). */
export function parsePrNotifyState(v: unknown): PrNotifyState | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<PrNotifyState>;
  if (s.version !== 1 || !Array.isArray(s.accounts) || !s.prs || typeof s.prs !== 'object') return null;
  if (!s.notified || typeof s.notified !== 'object') return null;
  return {
    version: 1,
    accounts: s.accounts.filter((a): a is string => typeof a === 'string'),
    prs: s.prs as Record<string, PrFacts>,
    notified: s.notified as Record<string, number>,
  };
}

const active = (item: LaunchpadPr): boolean => item.pr.state === 'open' || item.pr.state === 'draft';

function isAuthor(item: LaunchpadPr): boolean {
  const pr = item.pr;
  return (
    pr.viewer.isAuthor ||
    item.involvement.includes('author') ||
    (!!pr.repo.integration.accountId && pr.author.id === pr.repo.integration.accountId)
  );
}

/** Notifiable facts of a classified item (null for issues / WIPs). */
export function prFacts(item: ClassifiedItem): PrFacts | null {
  if (item.type !== 'pr') return null;
  const pr = item.pr;
  const facts: PrFacts = { acct: item.integrationKey ?? '', sha: pr.head.sha ?? '' };
  if (!active(item)) return facts;
  if (isAuthor(item)) {
    const approved =
      pr.reviewDecision === 'approved' ||
      (pr.reviewDecision == null && pr.reviewers.some((r) => r.state === 'approved'));
    if (approved && pr.state === 'open') facts.ap = true;
    if (pr.checksRollup === 'failure') facts.cf = true;
  } else {
    const requested = pr.viewer.reviewRequested || item.involvement.includes('review-requested');
    // `needs-review` is the classifier's verdict; `current-branch` hides it, so check the request too.
    if (item.statusGroup === 'needs-review' || (requested && item.statusGroup === 'current-branch'))
      facts.rr = true;
  }
  return facts;
}

const eventKey = (uid: string, kind: PrEventKind, sha: string): string => `${uid}|${kind}|${sha}`;

export interface PrDiffInput {
  /** Classified personal items of this refresh (issues / WIPs are ignored). */
  items: readonly ClassifiedItem[];
  /** Accounts whose PR source refreshed successfully this time. */
  okAccounts: readonly string[];
  now: number;
  /** Record facts but emit nothing (setting off, offline). */
  silent?: boolean;
}

/**
 * Diff a refresh against the previous state. Returns the new state (always — persist it when
 * `changed`) and the events to notify, in item order.
 */
export function diffPrEvents(
  prev: PrNotifyState | null,
  input: PrDiffInput,
): { state: PrNotifyState; events: PrEvent[]; changed: boolean } {
  const base = prev ?? emptyPrNotifyState();
  const ok = new Set(input.okAccounts);
  const known = new Set(base.accounts);
  const notified: Record<string, number> = { ...base.notified };
  const prs: Record<string, PrFacts> = {};
  const events: PrEvent[] = [];
  const seen = new Set<string>();

  for (const item of input.items) {
    const facts = prFacts(item);
    if (!facts || seen.has(item.uid)) continue;
    seen.add(item.uid);
    const acct = facts.acct;
    const old = base.prs[item.uid];
    if (!ok.has(acct)) {
      // Source failed / was skipped this refresh: keep what we knew (no events from cached data).
      if (old) prs[item.uid] = old;
      continue;
    }
    prs[item.uid] = facts;
    if (!known.has(acct)) continue; // silent baseline for a new account
    const fire = (kind: PrEventKind, now: boolean, before: boolean): void => {
      if (!now) return;
      // Checks: a new head commit that fails again is a new event; the others need a transition.
      if (before && (kind !== 'checks-failed' || old?.sha === facts.sha)) return;
      const key = eventKey(item.uid, kind, facts.sha);
      if (notified[key] !== undefined) return;
      if (input.silent || item.snoozed) return;
      notified[key] = input.now;
      events.push({ key, uid: item.uid, kind, item });
    };
    fire('review-requested', !!facts.rr, !!old?.rr);
    fire('approved', !!facts.ap, !!old?.ap);
    fire('checks-failed', !!facts.cf, !!old?.cf);
  }

  // PRs of failed sources that weren't returned at all this time are kept, too.
  for (const [uid, f] of Object.entries(base.prs)) {
    if (!(uid in prs) && !ok.has(f.acct)) prs[uid] = f;
  }

  // Baseline every account that refreshed successfully.
  const accounts = [...new Set([...base.accounts, ...ok])].sort();

  // Forget dedupe keys of PRs that are gone and old; cap the total.
  for (const [key, at] of Object.entries(notified)) {
    const uid = key.slice(0, key.indexOf('|'));
    if (!(uid in prs) && input.now - at > PR_NOTIFY_KEEP_MS) delete notified[key];
  }
  const keys = Object.entries(notified);
  if (keys.length > PR_NOTIFY_MAX_KEYS) {
    keys.sort((a, b) => a[1] - b[1]);
    for (const [k] of keys.slice(0, keys.length - PR_NOTIFY_MAX_KEYS)) delete notified[k];
  }

  const state: PrNotifyState = { version: 1, accounts, prs, notified };
  const changed = prev === null || JSON.stringify(prev) !== JSON.stringify(state);
  return { state, events, changed };
}

const prRef = (item: ClassifiedItem): string =>
  item.type === 'pr'
    ? `${item.repo?.fullName ?? `${item.pr.repo.owner}/${item.pr.repo.name}`}#${item.pr.number}`
    : '';

const TITLE: Record<PrEventKind, string> = {
  'review-requested': 'Review requested',
  approved: 'Pull request approved',
  'checks-failed': 'Checks failed',
};

/** Text of a single event. */
export function describePrEvent(e: PrEvent): { title: string; body: string } {
  const author =
    e.item.type === 'pr' && e.kind === 'review-requested' ? ` — by ${e.item.pr.author.login}` : '';
  return { title: `${TITLE[e.kind]}: ${prRef(e.item)}`, body: `${e.item.title}${author}` };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Rate limit: up to `max` events become one notification each; more are batched into a single
 * "N pull requests need attention" (click opens the Launchpad).
 */
export function planPrNotifications(
  events: readonly PrEvent[],
  max = PR_NOTIFY_MAX_INDIVIDUAL,
): PrNotification[] {
  if (!events.length) return [];
  if (events.length <= max) {
    return events.map((e) => ({ id: e.key, kind: e.kind, ...describePrEvent(e), item: e.item, count: 1 }));
  }
  const n = (k: PrEventKind): number => events.filter((e) => e.kind === k).length;
  const parts = [
    n('review-requested') && plural(n('review-requested'), 'review request', 'review requests'),
    n('approved') && plural(n('approved'), 'approval', 'approvals'),
    n('checks-failed') && plural(n('checks-failed'), 'failing check run', 'failing check runs'),
  ].filter(Boolean);
  const prs = new Set(events.map((e) => e.uid)).size;
  return [
    {
      id: `batch|${events[0]!.key}|${events.length}`,
      kind: 'batch',
      title: `${plural(prs, 'pull request needs', 'pull requests need')} attention`,
      body: parts.join(', '),
      count: events.length,
    },
  ];
}
