import { type HttpClient, ProviderError } from '../http';

export interface GqlError {
  type?: string;
  message: string;
  path?: Array<string | number>;
}

/** Maps GraphQL `errors[]` to a ProviderError. */
export function gqlError(errors: GqlError[], headers?: Headers): ProviderError {
  const e = errors[0]!;
  const providerMessage = errors.map((x) => x.message).join('; ');
  const base = { message: e.message, providerMessage };
  switch (e.type) {
    case 'NOT_FOUND':
      return new ProviderError({ ...base, code: 'not_found' });
    case 'RATE_LIMITED': {
      const reset = Number(headers?.get('x-ratelimit-reset') ?? 0);
      return new ProviderError({
        ...base,
        code: 'rate_limited',
        message: 'Rate limit exceeded.',
        retryAt: reset > 1e9 ? reset * 1000 : Date.now() + 60_000,
      });
    }
    case 'INSUFFICIENT_SCOPES': {
      const m = /requires one of the following scopes: \[([^\]]*)\]/.exec(e.message);
      const missingScopes = m
        ? m[1]!
            .split(',')
            .map((s) => s.trim().replace(/^'|'$/g, ''))
            .filter(Boolean)
        : undefined;
      return new ProviderError({ ...base, code: 'insufficient_scope', missingScopes });
    }
    case 'FORBIDDEN':
      return new ProviderError({
        ...base,
        code: /SAML|OAuth App access restrictions|organization/i.test(e.message)
          ? 'forbidden_org_policy'
          : 'insufficient_scope',
      });
    case 'UNPROCESSABLE':
    case 'BAD_USER_INPUT':
      return new ProviderError({ ...base, code: 'validation' });
    default:
      return new ProviderError({
        ...base,
        code: /conflict|head (sha|branch) .*(changed|modified)/i.test(e.message) ? 'conflict' : 'server',
      });
  }
}

/**
 * POSTs a GraphQL operation. Errors are thrown when there is no data, on rate limiting/scopes,
 * or when a top-level field failed; nested partial errors (e.g. inaccessible fork) are tolerated.
 */
export async function gql<T>(
  http: HttpClient,
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await http.request<{ data?: T | null; errors?: GqlError[] }>(url, {
    method: 'POST',
    body: { query, variables },
  });
  const body = res.data ?? {};
  const errors = body.errors ?? [];
  const fatal = errors.filter(
    (e) => !e.path || e.path.length <= 1 || e.type === 'RATE_LIMITED' || e.type === 'INSUFFICIENT_SCOPES',
  );
  if (!body.data || fatal.length)
    throw gqlError(
      fatal.length ? fatal : errors.length ? errors : [{ message: 'Empty GraphQL response' }],
      res.headers,
    );
  return body.data;
}

const ACTOR = `login avatarUrl ... on User { id name } ... on Bot { id } ... on Mannequin { id }`;

export const PR_FIELDS = `
fragment PrFields on PullRequest {
  id number title body isDraft state url createdAt updatedAt mergedAt closedAt
  additions deletions changedFiles isCrossRepository
  author { ${ACTOR} }
  headRefName headRefOid
  headRepository { id name url sshUrl owner { login } }
  baseRefName baseRefOid
  baseRepository { id name owner { login } viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }
  reviewDecision mergeable
  viewerCanUpdate viewerDidAuthor
  comments { totalCount }
  reviewRequests(first: 20) { nodes { asCodeOwner requestedReviewer { __typename ... on User { id login name avatarUrl } ... on Team { id slug name avatarUrl } ... on Bot { id login avatarUrl } } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { ${ACTOR} } } }
  assignees(first: 10) { nodes { id login name avatarUrl } }
  labels(first: 20) { nodes { name color } }
  milestone { id number title }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export const Q_PR_LIST = `
query GitHappensPrList($owner: String!, $name: String!, $states: [PullRequestState!], $head: String, $first: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, headRefName: $head, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ...PrFields }
    }
  }
}
${PR_FIELDS}`;

export const Q_PR_SEARCH = `
query GitHappensPrSearch($q: String!, $first: Int!, $after: String) {
  viewer { login }
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ...PrFields } }
  }
}
${PR_FIELDS}`;

export const Q_PR = `
query GitHappensPr($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ...PrFields viewerCanMergeAsAdmin }
  }
}
${PR_FIELDS}`;

export const Q_PR_ID = `
query GitHappensPrId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

export const Q_TIMELINE = `
query GitHappensPrTimeline($owner: String!, $name: String!, $number: Int!, $after: String, $withThreads: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT,
        HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT,
        REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT,
        READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, BASE_REF_CHANGED_EVENT, HEAD_REF_DELETED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { id databaseId body createdAt viewerCanUpdate author { ${ACTOR} } }
          ... on PullRequestReview { id databaseId state body createdAt author { ${ACTOR} } }
          ... on PullRequestCommit { commit { oid committedDate author { name user { id login name avatarUrl } } } }
          ... on HeadRefForcePushedEvent { createdAt actor { ${ACTOR} } beforeCommit { oid } afterCommit { oid } }
          ... on LabeledEvent { createdAt actor { ${ACTOR} } label { name } }
          ... on UnlabeledEvent { createdAt actor { ${ACTOR} } label { name } }
          ... on AssignedEvent { createdAt actor { ${ACTOR} } assignee { ... on User { login } ... on Bot { login } } }
          ... on UnassignedEvent { createdAt actor { ${ACTOR} } assignee { ... on User { login } ... on Bot { login } } }
          ... on ReviewRequestedEvent { createdAt actor { ${ACTOR} } requestedReviewer { ... on User { login } ... on Team { slug } } }
          ... on ReviewRequestRemovedEvent { createdAt actor { ${ACTOR} } requestedReviewer { ... on User { login } ... on Team { slug } } }
          ... on MergedEvent { createdAt actor { ${ACTOR} } mergeRefName commit { oid } }
          ... on ClosedEvent { createdAt actor { ${ACTOR} } }
          ... on ReopenedEvent { createdAt actor { ${ACTOR} } }
          ... on ReadyForReviewEvent { createdAt actor { ${ACTOR} } }
          ... on ConvertToDraftEvent { createdAt actor { ${ACTOR} } }
          ... on RenamedTitleEvent { createdAt actor { ${ACTOR} } previousTitle currentTitle }
          ... on BaseRefChangedEvent { createdAt actor { ${ACTOR} } previousRefName currentRefName }
          ... on HeadRefDeletedEvent { createdAt actor { ${ACTOR} } headRefName }
        }
      }
      reviewThreads(first: 100) @include(if: $withThreads) {
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { nodes { id databaseId body createdAt diffHunk author { ${ACTOR} } } }
        }
      }
    }
  }
}`;

export const Q_ASSIGNABLE = `
query GitHappensAssignable($owner: String!, $name: String!, $q: String) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 30, query: $q) { nodes { id login name avatarUrl } }
  }
}`;

export const M_DRAFT = `
mutation GitHappensConvertToDraft($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }`;
export const M_READY = `
mutation GitHappensReadyForReview($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }`;
export const M_RESOLVE = `
mutation GitHappensResolveThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;
export const M_UNRESOLVE = `
mutation GitHappensUnresolveThread($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;
export const M_THREAD_REPLY = `
mutation GitHappensThreadReply($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
    comment { id databaseId body createdAt author { ${ACTOR} } }
  }
}`;
export const M_AUTO_MERGE = `
mutation GitHappensEnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id } }
}`;
export const M_AUTO_MERGE_OFF = `
mutation GitHappensDisableAutoMerge($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id } } }`;

/** Max length of one GitHub search query string (spec 11 §6.4: split when longer). */
export const SEARCH_QUERY_MAX = 250;

/**
 * Batched personal PR search (spec 11 §6.4): one request with an aliased `search` per query string.
 * Aliases are `s0…sN` with variables `$q0…$qN`.
 */
export function buildMyPrsQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$q${i}: String!`).join(', ');
  const fields = Array.from(
    { length: count },
    (_, i) =>
      `  s${i}: search(type: ISSUE, query: $q${i}, first: $first) { issueCount nodes { ... on PullRequest { ...PrFields } } }`,
  ).join('\n');
  return `
query GitHappensMyPullRequests($first: Int!, ${vars}) {
  viewer { login }
${fields}
}
${PR_FIELDS}`;
}

/**
 * Split `repo:` qualifiers so `base + repos` stays under SEARCH_QUERY_MAX characters per query.
 * No repos → a single query without repo terms.
 */
export function searchQueries(
  base: string,
  repos: Array<{ owner: string; name: string }> | undefined,
): string[] {
  if (!repos?.length) return [base];
  const out: string[] = [];
  let cur = base;
  let n = 0;
  for (const r of repos) {
    const term = ` repo:${r.owner}/${r.name}`;
    if (n > 0 && cur.length + term.length > SEARCH_QUERY_MAX) {
      out.push(cur);
      cur = base;
      n = 0;
    }
    cur += term;
    n++;
  }
  out.push(cur);
  return out;
}
