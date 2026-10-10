import type { HttpClient } from '../http';
import type { InsightsDeployment, InsightsPr, ProviderInsights } from '../insights';
import type { RepoRef } from '../types';
import { gql } from './graphql';

/** GraphQL search: merged PRs of one repo in a window, with sizes, first commit and reviews. */
export const Q_INSIGHTS_PRS = `query KlInsightsPrs($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url createdAt mergedAt additions deletions
        author { login }
        mergeCommit { oid }
        commits(first: 1) { nodes { commit { authoredDate } } }
        timelineItems(first: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }
        reviews(first: 50) { nodes { submittedAt author { login } } }
      }
    }
  }
}`;

export interface GqlInsightsPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  mergeCommit: { oid: string } | null;
  commits: { nodes: Array<{ commit: { authoredDate: string } }> };
  timelineItems: { nodes: Array<{ createdAt?: string }> };
  reviews: { nodes: Array<{ submittedAt: string | null; author: { login: string } | null }> };
}

interface GqlSearch {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<GqlInsightsPr | Record<string, never>>;
  };
}

const day = (iso: string): string => iso.slice(0, 10);

export function normalizeGitHubInsightsPr(n: GqlInsightsPr): InsightsPr {
  const author = n.author?.login ?? 'ghost';
  const reviews = n.reviews.nodes
    .filter((r) => r.submittedAt && r.author && r.author.login !== author)
    .map((r) => ({ login: r.author!.login, at: r.submittedAt! }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const ready = n.timelineItems.nodes.find((x) => x.createdAt)?.createdAt;
  const first = n.commits.nodes[0]?.commit.authoredDate;
  return {
    number: n.number,
    title: n.title,
    author,
    createdAt: n.createdAt,
    ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}),
    ...(ready ? { readyAt: ready } : {}),
    ...(first ? { firstCommitAt: first } : {}),
    additions: n.additions,
    deletions: n.deletions,
    reviews,
    ...(n.mergeCommit ? { mergeCommitSha: n.mergeCommit.oid } : {}),
    webUrl: n.url,
  };
}

/** Insights queries for GitHub / GHE (GraphQL search + REST deployments). */
export function createGitHubInsights(o: { http: HttpClient; graphqlUrl: string }): ProviderInsights {
  const { http } = o;
  return {
    async mergedPullRequests(ref: RepoRef, q) {
      const range = q.until ? `${day(q.since)}..${day(q.until)}` : `>=${day(q.since)}`;
      const query = `repo:${ref.owner}/${ref.name} is:pr is:merged merged:${range} sort:updated-desc`;
      const items: InsightsPr[] = [];
      let after: string | null = null;
      let truncated: boolean;
      for (;;) {
        q.signal?.throwIfAborted();
        const data: GqlSearch = await gql<GqlSearch>(http, o.graphqlUrl, Q_INSIGHTS_PRS, { q: query, after });
        for (const n of data.search.nodes) {
          if (!('number' in n)) continue;
          const pr = normalizeGitHubInsightsPr(n as GqlInsightsPr);
          if (pr.mergedAt && pr.mergedAt >= q.since && (!q.until || pr.mergedAt < q.until)) items.push(pr);
        }
        if (items.length >= q.max) {
          truncated = data.search.pageInfo.hasNextPage || items.length > q.max;
          break;
        }
        // GitHub search returns at most 1,000 results per query.
        if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) {
          truncated = data.search.issueCount > 1000;
          break;
        }
        after = data.search.pageInfo.endCursor;
      }
      return { items: items.slice(0, q.max), truncated };
    },

    async deployments(ref, q) {
      const base = `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
      const out: InsightsDeployment[] = [];
      for (let page = 1; page <= 10 && out.length < q.max; page++) {
        q.signal?.throwIfAborted();
        const list = await http.get<
          Array<{ id: number; sha: string; environment: string; created_at: string }>
        >(`${base}/deployments`, { query: { environment: q.environment, per_page: 100, page } });
        let older = false;
        for (const d of list) {
          if (d.created_at < q.since) {
            older = true;
            continue;
          }
          const statuses = await http.get<Array<{ state: string; created_at: string }>>(
            `${base}/deployments/${d.id}/statuses`,
            { query: { per_page: 1 } },
          );
          const s = statuses[0];
          const known = ['success', 'failure', 'error', 'pending', 'inactive'];
          out.push({
            id: String(d.id),
            environment: d.environment,
            sha: d.sha,
            createdAt: d.created_at,
            state: (s && known.includes(s.state) ? s.state : 'unknown') as InsightsDeployment['state'],
            ...(s ? { stateAt: s.created_at } : {}),
          });
        }
        if (older || list.length < 100) break;
      }
      return out.slice(0, q.max);
    },
  };
}
