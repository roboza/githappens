import { Lock } from 'lucide-react';

import type { LfsLockInfo } from '../../../../shared/ipc/remotes-contract';
import styles from './lfs.module.css';

/**
 * Small "LFS" tag for file rows (spec 09 §2: tracked files show an LFS tag in the commit panel). Pass the
 * file's lock (from `useLfsLockMap`) to add a lock marker: accent when ours, red when someone else's.
 *
 * Usage in a file row: `const isLfs = useLfsMatcher(repoId); … {isLfs(path) && <LfsBadge lock={locks.get(path)} />}`
 */
export function LfsBadge({ lock, title }: { lock?: LfsLockInfo; title?: string }) {
  const lockTitle = lock
    ? lock.ours
      ? `Locked by you${lock.lockedAt ? ` since ${lock.lockedAt}` : ''}`
      : `Locked by ${lock.owner || 'someone else'}`
    : '';
  return (
    <span
      className={styles.badge}
      title={title ?? (lockTitle ? `Git LFS — ${lockTitle}` : 'Tracked by Git LFS')}
    >
      LFS
      {lock && <Lock size={10} aria-label={lockTitle} className={lock.ours ? styles.ours : styles.theirs} />}
    </span>
  );
}
