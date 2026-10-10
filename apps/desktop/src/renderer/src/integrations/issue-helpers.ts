import type { Issue, IssueRef, TrackerKind } from '@githappens/providers/types';

import type { IssueTransition } from '../../../shared/ipc/integrations-contract';

/** Pure helpers for the issue panel / dialogs (spec 10 §4.9, §8). No React, no IPC. */

/**
 * Validate a new branch name the way `git check-ref-format --branch` would (spec 10 §8 edge cases).
 * Returns an error message, or null when the name is acceptable.
 */
export function validateBranchName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Enter a branch name.';
  if (/[\s\x00-\x1f\x7f]/.test(name)) return 'Branch names cannot contain spaces or control characters.';
  if (/[~^:?*[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ or \\.';
  if (name.includes('..')) return 'Branch names cannot contain "..".';
  if (name.includes('@{')) return 'Branch names cannot contain "@{".';
  if (name === '@') return '"@" is not a valid branch name.';
  if (name.startsWith('-')) return 'Branch names cannot start with "-".';
  if (name.startsWith('/') || name.endsWith('/')) return 'Branch names cannot start or end with "/".';
  if (name.includes('//')) return 'Branch names cannot contain "//".';
  if (name.endsWith('.')) return 'Branch names cannot end with ".".';
  if (name.endsWith('.lock')) return 'Branch names cannot end with ".lock".';
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')))
    return 'No part of a branch name may start with "." or end with ".lock".';
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * HTML (Azure Boards descriptions) → plain text: block tags become line breaks, list items get "• ",
 * all other tags are dropped and entities decoded. The result is rendered as text — never injected.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
      if (ent[0] === '#') {
        const code =
          ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[ent.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Description as displayable text: markdown/adf (Jira arrives converted) as-is, HTML stripped. */
export function issueBodyText(issue: Pick<Issue, 'body' | 'bodyFormat'>): string {
  return issue.bodyFormat === 'html' ? htmlToText(issue.body ?? '') : (issue.body ?? '');
}

/** Transition preselected by "Transition issue to …": the first one leading to an in-progress state. */
export function defaultTransition(
  transitions: readonly IssueTransition[] | undefined,
): IssueTransition | undefined {
  return transitions?.find((t) => t.toCategory === 'in_progress');
}

export type TrackerIconName = 'github' | 'gitlab' | 'jira' | 'trello' | 'azure';

export interface TrackerInfo {
  label: string;
  icon: TrackerIconName;
  /** CSS colour (design token) used to tint the icon. */
  color: string;
}

/** Icon + label per tracker kind (ref-label badges, panel header). */
export function trackerInfo(kind: TrackerKind | string): TrackerInfo {
  switch (kind) {
    case 'github':
      return { label: 'GitHub', icon: 'github', color: 'var(--kl-text-normal)' };
    case 'gitlab':
      return { label: 'GitLab', icon: 'gitlab', color: 'var(--kl-orange)' };
    case 'jira-cloud':
      return { label: 'Jira', icon: 'jira', color: 'var(--kl-blue)' };
    case 'jira-dc':
      return { label: 'Jira Data Center', icon: 'jira', color: 'var(--kl-blue)' };
    case 'trello':
      return { label: 'Trello', icon: 'trello', color: 'var(--kl-teal)' };
    case 'azure-boards':
    case 'azure-devops':
      return { label: 'Azure Boards', icon: 'azure', color: 'var(--kl-blue)' };
    default:
      return { label: 'Issue tracker', icon: 'jira', color: 'var(--kl-text-secondary)' };
  }
}

/** The `IssueRef` stored in branch links / passed over IPC for an issue. */
export function issueRefOf(issue: Issue, integrationKey: string): IssueRef {
  return {
    trackerKind: issue.tracker.kind,
    integrationKey,
    scope: issue.tracker.scope,
    key: issue.key,
    webUrl: issue.webUrl,
  };
}

/** `"bug, ui ,, docs"` → `['bug', 'ui', 'docs']` (trimmed, de-duplicated, empty dropped). */
export function parseLabels(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const l = raw.trim();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Whether the tracker supports an issue "type" field on create (Jira / Azure Boards). */
export const supportsIssueType = (kind: TrackerKind | string): boolean =>
  kind === 'jira-cloud' || kind === 'jira-dc' || kind === 'azure-boards' || kind === 'azure-devops';

/** Branch name of a graph pill that can carry an issue link (local / checked-out branch pills only). */
export function pillBranchName(pill: {
  kind: string;
  label: string;
  local?: { shortName: string };
  hasLocal: boolean;
}): string | null {
  if (pill.kind !== 'local' && pill.kind !== 'head') return null;
  if (pill.local) return pill.local.shortName;
  return pill.hasLocal ? pill.label : null;
}
