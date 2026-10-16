import type { RefInfo, RepoId, StashEntry, StatusResult } from '@githappens/git/types';
import type { QueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Crosshair,
  FolderOpen,
  GitBranch,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Settings,
  SunMoon,
  Tag,
  Undo2,
} from 'lucide-react';

import {
  checkout,
  createBranch,
  createTag,
  discardAll,
  fetchAll,
  pull,
  push,
  redo,
  renameBranch,
  stashApply,
  stashPop,
  stashSave,
  undo,
} from '../actions/git-actions';
import { checkoutTargetFor } from '../actions/menus';
import { invoke } from '../lib/api';
import { quiet, runOp } from '../lib/ops';
import { qk } from '../repo/queries';
import { useSessionStore } from '../repo/sessions';
import { useLayoutStore } from '../stores/layout';
import { useRepoUiStore } from '../stores/repo-ui';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import {
  openExternalForSelection,
  openInEditor,
  openInTerminal,
  repoRoot,
  showInFolder,
} from '../tools/actions';
import { openBranchCleanup } from '../views/remotes/dialog-store';
import { createNewFile } from '../views/file/actions';
import { popLatestStash, quickStash, stashWithOptions } from '../views/ops/branching-actions';
import { openUndoHistory } from '../views/undo/useUndoPeek';
import { registerArgProvider } from './args';
import { registerCommands, setContextProvider } from './registry';
import { installShellCommands } from './shell-commands';
import { installRepoCommands } from '../views/repos/repo-commands';
import type { CommandContext, CommandDef } from './types';

/** The repo of the active tab, when its session is open. */
export function activeRepoId(): RepoId | undefined {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab?.repoPath) return undefined;
  const s = useSessionStore.getState().byPath[tab.repoPath.replace(/\\/g, '/').toLowerCase()];
  return s?.state === 'ready' ? s.repoId : undefined;
}

const mod = (k: string) => ({ win: `Ctrl+${k}`, mac: `Cmd+${k}` });

/**
 * Registers the Phase 2 command set (spec 01 §4.8 table) and argument providers.
 * Commands read live state from the query cache through the context provider.
 */
export function installAppCommands(
  qc: QueryClient,
  actions: { openPreferences(): void; openRepo(): void; openClone(): void; openInit(): void },
): () => void {
  const data = <T>(key: readonly unknown[]): T | undefined => qc.getQueryData<T>(key);

  setContextProvider((): CommandContext => {
    const repoId = activeRepoId();
    const status = repoId ? data<StatusResult>(qk.status(repoId)) : undefined;
    const stashes = repoId ? data<StashEntry[]>(qk.stashes(repoId)) : undefined;
    const remotes = repoId ? data<unknown[]>(qk.remotes(repoId)) : undefined;
    const info = repoId ? data<{ head: { kind: string } }>(qk.info(repoId)) : undefined;
    return {
      activeRepo: repoId,
      hasRemotes: (remotes?.length ?? 0) > 0,
      hasWip: (status?.entries.filter((e) => e.kind !== 'ignored').length ?? 0) > 0,
      hasStashes: (stashes?.length ?? 0) > 0,
      isDetached: info?.head.kind === 'detached',
      lfsEnabled: !!(repoId && data<{ initialized?: boolean }>(['lfsStatus', repoId])?.initialized),
      gitflowEnabled: !!(repoId && data<{ config?: unknown }>(['gitflow', repoId])?.config),
      focus: 'graph',
    };
  });

  const needRepo = (ctx: CommandContext): boolean => !!ctx.activeRepo;
  const repoReason = (ctx: CommandContext): string | undefined =>
    ctx.activeRepo ? undefined : 'Open a repository first';
  const withRepo = (fn: (repoId: RepoId, arg?: string) => unknown) => (ctx: CommandContext, arg?: string) => {
    if (ctx.activeRepo) void fn(ctx.activeRepo, arg);
  };
  const refsOf = (repoId: RepoId): RefInfo[] => data<RefInfo[]>(qk.refs(repoId)) ?? [];

  const commands: CommandDef[] = [
    // ---- repo / tabs ----
    {
      id: 'tab.new',
      title: 'New Tab',
      category: 'Repo',
      icon: Plus,
      keybinding: mod('T'),
      run: () => void useTabsStore.getState().newTab(),
    },
    {
      id: 'repo.open',
      title: 'Open Repo',
      category: 'Repo',
      icon: FolderOpen,
      arg: { kind: 'repo', placeholder: 'Recent repository, or Enter to browse…' },
      keybinding: { win: 'Ctrl+Shift+O', mac: 'Cmd+Shift+O' },
      run: (_ctx, arg) => (arg ? void useTabsStore.getState().openRepo(arg) : actions.openRepo()),
    },
    {
      id: 'repoMgmt.clone',
      title: 'Repo Management: Clone',
      category: 'Repo',
      run: () => actions.openClone(),
    },
    { id: 'repoMgmt.init', title: 'Repo Management: Init', category: 'Repo', run: () => actions.openInit() },
    {
      id: 'repo.openInFileManager',
      title: 'Open in File Manager',
      category: 'Repo',
      when: needRepo,
      whenReason: repoReason,
      keybinding: { win: 'Alt+O', mac: 'Option+O' },
      run: withRepo((r) => showInFolder(repoRoot(r))),
    },
    // ---- open in external apps (spec 12 §4.10, spec 01 §4.9) ----
    {
      id: 'repo.openInTerminal',
      title: 'Open in Terminal (external)',
      category: 'Repo',
      keybinding: { win: 'Alt+T', mac: 'Option+T' },
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((r) => openInTerminal(repoRoot(r))),
    },
    {
      id: 'repo.openInExternalEditor',
      title: 'Open Repo in External Editor',
      category: 'Repo',
      keybinding: { win: 'Ctrl+Shift+E', mac: 'Cmd+Shift+E' },
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((r) => openInEditor(repoRoot(r))),
    },
    {
      id: 'repo.openExternalDiff',
      title: 'Open Selected File in External Diff / Merge Tool',
      category: 'File',
      keybinding: mod('D'),
      when: needRepo,
      whenReason: repoReason,
      run: withRepo(openExternalForSelection),
    },
    // ---- settings / view ----
    {
      id: 'prefs.open',
      title: 'Settings',
      category: 'Settings',
      icon: Settings,
      keybinding: mod(','),
      run: () => actions.openPreferences(),
    },
    {
      id: 'theme.light',
      title: 'Switch to Light Theme',
      category: 'Settings',
      icon: SunMoon,
      run: async () => {
        await useSettingsStore.getState().set('ui.theme', 'builtin:light');
        await useSettingsStore.getState().set('ui.themeFollowOs', false);
      },
    },
    {
      id: 'theme.dark',
      title: 'Switch to Dark Theme',
      category: 'Settings',
      icon: SunMoon,
      run: async () => {
        await useSettingsStore.getState().set('ui.theme', 'builtin:dark');
        await useSettingsStore.getState().set('ui.themeFollowOs', false);
      },
    },
    {
      id: 'view.toggleLeftPanel',
      title: 'Toggle Left Panel',
      category: 'View',
      keybinding: mod('J'),
      run: () => useLayoutStore.getState().toggleLeft(),
    },
    {
      id: 'view.toggleRightPanel',
      title: 'Toggle Commit Detail Panel',
      category: 'View',
      keybinding: mod('K'),
      run: () => useLayoutStore.getState().toggleRight(),
    },
    // ---- history ----
    {
      id: 'history.searchCommits',
      title: 'Search Commits (message / sha / author)',
      category: 'History',
      icon: Search,
      arg: { kind: 'commitQuery', placeholder: 'Message, @author, #sha, file:path…' },
      keybinding: mod('F'),
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((repoId, arg) => {
        useRepoUiStore.getState().update(repoId, (u) => ({
          center: { kind: 'graph' },
          search: { ...u.search, text: arg ?? '', deepHits: null, activeIndex: 0 },
        }));
        window.dispatchEvent(new CustomEvent('kl:focus-graph-search'));
      }),
    },
    {
      id: 'graph.jumpToHead',
      title: 'Graph: Jump to HEAD',
      category: 'History',
      icon: Crosshair,
      when: needRepo,
      run: withRepo(async (repoId) => {
        const info = await invoke('git:repo:info', { repoId });
        if (info.head.sha) useRepoUiStore.getState().reveal(repoId, info.head.sha);
      }),
    },
    // ---- core ----
    {
      id: 'core.undo',
      title: 'Undo',
      category: 'Core',
      icon: Undo2,
      keybinding: mod('Z'),
      when: needRepo,
      run: withRepo(undo),
    },
    {
      id: 'core.redo',
      title: 'Redo',
      category: 'Core',
      icon: Redo2,
      keybinding: mod('Y'),
      when: needRepo,
      run: withRepo(redo),
    },
    // ---- working tree ----
    {
      id: 'file.create',
      title: 'Create File…',
      category: 'File',
      keywords: ['new file'],
      when: needRepo,
      run: withRepo((r) => void createNewFile(r)),
    },
    {
      id: 'wip.view',
      title: 'View Working Directory Changes',
      category: 'Branch',
      when: (c) => c.hasWip,
      run: withRepo((r) => useRepoUiStore.getState().select(r, { kind: 'wip' })),
    },
    {
      id: 'wip.stageAll',
      title: 'Stage All Changes',
      category: 'File',
      keybinding: { win: 'Ctrl+Shift+S', mac: 'Cmd+Shift+S' },
      when: (c) => c.hasWip,
      whenReason: (c) => (c.hasWip ? undefined : 'No changes'),
      run: withRepo((r) => quiet(runOp(r, { type: 'wip.stageAll' }))),
    },
    {
      id: 'wip.unstageAll',
      title: 'Unstage All Changes',
      category: 'File',
      keybinding: { win: 'Ctrl+Shift+U', mac: 'Cmd+Shift+U' },
      when: (c) => c.hasWip,
      run: withRepo((r) => quiet(runOp(r, { type: 'wip.unstageAll' }))),
    },
    {
      id: 'wip.commitPush',
      title: 'Commit and Push',
      category: 'File',
      keybinding: { win: 'Ctrl+Shift+Enter', mac: 'Cmd+Shift+Enter' },
      when: (c) => c.hasWip,
      run: () => window.dispatchEvent(new CustomEvent('kl:commit', { detail: { push: true } })),
    },
    {
      id: 'wip.discardAll',
      title: 'Discard All Changes',
      category: 'File',
      when: (c) => c.hasWip,
      run: withRepo(discardAll),
    },
    // ---- stash ----
    // Alt+S / Alt+Shift+S (spec 05 §4.10; Ctrl+Shift+S is Stage All)
    {
      id: 'stash.quick',
      title: 'Stash: Stash All Changes',
      category: 'Stash',
      icon: Archive,
      keybinding: { win: 'Alt+S', mac: 'Opt+S' },
      when: (c) => c.hasWip,
      whenReason: (c) => (c.hasWip ? undefined : 'No changes'),
      run: withRepo((r) => quickStash(r)),
    },
    {
      id: 'stash.popLatest',
      title: 'Stash: Pop Latest',
      category: 'Stash',
      icon: ArchiveRestore,
      keybinding: { win: 'Alt+Shift+S', mac: 'Opt+Shift+S' },
      when: (c) => c.hasStashes,
      whenReason: (c) => (c.hasStashes ? undefined : 'No stashes'),
      run: withRepo((r) => void popLatestStash(r)),
    },
    {
      id: 'stash.withOptions',
      title: 'Stash: Stash with Options…',
      category: 'Stash',
      icon: Archive,
      when: (c) => c.hasWip,
      run: withRepo((r) => void stashWithOptions(r)),
    },
    {
      id: 'core.undoHistory',
      title: 'Undo History…',
      category: 'Core',
      icon: Undo2,
      when: needRepo,
      run: withRepo((r) => openUndoHistory(r)),
    },
    {
      id: 'stash.create',
      title: 'Stash: Create',
      category: 'Stash',
      icon: Archive,
      when: (c) => c.hasWip,
      run: withRepo((r) => stashSave(r, true)),
    },
    {
      id: 'stash.pop',
      title: 'Stash: Pop',
      category: 'Stash',
      icon: ArchiveRestore,
      arg: { kind: 'stash' },
      when: (c) => c.hasStashes,
      run: withRepo((r, arg) => {
        const s = (data<StashEntry[]>(qk.stashes(r)) ?? []).find((x) => x.sha === arg);
        if (s) void stashPop(r, s.index, s.sha);
      }),
    },
    {
      id: 'stash.apply',
      title: 'Stash: Apply',
      category: 'Stash',
      arg: { kind: 'stash' },
      when: (c) => c.hasStashes,
      run: withRepo((r, arg) => {
        const s = (data<StashEntry[]>(qk.stashes(r)) ?? []).find((x) => x.sha === arg);
        if (s) void stashApply(r, s.index, s.sha);
      }),
    },
    // ---- branches / remotes ----
    {
      id: 'branch.create',
      title: 'Create Branch',
      category: 'Branch',
      icon: GitBranch,
      keybinding: mod('B'),
      when: needRepo,
      run: withRepo((r) => createBranch(r)),
    },
    {
      id: 'branch.cleanup',
      title: 'Clean Up Branches',
      category: 'Branch',
      when: needRepo,
      run: withRepo((r) => openBranchCleanup(r)),
    },
    {
      id: 'branch.rename',
      title: 'Rename Branch',
      category: 'Branch',
      arg: { kind: 'branch' },
      when: needRepo,
      run: withRepo((r, arg) => {
        const ref = refsOf(r).find((x) => x.fullName === arg && x.type === 'local');
        if (ref) void renameBranch(r, ref.shortName);
      }),
    },
    {
      id: 'branch.checkout',
      title: 'Checkout',
      category: 'Checkout',
      arg: { kind: 'branch', placeholder: 'Branch to check out…' },
      when: needRepo,
      run: withRepo((r, arg) => {
        const ref = refsOf(r).find((x) => x.fullName === arg);
        if (ref) void checkout(r, checkoutTargetFor(ref));
      }),
    },
    {
      id: 'tag.create',
      title: 'Create Tag at HEAD',
      category: 'Branch',
      icon: Tag,
      when: needRepo,
      run: withRepo(async (r) => {
        const info = await invoke('git:repo:info', { repoId: r });
        if (info.head.sha) void createTag(r, info.head.sha);
      }),
    },
    {
      id: 'remote.fetchAll',
      title: 'Fetch All',
      category: 'Branch',
      icon: RefreshCw,
      keybinding: mod('L'),
      when: (c) => c.hasRemotes,
      run: withRepo(fetchAll),
    },
    {
      id: 'remote.pull',
      title: 'Pull',
      category: 'Branch',
      icon: ArrowDownToLine,
      when: (c) => c.hasRemotes,
      run: withRepo((r) => pull(r)),
    },
    {
      id: 'remote.push',
      title: 'Push',
      category: 'Branch',
      icon: ArrowUpFromLine,
      when: (c) => c.hasRemotes && !c.isDetached,
      whenReason: (c) => (c.isDetached ? 'HEAD is detached' : c.hasRemotes ? undefined : 'No remotes'),
      run: withRepo((r) => push(r)),
    },
  ];

  const disposers = [
    registerCommands(commands),
    installShellCommands(qc, actions),
    // spec 03: repo-open recovery flows, RM search, CLI install, sparse checkout
    installRepoCommands(),
    registerArgProvider('branch', () => {
      const r = activeRepoId();
      if (!r) return [];
      return refsOf(r)
        .filter((x) => (x.type === 'local' || x.type === 'remote') && !x.symrefTarget)
        .map((x) => ({
          id: x.fullName,
          label: x.shortName,
          detail: x.type === 'remote' ? 'remote' : x.isHead ? 'current' : undefined,
          icon: x.type === 'remote' ? 'remoteBranch' : x.isHead ? 'branchHead' : 'branch',
        }));
    }),
    registerArgProvider('tag', () => {
      const r = activeRepoId();
      return r
        ? refsOf(r)
            .filter((x) => x.type === 'tag')
            .map((x) => ({ id: x.fullName, label: x.shortName, icon: 'tag' }))
        : [];
    }),
    registerArgProvider('stash', () => {
      const r = activeRepoId();
      const list = r ? (data<StashEntry[]>(qk.stashes(r)) ?? []) : [];
      return list.map((s) => ({ id: s.sha, label: `stash@{${s.index}}`, detail: s.message, icon: 'stash' }));
    }),
    registerArgProvider(
      'repo',
      async () =>
        (await invoke('repos:list', {}))
          .filter((x) => !x.missing)
          .map((x) => ({ id: x.path, label: x.alias ?? x.name, detail: x.path, icon: 'repo' })),
      { allowFreeText: false },
    ),
  ];
  return () => disposers.forEach((d) => d());
}
