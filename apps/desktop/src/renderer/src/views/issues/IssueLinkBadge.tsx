import type { RefPill } from '@githappens/graph';

import { pillBranchName } from '../../integrations/issue-helpers';
import { useIssueLinks } from '../../integrations/queries';
import { useActiveRepoId, useRememberQueryClient } from './issue-store';
import s from './IssueDetail.module.css';
import { openIssueDetail } from './IssueHost';
import { TrackerIcon } from './TrackerIcon';

/**
 * Tracker icon on a local branch pill linked to an issue (spec 10 §4.9); click opens the Issue panel.
 * Links come from `issues:links` (stored in issue-links.json, else inferred from `ABC-123` / `42-…` names).
 */
export function IssueLinkBadge({ pill }: { pill: RefPill }) {
  useRememberQueryClient();
  const repoId = useActiveRepoId();
  const links = useIssueLinks(repoId);
  const branch = pillBranchName(pill);
  const ref = branch ? links[branch] : undefined;
  if (!repoId || !ref) return null;
  const title = `Linked to ${ref.key} — click to view`;
  return (
    <button
      type="button"
      className={s.badge}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openIssueDetail(ref, { repoId });
      }}
    >
      <TrackerIcon kind={ref.trackerKind} size={11} />
    </button>
  );
}
