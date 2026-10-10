import type { ComposeSource } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';

import { useRepoUiStore, type ExplainTarget } from '../stores/repo-ui';

/** Show the AI Explain panel over the right panel (spec 12 §4.4). */
export function openExplain(repoId: RepoId, target: ExplainTarget): void {
  useRepoUiStore.getState().update(repoId, (u) => ({
    explain: { target, nonce: (u.explain?.nonce ?? 0) + 1 },
  }));
}

export function closeExplain(repoId: RepoId): void {
  useRepoUiStore.getState().update(repoId, () => ({ explain: null }));
}

/** Open the Commit Composer center view (spec 12 §4.6). */
export function openCompose(repoId: RepoId, source: ComposeSource): void {
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'compose', source } }));
}
