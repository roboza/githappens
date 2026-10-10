import { DEFAULT_FILTERS, recentWips, topIssues, type ClassifiedItem } from '@githappens/launchpad';
import { CircleDot, FolderGit2, GitBranch } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { openItem } from '../../launchpad/actions';
import { wipLabel } from '../../launchpad/helpers';
import { useLaunchpad } from '../../launchpad/queries';
import { useTabsStore } from '../../stores/tabs';
import { CompactLaunchpad } from '../launchpad/CompactLaunchpad';
import lp from '../launchpad/Launchpad.module.css';
import s from './Home.module.css';

const PER_SECTION = 5;

function Section({
  title,
  total,
  children,
  onSeeAll,
}: {
  title: string;
  total: number;
  children: ReactNode;
  onSeeAll(): void;
}) {
  return (
    <section className={s.section} aria-label={title}>
      <h3 className={s.heading}>
        {title}
        <span className={lp.count}>{total}</span>
      </h3>
      {children}
      {total > PER_SECTION && (
        <button type="button" className={lp.linkBtn} onClick={onSeeAll}>
          +{total - PER_SECTION} more in Launchpad
        </button>
      )}
    </section>
  );
}

/** "My issues" (top 5 by priority, then recency) — spec 11 §4.4. */
export function MyIssues({ active = true }: { active?: boolean }) {
  const q = useLaunchpad(DEFAULT_FILTERS, 'issues', active);
  const all = q.data?.items;
  const top = useMemo(() => topIssues(all ?? [], Number.MAX_SAFE_INTEGER), [all]);
  if (q.isPending || !q.data?.hasIntegrations) return null;
  const open = () => useTabsStore.getState().openLaunchpad({ tab: 'issues' });
  return (
    <Section title="My issues" total={top.length} onSeeAll={open}>
      {top.length === 0 ? (
        <p className={lp.compactMuted}>No open issues assigned to you.</p>
      ) : (
        top.slice(0, PER_SECTION).map((i) => <IssueRow key={i.uid} item={i} />)
      )}
    </Section>
  );
}

function IssueRow({ item }: { item: ClassifiedItem }) {
  if (item.type !== 'issue') return null;
  return (
    <button
      type="button"
      className={lp.compactRow}
      title={`${item.repo?.fullName ?? ''} — ${item.title}`}
      onClick={() => void openItem(item)}
    >
      <CircleDot size={12} aria-hidden />
      <span className={s.key}>{item.issue.key}</span>
      <span className={lp.rowTitle}>{item.title}</span>
      {item.issue.priority && <span className={s.meta}>{item.issue.priority}</span>}
    </button>
  );
}

/** "WIPs across recent repos" (repos with uncommitted changes) — spec 11 §4.4. */
export function RecentWips({ active = true }: { active?: boolean }) {
  const q = useLaunchpad(DEFAULT_FILTERS, 'wips', active);
  const all = q.data?.items;
  const wips = useMemo(() => recentWips(all ?? [], Number.MAX_SAFE_INTEGER), [all]);
  if (q.isPending) return null;
  const open = () => useTabsStore.getState().openLaunchpad({ tab: 'wips' });
  return (
    <Section title="WIPs across recent repos" total={wips.length} onSeeAll={open}>
      {wips.length === 0 ? (
        <p className={lp.compactMuted}>No uncommitted changes in your recent repositories.</p>
      ) : (
        wips.slice(0, PER_SECTION).map((i) =>
          i.type === 'wip' ? (
            <button
              key={i.uid}
              type="button"
              className={lp.compactRow}
              title={i.status.path}
              onClick={() => void openItem(i)}
            >
              <FolderGit2 size={12} aria-hidden />
              <span className={lp.rowTitle}>{i.status.name}</span>
              {i.status.branch && (
                <span className={s.meta}>
                  <GitBranch size={10} aria-hidden /> {i.status.branch}
                </span>
              )}
              <span className={s.meta}>{wipLabel(i.status)}</span>
            </button>
          ) : null,
        )
      )}
    </Section>
  );
}

/**
 * Home view "Focus" column (spec 11 §4.4): compact Launchpad (needs review / ready to merge /
 * blocked), My issues and WIPs across recent repos. Pass as `RepoManagementView`'s `focus` prop.
 */
export function HomeFocus({ active = true }: { active?: boolean }) {
  return (
    <div className={s.focus}>
      <CompactLaunchpad active={active} />
      <MyIssues active={active} />
      <RecentWips active={active} />
    </div>
  );
}
