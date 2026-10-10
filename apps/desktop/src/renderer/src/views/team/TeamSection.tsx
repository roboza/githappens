import type { RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, Users } from 'lucide-react';
import { useState } from 'react';

import { useTeamStatus, useTeamView } from '../../conflicts/api';
import { Avatar } from '../../components/Avatar';
import { formatDate } from '../../lib/format';
import { useSettingsStore } from '../../stores/settings';
import leftStyles from '../left/LeftPanel.module.css';
import s from './Team.module.css';

const openPrefs = (section: string): void => {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: section }));
};

const ago = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : formatDate(Math.floor(t / 1000), 'relative');
};

/**
 * Left-panel TEAM section (spec 14 §4.4, org + opt-in): teammates with active branches in this repo,
 * touched-file counts and last activity. Hidden when no GitHappens Cloud server is configured; shows a
 * sign-in hint or the footprints opt-in prompt until sharing is active.
 */
export function TeamSection({ repoId }: { repoId: RepoId }) {
  const status = useTeamStatus();
  const st = status.data;
  const view = useTeamView(repoId, !!st?.active);
  const [open, setOpen] = useState(true);
  const setSetting = useSettingsStore((x) => x.set);
  if (!st?.configured) return null;

  const repo = view.data?.repos[0];
  const me = view.data?.me?.id;
  const members = (repo?.members ?? []).filter((m) => m.branches.length > 0);
  const count = members.filter((m) => m.user.id !== me).length;

  return (
    <section className={leftStyles.section}>
      <div className={leftStyles.sectionHeaderRow}>
        <button
          type="button"
          className={leftStyles.sectionHeader}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Users size={14} />
          <span className={leftStyles.sectionTitle}>Team</span>
          {st.active && <span className={leftStyles.count}>{count}</span>}
        </button>
        {st.active && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Refresh team"
            title="Refresh team"
            className={leftStyles.headerAdd}
            onClick={(e) => {
              e.stopPropagation();
              void view.refetch();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void view.refetch();
              }
            }}
          >
            <RefreshCw size={13} />
          </span>
        )}
      </div>
      {open && (
        <div role="tree" aria-label="Team">
          {!st.signedIn ? (
            <div className={s.prompt}>
              Sign in to GitHappens Cloud to see what your teammates are working on.
              <button type="button" className={s.promptBtn} onClick={() => openPrefs('Account')}>
                Sign in…
              </button>
            </div>
          ) : !st.orgId ? (
            <p className={leftStyles.empty}>Join or create an organization to use the team view.</p>
          ) : !st.footprintsEnabled ? (
            <div className={s.prompt}>
              Share which files and lines your unmerged branches change (never file contents; paths are hashed
              unless {st.orgName ?? 'your organization'} allows names) to get warned about overlapping work.
              <button
                type="button"
                className={s.promptBtn}
                onClick={() => void setSetting('team.footprints', true).then(() => status.refetch())}
              >
                Share work footprints
              </button>
            </div>
          ) : view.isError ? (
            <p className={`${leftStyles.empty} ${s.error}`}>Team view unavailable (offline?)</p>
          ) : view.isPending ? null : members.length === 0 ? (
            <p className={leftStyles.empty}>No teammates are working in this repository</p>
          ) : (
            members.map((m) => (
              <div key={m.user.id} role="group" aria-label={m.user.name}>
                <div
                  role="treeitem"
                  tabIndex={0}
                  className={`${leftStyles.row} ${s.member}`}
                  title={`${m.user.name}${m.user.email ? ` <${m.user.email}>` : ''}`}
                >
                  <Avatar name={m.user.name} email={m.user.email ?? ''} size={16} />
                  <span className={leftStyles.name}>
                    {m.user.name}
                    {m.user.id === me ? ' (you)' : ''}
                  </span>
                  <span className={s.when}>{ago(m.lastActivity)}</span>
                </div>
                {m.branches.map((b) => (
                  <div
                    key={b.branchHash}
                    role="treeitem"
                    tabIndex={-1}
                    className={`${leftStyles.row} ${s.branch}`}
                    title={b.branchLabel ?? 'Branch name not shared by organization policy'}
                  >
                    <GitBranch size={12} />
                    <span className={leftStyles.name}>
                      {b.branchLabel ?? `branch #${b.branchHash.slice(0, 6)}`}
                    </span>
                    <span className={s.files}>
                      {b.fileCount} file{b.fileCount === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
