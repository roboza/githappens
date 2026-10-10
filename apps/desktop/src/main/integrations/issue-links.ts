import path from 'node:path';

import type { ConnectedIntegration, IssueRef, TrackerKind } from '@githappens/providers/types';

import { readJson, writeFileAtomic } from '../settings/atomic-file';

/**
 * Branch ↔ issue links (spec 10 §4.9): stored per repo in `<profile>/repos/<repoId>/issue-links.json`
 * (`branch → IssueRef`) and inferred from branch names (`ABC-123` for Jira, `42-…` / `#42` for GitHub/GitLab).
 */

interface LinksFile {
  version: 1;
  links: Record<string, IssueRef>;
}

export class IssueLinkStore {
  constructor(private readonly dir: () => string) {}

  private file(repoId: string): string {
    return path.join(this.dir(), 'repos', repoId.replace(/[^\w.-]+/g, '_'), 'issue-links.json');
  }

  all(repoId: string): Record<string, IssueRef> {
    const r = readJson<LinksFile>(this.file(repoId));
    return r.kind === 'ok' && r.value && typeof r.value.links === 'object' ? { ...r.value.links } : {};
  }

  get(repoId: string, branch: string): IssueRef | null {
    return this.all(repoId)[branch] ?? null;
  }

  set(repoId: string, branch: string, issue: IssueRef | null): void {
    const links = this.all(repoId);
    if (issue) links[branch] = issue;
    else delete links[branch];
    const data: LinksFile = { version: 1, links };
    writeFileAtomic(this.file(repoId), `${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Jira-style key anywhere in the branch name (`feature/ABC-123-login` → `ABC-123`). */
const JIRA_KEY = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])/;
/** GitHub/GitLab issue number: leading `42-…`, `#42…`, or `…/42-…` after a type prefix. */
const ISSUE_NUMBER = /(?:^|\/)#?(\d+)(?:[-_]|$)/;

export interface InferenceContext {
  /** Connected tracker accounts (Jira sites, GitHub/GitLab accounts). */
  accounts: Array<Pick<ConnectedIntegration, 'key' | 'kind' | 'host'>>;
  /** Hosting repo of `origin` (or first provider remote) mapped to a connected account, if any. */
  repo?: { integrationKey: string; kind: 'github' | 'gitlab'; owner: string; name: string; webBase: string };
}

/**
 * Infer the issue of a branch from its name. Jira keys need a connected Jira account (Cloud preferred);
 * plain numbers map to the repo's own GitHub/GitLab issues. Returns null when nothing matches.
 */
export function inferIssueLink(branch: string, ctx: InferenceContext): IssueRef | null {
  const name = branch.replace(/^refs\/heads\//, '');
  const jira = JIRA_KEY.exec(name);
  if (jira) {
    const acct =
      ctx.accounts.find((a) => a.kind === 'jira-cloud') ?? ctx.accounts.find((a) => a.kind === 'jira-dc');
    if (acct) {
      const key = jira[1]!;
      return {
        trackerKind: acct.kind as TrackerKind,
        integrationKey: acct.key,
        scope: key.split('-')[0]!,
        key,
        webUrl: `https://${acct.host}/browse/${key}`,
      };
    }
  }
  const num = ISSUE_NUMBER.exec(name);
  if (num && ctx.repo) {
    const n = num[1]!;
    const r = ctx.repo;
    return {
      trackerKind: r.kind,
      integrationKey: r.integrationKey,
      scope: `${r.owner}/${r.name}`,
      key: `#${n}`,
      webUrl: r.kind === 'gitlab' ? `${r.webBase}/-/issues/${n}` : `${r.webBase}/issues/${n}`,
    };
  }
  return null;
}
