import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  matchesSettingQuery,
  SETTINGS_SECTIONS,
  type SettingDescriptor,
  type SettingsSection,
} from '../../../../shared/settings/registry';
import { TOOL_PRESETS } from '../../../../shared/settings/external-tools';
import { EngineCard } from '../../components/EngineCard';
import { EnvironmentCard } from '../../components/EnvironmentCard';
import { IpcError } from '../../lib/api';
import type { RepoId } from '@githappens/git/types';

import { useSession, useSessionStore } from '../../repo/sessions';
import { prefsInvoke, useSettingsStore } from '../../stores/settings';
import { useTabsStore } from '../../stores/tabs';
import { AccountPanel, ACCOUNT_PANEL_SETTING_KEYS, OrganizationPanel } from '../account';
import { AiPrefsPanel } from '../ai/AiPrefsPanel';
import { NetworkPanel } from '../network';
import { SshPanel } from '../ssh';
import { ExternalToolsPanel } from '../tools';
import { IntegrationsSection } from '../integrations/IntegrationsSection';
import { UpdatesPrefsPanel } from '../update/UpdatesPrefsPanel';
import { GpgPanel } from '../gpg/GpgPanel';
import { AdvancedSection, ExperimentalSection } from './AdvancedSection';
import { KeybindingsSection } from './KeybindingsSection';
import { isRepoSection, REPO_SECTIONS, usePrefsNavStore, type RepoSection } from './prefs-nav';
import { RepoSectionContent } from './repo/RepoSections';
import s from './PreferencesView.module.css';
import { ProfilesSection } from './ProfilesSection';
import { SettingRow } from './SettingRow';
import { ThemesSection } from './ThemesSection';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Sections rendered by a dedicated component instead of (or before) generic rows. */
const CUSTOM_SECTIONS = new Set<SettingsSection>([
  'Profiles',
  'Themes',
  'Integrations',
  'Keybindings',
  'Advanced',
  'About',
]);
/** Settings owned by a custom control (hidden from generic rows). */
const HIDDEN_KEYS = new Set([
  'git.executable',
  'ui.theme',
  'ui.themeFollowOs',
  'ui.themeLight',
  'ui.themeDark',
  'updates.channel',
  'updates.autoDownload',
  // Owned by AiPrefsPanel (spec 12 §4.5).
  'ai.enabled',
  'ai.provider',
  'ai.model',
  'ai.baseUrl',
  'ai.effort',
  'ai.consent',
  'ai.effortOverrides',
  'ai.featureInstructions',
  // Owned by AccountPanel (spec 14 §4.1).
  ...ACCOUNT_PANEL_SETTING_KEYS,
]);

const SECTION_INTRO: Partial<Record<SettingsSection, string>> = {
  Git: 'Git engine and default behaviour for pull, checkout and the commit graph.',
  'External Tools':
    'Command templates may use $BASE $LOCAL $REMOTE $MERGED; each is passed as a single argument, so paths with spaces are safe.',
  'Commit Signing':
    'These values are stored in your profile. Use "Apply to Git config" to write them to git, so signing also works from the command line.',
  SSH: 'Key and agent preferences for git network operations over SSH.',
  Network: 'Proxy and certificate settings for git network operations and provider integrations.',
  AI: 'AI requests go straight from this computer to the provider you choose, using your own API key.',
  Account:
    'Optional GitHappens Cloud: sign in to sync settings (end-to-end encrypted), share Cloud Patches and see teammate overlaps. Nothing is sent anywhere until you configure a server.',
  Workspaces: 'Groups of repositories you can open, fetch and pull together, plus the Launchpad inbox.',
  Notifications: 'Toasts inside the app and OS notifications while the window is in the background.',
  Experimental:
    'Features that are still being tried out. They may change or go away; turn them off if something misbehaves.',
  Advanced:
    'Edit the raw settings.json of this profile, export or import your settings, or reset everything.',
  Integrations:
    'Connect GitHub, GitLab, Bitbucket, Azure DevOps and Jira accounts. Tokens are stored encrypted on this computer and never shown again.',
};

/**
 * Preferences (spec 13 §4.1): large modal with a sectioned sidebar, search across all settings,
 * generic rows by descriptor type, profiles, themes, keybindings and About.
 */
export function PreferencesView({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const registry = useSettingsStore((st) => st.registry);
  const section = usePrefsNavStore((st) => st.section);
  const go = usePrefsNavStore((st) => st.go);
  const [query, setQuery] = useState('');
  const platform = window.api.platform;
  const profileName = useSettingsStore((st) => st.profile?.name);
  const activeRepo = useActiveRepo();
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  useEffect(() => {
    prefsInvoke('settings:status', {}).then(
      (st) => setReadOnlyReason(st.readOnly ? (st.readOnlyReason ?? 'Settings are read-only.') : null),
      () => setReadOnlyReason(null),
    );
  }, []);
  // A repo section without an active repo falls back to General.
  const shown = isRepoSection(section) && !activeRepo ? 'General' : section;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  const visible = useMemo(
    () => registry.filter((d) => !d.platforms || d.platforms.includes(platform)),
    [registry, platform],
  );
  const matches = useMemo(
    () => (query.trim() ? visible.filter((d) => matchesSettingQuery(d, query)) : []),
    [visible, query],
  );
  const searching = query.trim().length > 0;
  const countBySection = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of matches) m.set(d.section, (m.get(d.section) ?? 0) + 1);
    return m;
  }, [matches]);

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Preferences"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
    >
      <aside className={s.sidebar}>
        <div className={s.sidebarHeader}>
          <h1>Preferences</h1>
          <input
            type="text"
            className={s.search}
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav aria-label="Preference sections">
          <ul className={s.nav}>
            <li className={s.navGroup} title={profileName ? `Profile: ${profileName}` : undefined}>
              Profile{profileName ? `: ${profileName}` : ''}
            </li>
            {SETTINGS_SECTIONS.map((sec) => {
              const n = countBySection.get(sec) ?? 0;
              const nameHit = sec.toLowerCase().includes(query.trim().toLowerCase());
              return (
                <li key={sec}>
                  <button
                    type="button"
                    className={`${s.navItem} ${!searching && sec === shown ? s.navItemActive : ''} ${
                      searching && !n && !nameHit ? s.navItemDim : ''
                    }`}
                    aria-current={!searching && sec === shown ? 'page' : undefined}
                    onClick={() => {
                      setQuery('');
                      go(sec);
                    }}
                  >
                    <span>{sec}</span>
                    {searching && n > 0 && <span className={s.count}>{n}</span>}
                  </button>
                </li>
              );
            })}
            {activeRepo && (
              <>
                <li className={s.navGroup} title={activeRepo.repoPath}>
                  Repo: {activeRepo.name}
                </li>
                {REPO_SECTIONS.map((sec) => (
                  <li key={sec}>
                    <button
                      type="button"
                      className={`${s.navItem} ${!searching && sec === shown ? s.navItemActive : ''}`}
                      aria-current={!searching && sec === shown ? 'page' : undefined}
                      onClick={() => {
                        setQuery('');
                        go(sec);
                      }}
                    >
                      <span>{sec.replace(/^Repo: /, '')}</span>
                    </button>
                  </li>
                ))}
              </>
            )}
          </ul>
        </nav>
      </aside>
      <section className={s.main}>
        <header className={s.mainHeader}>
          <h2>
            {searching
              ? `Results for “${query.trim()}”`
              : isRepoSection(shown)
                ? `${shown.replace(/^Repo: /, '')} — ${activeRepo?.name ?? ''}`
                : shown}
          </h2>
          <button type="button" className={s.close} aria-label="Close preferences" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className={s.content}>
          {readOnlyReason && (
            <p className={s.readOnlyBanner} role="alert" data-testid="settings-read-only">
              {readOnlyReason}
            </p>
          )}
          {searching ? (
            <SearchResults matches={matches} />
          ) : isRepoSection(shown) && activeRepo ? (
            <RepoSectionContent
              key={activeRepo.repoPath}
              section={shown as RepoSection}
              repoPath={activeRepo.repoPath}
              repoId={activeRepo.repoId}
              onClose={onClose}
            />
          ) : (
            <SectionContent
              section={shown as SettingsSection}
              rows={visible.filter((d) => d.section === shown)}
            />
          )}
        </div>
      </section>
    </dialog>
  );
}

function SearchResults({ matches }: { matches: SettingDescriptor[] }) {
  if (matches.length === 0) return <p className={s.empty}>No settings match.</p>;
  const bySection = SETTINGS_SECTIONS.map(
    (sec) => [sec, matches.filter((d) => d.section === sec)] as const,
  ).filter(([, list]) => list.length > 0);
  return (
    <>
      {bySection.map(([sec, list]) => (
        <div key={sec} className={s.group}>
          <h3 className={s.groupTitle}>{sec}</h3>
          {list.map((d) => (
            <SettingRow key={d.key} d={d} />
          ))}
        </div>
      ))}
    </>
  );
}

function GenericRows({ rows }: { rows: SettingDescriptor[] }) {
  const list = rows.filter((d) => !HIDDEN_KEYS.has(d.key));
  const groups: [string, SettingDescriptor[]][] = [];
  for (const d of list) {
    const g = d.group ?? '';
    const existing = groups.find(([name]) => name === g);
    if (existing) existing[1].push(d);
    else groups.push([g, [d]]);
  }
  return (
    <>
      {groups.map(([g, ds]) => (
        <div key={g || '_'} className={s.group}>
          {g && <h3 className={s.groupTitle}>{g}</h3>}
          {ds.map((d) => (
            <SettingRow key={d.key} d={d} />
          ))}
        </div>
      ))}
    </>
  );
}

function SectionContent({ section, rows }: { section: SettingsSection; rows: SettingDescriptor[] }) {
  const intro = SECTION_INTRO[section];
  return (
    <>
      {intro && <p className={s.intro}>{intro}</p>}
      {section === 'Profiles' && <ProfilesSection />}
      {section === 'Themes' && <ThemesSection />}
      {section === 'Keybindings' && <KeybindingsSection />}
      {section === 'About' && <AboutSection />}
      {section === 'Advanced' && <AdvancedSection />}
      {section === 'Experimental' && <ExperimentalSection />}
      {section === 'Integrations' && <IntegrationsSection />}
      {section === 'AI' && <AiPrefsPanel />}
      {section === 'SSH' && <SshPanel />}
      {section === 'Network' && <NetworkPanel />}
      {section === 'Account' && (
        <>
          <AccountPanel />
          <OrganizationPanel />
        </>
      )}
      {section === 'Git' && (
        <div className={s.cards}>
          <EngineCard />
        </div>
      )}
      {!CUSTOM_SECTIONS.has(section) && <GenericRows rows={rows} />}
      {section === 'General' && <UpdatesPrefsPanel />}
      {section === 'External Tools' && (
        <>
          <ExternalToolsPanel />
          <ToolPresetHelp />
        </>
      )}
      {section === 'Commit Signing' && (
        <>
          <GpgPanel />
          <SigningActions />
        </>
      )}
      {CUSTOM_SECTIONS.has(section) && rows.filter((d) => !HIDDEN_KEYS.has(d.key)).length > 0 && (
        <GenericRows rows={rows} />
      )}
    </>
  );
}

function ToolPresetHelp() {
  return (
    <details>
      <summary className={s.muted}>Built-in tool command lines</summary>
      <table className={s.kbTable}>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Diff</th>
            <th>Merge</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(TOOL_PRESETS).map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td className="mono">{p.diff ? `${p.exe} ${p.diff}` : '—'}</td>
              <td className="mono">{p.merge ? `${p.exe} ${p.merge}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The repo path of the active tab, if any (for "write to this repository"). */
function useActiveRepoPath(): string | undefined {
  return useTabsStore((st) => st.tabs.find((t) => t.id === st.activeTabId)?.repoPath);
}

/** The active tab's repository (drives the "Repo: <name>" group, spec 13 §4.1). */
function useActiveRepo(): { repoPath: string; name: string; repoId?: RepoId } | null {
  const repoPath = useActiveRepoPath();
  const session = useSession(repoPath);
  if (!repoPath) return null;
  const name =
    repoPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || repoPath;
  return { repoPath, name, repoId: session?.state === 'ready' ? session.repoId : undefined };
}

function SigningActions() {
  const repoPath = useActiveRepoPath();
  const scope = useSettingsStore((st) => st.values?.['signing.writeScope'] ?? 'global');
  const repoOpen = useSessionStore((st) =>
    repoPath ? st.byPath[repoPath.replace(/\\/g, '/').toLowerCase()]?.state === 'ready' : false,
  );
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = async (): Promise<void> => {
    setConfirm(false);
    try {
      const entries = await prefsInvoke('signing:apply', {
        repoPath: scope === 'local' ? repoPath : undefined,
      });
      setResult({
        ok: true,
        text: `Wrote ${entries.map((e) => (e.value === null ? `−${e.key}` : `${e.key}=${e.value}`)).join(', ')}`,
      });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    }
  };

  const target = scope === 'local' ? (repoPath ?? 'no repository open') : '~/.gitconfig';
  return (
    <div className={s.group}>
      <div className={s.toolbar}>
        {confirm ? (
          <>
            <span>
              Write signing settings to <code>{target}</code>?
            </span>
            <button type="button" className="primary" onClick={() => void apply()}>
              Write
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={scope === 'local' && !(repoPath && repoOpen)}
            onClick={() => setConfirm(true)}
          >
            Apply to Git config
          </button>
        )}
      </div>
      {result && (
        <p className={result.ok ? s.ok : s.error} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
    </div>
  );
}

function AboutSection() {
  const go = usePrefsNavStore((st) => st.go);
  return (
    <>
      <div className={s.cards}>
        <EnvironmentCard />
        <EngineCard />
      </div>
      <p className={s.muted}>
        settings.json, export / import and Reset all live in{' '}
        <button type="button" onClick={() => go('Advanced')}>
          Advanced
        </button>
        .
      </p>
    </>
  );
}
