import { checkIgnored, HOOK_OUTPUT_PHASE, readCommitTemplate, type GitService } from '@githappens/git';
import type { RepoId } from '@githappens/git/types';

import type { CoAuthor, CommitEventContract } from '../../shared/ipc/commit-contract';
import { createCommitHandlers, type CommitHandlers } from '../ipc/commit-handlers';
import { filterCoAuthors, parseShortlog, ShortlogCache } from './co-authors';
import { commitContext, stagedEolIssues } from './context';
import { DraftStore } from './drafts';

export { DRAFT_MAX_AGE_MS, DraftStore, draftKey, sanitizeDraft } from './drafts';
export { filterCoAuthors, parseShortlog, ShortlogCache } from './co-authors';
export { commitContext, commitHooks, isRunnableHook, parseLsFilesEol, stagedEolIssues } from './context';

export interface CommitServicesDeps {
  userDataDir: () => string;
  repos: { get(repoId: RepoId): GitService };
  /**
   * Provider collaborators for the repository when an integration is connected (spec 10); optional and
   * best-effort — failures are ignored.
   */
  collaborators?: (repoId: RepoId) => Promise<CoAuthor[]>;
}

/**
 * `git:progress` events with the `hook-output` phase → `commit:hookOutput` payload (git sends hook
 * stdout to stderr, so every chunk is reported as `err`). Returns null for other progress events.
 */
export function hookOutputEvent(
  repoId: RepoId,
  opId: string,
  p: { phase: string; text: string },
): CommitEventContract['commit:hookOutput'] | null {
  if (p.phase !== HOOK_OUTPUT_PHASE) return null;
  return { repoId, opId, chunk: p.text, stream: 'err' };
}

/** Main-side services of the commit composer (spec 06): drafts, templates, co-authors, context. */
export function createCommitServices(d: CommitServicesDeps): {
  drafts: DraftStore;
  shortlog: ShortlogCache;
  handlers: CommitHandlers;
} {
  const drafts = new DraftStore(d.userDataDir);
  const shortlog = new ShortlogCache();
  const repoPath = (repoId: RepoId): string => {
    const r = d.repos.get(repoId).repo;
    return r.worktreeRoot ?? r.gitDir;
  };
  const handlers = createCommitHandlers({
    coAuthors: async (repoId, q, limit) => {
      const svc = d.repos.get(repoId);
      const history = await shortlog.get(svc.repo.commonDir, async () => {
        const r = await svc.runRead(['shortlog', '-sne', '--all', '--no-merges'], {
          expectedExitCodes: [0, 128],
          timeoutMs: 30_000,
        });
        return parseShortlog(String(r.stdout));
      });
      const provider = d.collaborators ? await d.collaborators(repoId).catch(() => []) : [];
      // the committer (config or GIT_COMMITTER_* env) never co-authors their own commit
      const me = await svc.runRead(['var', 'GIT_COMMITTER_IDENT'], { expectedExitCodes: [0, 128] });
      const self = /<([^>]*)>/.exec(String(me.stdout))?.[1]?.trim() ?? '';
      return filterCoAuthors([history, provider], q, { limit, exclude: self ? [self] : [] });
    },
    template: async (repoId) => readCommitTemplate(d.repos.get(repoId)),
    context: async (repoId) => commitContext(d.repos.get(repoId)),
    eolCheck: async (repoId) => stagedEolIssues(d.repos.get(repoId)),
    checkIgnore: async (repoId, p) => {
      const hit = await checkIgnored(d.repos.get(repoId), p);
      return hit ? { ignored: true, ...hit } : { ignored: false };
    },
    getDraft: (repoId, branch) => drafts.get(repoPath(repoId), branch),
    setDraft: (repoId, branch, draft) => drafts.set(repoPath(repoId), branch, draft),
  });
  return { drafts, shortlog, handlers };
}
