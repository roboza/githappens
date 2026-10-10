import type { RepoId } from '@githappens/git/types';

import type {
  CoAuthor,
  CommitContext,
  CommitIpcContract,
  CommitTemplate,
  EolIssue,
  IgnoreCheck,
  StoredDraft,
} from '../../shared/ipc/commit-contract';
import type { HandlerContext } from './registry';

export type CommitHandlers = {
  [C in keyof CommitIpcContract]: (
    req: CommitIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => CommitIpcContract[C]['res'] | Promise<CommitIpcContract[C]['res']>;
};

/** What the handlers need (implemented by `createCommitServices`, stubbed in tests). */
export interface CommitHandlerDeps {
  coAuthors(repoId: RepoId, q: string, limit: number): Promise<CoAuthor[]>;
  template(repoId: RepoId): Promise<CommitTemplate>;
  context(repoId: RepoId): Promise<CommitContext>;
  eolCheck(repoId: RepoId): Promise<EolIssue[]>;
  checkIgnore(repoId: RepoId, path: string): Promise<IgnoreCheck>;
  getDraft(repoId: RepoId, branch: string | null): StoredDraft | null;
  setDraft(repoId: RepoId, branch: string | null, draft: StoredDraft | null): void;
}

const MAX_LIMIT = 100;
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const branchOf = (v: unknown): string | null =>
  typeof v === 'string' && v && !/[\0\r\n]/.test(v) ? v.slice(0, 1024) : null;

/** Commit composer IPC (spec 06 §5). Input is validated here; mutations stay `git:op:run`. */
export function createCommitHandlers(d: CommitHandlerDeps): CommitHandlers {
  return {
    'commit:coAuthorSuggestions': ({ repoId, q, limit }) =>
      d.coAuthors(repoId, str(q, 200), Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit) || 20)))),
    'commit:template': ({ repoId }) => d.template(repoId),
    'commit:context': ({ repoId }) => d.context(repoId),
    'commit:eolCheck': ({ repoId }) => d.eolCheck(repoId),
    'commit:checkIgnore': ({ repoId, path }) => {
      const p = str(path, 4096).replace(/\\/g, '/');
      if (!p || p.startsWith('-') || /[\0\r\n]/.test(p)) return { ignored: false };
      return d.checkIgnore(repoId, p);
    },
    'commit:draft:get': ({ repoId, branch }) => d.getDraft(repoId, branchOf(branch)),
    'commit:draft:set': ({ repoId, branch, draft }) => d.setDraft(repoId, branchOf(branch), draft),
  };
}
