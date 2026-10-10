import type { HttpClient } from '../http';
import type { InsightsPr, ProviderInsights } from '../insights';

interface GlMr {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha?: string | null;
  author: { username: string } | null;
}

interface GlNote {
  author: { username: string };
  created_at: string;
  system: boolean;
  body: string;
}

/** Insights queries for GitLab (REST: merged MRs, diff size and first review note / approval per MR). */
export function createGitLabInsights(o: { http: HttpClient }): ProviderInsights {
  const { http } = o;
  return {
    async mergedPullRequests(ref, q) {
      const project = `projects/${encodeURIComponent(`${ref.owner}/${ref.name}`)}`;
      const items: InsightsPr[] = [];
      let truncated = false;
      for (let page = 1; page <= 50 && !truncated; page++) {
        q.signal?.throwIfAborted();
        const list = await http.get<GlMr[]>(`${project}/merge_requests`, {
          query: { state: 'merged', updated_after: q.since, per_page: 100, page, order_by: 'updated_at' },
        });
        for (const mr of list) {
          if (!mr.merged_at || mr.merged_at < q.since || (q.until && mr.merged_at >= q.until)) continue;
          if (items.length >= q.max) {
            truncated = true;
            break;
          }
          const author = mr.author?.username ?? 'ghost';
          const [changes, notes] = await Promise.all([
            http
              .get<{ changes?: Array<{ diff: string }> }>(`${project}/merge_requests/${mr.iid}/changes`)
              .catch(() => ({ changes: [] as Array<{ diff: string }> })),
            http
              .get<GlNote[]>(`${project}/merge_requests/${mr.iid}/notes`, {
                query: { sort: 'asc', order_by: 'created_at', per_page: 50 },
              })
              .catch(() => [] as GlNote[]),
          ]);
          let additions = 0;
          let deletions = 0;
          for (const c of changes.changes ?? []) {
            for (const line of c.diff.split('\n')) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
          }
          const merge = mr.merge_commit_sha ?? mr.squash_commit_sha ?? undefined;
          items.push({
            number: mr.iid,
            title: mr.title,
            author,
            createdAt: mr.created_at,
            mergedAt: mr.merged_at,
            additions,
            deletions,
            reviews: notes
              .filter((n) => n.author.username !== author && (!n.system || /^approved/i.test(n.body)))
              .map((n) => ({ login: n.author.username, at: n.created_at })),
            ...(merge ? { mergeCommitSha: merge } : {}),
            webUrl: mr.web_url,
          });
        }
        if (list.length < 100) break;
      }
      return { items, truncated };
    },
  };
}
