import { compactGroups, DEFAULT_FILTERS, type LaunchpadGroup } from '@githappens/launchpad';
import { CircleDot, GitPullRequest } from 'lucide-react';
import { useMemo } from 'react';

import { openItem } from '../../launchpad/actions';
import { useLaunchpad } from '../../launchpad/queries';
import { useTabsStore } from '../../stores/tabs';
import s from './Launchpad.module.css';

const GROUPS: LaunchpadGroup[] = ['needs-review', 'ready-to-merge', 'blocked'];

/**
 * Home view "Focus" column (spec 11 §4.4): Needs your review / Ready to merge / Blocked, max 5 each,
 * with "See all in Launchpad" links that open the pinned tab at that group.
 */
export function CompactLaunchpad({ perGroup = 5, active = true }: { perGroup?: number; active?: boolean }) {
  const q = useLaunchpad(DEFAULT_FILTERS, 'prs', active);
  const groups = useMemo(
    () => compactGroups(q.data?.items ?? [], GROUPS, perGroup),
    [q.data?.items, perGroup],
  );
  const open = (group?: LaunchpadGroup) => useTabsStore.getState().openLaunchpad({ tab: 'prs', group });

  if (q.isPending) return <p className={s.compactMuted}>Loading…</p>;
  if (q.isError) return <p className={s.compactMuted}>Launchpad unavailable.</p>;
  if (!q.data.hasIntegrations)
    return (
      <p className={s.compactMuted}>
        Connect GitHub, GitLab, Bitbucket or Azure DevOps to see your pull requests.
      </p>
    );

  const empty = groups.every((g) => g.total === 0);
  return (
    <div className={s.compact} aria-label="Launchpad summary">
      {empty ? (
        <p className={s.compactMuted}>You’re all caught up.</p>
      ) : (
        groups
          .filter((g) => g.total > 0)
          .map((g) => (
            <div key={g.group} className={s.compactGroup}>
              <h4>
                <span className={`${s.groupDot} ${s[`bg-${g.group}`] ?? ''}`} aria-hidden />
                {g.label}
                <span className={s.count}>{g.total}</span>
              </h4>
              {g.items.map((i) => (
                <button
                  key={i.uid}
                  type="button"
                  className={s.compactRow}
                  title={`${i.repo?.fullName ?? ''} — ${i.title}`}
                  onClick={() => void openItem(i)}
                >
                  {i.type === 'pr' ? (
                    <GitPullRequest size={12} aria-hidden />
                  ) : (
                    <CircleDot size={12} aria-hidden />
                  )}
                  <span className={s.rowTitle}>{i.title}</span>
                  <span className={s.repo}>{i.type === 'pr' ? `#${i.pr.number}` : ''}</span>
                </button>
              ))}
              {g.total > g.items.length && (
                <button type="button" className={s.linkBtn} onClick={() => open(g.group)}>
                  +{g.total - g.items.length} more
                </button>
              )}
            </div>
          ))
      )}
      <button type="button" className={s.linkBtn} onClick={() => open()}>
        See all in Launchpad
      </button>
    </div>
  );
}
