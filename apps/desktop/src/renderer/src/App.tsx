import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { SETTINGS_SECTIONS, type SettingsSection } from '../../shared/settings/registry';

import styles from './App.module.css';
import { installAppCommands } from './commands/app-commands';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenuHost } from './components/ContextMenu';
import { CredentialPromptHost } from './components/CredentialPrompt';
import { DialogHost } from './components/Dialogs';
import { ToastHost } from './components/ToastHost';
import { invoke, on } from './lib/api';
import { installRepoChangeListener } from './repo/queries';
import { StatusBar } from './shell/StatusBar';
import { TitleBar } from './shell/TitleBar';
import { useShortcuts } from './shell/useShortcuts';
import { useLayoutStore } from './stores/layout';
import { useSettingsStore } from './stores/settings';
import { useTabsStore } from './stores/tabs';
import { useToastStore } from './stores/toasts';
import { useThemeController } from './theme/useThemeController';
import { useWorkspaces } from './workspaces/queries';
import { ShellHost } from './shell/ShellHost';
import { HomeFocus } from './views/home';
import { browseAndOpen, openRepoWithRecovery } from './views/repos/open-flow';
import { openPatchLink } from './cloud-patches';
import { CloneDialog, InitDialog } from './views/CloneInitDialogs';
import { usePrefsNavStore } from './views/preferences/prefs-nav';
import { PreferencesView } from './views/preferences/PreferencesView';
import { CreatePullRequestHost } from './views/pr/CreatePullRequest';
import { CloudFeaturesHost } from './cloud/CloudFeaturesHost';
import { LeftDialogsHost } from './views/remotes/LeftDialogsHost';
import { LaunchpadList, LaunchpadView } from './views/launchpad';
import { RepoManagementView } from './views/RepoManagementView';
import { RepoTab } from './views/RepoView';
import { UpdateNotifier } from './views/update/UpdateNotifier';
import { WhatsNewDialog } from './views/update/WhatsNewDialog';

/** App shell (spec 01 §4.1): title bar with tabs, active tab content, status bar. */
export function App() {
  const qc = useQueryClient();
  const settingsReady = useSettingsStore((s) => s.ready);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const tabsReady = useTabsStore((s) => s.hydrated);
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [createDialog, setCreateDialog] = useState<'clone' | 'init' | null>(null);
  useThemeController();

  useEffect(() => {
    hydrateSettings().catch((e: Error) =>
      useToastStore.getState().push({ kind: 'error', title: 'Could not load settings', body: e.message }),
    );
    invoke('shell:getInitialState', {})
      .then(({ tabs, layout }) => {
        useLayoutStore.getState().hydrate(layout);
        useTabsStore.getState().hydrate(tabs);
      })
      .catch(() => useTabsStore.getState().hydrate({ tabs: [], activeTabId: null }));
  }, [hydrateSettings]);

  useEffect(() => installRepoChangeListener(qc), [qc]);
  // CLI / menu / drop / open-file paths get the init + safe.directory recovery prompts (spec 03).
  useEffect(() => on('app:openRepoRequest', ({ path }) => void openRepoWithRecovery(path)), []);
  // Cloud Patch links (githappens://patch/<id>#k=…): queued in main until the UI takes them (spec 14 §6.3).
  useEffect(() => {
    const drain = (): void =>
      void invoke('cloud:takeDeepLinks', { kinds: ['patch'] })
        .then((links) => links.forEach((l) => l.kind === 'patch' && void openPatchLink(l.url)))
        .catch(() => undefined);
    drain();
    return on('cloud:deepLink', (l) => {
      if (l.kind === 'patch') drain();
    });
  }, []);
  // Views outside the shell (e.g. "Connect account" in the PR panel) open Preferences at a section.
  useEffect(() => {
    const open = (e: Event): void => {
      const section = (e as CustomEvent<unknown>).detail;
      if (typeof section === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(section)) {
        usePrefsNavStore.getState().go(section as SettingsSection);
      }
      setPrefsOpen(true);
    };
    window.addEventListener('kl:open-preferences', open);
    return () => window.removeEventListener('kl:open-preferences', open);
  }, []);

  const openRepo = useCallback(async () => {
    await browseAndOpen();
  }, []);
  const actions = useMemo(
    () => ({
      openPreferences: () => setPrefsOpen(true),
      openRepo,
      openClone: () => setCreateDialog('clone'),
      openInit: () => setCreateDialog('init'),
    }),
    [openRepo],
  );
  useShortcuts(actions);
  useEffect(() => installAppCommands(qc, actions), [qc, actions]);

  const workspaceList = useWorkspaces().data;
  const workspaceChoices = useMemo(
    () => (workspaceList ?? []).map((w) => ({ id: w.id, name: w.name })),
    [workspaceList],
  );

  const ready = settingsReady && tabsReady;
  return (
    <div className={styles.app}>
      <TitleBar onOpenPreferences={() => setPrefsOpen(true)} />
      <main className={styles.content}>
        {!ready ? (
          <p className={styles.loading}>Loading…</p>
        ) : active?.kind === 'launchpad' ? (
          <LaunchpadView workspaces={workspaceChoices} />
        ) : active?.kind === 'repo' && active.repoPath ? (
          <RepoTab key={active.id} path={active.repoPath} />
        ) : (
          <RepoManagementView
            focus={<HomeFocus />}
            renderWorkspacePrs={(ws) => (
              <LaunchpadList scope={{ kind: 'workspace', workspaceId: ws.id }} tab="prs" />
            )}
            renderWorkspaceIssues={(ws) => (
              <LaunchpadList scope={{ kind: 'workspace', workspaceId: ws.id }} tab="issues" />
            )}
          />
        )}
      </main>
      <StatusBar />
      {prefsOpen && <PreferencesView onClose={() => setPrefsOpen(false)} />}
      {createDialog === 'clone' && <CloneDialog onClose={() => setCreateDialog(null)} />}
      {createDialog === 'init' && <InitDialog onClose={() => setCreateDialog(null)} />}
      <CommandPalette />
      <ShellHost />
      <DialogHost />
      <CredentialPromptHost />
      <ContextMenuHost />
      <CreatePullRequestHost />
      <CloudFeaturesHost />
      <LeftDialogsHost />
      <UpdateNotifier />
      <WhatsNewDialog />
      <ToastHost />
    </div>
  );
}
