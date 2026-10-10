import type { CoAuthor } from '@githappens/git/ops';
import type { InProgressOp } from '@githappens/git/types';

/** Summary length guidance (spec 06 §4.5): ≤ 50 fine, 51–72 amber, > 72 red (never blocking). */
export const SUMMARY_SOFT = 50;
export const SUMMARY_HARD = 72;

export type CounterTone = 'ok' | 'warn' | 'over';

export function summaryCounter(summary: string): { text: string; tone: CounterTone; title: string } {
  const n = [...summary].length;
  const tone: CounterTone = n > SUMMARY_HARD ? 'over' : n > SUMMARY_SOFT ? 'warn' : 'ok';
  const title =
    tone === 'over'
      ? `${n - SUMMARY_HARD} characters over 72 — long summaries get truncated on most hosts`
      : tone === 'warn'
        ? 'Over the conventional 50-character summary length'
        : 'Summaries of 50 characters or fewer read best';
  return { text: `${n}/${SUMMARY_HARD}`, tone, title };
}

/**
 * Paste into the single-line summary (spec 06 §4.5): the first non-empty line becomes the summary
 * insertion, the rest (blank lines between trimmed) goes to the description. Returns null when the
 * pasted text has a single line (let the input handle it natively).
 */
export function splitPaste(
  pasted: string,
  current: { summary: string; description: string; selStart: number; selEnd: number },
): { summary: string; description: string; caret: number } | null {
  const text = pasted.replace(/\r\n?/g, '\n');
  if (!text.includes('\n')) return null;
  const lines = text.split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  if (!lines.length) return null;
  const first = lines.shift()!.trim();
  while (lines.length && !lines[0]!.trim()) lines.shift();
  const rest = lines.join('\n').replace(/\s+$/, '');
  const { summary, selStart, selEnd } = current;
  const nextSummary = summary.slice(0, selStart) + first + summary.slice(selEnd);
  const desc = current.description.replace(/\s+$/, '');
  return {
    summary: nextSummary,
    description: rest ? (desc ? `${rest}\n\n${desc}` : rest) : current.description,
    caret: selStart + first.length,
  };
}

// ---- co-author trailers (spec 06 §4.5, §6.8) ----

export const formatCoAuthor = (c: CoAuthor): string => `${c.name.trim()} <${c.email.trim()}>`;

/** Parse "Name <email>" (or a bare email) typed into the picker. */
export function parseCoAuthor(input: string): CoAuthor | null {
  const t = input.trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(t);
  if (m) return { name: m[1]!.trim() || m[2]!, email: m[2]! };
  if (/^[^<>\s]+@[^<>\s]+\.[^<>\s]+$/.test(t)) return { name: t.split('@')[0]!, email: t };
  return null;
}

const TRAILER_RE = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/i;

/** `Co-authored-by:` trailers already written in a description. */
export function coAuthorsInText(text: string): CoAuthor[] {
  const out: CoAuthor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = TRAILER_RE.exec(line.trim());
    if (m) out.push({ name: m[1]!, email: m[2]! });
  }
  return out;
}

/** Add a co-author unless the same email is already present (case-insensitive). */
export function addCoAuthor(list: CoAuthor[], c: CoAuthor): CoAuthor[] {
  const e = c.email.trim().toLowerCase();
  return list.some((x) => x.email.trim().toLowerCase() === e) ? list : [...list, c];
}

/** Co-authors to pass to `commit.create`: never duplicates a trailer the description already has. */
export function trailersToAdd(description: string, chips: CoAuthor[]): CoAuthor[] {
  const present = new Set(coAuthorsInText(description).map((c) => c.email.toLowerCase()));
  const out: CoAuthor[] = [];
  for (const c of chips) {
    const e = c.email.trim().toLowerCase();
    if (!e || present.has(e)) continue;
    present.add(e);
    out.push(c);
  }
  return out;
}

// ---- templates & prefills (spec 06 §6.9, §6.8) ----

/** Remove `#` comment lines (git `--cleanup=strip`) and collapse surrounding blank lines. */
export function stripCommentLines(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '');
}

/** Split a message into summary (first line) and description (rest, leading blank lines dropped). */
export function splitMessageText(text: string): { summary: string; description: string } {
  const t = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const nl = t.indexOf('\n');
  if (nl < 0) return { summary: t.trim(), description: '' };
  return { summary: t.slice(0, nl).trim(), description: t.slice(nl + 1).replace(/^\n+/, '') };
}

/**
 * Template → composer fields. With `strip`, `#` lines are dropped (they would be removed on commit
 * anyway); otherwise the description keeps them as hints.
 */
export function templateFields(text: string, strip: boolean): { summary: string; description: string } {
  const t = strip ? stripCommentLines(text) : text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return splitMessageText(t);
}

/** True when the composer still shows exactly what the template would fill in (or nothing). */
export function isPristine(
  draft: { summary: string; description: string },
  template: { summary: string; description: string } | null,
): boolean {
  const empty = !draft.summary.trim() && !draft.description.trim();
  if (empty || !template) return empty;
  return draft.summary === template.summary && draft.description === template.description;
}

/** Composer text for MERGE_MSG / SQUASH_MSG / cherry-pick / rebase messages (comments stripped). */
export function prefillFromMessage(message: string): { summary: string; description: string } {
  return splitMessageText(stripCommentLines(message));
}

// ---- button label (spec 06 §4.1, §6.8) ----

export interface ComposerMode {
  op: InProgressOp | null;
  /** Merge without MERGE_HEAD (`merge --squash`): continue = plain commit. */
  squash: boolean;
  amend: boolean;
  allowEmpty: boolean;
  stagedCount: number;
  push: boolean;
}

export type CommitAction = 'commit' | 'merge.continue' | 'rebase.continue' | 'sequencer.continue';

/** What the commit button does in the current repository state. */
export function commitAction(m: ComposerMode): CommitAction {
  if (m.op === 'merge' && !m.squash) return 'merge.continue';
  if (m.op === 'rebase') return 'rebase.continue';
  if (m.op === 'cherry-pick' || m.op === 'revert') return 'sequencer.continue';
  return 'commit';
}

export function commitButtonLabel(m: ComposerMode): string {
  const action = commitAction(m);
  const andPush = m.push ? ' and push' : '';
  if (action === 'merge.continue') return 'Commit and Merge';
  if (action === 'rebase.continue') return 'Continue Rebase';
  if (action === 'sequencer.continue') return m.op === 'revert' ? 'Continue Revert' : 'Continue Cherry-pick';
  if (m.op === 'merge' && m.squash) return `Commit squashed changes${andPush}`;
  if (m.amend) return `Amend previous commit${andPush}`;
  if (m.stagedCount === 0) return m.allowEmpty ? `Create empty commit${andPush}` : 'Stage files to commit';
  return `Commit changes to ${m.stagedCount} file${m.stagedCount === 1 ? '' : 's'}${andPush}`;
}

/** `sign` value of `commit.create` for the per-commit toggle. */
export function signFlag(choice: 'config' | 'on' | 'off'): 'config' | 'force' | 'off' {
  return choice === 'on' ? 'force' : choice;
}

// ---- hook output (spec 06 §4.6) ----

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Hook output without ANSI escapes; bare CR progress lines collapse to their last state. */
export function cleanHookOutput(text: string): string {
  return text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? (l.split('\r').filter(Boolean).pop() ?? '') : l))
    .join('\n');
}
