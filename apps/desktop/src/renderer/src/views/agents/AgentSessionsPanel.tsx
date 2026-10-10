import type { RepoId, WorktreeInfo } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  FileDiff,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitBranchPlus,
  ListChecks,
  Plus,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { AgentSession } from '../../../../shared/ipc/agents-contract';
import { agentsInvoke, agentsOn } from '../../agents/api';
import { invoke } from '../../lib/api';
import { formatDate, fullDate } from '../../lib/format';
import { useRepoInfo, useStatus } from '../../repo/queries';
import { useWorktrees } from '../left/RepoExtrasSections';
import {
  createWorktreeWithAgent,
  editAgentSetupCommands,
  focusTerminalSession,
  openAgentSession,
  openWorktree,
  openWorktreeInTerminal,
  showWorktreeChanges,
  stopAgentSession,
} from './agent-actions';
import {
  AGENT_KIND_LABEL,
  AGENT_STATUS_LABEL,
  branchLabel,
  folderName,
  groupSessions,
} from './agent-helpers';
import styles from './AgentSessionsPanel.module.css';

export interface AgentSessionsPanelProps {
  repoId: RepoId;
}

/** Re-list at least this often (statuses are time-based); `agents:changed` triggers it sooner. */
const POLL_MS = 3000;

/**
 * Left-panel "Agents" mode (spec 12 §4.12): coding-agent sessions per worktree of the repo,
 * with status, Focus terminal / Stop / Show changes, and starting new sessions.
 */
export function AgentSessionsPanel({ repoId }: AgentSessionsPanelProps) {
  const qc = useQueryClient();
  const info = useRepoInfo(repoId);
  const worktrees = useWorktrees(repoId);
  const root = info.data?.worktreeRoot ?? null;

  const paths = useMemo(() => {
    const list = (worktrees.data ?? []).filter((w) => !w.bare).map((w) => w.path);
    if (!list.length && root) list.push(root);
    return list;
  }, [worktrees.data, root]);

  const sessions = useQuery({
    queryKey: ['agents', repoId, paths],
    queryFn: () => agentsInvoke('agents:list', { worktreePaths: paths, external: true }),
    enabled: paths.length > 0,
    refetchInterval: POLL_MS,
  });

  useEffect(
    () => agentsOn('agents:changed', () => void qc.invalidateQueries({ queryKey: ['agents', repoId] })),
    [qc, repoId],
  );

  const groups = useMemo(() => {
    const wts: WorktreeInfo[] = worktrees.data?.length
      ? worktrees.data
      : root
        ? [{ path: root, head: null, detached: false, bare: false, isMain: true, isCurrent: true }]
        : [];
    return groupSessions(wts, sessions.data ?? []);
  }, [worktrees.data, root, sessions.data]);

  return (
    <div className={styles.panel} aria-label="Agent sessions">
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolBtn}
          title="Create a worktree and start an agent in it"
          onClick={() => void createWorktreeWithAgent(repoId, root, qc)}
        >
          <GitBranchPlus size={14} />
          <span>Create worktree + agent</span>
        </button>
        {root && (
          <button
            type="button"
            className={styles.toolBtn}
            title="Commands typed into a new agent's terminal (once per worktree) before the agent starts"
            onClick={() => void editAgentSetupCommands(root)}
          >
            <ListChecks size={14} />
            <span>Setup commands…</span>
          </button>
        )}
      </div>
      {sessions.isError && (
        <div className={styles.error} role="alert">
          Could not list agent sessions: {(sessions.error as Error).message}
        </div>
      )}
      <div className={styles.groups} role="tree">
        {groups.map((g) => (
          <WorktreeGroupView
            key={g.worktree?.path ?? '(other)'}
            repoId={repoId}
            worktree={g.worktree}
            sessions={g.sessions}
          />
        ))}
        {worktrees.isLoading && <div className={styles.muted}>Loading worktrees…</div>}
      </div>
    </div>
  );
}

/** WIP file count of a worktree; other worktrees are opened as repos (ref-counted) while shown. */
function useWorktreeWip(repoId: RepoId, w: WorktreeInfo | null): number | null {
  const [otherId, setOtherId] = useState<RepoId | null>(null);
  const path = w && !w.isCurrent ? w.path : null;
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let opened: RepoId | null = null;
    invoke('git:repo:open', { path }).then(
      (r) => {
        opened = r.id;
        if (alive) setOtherId(r.id);
        else void invoke('git:repo:close', { repoId: r.id }).catch(() => undefined);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      setOtherId(null);
      if (opened) void invoke('git:repo:close', { repoId: opened }).catch(() => undefined);
    };
  }, [path]);
  const id = w?.isCurrent ? repoId : otherId;
  const status = useStatus(id ?? '', !!id);
  return id && status.data ? status.data.entries.length : null;
}

function WorktreeGroupView({
  repoId,
  worktree,
  sessions,
}: {
  repoId: RepoId;
  worktree: WorktreeInfo | null;
  sessions: AgentSession[];
}) {
  const wip = useWorktreeWip(repoId, worktree);
  const branch = worktree ? branchLabel(worktree) : '';
  return (
    <section className={styles.group} role="treeitem" aria-expanded>
      <header className={styles.groupHeader} title={worktree?.path}>
        {worktree ? (
          worktree.isMain ? (
            <FolderTree size={13} />
          ) : (
            <GitBranch size={13} />
          )
        ) : (
          <FolderOpen size={13} />
        )}
        <span className={styles.groupName}>
          {worktree ? (
            <>
              <span className={styles.branch}>{branch || folderName(worktree.path)}</span>
              {branch && <span className={styles.folder}>{folderName(worktree.path)}</span>}
            </>
          ) : (
            'Other folders'
          )}
        </span>
        {wip !== null && wip > 0 && (
          <span className={styles.wip} title={`${wip} changed file${wip === 1 ? '' : 's'}`}>
            {wip}
          </span>
        )}
        {worktree && !worktree.isCurrent && (
          <button
            type="button"
            className={styles.iconBtn}
            title="Open worktree"
            aria-label="Open worktree"
            onClick={() => openWorktree(worktree.path)}
          >
            <FolderOpen size={13} />
          </button>
        )}
        {worktree && (
          <button
            type="button"
            className={styles.iconBtn}
            title="Open in terminal"
            aria-label="Open in terminal"
            onClick={() => openWorktreeInTerminal(repoId, worktree.path)}
          >
            <SquareTerminal size={13} />
          </button>
        )}
        {worktree && (
          <button
            type="button"
            className={styles.iconBtn}
            title="New agent session"
            aria-label="New agent session"
            onClick={() => void openAgentSession(repoId, worktree.path)}
          >
            <Plus size={14} />
          </button>
        )}
      </header>
      {sessions.length === 0 ? (
        <div className={styles.empty}>No agent sessions</div>
      ) : (
        sessions.map((s) => <AgentCard key={s.id} repoId={repoId} session={s} />)
      )}
    </section>
  );
}

function AgentCard({ repoId, session: s }: { repoId: RepoId; session: AgentSession }) {
  const startedSec = Math.floor(s.startedAt / 1000);
  const actionable = !s.external && !!s.ptyId;
  return (
    <div
      className={styles.card}
      role="group"
      aria-label={s.label}
      onDoubleClick={() => actionable && focusTerminalSession(repoId, s.ptyId!)}
    >
      <div className={styles.cardTop}>
        <Bot size={14} className={styles[`kind_${s.kind}`]} aria-hidden />
        <span className={styles.kind}>{AGENT_KIND_LABEL[s.kind]}</span>
        <span className={`${styles.pill} ${styles[`st_${s.status}`]}`}>
          {s.status === 'running' && <span className={styles.dot} aria-hidden />}
          {AGENT_STATUS_LABEL[s.status]}
          {s.status === 'exited' && s.exitCode !== undefined && s.exitCode !== 0 ? ` (${s.exitCode})` : ''}
        </span>
      </div>
      <div className={styles.meta}>
        <span title={fullDate(startedSec)}>started {formatDate(startedSec)}</span>
        <span className={styles.sep}>·</span>
        {s.external ? (
          <span title={`pid ${s.pid ?? '?'} — started outside GitHappens (read-only)`}>external</span>
        ) : (
          <span title={s.cwd}>{s.launched ? s.label : `${s.command} in terminal`}</span>
        )}
      </div>
      <div className={styles.actions}>
        {actionable && (
          <button
            type="button"
            className={styles.action}
            onClick={() => focusTerminalSession(repoId, s.ptyId!)}
          >
            <SquareTerminal size={12} /> Focus terminal
          </button>
        )}
        {actionable && (
          <button
            type="button"
            className={styles.action}
            title={s.status === 'exited' ? 'Remove from the list' : 'Send Ctrl+C (kill after confirmation)'}
            onClick={() => void stopAgentSession(s)}
          >
            {s.status === 'exited' ? <X size={12} /> : <Square size={12} />}
            {s.status === 'exited' ? 'Dismiss' : 'Stop'}
          </button>
        )}
        {s.worktreePath && (
          <button
            type="button"
            className={styles.action}
            onClick={() => void showWorktreeChanges(repoId, s.worktreePath!)}
          >
            <FileDiff size={12} /> Show changes
          </button>
        )}
      </div>
    </div>
  );
}
