import type { RepoId, RepoInfo } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  Cloud,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  Layers,
  Plus,
  Rocket,
  Star,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { checkout } from '../actions/git-actions';
import { checkoutTargetFor } from '../actions/menus';
import { runCommand } from '../commands';
import { invoke } from '../lib/api';
import { quiet, runOp } from '../lib/ops';
import { useRefs } from '../repo/queries';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaces, useWorkspaceUi } from '../workspaces/queries';
import { FilterDropdown } from './FilterDropdown';
import { branchSwitcherItems, repoSwitcherItems } from './switcher-model';
import styles from './Toolbar.module.css';

type Anchor = { left: number; top: number } | null;

function anchorOf(e: React.MouseEvent<HTMLElement>): { left: number; top: number } {
  const r = e.currentTarget.getBoundingClientRect();
  return { left: r.left, top: r.bottom + 2 };
}

const ICONS: Record<string, ReactNode> = {
  'Open tabs': <FolderGit2 size={14} aria-hidden />,
  Favorites: <Star size={14} aria-hidden />,
  Recent: <FolderGit2 size={14} aria-hidden />,
};

/** Breadcrumb `repository ▾` (spec 01 §4.4): open tabs, favorites, recents, Open / Clone / Init. */
export function RepoSwitcher({ label, title }: { label: string; title: string }) {
  const [at, setAt] = useState<Anchor>(null);
  const { tabs, activeTabId } = useTabsStore();
  const repos = useQuery({
    queryKey: ['repos:list'],
    queryFn: () => invoke('repos:list', {}),
    enabled: at !== null,
    staleTime: 5_000,
  });
  const items = repoSwitcherItems(tabs, activeTabId, repos.data ?? []).map((i) => ({
    ...i,
    icon: ICONS[i.group ?? ''],
  }));
  return (
    <>
      <button
        type="button"
        className={styles.crumbBtn}
        title={`${title}\nSwitch repository`}
        aria-haspopup="dialog"
        onClick={(e) => setAt(anchorOf(e))}
      >
        <FolderGit2 size={15} aria-hidden />
        <span className={styles.crumb}>{label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {at && (
        <FilterDropdown
          anchor={at}
          label="Switch repository"
          placeholder="Open tabs, favorites and recent repositories…"
          loading={repos.isLoading}
          items={items}
          actions={[
            {
              label: 'Open repository…',
              icon: <FolderOpen size={14} />,
              onSelect: () => void runCommand('repo.openFolder'),
            },
            { label: 'Clone…', icon: <Cloud size={14} />, onSelect: () => void runCommand('repoMgmt.clone') },
            { label: 'Init…', icon: <Plus size={14} />, onSelect: () => void runCommand('repoMgmt.init') },
          ]}
          onPick={(id) => {
            if (id.startsWith('tab:')) useTabsStore.getState().activate(id.slice(4));
            else if (id.startsWith('path:')) void useTabsStore.getState().openRepo(id.slice(5));
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/** Breadcrumb `branch ▾` (spec 01 §4.4): filterable checkout, Enter on a new name creates it. */
export function BranchSwitcher({ repoId, info, label }: { repoId: RepoId; info: RepoInfo; label: string }) {
  const [at, setAt] = useState<Anchor>(null);
  const refs = useRefs(repoId);
  const items = branchSwitcherItems(refs.data ?? []).map((i) => ({
    ...i,
    icon: i.group === 'Remote' ? <Cloud size={14} aria-hidden /> : <GitBranch size={14} aria-hidden />,
  }));
  const names = new Set((refs.data ?? []).filter((r) => r.type === 'local').map((r) => r.shortName));
  return (
    <>
      <button
        type="button"
        className={styles.crumbBtn}
        title="Switch branch"
        aria-haspopup="dialog"
        disabled={info.isBare}
        onClick={(e) => setAt(anchorOf(e))}
      >
        <GitBranch size={15} aria-hidden />
        <span className={styles.crumb}>{label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {at && (
        <FilterDropdown
          anchor={at}
          label="Switch branch"
          placeholder="Check out a branch, or type a new name…"
          loading={refs.isLoading}
          items={items}
          allowCreate={(q) =>
            names.has(q) || /\s/.test(q) || info.head.sha === null ? null : `Create branch “${q}” at HEAD`
          }
          onCreate={(name) =>
            quiet(
              runOp(
                repoId,
                { type: 'branch.create', name, startPoint: 'HEAD', checkout: true },
                { successToast: `Created branch ${name}` },
              ),
            )
          }
          onPick={(id) => {
            const ref = refs.data?.find((r) => r.fullName === id);
            if (ref && !ref.isHead) void checkout(repoId, checkoutTargetFor(ref));
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/** Toolbar Launchpad entry point (spec 01 §4.1 ToolbarRight). */
export function LaunchpadButton({
  className,
  labelClassName,
}: {
  className?: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      title="Launchpad"
      aria-label="Launchpad"
      onClick={() => useTabsStore.getState().openLaunchpad()}
    >
      <Rocket size={17} />
      <span className={labelClassName}>Launchpad</span>
    </button>
  );
}

/** Toolbar Workspaces entry point: pick a workspace to show on the Repo Management page. */
export function WorkspacesButton({
  className,
  labelClassName,
}: {
  className?: string;
  labelClassName?: string;
}) {
  const [at, setAt] = useState<Anchor>(null);
  const workspaces = useWorkspaces();
  return (
    <>
      <button
        type="button"
        className={className}
        title="Workspaces"
        aria-label="Workspaces"
        onClick={(e) => setAt(anchorOf(e))}
      >
        <Layers size={17} />
        <span className={labelClassName}>Workspaces</span>
      </button>
      {at && (
        <FilterDropdown
          anchor={at}
          label="Workspaces"
          placeholder="Open a workspace…"
          loading={workspaces.isLoading}
          items={(workspaces.data ?? []).map((w) => ({
            id: w.id,
            label: w.name,
            detail: `${w.repos.length} repo${w.repos.length === 1 ? '' : 's'}`,
            icon: <Layers size={14} aria-hidden />,
          }))}
          actions={[
            {
              label: 'Manage workspaces…',
              icon: <GitBranchPlus size={14} />,
              onSelect: () => void runCommand('repoMgmt.show'),
            },
          ]}
          onPick={(id) => {
            useWorkspaceUi.getState().select(id);
            void runCommand('repoMgmt.show');
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}
