import type { RepoId, WorktreeInfo } from '@githappens/git/types';
import type { QueryClient } from '@tanstack/react-query';
import {
  Columns2,
  FileCode,
  FilePlus,
  FileSearch,
  FileX,
  FolderGit2,
  GitFork,
  GitPullRequest,
  FileClock,
  Keyboard,
  Maximize,
  Palette,
  ScrollText,
  SunMoon,
  User,
  Wrench,
} from 'lucide-react';

import type { SettingsSection } from '../../../shared/settings/registry';
import { createTag, stashPop } from '../actions/git-actions';
import { prompt, confirm } from '../components/Dialogs';
import { usePaletteStore } from '../components/CommandPalette';
import { requestGitflowInit } from '../gitflow/api';
import { invoke } from '../lib/api';
import { quiet, runOp } from '../lib/ops';
import { behaviourInvoke } from '../notifications/api';
import { useSessionStore } from '../repo/sessions';
import { useLayoutStore } from '../stores/layout';
import { useRepoUiStore } from '../stores/repo-ui';
import { prefsInvoke, useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { wsInvoke } from '../workspaces/api';
import { openWorkspaceView } from '../workspaces/actions';
import { cycleFocus } from '../shell/focus-cycle';
import { shellInvoke } from '../shell/shell2-api';
import { requestCloseTab } from '../shell/tab-actions';
import { useShortcutsOverlay } from '../shell/shortcuts-overlay-store';
import { toggleFullscreen } from '../shell/window-state';
import { openDefault, openInEditor, repoRoot } from '../tools/actions';
import { invalidateFileList, searchFiles } from '../views/finder/finder-client';
import { finderRepoKey, getFileMru, recordFileMru } from '../views/finder/finder-mru';
import { createWorktree } from '../views/left/RepoExtrasSections';
import { openCreatePullRequest } from '../views/pr/CreatePullRequest';
import { usePrefsNavStore } from '../views/preferences/prefs-nav';
import { confirmAndSwitchProfile } from '../views/preferences/ProfileSwitchMenu';
import { updateInvoke } from '../views/update/update-api';
import { showWhatsNew } from '../views/update/WhatsNewDialog';
import { registerArgProvider } from './args';
import { registerCommands } from './registry';
import type { CommandContext, CommandDef } from './types';

/**
 * Shell-completion commands (spec 01 §4.8 table, spec 12 §4.8 / §4.11): the palette entries that were
 * missing, the commands behind the remaining default shortcuts and the native menu, plus the file /
 * profile / theme / worktree argument providers. Installed by `installAppCommands`.
 */

export interface ShellCommandActions {
  openPreferences(): void;
}

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

function activeTabRepo(): { repoId?: RepoId; path?: string } {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab?.repoPath) return {};
  const s = useSessionStore.getState().byPath[norm(tab.repoPath)];
  return { repoId: s?.state === 'ready' ? s.repoId : undefined, path: tab.repoPath };
}

const toastError = (title: string, e: unknown): void => {
  useToastStore.getState().push({ kind: 'error', title, body: e instanceof Error ? e.message : String(e) });
};

/** Open a repo file in the center view (in-app editor, history or blame; spec 07). */
export function openFileView(repoId: RepoId, path: string, mode: 'edit' | 'history' | 'blame'): void {
  const p = activeTabRepo().path;
  if (p) recordFileMru(finderRepoKey(p), path);
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'file', path, mode } }));
}

export function installShellCommands(qc: QueryClient, actions: ShellCommandActions): () => void {
  const data = <T>(key: readonly unknown[]): T | undefined => qc.getQueryData<T>(key);
  const needRepo = (ctx: CommandContext): boolean => !!ctx.activeRepo;
  const repoReason = (ctx: CommandContext): string | undefined =>
    ctx.activeRepo ? undefined : 'Open a repository first';
  const withRepo =
    (fn: (repoId: RepoId, arg?: string) => unknown) =>
    (ctx: CommandContext, arg?: string): void => {
      if (ctx.activeRepo) void fn(ctx.activeRepo, arg);
    };
  const openPrefs = (section?: SettingsSection): void => {
    if (section) usePrefsNavStore.getState().go(section);
    actions.openPreferences();
  };
  const fileCmd = (
    id: string,
    title: string,
    run: (repoId: RepoId, path: string) => unknown,
    extra: Partial<CommandDef> = {},
  ): CommandDef => ({
    id,
    title,
    category: 'File',
    arg: { kind: 'file', placeholder: 'File…' },
    when: needRepo,
    whenReason: repoReason,
    run: withRepo((r, arg) => {
      if (arg) void run(r, arg);
    }),
    ...extra,
  });

  const commands: CommandDef[] = [
    // ---- repo ----
    {
      id: 'repoMgmt.show',
      title: 'Repo Management',
      category: 'Repo',
      icon: FolderGit2,
      keywords: ['new tab', 'recent', 'open'],
      run: () => {
        const tabs = useTabsStore.getState();
        const existing = tabs.tabs.find((t) => t.kind === 'newTab' || t.kind === 'repoManagement');
        if (existing) tabs.activate(existing.id);
        else tabs.newTab();
      },
    },
    {
      id: 'workspace.open',
      title: 'Workspace: Open…',
      category: 'Repo',
      icon: FolderGit2,
      keywords: ['workspaces', 'repo management', 'group'],
      keybinding: { win: 'Ctrl+Alt+O', mac: 'Cmd+Option+O' },
      arg: { kind: 'workspace', placeholder: 'Workspace…' },
      run: (_ctx, arg) => {
        if (arg) openWorkspaceView(arg);
      },
    },
    {
      id: 'repo.closeTab',
      title: 'Close Tab',
      category: 'Repo',
      run: () => {
        const { activeTabId } = useTabsStore.getState();
        if (activeTabId) void requestCloseTab(activeTabId);
      },
    },
    {
      id: 'repo.openInIde',
      title: 'Open Repo in IDE (configured editor)',
      category: 'Repo',
      keywords: ['vscode', 'code', 'cursor', 'jetbrains', 'sublime', 'editor'],
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((r) => openInEditor(repoRoot(r))),
    },
    {
      id: 'repo.maintenance',
      title: 'Perform Repo Maintenance (gc / commit-graph)',
      category: 'Repo',
      icon: Wrench,
      keywords: ['gc', 'garbage', 'maintenance', 'optimize'],
      when: needRepo,
      whenReason: repoReason,
      run: withRepo(async (r) => {
        const toasts = useToastStore.getState();
        toasts.push({ kind: 'info', title: 'Repository maintenance started' });
        try {
          const res = await shellInvoke('repo:maintenance', { repoId: r });
          toasts.push({
            kind: 'success',
            title: 'Repository maintenance finished',
            body: res.steps.join('\n'),
          });
        } catch (e) {
          toastError('Repository maintenance failed', e);
        }
      }),
    },
    {
      id: 'repo.settings',
      title: 'Repository Settings',
      category: 'Settings',
      run: () => openPrefs('Git'),
    },
    {
      id: 'stash.popLatest',
      title: 'Stash: Pop Latest',
      category: 'Stash',
      when: (c) => c.hasStashes,
      whenReason: (c) => (c.hasStashes ? undefined : 'No stashes'),
      run: withRepo((r) => stashPop(r)),
    },

    // ---- settings ----
    {
      id: 'lfs.init',
      title: 'Initialize LFS',
      category: 'Settings',
      keywords: ['git lfs', 'large files'],
      when: (c) => !!c.activeRepo && !c.lfsEnabled,
      whenReason: (c) => (c.lfsEnabled ? 'LFS is already initialized' : repoReason(c)),
      run: withRepo((r) => quiet(runOp(r, { type: 'lfs.install' }, { successToast: 'Initialized Git LFS' }))),
    },
    {
      id: 'lfs.configure',
      title: 'Configure LFS (track patterns)',
      category: 'Settings',
      keywords: ['git lfs', 'track'],
      when: needRepo,
      whenReason: repoReason,
      run: withRepo(async (r) => {
        const p = await prompt({
          title: 'Track with Git LFS',
          label: 'Patterns (comma separated)',
          placeholder: '*.psd, *.zip',
          okLabel: 'Track',
        });
        const patterns = (p?.value ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        if (patterns.length) quiet(runOp(r, { type: 'lfs.track', patterns }));
      }),
    },
    {
      id: 'signing.configure',
      title: 'Configure GPG Signing',
      category: 'Settings',
      keywords: ['gpg', 'ssh signing', 'sign commits'],
      run: () => openPrefs('Commit Signing'),
    },
    {
      id: 'gitflow.configure',
      title: 'Configure Git Flow',
      category: 'Settings',
      keywords: ['gitflow', 'git flow'],
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((r) => requestGitflowInit(r)),
    },
    {
      id: 'theme.select',
      title: 'Switch Theme',
      category: 'Settings',
      icon: Palette,
      arg: { kind: 'theme', placeholder: 'Theme…' },
      run: async (_ctx, arg) => {
        if (!arg) return;
        const st = useSettingsStore.getState();
        await st.set('ui.theme', arg);
        await st.set('ui.themeFollowOs', false);
      },
    },
    {
      id: 'account.manage',
      title: 'Manage Account',
      category: 'Settings',
      icon: User,
      run: () => openPrefs('Account'),
    },
    {
      id: 'profile.switch',
      title: 'Switch to Profile',
      category: 'Settings',
      icon: User,
      arg: { kind: 'profile', placeholder: 'Profile…' },
      run: async (_ctx, arg) => {
        if (!arg) return;
        // Confirms when git operations are running (spec 13 §4.3); the window reloads on success.
        await confirmAndSwitchProfile(arg);
      },
    },
    {
      id: 'app.about',
      title: 'About GitHappens',
      category: 'Settings',
      run: () => openPrefs('About'),
    },
    {
      id: 'app.checkForUpdates',
      title: 'Check for Updates',
      category: 'Settings',
      run: async () => {
        try {
          await updateInvoke('update:check', {});
        } catch (e) {
          toastError('Could not check for updates', e);
        }
      },
    },

    // ---- view ----
    {
      id: 'view.toggleSyntaxHighlighting',
      title: 'Toggle Syntax Highlighting',
      category: 'View',
      run: () => {
        const st = useSettingsStore.getState();
        void st.set('editor.syntaxHighlighting', !(st.values?.['editor.syntaxHighlighting'] ?? true));
      },
    },
    {
      id: 'view.toggleTheme',
      title: 'Toggle Theme (light / dark)',
      category: 'View',
      icon: SunMoon,
      run: async () => {
        const st = useSettingsStore.getState();
        const v = st.values;
        const light = v?.['ui.themeLight'] ?? 'builtin:light';
        const dark = v?.['ui.themeDark'] ?? 'builtin:dark';
        // Anything but the configured light theme counts as dark: toggling goes to the light one.
        await st.set('ui.theme', v?.['ui.theme'] === light ? dark : light);
        await st.set('ui.themeFollowOs', false);
      },
    },
    {
      id: 'view.toggleTerminal',
      title: 'Toggle Terminal',
      category: 'View',
      when: needRepo,
      run: () => useLayoutStore.getState().patch({ terminalOpen: !useLayoutStore.getState().terminalOpen }),
    },
    {
      id: 'terminal.newTab',
      title: 'Terminal: New Tab',
      category: 'View',
      keywords: ['shell', 'console'],
      when: needRepo,
      whenReason: repoReason,
      run: () => {
        const layout = useLayoutStore.getState();
        const wasOpen = layout.terminalOpen;
        if (!wasOpen) layout.patch({ terminalOpen: true });
        // A freshly opened panel starts with a tab; only an already open one gets another.
        if (wasOpen) window.dispatchEvent(new CustomEvent('kl:terminal-new-tab'));
      },
    },
    {
      id: 'view.fullscreen',
      title: 'Toggle Fullscreen',
      category: 'View',
      icon: Maximize,
      run: () => toggleFullscreen(),
    },
    {
      id: 'view.closeCurrent',
      title: 'Close Current View',
      category: 'View',
      run: () => {
        const r = activeTabRepo().repoId;
        if (!r) return;
        const c = useRepoUiStore.getState().get(r).center;
        // Editors, the merge tool, rebase and compose keep Esc for themselves (they have unsaved state).
        if (
          c.kind === 'diff' ||
          c.kind === 'pr' ||
          c.kind === 'patch' ||
          (c.kind === 'file' && c.mode !== 'edit')
        )
          useRepoUiStore.getState().update(r, () => ({ center: { kind: 'graph' } }));
      },
    },
    {
      id: 'view.focusNextPanel',
      title: 'Focus Next Panel',
      category: 'View',
      run: () => cycleFocus(1),
    },
    {
      id: 'view.focusPrevPanel',
      title: 'Focus Previous Panel',
      category: 'View',
      run: () => cycleFocus(-1),
    },
    {
      id: 'view.shortcuts',
      title: 'Keyboard Shortcuts',
      category: 'View',
      icon: Keyboard,
      keywords: ['keybindings', 'hotkeys', 'help'],
      run: () => useShortcutsOverlay.getState().toggle(),
    },
    {
      id: 'finder.files',
      title: 'Go to File…',
      category: 'File',
      icon: FileSearch,
      keywords: ['fuzzy', 'finder', 'open file', 'quick open'],
      when: needRepo,
      whenReason: repoReason,
      run: () => usePaletteStore.getState().open('#'),
    },

    // ---- AI ----
    {
      id: 'ai.commitMessage',
      title: 'AI: Generate Commit Message',
      category: 'File',
      keywords: ['ai', 'claude', 'message', 'generate'],
      when: (c) => !!c.activeRepo && c.hasWip,
      whenReason: (c) => (c.activeRepo ? (c.hasWip ? undefined : 'No changes') : repoReason(c)),
      run: withRepo((r) => {
        useRepoUiStore.getState().select(r, { kind: 'wip' });
        // The composer mounts with the WIP selection; give it a frame before asking it to generate.
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent('kl:ai-commit-message', { detail: { repoId: r } })),
        );
      }),
    },

    // ---- history / files (arg: file) ----
    fileCmd('history.blame', 'Blame', (r, p) => openFileView(r, p, 'blame'), {
      category: 'History',
      icon: Columns2,
    }),
    fileCmd('history.file', 'File History', (r, p) => openFileView(r, p, 'history'), {
      category: 'History',
      icon: FileClock,
      keywords: ['log', 'file history'],
    }),
    fileCmd('file.open', 'Open File (in-app editor)', (r, p) => openFileView(r, p, 'edit'), {
      icon: FileCode,
    }),
    fileCmd('file.edit', 'Edit File in External Editor', (r, p) => {
      const root = activeTabRepo().path;
      if (root) recordFileMru(finderRepoKey(root), p);
      return openInEditor({ repoId: r, path: p });
    }),
    fileCmd('file.view', 'View File with Default Program', (r, p) => openDefault({ repoId: r, path: p })),
    fileCmd(
      'file.delete',
      'Delete File',
      async (r, p) => {
        if (!(await confirm('Delete file', `Delete ${p} from the working tree?`, 'Delete', true))) return;
        try {
          await shellInvoke('files:delete', { repoId: r, path: p });
          invalidateFileList(r);
        } catch (e) {
          toastError('Could not delete the file', e);
        }
      },
      { icon: FileX },
    ),

    // ---- branch / tags / PRs ----
    {
      id: 'tag.createAnnotated',
      title: 'Create Annotated Tag at HEAD',
      category: 'Branch',
      when: needRepo,
      whenReason: repoReason,
      run: withRepo(async (r) => {
        const info = await invoke('git:repo:info', { repoId: r });
        if (info.head.sha) void createTag(r, info.head.sha, true);
      }),
    },
    {
      id: 'pr.start',
      title: 'Start Pull Request',
      category: 'Branch',
      icon: GitPullRequest,
      keywords: ['pull request', 'pr', 'merge request'],
      when: (c) => !!c.activeRepo && c.hasRemotes && !c.isDetached,
      whenReason: (c) =>
        !c.activeRepo
          ? repoReason(c)
          : c.isDetached
            ? 'HEAD is detached'
            : c.hasRemotes
              ? undefined
              : 'No remotes',
      run: withRepo(async (r) => {
        const info = await invoke('git:repo:info', { repoId: r });
        if (info.head.kind === 'branch') openCreatePullRequest(r, { headBranch: info.head.name });
      }),
    },
    {
      id: 'pr.create',
      title: 'Pull Request: Create',
      category: 'Branch',
      icon: GitPullRequest,
      keywords: ['pull request', 'pr', 'merge request', 'create', 'new'],
      when: (c) => !!c.activeRepo && c.hasRemotes && !c.isDetached,
      whenReason: (c) =>
        !c.activeRepo
          ? repoReason(c)
          : c.isDetached
            ? 'HEAD is detached'
            : c.hasRemotes
              ? undefined
              : 'No remotes',
      run: withRepo(async (r) => {
        const info = await invoke('git:repo:info', { repoId: r });
        if (info.head.kind === 'branch') openCreatePullRequest(r, { headBranch: info.head.name });
      }),
    },

    // ---- patches ----
    {
      id: 'patch.createFromWip',
      title: 'Create Patch from WIP',
      category: 'Patch',
      icon: FilePlus,
      when: (c) => !!c.activeRepo && c.hasWip,
      whenReason: (c) => (c.activeRepo ? (c.hasWip ? undefined : 'No changes') : repoReason(c)),
      run: withRepo(async (r) => {
        try {
          const res = await shellInvoke('wip:savePatch', { repoId: r });
          if (res.saved)
            useToastStore.getState().push({ kind: 'success', title: 'Patch saved', body: res.path });
        } catch (e) {
          toastError('Could not create the patch', e);
        }
      }),
    },
    {
      id: 'patch.apply',
      title: 'Apply Patch…',
      category: 'Patch',
      when: needRepo,
      whenReason: repoReason,
      run: withRepo(async (r) => {
        const file = await prefsInvoke('prefs:pickPath', { kind: 'file', title: 'Apply patch' });
        if (!file) return;
        quiet(
          runOp(
            r,
            {
              type: 'patch.apply',
              patchFile: file,
              mode: 'apply',
              target: { kind: 'worktree' },
              threeWay: true,
            },
            { successToast: 'Patch applied' },
          ),
        );
      }),
    },

    // ---- logs / help ----
    {
      id: 'logs.open',
      title: 'Open Logs Folder',
      category: 'Logs',
      icon: ScrollText,
      keywords: ['activity', 'errors', 'performance', 'support'],
      run: async () => {
        try {
          await behaviourInvoke('logs:open', {});
        } catch (e) {
          toastError('Could not open the logs folder', e);
        }
      },
    },
    {
      id: 'app.releaseNotes',
      title: 'View Release Notes',
      category: 'Logs',
      keywords: ["what's new", 'changelog'],
      run: () => showWhatsNew(),
    },

    // ---- worktrees ----
    {
      id: 'worktree.open',
      title: 'Open Worktree',
      category: 'Worktree',
      icon: GitFork,
      arg: { kind: 'worktree', placeholder: 'Worktree…' },
      when: needRepo,
      whenReason: repoReason,
      run: (_ctx, arg) => {
        if (arg) void useTabsStore.getState().openRepo(arg);
      },
    },
    {
      id: 'worktree.create',
      title: 'Create Worktree',
      category: 'Worktree',
      icon: GitFork,
      when: needRepo,
      whenReason: repoReason,
      run: withRepo((r) => createWorktree(r, activeTabRepo().path ?? null)),
    },

    // ---- favorites (spec 01 §4.9 favorite.open.N) ----
    ...Array.from({ length: 9 }, (_, i): CommandDef => ({
      id: `favorite.open.${i + 1}`,
      title: `Open Favorite Repository ${i + 1}`,
      category: 'Repo',
      run: async () => {
        const favs = (await invoke('repos:list', {})).filter((x) => x.favorite && !x.missing);
        const fav = favs[i];
        if (fav) void useTabsStore.getState().openRepo(fav.path);
        else useToastStore.getState().push({ kind: 'info', title: `No favorite repository #${i + 1}` });
      },
    })),
  ];

  const disposers = [
    registerCommands(commands),
    registerArgProvider(
      'file',
      async (query) => {
        const { repoId, path } = activeTabRepo();
        if (!repoId || !path) return [];
        const paths = await searchFiles(repoId, query, getFileMru(finderRepoKey(path)));
        return paths.map((p) => ({ id: p, label: p, icon: 'file' as const }));
      },
      { filter: 'none', debounceMs: 40, allowFreeText: false },
    ),
    registerArgProvider(
      'profile',
      async () => {
        const r = await prefsInvoke('profiles:list', {});
        return r.profiles.map((p) => ({
          id: p.id,
          label: p.name,
          detail: p.id === r.activeId ? 'current' : p.authorEmail || undefined,
          icon: 'profile' as const,
        }));
      },
      { allowFreeText: false },
    ),
    registerArgProvider(
      'theme',
      async () => {
        const list = await prefsInvoke('themes:list', {});
        const cur = useSettingsStore.getState().values?.['ui.theme'];
        return list
          .filter((t) => !t.errors?.length)
          .map((t) => ({
            id: t.id,
            label: t.name,
            detail: t.id === cur ? 'current' : `${t.scheme}${t.source === 'user' ? ' · custom' : ''}`,
            icon: 'theme' as const,
          }));
      },
      { allowFreeText: false },
    ),
    registerArgProvider(
      'workspace',
      async () => {
        const list =
          data<Array<{ id: string; name: string; repos: unknown[]; hidden: boolean; description?: string }>>([
            'workspaces',
          ]) ?? (await wsInvoke('workspace:list', {}));
        return list.map((w) => ({
          id: w.id,
          label: w.name,
          detail: `${w.repos.length} repo${w.repos.length === 1 ? '' : 's'}${w.hidden ? ' · hidden' : ''}${w.description ? ` · ${w.description}` : ''}`,
          icon: 'folder' as const,
        }));
      },
      { allowFreeText: false },
    ),
    registerArgProvider(
      'worktree',
      async () => {
        const { repoId } = activeTabRepo();
        if (!repoId) return [];
        const list =
          data<WorktreeInfo[]>(['worktrees', repoId]) ?? (await invoke('git:worktrees', { repoId }));
        return list
          .filter((w) => !w.bare)
          .map((w) => ({
            id: w.path,
            label: w.branch?.replace(/^refs\/heads\//, '') ?? (w.detached ? 'detached HEAD' : w.path),
            detail: `${w.path}${w.isCurrent ? ' · current' : w.isMain ? ' · main' : ''}`,
            icon: 'worktree' as const,
          }));
      },
      { allowFreeText: false },
    ),
  ];
  return () => disposers.forEach((d) => d());
}
