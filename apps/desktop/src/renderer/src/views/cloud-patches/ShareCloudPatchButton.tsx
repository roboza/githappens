import type { RepoId } from '@githappens/git/types';
import { CloudUpload } from 'lucide-react';

import { shareWip } from '../../cloud-patches/actions';
import { shareBlockedReason, usePatchAvailability } from '../../cloud-patches/api';

/**
 * WIP header icon "Share as Cloud Patch" (spec 14 §4.2). Hidden when no server is configured; disabled with
 * an explanation when signed out or there are no changes.
 */
export function ShareCloudPatchButton({
  repoId,
  hasChanges,
  className,
}: {
  repoId: RepoId;
  hasChanges: boolean;
  className?: string;
}) {
  const avail = usePatchAvailability();
  if (!avail.configured) return null;
  const blocked = shareBlockedReason(avail) ?? (hasChanges ? null : 'There are no changes to share.');
  return (
    <button
      type="button"
      className={className}
      disabled={!!blocked}
      onClick={() => void shareWip(repoId)}
      aria-label="Share as Cloud Patch"
      title={blocked ?? 'Share as Cloud Patch'}
    >
      <CloudUpload size={14} />
    </button>
  );
}
