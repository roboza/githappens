import type { RepoId } from '@githappens/git/types';

import { confirm } from '../../components/Dialogs';
import { runOp } from '../../lib/ops';

/**
 * "Reset Git Flow configuration…" (spec 13 Gitflow "Initialize/Reset"): confirm, then run `gitflow.reset`,
 * which removes every `gitflow.*` key. Branches and tags are kept. Resolves true when the reset ran.
 */
export async function confirmResetGitflow(repoId: RepoId): Promise<boolean> {
  const ok = await confirm(
    'Reset Git Flow configuration?',
    'All gitflow.* settings (branch names, prefixes, version tag prefix) are removed from this repository. ' +
      'Branches and tags are kept. You can initialize Git Flow again later.',
    'Reset',
    true,
  );
  if (!ok) return false;
  try {
    return !!(await runOp(repoId, { type: 'gitflow.reset' }, { successToast: (r) => r.summary ?? 'Reset' }));
  } catch {
    return false; // reported by runOp
  }
}
