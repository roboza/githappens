import { integrationKey as keyOf, ProviderError, type RepoRef } from '@githappens/providers';

import type { IntegrationKind, IntegrationsIpcContract } from '../../shared/ipc/integrations-contract';
import type { IntegrationService } from '../integrations/integration-service';
import type { HandlerContext } from './registry';

export type IntegrationsHandlers = {
  [C in keyof IntegrationsIpcContract]: (
    req: IntegrationsIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => IntegrationsIpcContract[C]['res'] | Promise<IntegrationsIpcContract[C]['res']>;
};

/** OAuth flows run in main (system browser + loopback / device flow); see oauth-manager.ts. */
export interface OAuthFlows {
  start(kind: IntegrationKind, host: string | undefined): { flowId: string };
  cancel(flowId: string): void;
  availability(): Partial<Record<IntegrationKind, boolean>>;
  /** Best-effort token revocation at the provider before disconnecting. */
  revoke(integrationKey: string): Promise<'revoked' | 'unsupported' | void>;
}

const unsupported = (what: string): never => {
  throw new ProviderError({ code: 'unsupported', message: `This service does not support ${what}.` });
};

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`);
  return v;
}

/** Integrations IPC (spec 10 §5.5). Tokens only ever flow renderer → main (PAT entry), never back. */
export function createIntegrationsHandlers(svc: IntegrationService, oauth: OAuthFlows): IntegrationsHandlers {
  const hosting = (ref: RepoRef) => svc.provider(keyOf(ref.integration));
  const background = (ref: RepoRef, bg: boolean | undefined) =>
    svc.provider(keyOf(ref.integration), { background: !!bg });
  return {
    // ---- accounts ----
    'auth:list': () => svc.list(),
    'auth:startOAuth': ({ kind, host }) => oauth.start(kind, host),
    'auth:cancelOAuth': ({ flowId }) => oauth.cancel(flowId),
    'auth:connectPat': ({ kind, host, token, username }) =>
      svc.connect(kind, host, { type: 'pat', accessToken: str(token.trim(), 'token'), username }, 'pat'),
    'auth:disconnect': async ({ integrationKey, revoke }) => {
      if (revoke) await oauth.revoke(integrationKey).catch(() => undefined);
      svc.disconnect(integrationKey);
    },
    'auth:tokenPageUrl': ({ kind, host }) => svc.tokenPageUrl(kind, host),
    'auth:oauthAvailability': () => oauth.availability(),
    'auth:organizations': ({ integrationKey }) => svc.organizations(integrationKey),
    'auth:selectOrganization': ({ integrationKey, id }) =>
      svc.selectOrganization(integrationKey, str(id, 'organization')),

    // ---- repos ----
    'provider:listOwners': ({ integrationKey }) => svc.call(() => svc.provider(integrationKey).listOwners()),
    'provider:listRepos': ({ integrationKey, owner, query, cursor }) =>
      svc.call(() => svc.provider(integrationKey).listRepos({ owner, query, cursor })),
    'provider:listForks': ({ ref, cursor }) => svc.call(() => hosting(ref).listForks(ref, cursor)),
    'provider:createRepo': ({ integrationKey, ...opts }) =>
      svc.call(async () => {
        const p = svc.provider(integrationKey);
        if (!p.createRepo) return unsupported('creating repositories');
        return p.createRepo({ ...opts, name: str(opts.name?.trim(), 'name') });
      }),
    'provider:fork': ({ ref, owner }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.createFork) return unsupported('forking');
        return p.createFork(ref, owner ? { owner } : undefined);
      }),
    'provider:resolveRemotes': ({ repoId }) => svc.resolveRemotes(repoId),
    'provider:webUrl': ({ repoId, remote, target }) => svc.webUrl(repoId, target, remote),

    // ---- pull requests ----
    'pr:list': ({ repoId, filter, background: bg }) => svc.listPullRequests(repoId, filter, !!bg),
    'pr:get': ({ ref, number }) =>
      svc.call(async () => {
        const pr = await hosting(ref).getPullRequest(ref, number);
        if (pr === 'not-modified') throw new Error('Unexpected not-modified response');
        return pr;
      }),
    'pr:timeline': ({ ref, number, cursor }) => svc.call(() => hosting(ref).getTimeline(ref, number, cursor)),
    'pr:checks': ({ ref, sha, background: bg }) => svc.call(() => background(ref, bg).getChecks(ref, sha)),
    'pr:create': (input) => svc.call(() => hosting(input.base).createPullRequest(input)),
    'pr:update': ({ ref, number, patch }) =>
      svc.call(() => hosting(ref).updatePullRequest(ref, number, patch)),
    'pr:comment': ({ ref, number, body, inReplyTo }) =>
      svc.call(() => hosting(ref).addComment(ref, number, body, inReplyTo || undefined)),
    'pr:review': ({ ref, number, input }) => svc.call(() => hosting(ref).submitReview(ref, number, input)),
    'pr:merge': ({ ref, number, method, title, message, deleteBranch, expectedHeadSha }) =>
      svc.call(() =>
        hosting(ref).merge(ref, number, {
          method,
          title,
          message,
          deleteBranch,
          expectedHeadSha: str(expectedHeadSha, 'expectedHeadSha'),
        }),
      ),
    'pr:close': ({ ref, number }) => svc.call(() => hosting(ref).close(ref, number)),
    'pr:reopen': ({ ref, number }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (p.reopen) return p.reopen(ref, number);
        await p.updatePullRequest(ref, number, { state: 'open' });
      }),
    'pr:setDraft': ({ ref, number, draft }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.setDraft || !p.capabilities.prDraft) return unsupported('draft pull requests');
        return p.setDraft(ref, number, !!draft);
      }),
    'pr:resolveThread': ({ ref, threadId, resolved }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.setThreadResolved) return unsupported('resolving review threads');
        return p.setThreadResolved(ref, str(threadId, 'threadId'), !!resolved);
      }),
    'pr:setAutoMerge': ({ ref, number, method }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.setAutoMerge) return unsupported('auto-merge');
        return p.setAutoMerge(ref, number, method ?? null);
      }),
    'pr:checkout': ({ repoId, pr, mode, worktreePath }) =>
      svc.checkoutPr(repoId, pr, mode === 'worktree' ? 'worktree' : 'branch', worktreePath || undefined),
    'pr:fetch': ({ repoId, pr }) => svc.fetchPr(repoId, pr),
    'pr:commits': ({ repoId, base, head }) => svc.commits(repoId, base, head),
    'pr:conflictCheck': ({ repoId, source, target }) => svc.conflictCheck(repoId, source, target),
    'pr:templates': ({ repoId, ref, branch }) => svc.templates(repoId, ref, branch),
    'pr:searchUsers': ({ ref, query }) => svc.call(() => hosting(ref).searchUsers(ref, query)),
    'pr:labels': ({ ref }) => svc.call(() => hosting(ref).listLabels(ref)),
    'pr:milestones': ({ ref }) =>
      svc.call(async () => {
        const p = hosting(ref);
        return p.listMilestones && p.capabilities.prMilestone ? p.listMilestones(ref) : [];
      }),
    'pr:index': ({ repoId, background: bg }) => svc.prIndex(repoId, false, !!bg),
    'pr:filters': () => svc.prFilters(),
    'pr:saveFilters': ({ filters }) => svc.savePrFilters(filters),

    // ---- CI (spec 10 §4.8) ----
    'ci:list': ({ ref, branch, cursor, background: bg }) =>
      svc.call(async () => {
        const p = background(ref, bg);
        if (!p.listCiRuns) return { items: [] };
        return p.listCiRuns(ref, { branch: branch || undefined, cursor });
      }),
    'ci:rerun': ({ ref, runId, failedOnly }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.rerunCi) return unsupported('re-running CI');
        return p.rerunCi(ref, str(runId, 'runId'), { failedOnly: !!failedOnly });
      }),
    'ci:cancel': ({ ref, runId }) =>
      svc.call(async () => {
        const p = hosting(ref);
        if (!p.cancelCi) return unsupported('cancelling CI runs');
        return p.cancelCi(ref, str(runId, 'runId'));
      }),
    'ci:rerunFailed': ({ ref, branch }) => svc.rerunFailedCi(ref, str(branch, 'branch')),

    // ---- issues ----
    'issues:scopes': ({ integrationKey }) => svc.call(() => svc.tracker(integrationKey).listScopes()),
    'issues:list': ({ integrationKey, scope, filter, cursor, background: bg }) =>
      svc.call(() => svc.tracker(integrationKey, { background: !!bg }).listIssues(scope, filter, cursor)),
    'issues:get': ({ integrationKey, scope, key }) =>
      svc.call(() => svc.tracker(integrationKey).getIssue(scope, key)),
    'issues:create': ({ integrationKey, scope, input }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        if (!t.createIssue) return unsupported('creating issues');
        return t.createIssue(scope, { ...input, title: str(input.title?.trim(), 'title') });
      }),
    'issues:update': ({ integrationKey, scope, key, patch }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        if (!t.updateIssue) return unsupported('editing issues');
        return t.updateIssue(scope, key, patch);
      }),
    'issues:transitions': ({ integrationKey, scope, key }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        return t.listTransitions ? t.listTransitions(scope, key) : [];
      }),
    'issues:transition': ({ integrationKey, scope, key, transitionId }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        if (!t.transition) return unsupported('issue transitions');
        return t.transition(scope, key, str(transitionId, 'transitionId'));
      }),
    'issues:comment': ({ integrationKey, scope, key, body }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        if (!t.addComment) return unsupported('commenting on issues');
        return t.addComment(scope, key, str(body?.trim(), 'comment'));
      }),
    'issues:comments': ({ integrationKey, scope, key }) =>
      svc.call(async () => {
        const t = svc.tracker(integrationKey);
        return t.listComments ? t.listComments(scope, key) : [];
      }),
    'issues:assignSelf': ({ integrationKey, scope, key }) => svc.assignSelf(integrationKey, scope, key),
    'issues:createBranch': ({ repoId, issue, branchName, base, checkout, transitionId, assignSelf }) =>
      svc.createBranch(repoId, str(branchName, 'branch name'), str(base, 'base'), !!checkout, issue, {
        transitionId: transitionId || undefined,
        assignSelf: !!assignSelf,
      }),
    'issues:linkForBranch': ({ repoId, branch }) => svc.linkForBranch(repoId, str(branch, 'branch')),
    'issues:links': ({ repoId }) => svc.issueLinks(repoId),
    'issues:setLink': ({ repoId, branch, issue }) => svc.setIssueLink(repoId, str(branch, 'branch'), issue),

    // ---- SSH ----
    'ssh:upload': ({ integrationKey, title, publicKey }) =>
      svc.call(async () => {
        const p = svc.provider(integrationKey);
        if (!p.uploadSshKey) throw new Error('This provider does not support uploading SSH keys.');
        return p.uploadSshKey(str(title, 'title'), str(publicKey.trim(), 'publicKey'));
      }),
  };
}
