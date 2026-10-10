import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpLeft } from 'lucide-react';
import { useState } from 'react';

import { invoke } from '../../lib/api';
import { runOp } from '../../lib/ops';
import { useRepoInfo } from '../../repo/queries';
import { useRepoUiStore } from '../../stores/repo-ui';
import { remotesInvoke } from '../remotes/remotes-ipc';
import { openRepoInCurrentTab } from '../worktrees/worktree-actions';
import styles from './submodules.module.css';
import { pointerChangeText } from './submodule-model';

/**
 * "Back to parent" banner (spec 09 §6.9 "Open"): shown while a submodule is open. When its HEAD moved
 * away from the parent's gitlink, offers to stage the new pointer in the parent and go back.
 */
export function SubmoduleParentBanner({ repoId }: { repoId: RepoId }) {
  const head = useRepoInfo(repoId).data?.head;
  const headKey = head ? (head.kind === 'branch' ? `${head.name}@${head.sha ?? ''}` : head.sha) : '';
  const parent = useQuery({
    queryKey: ['submoduleParent', repoId, headKey],
    queryFn: () => remotesInvoke('git:submodule:parent', { repoId }),
    staleTime: 10_000,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const p = parent.data;
  if (!p) return null;
  const parentName = p.parentPath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();

  const stageAndBack = async (): Promise<void> => {
    setBusy(true);
    try {
      const info = await invoke('git:repo:open', { path: p.parentPath });
      const r = await runOp(
        info.id,
        { type: 'wip.stage', paths: [p.path] },
        { successToast: `Staged the new pointer of ${p.path} in ${parentName}` },
      );
      if (r && (await openRepoInCurrentTab(p.parentPath))) {
        useRepoUiStore.getState().select(info.id, { kind: 'wip' });
      }
    } catch {
      /* runOp showed the error */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.banner} role="status">
      <div className={styles.bannerText}>
        <strong>Submodule</strong> {p.path} of {parentName}
        {p.pointerChanged && (
          <div className={styles.bannerSub}>
            {pointerChangeText({ path: p.path, from: p.indexSha ?? p.recordedSha, to: p.headSha })}
          </div>
        )}
      </div>
      <div className={styles.bannerActions}>
        {p.pointerChanged && (
          <button type="button" className="primary" disabled={busy} onClick={() => void stageAndBack()}>
            Stage pointer &amp; go back
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void openRepoInCurrentTab(p.parentPath)}>
          <ArrowUpLeft size={13} aria-hidden /> Back to parent
        </button>
      </div>
    </div>
  );
}
