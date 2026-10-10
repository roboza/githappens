import type { RepoId } from '@githappens/git/types';
import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { Res } from '../../../../../shared/ipc/contract';
import {
  DISPLAY_ENCODINGS,
  type GitConfigListResult,
  type RepoGitConfigKey,
  type RepoSettings,
} from '../../../../../shared/ipc/repo-settings-contract';
import { hasExperiment } from '../../../../../shared/settings/registry';
import { requestGitflowInit } from '../../../gitflow/api';
import { invoke, IpcError, on } from '../../../lib/api';
import { prefsInvoke, prefsOn, useSetting, useSettingsStore } from '../../../stores/settings';
import { initializeLfs, trackPattern } from '../../lfs/lfs-actions';
import type { RepoSection } from '../prefs-nav';
import s from '../PreferencesView.module.css';
import { ScopeBadge } from '../SettingRow';
import { readWriteOnFetch, setWriteOnFetch, WRITE_ON_FETCH_KEY } from './commit-graph-pref';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

const REPO_SECTION_INTRO: Record<RepoSection, string> = {
  'Repo: Identity & Signing':
    "Values written to this repository's .git/config override your profile and ~/.gitconfig for commits made here.",
  'Repo: Commit': 'Commit message template and commit encoding for this repository.',
  'Repo: Encoding': 'How files that are not valid UTF-8 are displayed in the file and blame views.',
  'Repo: Git Hooks':
    'Use a custom hooks folder (core.hooksPath). Relative paths resolve from the repository root, as git does.',
  'Repo: Issues': 'Which connected issue tracker the Issues panel uses for this repository.',
  'Repo: LFS & Git Flow': 'Shortcuts to the Git LFS and Git Flow setup for this repository.',
  'Repo: Agents':
    'Commands run when a coding-agent session starts in a new worktree of this repository (git config githappens.agentSetup).',
  'Repo: Performance': "Graph speed-ups for large repositories, stored in this repository's .git/config.",
};

interface RepoCtx {
  repoPath: string;
  repoId?: RepoId;
  config: GitConfigListResult | null;
  settings: RepoSettings | null;
  reload(): void;
}

/** Repo-specific Preferences sections (spec 13 §4.2 "Repo-specific sections"). */
export function RepoSectionContent({
  section,
  repoPath,
  repoId,
  onClose,
}: {
  section: RepoSection;
  repoPath: string;
  repoId?: RepoId;
  onClose(): void;
}) {
  const [config, setConfig] = useState<GitConfigListResult | null>(null);
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    Promise.all([
      prefsInvoke('gitconfig:list', { repoPath }),
      prefsInvoke('repoSettings:get', { repoPath }),
    ]).then(
      ([c, r]) => {
        setConfig(c);
        setSettings(r);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [repoPath]);
  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(
    () =>
      prefsOn('repoSettings:changed', (e) => {
        if (e.repoPath === repoPath) setSettings(e.settings);
      }),
    [repoPath],
  );

  const ctx: RepoCtx = { repoPath, repoId, config, settings, reload };
  return (
    <>
      <p className={s.intro}>
        {REPO_SECTION_INTRO[section]} <code>{repoPath}</code>
      </p>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {section === 'Repo: Identity & Signing' && <IdentitySection ctx={ctx} />}
      {section === 'Repo: Commit' && (
        <div className={s.group}>
          <GitConfigRow
            ctx={ctx}
            k="commit.template"
            title="Commit message template"
            description="File whose text pre-fills the commit composer (the composer reads commit.template)."
            kind="path"
          />
          <GitConfigRow
            ctx={ctx}
            k="i18n.commitEncoding"
            title="Commit message encoding"
            description="Encoding git records for commit messages made in this repository."
            kind="select"
            options={DISPLAY_ENCODINGS.map((e) => ({ value: e.label.toUpperCase(), label: e.title }))}
          />
        </div>
      )}
      {section === 'Repo: Encoding' && <EncodingSection ctx={ctx} />}
      {section === 'Repo: Git Hooks' && (
        <div className={s.group}>
          <GitConfigRow
            ctx={ctx}
            k="core.hooksPath"
            title="Hooks path"
            description="Folder git runs hooks from. Unset to use .git/hooks."
            kind="dir"
          />
        </div>
      )}
      {section === 'Repo: Issues' && <IssuesSection ctx={ctx} />}
      {section === 'Repo: LFS & Git Flow' && <LfsFlowSection ctx={ctx} onClose={onClose} />}
      {section === 'Repo: Performance' && <PerformanceSection ctx={ctx} />}
      {section === 'Repo: Agents' && (
        <div className={s.group}>
          <GitConfigRow
            ctx={ctx}
            k="githappens.agentSetup"
            title="Agent setup commands"
            description="One command per line, e.g. pnpm install. Run in the new worktree before the agent starts."
            kind="textarea"
          />
        </div>
      )}
    </>
  );
}

// ---- git config rows ------------------------------------------------------------------------------

interface GitConfigRowProps {
  ctx: RepoCtx;
  k: RepoGitConfigKey;
  title: string;
  description: string;
  kind: 'text' | 'path' | 'dir' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  placeholder?: string;
}

function GitConfigRow({ ctx, k, title, description, kind, options, placeholder }: GitConfigRowProps) {
  const local = ctx.config?.local[k];
  const effective = ctx.config?.effective[k];
  const [draft, setDraft] = useState(local ?? '');
  const [error, setError] = useState<string | null>(null);
  // Re-sync the draft when the stored value changes (derived state, no effect).
  const [seen, setSeen] = useState(local);
  if (seen !== local) {
    setSeen(local);
    setDraft(local ?? '');
  }
  const id = `repo-${k}`;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setError(null);
      await fn();
      ctx.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const save = (v: string): Promise<void> =>
    v.trim()
      ? run(() => prefsInvoke('gitconfig:set', { repoPath: ctx.repoPath, key: k, value: v }))
      : run(() => prefsInvoke('gitconfig:unset', { repoPath: ctx.repoPath, key: k }));
  const browse = async (): Promise<void> => {
    const p = await prefsInvoke('prefs:pickPath', {
      kind: kind === 'dir' ? 'directory' : 'file',
      title,
      defaultPath: draft || ctx.repoPath,
    }).catch(() => null);
    if (p) {
      setDraft(p);
      await save(p);
    }
  };

  return (
    <div className={s.row} data-gitconfig={k}>
      <div className={s.rowText}>
        <label htmlFor={id} className={s.rowTitle}>
          {title}
          <ScopeBadge scope="gitLocal" />
        </label>
        <p className={s.rowDesc}>
          {description}
          {local === undefined && effective !== undefined && (
            <>
              {' '}
              Inherited: <code>{effective.length > 60 ? `${effective.slice(0, 60)}…` : effective}</code>
            </>
          )}
        </p>
        <span className={s.rowKey}>{k}</span>
      </div>
      <div className={s.control}>
        {kind === 'select' ? (
          <select id={id} value={local ?? ''} onChange={(e) => void save(e.target.value)}>
            <option value="">Not set (inherit)</option>
            {local && !options?.some((o) => o.value === local) && <option value={local}>{local}</option>}
            {options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : kind === 'textarea' ? (
          <textarea
            id={id}
            className={s.textarea}
            rows={4}
            spellCheck={false}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== (local ?? '') && void save(draft)}
          />
        ) : (
          <>
            <input
              id={id}
              type="text"
              spellCheck={false}
              value={draft}
              placeholder={placeholder ?? (effective ? `inherit: ${effective}` : 'Not set')}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft.trim() !== (local ?? '') && void save(draft)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            {(kind === 'path' || kind === 'dir') && (
              <button
                type="button"
                aria-label={`Browse for ${title}`}
                title="Browse…"
                onClick={() => void browse()}
              >
                <FolderOpen size={14} />
              </button>
            )}
          </>
        )}
      </div>
      <span />
      {error && (
        <p className={s.rowError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type ConnectedIntegration = Res<'auth:list'>[number];

const BOOL_OPTIONS = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
];

function IdentitySection({ ctx }: { ctx: RepoCtx }) {
  const profile = useSettingsStore((st) => st.profile);
  const local = ctx.config?.local;
  const differs = (a?: string, b?: string): boolean =>
    !!a && (b ?? '').trim().toLowerCase() !== a.trim().toLowerCase();
  const overridden =
    !!profile &&
    (differs(local?.['user.email'], profile.authorEmail) ||
      differs(local?.['user.name'], profile.authorName));
  return (
    <>
      {overridden && (
        <p className={s.intro} role="status" data-testid="repo-identity-override">
          This repository overrides your profile identity ({profile?.authorName} &lt;{profile?.authorEmail}
          &gt;): commits here use the values below.
        </p>
      )}
      <div className={s.group}>
        <h3 className={s.groupTitle}>Identity</h3>
        <GitConfigRow
          ctx={ctx}
          k="user.name"
          title="Author name"
          description="Overrides the profile name."
          kind="text"
        />
        <GitConfigRow
          ctx={ctx}
          k="user.email"
          title="Author email"
          description="Overrides the profile email."
          kind="text"
        />
      </div>
      <div className={s.group}>
        <h3 className={s.groupTitle}>Signing override</h3>
        <GitConfigRow
          ctx={ctx}
          k="commit.gpgsign"
          title="Sign commits"
          description="Sign every commit made in this repository (or never), regardless of your global setting."
          kind="select"
          options={BOOL_OPTIONS}
        />
        <GitConfigRow
          ctx={ctx}
          k="tag.gpgsign"
          title="Sign tags"
          description="Sign annotated tags."
          kind="select"
          options={BOOL_OPTIONS}
        />
        <GitConfigRow
          ctx={ctx}
          k="gpg.format"
          title="Signing format"
          description="openpgp (GPG), ssh (Git 2.34+) or x509."
          kind="select"
          options={[
            { value: 'openpgp', label: 'GPG (openpgp)' },
            { value: 'ssh', label: 'SSH' },
            { value: 'x509', label: 'X.509' },
          ]}
        />
        <GitConfigRow
          ctx={ctx}
          k="user.signingkey"
          title="Signing key"
          description="GPG key id, or an SSH public key path for the ssh format."
          kind="text"
        />
      </div>
    </>
  );
}

function EncodingSection({ ctx }: { ctx: RepoCtx }) {
  const flags = useSetting('experimental.flags');
  const enabled = hasExperiment(flags, 'repoDisplayEncoding');
  const [error, setError] = useState<string | null>(null);
  const value = ctx.settings?.encoding ?? 'utf-8';
  return (
    <div className={s.group}>
      <div className={s.row}>
        <div className={s.rowText}>
          <label htmlFor="repo-encoding" className={s.rowTitle}>
            Display encoding
            <ScopeBadge scope="repo" />
            {!enabled && (
              <span className={s.badgeWarn} title="Enable it in Preferences › Experimental">
                Experimental — off
              </span>
            )}
          </label>
          <p className={s.rowDesc}>
            Files that are not valid UTF-8 are decoded with this encoding (read-only) instead of Latin-1.
            {!enabled && ' Turn on "Per-repository display encoding" in Experimental to apply it.'}
          </p>
        </div>
        <div className={s.control}>
          <select
            id="repo-encoding"
            value={value}
            onChange={(e) => {
              setError(null);
              prefsInvoke('repoSettings:set', {
                repoPath: ctx.repoPath,
                patch: { encoding: e.target.value },
              }).catch((err: unknown) => setError(errorText(err)));
            }}
          >
            {!DISPLAY_ENCODINGS.some((x) => x.label === value) && <option value={value}>{value}</option>}
            {DISPLAY_ENCODINGS.map((x) => (
              <option key={x.label} value={x.label}>
                {x.title}
              </option>
            ))}
          </select>
        </div>
        <span />
        {error && (
          <p className={s.rowError} role="alert">
            {error}
          </p>
        )}
      </div>
      <GitConfigRow
        ctx={ctx}
        k="i18n.logOutputEncoding"
        title="Log output encoding"
        description="Encoding git converts commit messages to when showing history."
        kind="select"
        options={DISPLAY_ENCODINGS.map((e) => ({ value: e.label.toUpperCase(), label: e.title }))}
      />
    </div>
  );
}

function IssuesSection({ ctx }: { ctx: RepoCtx }) {
  const [integrations, setIntegrations] = useState<ConnectedIntegration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tracker = ctx.settings?.issueTracker ?? null;
  const [project, setProject] = useState(tracker?.projectKey ?? '');
  const [seenProject, setSeenProject] = useState(tracker?.projectKey);
  if (seenProject !== tracker?.projectKey) {
    setSeenProject(tracker?.projectKey);
    setProject(tracker?.projectKey ?? '');
  }
  useEffect(() => {
    invoke('auth:list', {}).then(setIntegrations, () => setIntegrations([]));
  }, []);
  const save = (patch: Partial<RepoSettings>): void => {
    setError(null);
    prefsInvoke('repoSettings:set', { repoPath: ctx.repoPath, patch }).catch((e: unknown) =>
      setError(errorText(e)),
    );
  };
  return (
    <div className={s.group}>
      <div className={s.row}>
        <div className={s.rowText}>
          <label htmlFor="repo-issue-tracker" className={s.rowTitle}>
            Issue tracker
            <ScopeBadge scope="repo" />
          </label>
          <p className={s.rowDesc}>
            Automatic uses the provider of this repository&apos;s remote when it is connected.
          </p>
        </div>
        <div className={s.control}>
          <select
            id="repo-issue-tracker"
            value={tracker?.integrationKey ?? ''}
            onChange={(e) => {
              const i = integrations?.find((x) => x.key === e.target.value);
              save({
                issueTracker: i
                  ? { integrationKey: i.key, kind: i.kind, projectKey: project || undefined }
                  : null,
              });
            }}
          >
            <option value="">Automatic</option>
            {tracker && !integrations?.some((i) => i.key === tracker.integrationKey) && (
              <option value={tracker.integrationKey}>{tracker.integrationKey} (disconnected)</option>
            )}
            {integrations?.map((i) => (
              <option key={i.key} value={i.key}>
                {i.kind} — {i.login}@{i.host}
              </option>
            ))}
          </select>
        </div>
        <span />
      </div>
      {tracker && (
        <div className={s.row}>
          <div className={s.rowText}>
            <label htmlFor="repo-issue-project" className={s.rowTitle}>
              Project / board
              <ScopeBadge scope="repo" />
            </label>
            <p className={s.rowDesc}>owner/repo, Jira project key, Trello board or Linear team.</p>
          </div>
          <div className={s.control}>
            <input
              id="repo-issue-project"
              type="text"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              onBlur={() =>
                project !== (tracker.projectKey ?? '') &&
                save({ issueTracker: { ...tracker, projectKey: project.trim() || undefined } })
              }
            />
          </div>
          <span />
        </div>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function LfsFlowSection({ ctx, onClose }: { ctx: RepoCtx; onClose(): void }) {
  const repoId = ctx.repoId;
  return (
    <>
      <div className={s.group}>
        <h3 className={s.groupTitle}>Git LFS</h3>
        <div className={s.toolbar}>
          <button type="button" disabled={!repoId} onClick={() => repoId && initializeLfs(repoId)}>
            Initialize LFS
          </button>
          <button
            type="button"
            disabled={!repoId}
            onClick={() => {
              if (!repoId) return;
              onClose();
              void trackPattern(repoId);
            }}
          >
            Track pattern…
          </button>
        </div>
      </div>
      <div className={s.group}>
        <h3 className={s.groupTitle}>Git Flow</h3>
        <div className={s.toolbar}>
          <button
            type="button"
            disabled={!repoId}
            onClick={() => {
              if (!repoId) return;
              onClose();
              requestGitflowInit(repoId);
            }}
          >
            Initialize / configure Git Flow…
          </button>
        </div>
      </div>
      <div className={s.group}>
        <h3 className={s.groupTitle}>Submodules</h3>
        <GitConfigRow
          ctx={ctx}
          k="submodule.recurse"
          title="Recurse into submodules"
          description="Commands like checkout and pull also update submodules (submodule.recurse)."
          kind="select"
          options={BOOL_OPTIONS}
        />
      </div>
    </>
  );
}

/**
 * "Write commit-graph on fetch" (spec 02 §6.15.1 opt-in): `fetch.writeCommitGraph` in the repo's local
 * config, set / unset through the queued `config.set` op and read back with `git:config:get`.
 */
function PerformanceSection({ ctx }: { ctx: RepoCtx }) {
  const repoId = ctx.repoId;
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!repoId) return;
    readWriteOnFetch(invoke, repoId).then(setValue, (e: unknown) => setError(errorText(e)));
  }, [repoId]);
  useEffect(load, [load]);
  // edited elsewhere (terminal, another window): the watcher reports the `config` scope
  useEffect(
    () =>
      on('git:repo:changed', (e) => {
        if (e.repoId === repoId && e.scopes.includes('config')) load();
      }),
    [repoId, load],
  );
  const toggle = async (on: boolean): Promise<void> => {
    if (!repoId) return;
    setBusy(true);
    setError(null);
    try {
      await setWriteOnFetch(invoke, repoId, on);
      setValue(await readWriteOnFetch(invoke, repoId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.group}>
      <div className={s.row} data-gitconfig={WRITE_ON_FETCH_KEY}>
        <div className={s.rowText}>
          <label htmlFor="repo-write-commit-graph" className={s.rowTitle}>
            Write commit-graph on fetch
            <ScopeBadge scope="gitLocal" />
          </label>
          <p className={s.rowDesc}>
            Git updates the commit-graph file after every fetch, so the graph keeps loading fast as history
            grows (no separate background write needed).
            {!repoId && ' Open the repository to change this.'}
          </p>
          <span className={s.rowKey}>{WRITE_ON_FETCH_KEY}</span>
        </div>
        <div className={s.control}>
          <input
            id="repo-write-commit-graph"
            type="checkbox"
            data-testid="repo-write-commit-graph"
            checked={value ?? false}
            disabled={!repoId || value === null || busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
        </div>
        <span />
        {error && (
          <p className={s.rowError} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
