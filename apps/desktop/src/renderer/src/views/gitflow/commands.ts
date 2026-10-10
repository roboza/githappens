import type { RepoId } from '@githappens/git/types';

import type { GitflowBranchKind } from '../../../../shared/ipc/gitflow-contract';
import type { CommandDef } from '../../commands/types';
import { GITFLOW_START_EVENT, requestGitflowInit } from '../../gitflow/api';
import { quiet, runOp } from '../../lib/ops';
import { FLOW_KINDS, KIND_TITLE } from './helpers';
import { confirmResetGitflow } from './reset';

/** Ask a mounted GitFlowSection to show the inline start input (any flow type, incl. bugfix/support). */
function requestStart(repoId: RepoId, kind: GitflowBranchKind): void {
  window.dispatchEvent(new CustomEvent(GITFLOW_START_EVENT, { detail: { repoId, kind } }));
}

/**
 * Command-palette entries for Git Flow (spec 12 §4.9). Init / Start open the UI of the mounted
 * GitFlowSection (dialog / inline input); Continue / Abort / Reset run the ops directly (Reset confirms).
 */
export function gitflowCommands(repoId: RepoId): CommandDef[] {
  return [
    {
      id: 'gitflow.init',
      title: 'Git Flow: Initialize…',
      category: 'Branch',
      keywords: ['gitflow', 'git flow', 'develop'],
      run: () => requestGitflowInit(repoId),
    },
    ...FLOW_KINDS.map((k): CommandDef => ({
      id: `gitflow.start.${k}`,
      title: `Git Flow: Start ${KIND_TITLE[k]}`,
      category: 'Branch',
      keywords: ['gitflow', 'git flow', k],
      run: () => requestStart(repoId, k),
    })),
    {
      id: 'gitflow.continue',
      title: 'Git Flow: Continue Finish',
      category: 'Branch',
      keywords: ['gitflow', 'git flow', 'resume'],
      run: () =>
        quiet(runOp(repoId, { type: 'gitflow.continue' }, { successToast: (r) => r.summary ?? 'Finished' })),
    },
    {
      id: 'gitflow.abort',
      title: 'Git Flow: Abort Finish',
      category: 'Branch',
      keywords: ['gitflow', 'git flow'],
      run: () =>
        quiet(runOp(repoId, { type: 'gitflow.abort' }, { successToast: (r) => r.summary ?? 'Aborted' })),
    },
    {
      id: 'gitflow.reset',
      title: 'Git Flow: Reset Configuration…',
      category: 'Branch',
      keywords: ['gitflow', 'git flow', 'remove', 'uninitialize'],
      run: () => void confirmResetGitflow(repoId),
    },
  ];
}
