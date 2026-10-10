import type { RepoId } from '@githappens/git/types';
import { Target } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useConflictReport } from '../../conflicts/api';
import { indicatorView } from '../../conflicts/helpers';
import { ConflictPopover, type ShareCloudPatchRequest } from './ConflictPopover';
import s from './Conflicts.module.css';

/**
 * Target indicator next to the branch crumb (spec 14 §4.4): grey ◎ = no conflicts, amber = conflicts with
 * the target, badge = conflicted files + teammate overlaps (red when teammates overlap). Hidden for
 * detached HEAD / unborn / bare repos and when no target resolves.
 */
export function TargetIndicator({
  repoId,
  onShareCloudPatch,
}: {
  repoId: RepoId;
  onShareCloudPatch?: (req: ShareCloudPatchRequest) => void;
}) {
  const q = useConflictReport(repoId);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const view = indicatorView(q.data);
  if (!view.visible || !q.data) return null;
  return (
    <>
      <button
        type="button"
        className={`${s.indicator} ${view.tone === 'amber' ? s.amber : ''}`}
        title={view.tooltip}
        aria-label={`Conflict prevention: ${view.tooltip.replace(/\n/g, '; ')}`}
        data-conflict-indicator
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <Target size={15} aria-hidden />
        {view.badge > 0 && (
          <span className={`${s.badge} ${view.badgeTone === 'red' ? s.badgeRed : s.badgeAmber}`}>
            {view.badge}
          </span>
        )}
      </button>
      {anchor && (
        <ConflictPopover
          repoId={repoId}
          report={q.data}
          anchor={anchor}
          onClose={close}
          onShareCloudPatch={onShareCloudPatch}
        />
      )}
    </>
  );
}
