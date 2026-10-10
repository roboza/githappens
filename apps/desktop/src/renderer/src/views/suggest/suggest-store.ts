import type { PullRequest } from '@githappens/providers/types';
import { create } from 'zustand';

import type { SuggestPr, SuggestSession } from '../../../../shared/ipc/suggest-contract';
import { extrasInvoke } from '../../cloud/extras-api';

/** Active Code Suggest sessions (isolated worktrees), shared by the banner and the PR header button. */
interface SuggestStore {
  sessions: SuggestSession[];
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useSuggestStore = create<SuggestStore>((set) => ({
  sessions: [],
  loaded: false,
  async refresh() {
    try {
      set({ sessions: await extrasInvoke('suggest:sessions', {}), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** The PR coordinates Code Suggest needs. */
export function toSuggestPr(pr: PullRequest): SuggestPr {
  return {
    ref: pr.repo,
    number: pr.number,
    title: pr.title,
    headSha: pr.head.sha,
    headBranch: pr.head.branch,
    baseBranch: pr.base.branch,
    isCrossRepository: pr.isCrossRepository,
    ...(pr.head.repoCloneUrl ? { headCloneUrl: pr.head.repoCloneUrl } : {}),
    webUrl: pr.webUrl,
  };
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function sessionForPath(
  sessions: SuggestSession[],
  repoPath: string | undefined,
): SuggestSession | undefined {
  if (!repoPath) return undefined;
  return sessions.find((s) => norm(s.worktreePath) === norm(repoPath));
}
