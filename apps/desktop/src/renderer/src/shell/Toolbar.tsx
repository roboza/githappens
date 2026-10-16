import type { GitOperationType } from '@githappens/git/ops';
import type { RepoId, RepoInfo } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  GitBranch,
  HardDrive,
  Loader2,
  Redo2,
  Search,
  SquareTerminal,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { createBranch, fetchAll, pull, push, redo, stashPop, stashSave, undo } from '../actions/git-actions';
import { useContextMenu } from '../components/ContextMenu';
import { invoke } from '../lib/api';
import { basename } from '../lib/format';
import { useRefs, useStashes, useStatus } from '../repo/queries';
import { useLayoutStore } from '../stores/layout';
import { useRepoOps } from '../stores/ops';
import { useSetting, useSettingsStore } from '../stores/settings';
import { shareAsCloudPatch } from '../cloud-patches';
import { repoOpenMenu } from '../tools/menus';
import { TargetIndicator } from '../views/conflicts/TargetIndicator';
import { openUndoHistory, useUndoPeek } from '../views/undo/useUndoPeek';
import { describeAutoFetch, resumeAutoFetch, useAutoFetchState } from '../notifications/auto-fetch-state';
import { useKeybindingLabel } from '../commands/keybindings-store';
import { useTabsStore } from '../stores/tabs';
import { lfsMenuItems } from '../views/lfs/lfs-actions';
import { openBranchCleanup } from '../views/remotes/dialog-store';
import { SparseToolbarButton } from '../views/sparse/SparseCheckout';
import { lfsInUse } from '../views/lfs/lfs-model';
import { BranchSwitcher, LaunchpadButton, RepoSwitcher, WorkspacesButton } from './Switchers';
import styles from './Toolbar.module.css';

function ToolButton(props: {
  icon: ReactNode;
  label: string;
  badge?: number;
  /** Small warning dot (e.g. auto-fetch paused). */
  alert?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onClick?(e?: React.MouseEvent): void;
  onMenu?(e: React.MouseEvent): void;
}) {
  return (
    <div className={styles.toolWrap}>
      <button
        type="button"
        className={styles.tool}
        disabled={props.disabled || props.busy}
        title={props.title ?? props.label}
        // The label is hidden at narrow widths / with ui.toolbarLabels off: keep the same accessible
        // name either way (the title carries the longer description and shortcut).
        aria-label={props.badge ? `${props.label} ${props.badge}` : props.label}
        onClick={props.onClick}
        aria-busy={props.busy}
      >
        {props.busy ? <Loader2 size={17} className={styles.spin} /> : props.icon}
        <span className={styles.toolLabel}>{props.label}</span>
        {!!props.badge && <span className={styles.badge}>{props.badge}</span>}
        {props.alert && <span className={styles.alertDot} aria-hidden />}
      </button>
      {props.onMenu && (
        <button
          type="button"
          className={styles.menuBtn}
          aria-label={`${props.label} options`}
          disabled={props.disabled}
          onClick={props.onMenu}
        >
          <ChevronDown size={12} />
        </button>
      )}
    </div>
  );
}

const PULL_LABEL = {
  'ff-if-possible': 'Fast-forward if possible',
  'ff-only': 'Fast-forward only',
  rebase: 'Rebase',
  'merge-no-ff': 'Always merge (no fast-forward)',
} as const;

/** Toolbar (spec 01 §4.3–4.4): breadcrumb + actions. */
export function Toolbar({ repoId, info, onSearch }: { repoId: RepoId; info: RepoInfo; onSearch(): void }) {
  const refs = useRefs(repoId);
  const stashes = useStashes(repoId);
  const status = useStatus(repoId, !info.isBare);
  const remotes = useQuery({
    queryKey: ['remotes', repoId],
    queryFn: () => invoke('git:remotes', { repoId }),
  });
  const pullMode = useSetting('git.pullMode') ?? 'ff-if-possible';
  const showLabels = useSetting('ui.toolbarLabels') ?? true;
  const autoFetch = useAutoFetchState(repoId);
  const autoFetchLine = describeAutoFetch(autoFetch);
  const setSetting = useSettingsStore((s) => s.set);
  const showMenu = useContextMenu((s) => s.show);
  // Kept fresh by the `undo:changed` event (spec 05 §5) instead of re-polling on every refs/status refresh.
  const peek = useUndoPeek(repoId);
  const ops = useRepoOps(repoId);
  const lfs = useQuery({
    queryKey: ['lfsStatus', repoId],
    queryFn: () => invoke('git:lfs:status', { repoId }),
  });
  /** LFS actions (spec 09 §4 LFS ▾). */
  const lfsMenu = (e?: React.MouseEvent): void => {
    const r = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    showMenu(r?.left ?? 200, (r?.bottom ?? 60) + 2, lfsMenuItems(repoId, lfs.data, remotes.data));
  };
  const running = (types: GitOperationType[]): boolean => ops.some((o) => types.includes(o.type));

  const headRef = refs.data?.find((r) => r.isHead && r.type === 'local');
  const branchLabel =
    info.head.kind === 'branch' ? info.head.name : `HEAD (detached at ${info.head.sha.slice(0, 7)})`;
  const repoName = basename(info.worktreeRoot ?? info.gitDir.replace(/[\\/]\.git$/, ''));
  const stateLabel = info.state !== 'clean' ? info.state.replace('-', ' ') : null;
  const hasRemotes = (remotes.data?.length ?? 0) > 0;
  const dirty = (status.data?.entries.filter((e) => e.kind !== 'ignored').length ?? 0) > 0;
  const unborn = info.head.sha === null;
  // Spec 01 §4.3: Push without an upstream asks for remote / branch name first.
  const noUpstream =
    info.head.kind === 'branch' && !!refs.data && (!headRef?.upstream || headRef.upstream.gone);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const repoLabel = activeTab?.kind === 'repo' && activeTab.alias ? activeTab.alias : repoName;
  const undoKey = useKeybindingLabel('core.undo');
  const redoKey = useKeybindingLabel('core.redo');
  const branchKey = useKeybindingLabel('branch.create');
  const fetchKey = useKeybindingLabel('remote.fetchAll');
  const searchCmdKey = useKeybindingLabel('history.searchCommits');
  const focusSearchKey = useKeybindingLabel('graph.focusSearch');
  const searchKey = searchCmdKey ?? focusSearchKey;
  const terminalKey = useKeybindingLabel('view.toggleTerminal');
  const withKey = (label: string, key: string | undefined): string => (key ? `${label} (${key})` : label);

  return (
    <div
      className={styles.toolbar}
      data-theme-scope="toolbar"
      data-focus-zone="toolbar"
      role="toolbar"
      aria-label="Repository actions"
      data-labels={showLabels ? undefined : 'off'}
    >
      <div className={styles.breadcrumb}>
        <RepoSwitcher label={repoLabel} title={info.worktreeRoot ?? info.gitDir} />
        {!info.isBare && (
          <button
            type="button"
            className={styles.menuBtn}
            aria-label="Open repository in…"
            title="Open in file manager, terminal or editor"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showMenu(r.left, r.bottom + 2, repoOpenMenu(repoId));
            }}
          >
            <ChevronDown size={12} />
          </button>
        )}
        <ChevronRight size={14} aria-hidden className={styles.sep} />
        <BranchSwitcher repoId={repoId} info={info} label={branchLabel} />
        <TargetIndicator
          repoId={repoId}
          onShareCloudPatch={(req) =>
            void shareAsCloudPatch(
              req.repoId,
              { kind: 'wip', stagedOnly: false },
              { collaborators: req.collaboratorIds },
            )
          }
        />
        {stateLabel && <span className={styles.state}>{stateLabel}</span>}
      </div>
      <div className={styles.actions}>
        <ToolButton
          icon={<Undo2 size={17} />}
          label="Undo"
          busy={running(['undo.run', 'reflog.restore'])}
          title={
            peek.data?.undo
              ? withKey(`Undo ${peek.data.undo.label}`, undoKey)
              : (peek.data?.blockedBy ?? 'Nothing to undo — click to restore from the reflog')
          }
          onClick={() => void undo(repoId)}
          onMenu={(e) => openUndoHistory(repoId, e)}
        />
        <ToolButton
          icon={<Redo2 size={17} />}
          label="Redo"
          disabled={!peek.data?.redo}
          busy={running(['redo.run'])}
          title={peek.data?.redo ? withKey(`Redo ${peek.data.redo.label}`, redoKey) : 'Nothing to redo'}
          onClick={() => void redo(repoId)}
        />
        <span className={styles.divider} />
        <ToolButton
          icon={<ArrowDownToLine size={17} />}
          label="Pull"
          badge={headRef?.upstream?.behind}
          disabled={!hasRemotes || info.isBare}
          busy={running(['pull', 'fetch'])}
          alert={!!autoFetch?.paused}
          title={
            hasRemotes
              ? `Pull (${PULL_LABEL[pullMode]})${autoFetchLine ? `\n${autoFetchLine}` : ''}`
              : 'No remotes'
          }
          onClick={() => pull(repoId)}
          onMenu={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 2, [
              { label: 'Fetch all', shortcut: fetchKey, onSelect: () => fetchAll(repoId) },
              ...(autoFetch?.paused
                ? [
                    {
                      label: 'Resume auto-fetch',
                      onSelect: () => void resumeAutoFetch(repoId).catch(() => undefined),
                    },
                  ]
                : []),
              'separator',
              ...(Object.keys(PULL_LABEL) as (keyof typeof PULL_LABEL)[]).map((m) => ({
                label: `${m === pullMode ? '✓ ' : '   '}Pull (${PULL_LABEL[m].toLowerCase()})`,
                onSelect: () => pull(repoId, m),
              })),
              'separator',
              ...(Object.keys(PULL_LABEL) as (keyof typeof PULL_LABEL)[])
                .filter((m) => m !== pullMode)
                .map((m) => ({
                  label: `Set default: ${PULL_LABEL[m]}`,
                  onSelect: () => void setSetting('git.pullMode', m),
                })),
            ]);
          }}
        />
        <ToolButton
          icon={<ArrowUpFromLine size={17} />}
          label="Push"
          badge={headRef?.upstream?.ahead}
          disabled={!hasRemotes || info.head.kind !== 'branch' || unborn}
          busy={running(['push'])}
          alert={noUpstream && hasRemotes}
          title={
            info.head.kind !== 'branch'
              ? 'Check out a branch to push'
              : noUpstream
                ? `Push — ${info.head.name} has no upstream yet; you will choose the remote branch`
                : 'Push'
          }
          onClick={() => void push(repoId)}
        />
        <ToolButton
          icon={<GitBranch size={17} />}
          label="Branch"
          disabled={unborn}
          busy={running(['branch.create'])}
          title={withKey('Create branch', branchKey)}
          onClick={() => void createBranch(repoId)}
          onMenu={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 2, [
              { label: 'Create branch…', shortcut: branchKey, onSelect: () => void createBranch(repoId) },
              { label: 'Clean up branches…', onSelect: () => openBranchCleanup(repoId) },
            ]);
          }}
        />
        <ToolButton
          icon={<Archive size={17} />}
          label="Stash"
          disabled={!dirty || info.isBare}
          busy={running(['stash.push'])}
          title={dirty ? 'Stash changes' : 'No changes to stash'}
          onClick={() => void stashSave(repoId)}
        />
        {lfsInUse(lfs.data) && (
          <ToolButton
            icon={<HardDrive size={17} />}
            label="LFS"
            busy={running(['lfs.pull', 'lfs.push', 'lfs.fetch', 'lfs.track', 'lfs.untrack'])}
            title={`Git LFS — ${lfs.data.tracked.length} tracked pattern${lfs.data.tracked.length === 1 ? '' : 's'}`}
            onClick={(e?: React.MouseEvent) => lfsMenu(e)}
          />
        )}
        <SparseToolbarButton
          repoId={repoId}
          busy={running(['sparse.set', 'sparse.add', 'sparse.disable', 'sparse.reapply'])}
          renderButton={(p) => <ToolButton {...p} />}
        />
        <ToolButton
          icon={<ArchiveRestore size={17} />}
          label="Pop"
          disabled={!stashes.data?.length}
          busy={running(['stash.pop'])}
          title={stashes.data?.[0] ? `Pop ${stashes.data[0].message}` : 'No stashes'}
          onClick={() => void stashPop(repoId)}
        />
      </div>
      <div className={styles.right}>
        <ToolButton
          icon={<Search size={17} />}
          label="Search"
          title={withKey('Search commits', searchKey)}
          onClick={onSearch}
        />
        <ToolButton
          icon={<SquareTerminal size={17} />}
          label="Terminal"
          disabled={info.isBare}
          title={withKey('Toggle terminal', terminalKey)}
          onClick={() =>
            useLayoutStore.getState().patch({ terminalOpen: !useLayoutStore.getState().terminalOpen })
          }
        />
        <LaunchpadButton className={styles.tool} labelClassName={styles.toolLabel} />
        <WorkspacesButton className={styles.tool} labelClassName={styles.toolLabel} />
      </div>
    </div>
  );
}
