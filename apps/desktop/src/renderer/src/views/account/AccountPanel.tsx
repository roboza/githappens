import type { IdpId, ServerInfo } from '@githappens/cloud-api/types';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, KeyRound, LogOut, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import {
  SYNC_CATEGORY_LABELS,
  SYNC_DATA_CATEGORIES,
  type CloudStatus,
  type SyncStatus,
} from '../../../../shared/ipc/cloud-contract';
import { confirm } from '../../components/Dialogs';
import { UserAvatar } from '../../integrations/ui';
import { useSettingsStore } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { cloudErrorText, cloudInvoke, copyText, openPreferencesAt, relativeTime } from '../../cloud/api';
import { ck, setSyncStatus, useCloudStatus, useServerInfo, useSyncStatus } from '../../cloud/queries';
import prefs from '../preferences/PreferencesView.module.css';
import s from './Account.module.css';
import { CertificateTrustBox, offerGithubIntegration } from './CloudExtras';

/** Settings rendered by AccountPanel (hide their generic rows in Preferences → Account). */
export const ACCOUNT_PANEL_SETTING_KEYS = [
  'cloud.serverUrl',
  'sync.enabled',
  'sync.preferences',
  'sync.keybindings',
  'sync.themes',
  'sync.workspaces',
  'sync.launchpad',
  'sync.integrationsList',
] as const;

const IDP_LABELS: Record<IdpId, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  google: 'Google',
  email: 'Email link',
  dev: 'Developer login',
};

const KIND_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket Data Center',
  'azure-devops': 'Azure DevOps',
  'jira-cloud': 'Jira',
  'jira-dc': 'Jira Data Center',
  trello: 'Trello',
  'azure-boards': 'Azure Boards',
};

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(id);
    try {
      return await fn();
    } catch (e) {
      setError(cloudErrorText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { error, setError, busy, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className={prefs.error} role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * Preferences → Account (spec 14 §4.1): server URL, sign-in, settings sync (passphrase, recovery
 * key, categories, conflicts, reconnect hints) and a danger zone. Fully usable offline from the
 * cached session; makes no network calls while no server is configured.
 */
export function AccountPanel() {
  const { data: status } = useCloudStatus();
  const saved = useSettingsStore((st) => st.values?.['cloud.serverUrl']) ?? '';
  if (!status) return null;
  return (
    <div className={s.panel} data-testid="account-panel">
      {status.offline && (
        <div className={s.bannerWarn} role="status">
          <WifiOff size={14} aria-hidden /> The cloud server can&apos;t be reached. Showing cached account
          data; sync resumes automatically.
        </div>
      )}
      {status.expired && !status.session && (
        <div className={s.bannerWarn} role="status">
          <ShieldAlert size={14} aria-hidden /> Your session expired. Sign in again to keep syncing.
        </div>
      )}
      <ServerSection key={saved} status={status} />
      {status.serverUrl && <SignInSection status={status} />}
      {status.session && <SyncSection status={status} />}
      {status.session && <DangerZone />}
    </div>
  );
}

// ---- server ----------------------------------------------------------------------------------------

function ServerSection({ status }: { status: CloudStatus }) {
  const saved = useSettingsStore((st) => st.values?.['cloud.serverUrl']) ?? '';
  const setSetting = useSettingsStore((st) => st.set);
  const [url, setUrl] = useState(saved);
  const [checked, setChecked] = useState<{ url: string; info: ServerInfo } | null>(null);
  const { error, busy, run } = useAction();

  const validate = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    const r = await run('validate', () => cloudInvoke('cloud:validateServer', { url }));
    if (r) setChecked(r);
  };
  const save = async (): Promise<void> => {
    if (status.session && checked?.url !== status.serverUrl) {
      const ok = await confirm(
        'Change cloud server?',
        'You will be signed out of the current server. Data on that server is not deleted.',
        'Change server',
      );
      if (!ok) return;
    }
    await run('save', async () => {
      const r = checked?.url === url.trim() ? checked : await cloudInvoke('cloud:validateServer', { url });
      setChecked(r);
      await setSetting('cloud.serverUrl', r.url);
    });
  };
  const turnOff = async (): Promise<void> => {
    if (
      status.session &&
      !(await confirm('Turn off cloud features?', 'You will be signed out. Local data is kept.', 'Turn off'))
    ) {
      return;
    }
    await run('off', () => setSetting('cloud.serverUrl', ''));
    setChecked(null);
  };

  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Cloud server</h3>
      <p className={s.muted}>
        GitHappens Cloud is optional and self-hostable. It enables sign-in, end-to-end encrypted settings
        sync, organizations and Cloud Patches. Nothing is sent anywhere until you configure a server.
      </p>
      <form className={s.stack} onSubmit={(e) => void validate(e)}>
        <div className={s.inline}>
          <input
            type="text"
            aria-label="Cloud server address"
            placeholder="https://cloud.example.com"
            value={url}
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              setChecked(null);
            }}
          />
          <button type="submit" disabled={!url.trim() || !!busy}>
            {busy === 'validate' ? 'Checking…' : 'Validate'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!url.trim() || !!busy || url.trim() === saved}
            onClick={() => void save()}
          >
            Save
          </button>
          {saved && (
            <button type="button" disabled={!!busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          )}
        </div>
        {status.serverUrlError && <p className={prefs.error}>{status.serverUrlError}</p>}
        {checked && (
          <p className={prefs.ok} role="status">
            {checked.info.name} {checked.info.version} at {checked.url} — sign-in with{' '}
            {checked.info.idps.map((i) => IDP_LABELS[i] ?? i).join(', ') || 'no providers'}.
          </p>
        )}
        {!saved && (
          <p className={s.muted}>
            <CloudOff size={12} aria-hidden /> Cloud features are off.
          </p>
        )}
        <ErrorLine error={error} />
        <CertificateTrustBox url={url} error={error} onTrusted={() => void validate()} />
      </form>
    </div>
  );
}

// ---- sign-in ---------------------------------------------------------------------------------------

function SignInSection({ status }: { status: CloudStatus }) {
  const { data: info, error: infoError, refetch } = useServerInfo(status.session ? null : status.serverUrl);
  const { error, busy, run } = useAction();
  const session = status.session;

  if (session) {
    const user = {
      login: session.user.email,
      name: session.user.name,
      email: session.user.email,
      avatarUrl: session.user.avatarUrl,
    };
    return (
      <div className={prefs.group}>
        <h3 className={prefs.groupTitle}>Account</h3>
        <div className={s.user}>
          <UserAvatar user={user} size={36} />
          <div className={s.grow}>
            <div>
              <strong>{session.user.name}</strong>
            </div>
            <div className={s.small}>
              {session.user.email} · {session.serverUrl.replace(/^https?:\/\//, '')}
            </div>
          </div>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('out', () => cloudInvoke('cloud:signOut', {}))}
          >
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
        <ErrorLine error={error} />
      </div>
    );
  }

  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Sign in</h3>
      <p className={s.muted}>
        Sign-in opens your browser. Signing in with GitHub here does not connect the GitHub integration —
        connect it separately under Integrations.
      </p>
      {infoError ? (
        <div className={s.inline}>
          <p className={prefs.error}>{cloudErrorText(infoError)}</p>
          <button type="button" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className={s.inline}>
        {status.signingIn ? (
          <>
            <span className={s.small}>
              <RefreshCw size={12} aria-hidden /> Waiting for the browser…
            </span>
            <button type="button" onClick={() => void cloudInvoke('cloud:cancelSignIn', {})}>
              Cancel
            </button>
          </>
        ) : (
          (info?.idps ?? []).map((idp) => (
            <button
              key={idp}
              type="button"
              className={idp === info?.idps[0] ? 'primary' : undefined}
              disabled={!!busy}
              onClick={() =>
                void run(idp, () => cloudInvoke('cloud:signIn', { idp })).then((signedIn) => {
                  if (signedIn && idp === 'github') void offerGithubIntegration();
                })
              }
            >
              Continue with {IDP_LABELS[idp] ?? idp}
            </button>
          ))
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

// ---- recovery key ----------------------------------------------------------------------------------

function downloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function RecoveryKeyBox({ value, account, onDone }: { value: string; account: string; onDone(): void }) {
  return (
    <div className={s.recovery} role="region" aria-label="Recovery key">
      <strong>
        <KeyRound size={14} aria-hidden /> Your sync recovery key
      </strong>
      <p className={s.muted}>
        Store it somewhere safe (password manager or printout). It unlocks your synced settings if you forget
        the passphrase. Nobody — including the server operator — can recover your data without it.
      </p>
      <code className={s.recoveryKey} data-testid="recovery-key">
        {value}
      </code>
      <div className={s.inline}>
        <button type="button" onClick={() => copyText(value)}>
          Copy
        </button>
        <button
          type="button"
          onClick={() =>
            downloadText(
              'githappens-sync-recovery-key.txt',
              `GitHappens settings sync — recovery key\n\n${value}\n\nAccount: ${account}\nCreated: ${new Date().toISOString()}\n`,
            )
          }
        >
          Download
        </button>
        <span className={prefs.spacer} />
        <button type="button" className="primary" onClick={onDone}>
          I saved it
        </button>
      </div>
    </div>
  );
}

// ---- sync ------------------------------------------------------------------------------------------

function SyncSection({ status }: { status: CloudStatus }) {
  const qc = useQueryClient();
  const { data: sync } = useSyncStatus(true);
  const { error, setError, busy, run } = useAction();
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const account = `${status.session?.user.email ?? ''} @ ${status.serverUrl ?? ''}`;

  if (!sync) return null;
  const apply = (st: SyncStatus | undefined): void => {
    if (st) setSyncStatus(qc, st);
  };

  return (
    <div className={prefs.group} data-testid="sync-section">
      <h3 className={prefs.groupTitle}>Settings sync</h3>
      <p className={s.muted}>
        End-to-end encrypted with your sync passphrase: the server stores only ciphertext. Paths, tokens, SSH
        keys and terminal settings never leave this computer.
      </p>

      <div className={prefs.row}>
        <div className={prefs.rowText}>
          <label htmlFor="sync-enabled" className={prefs.rowTitle}>
            Sync settings across computers
          </label>
          <p className={prefs.rowDesc}>{sync.enabled ? describeState(sync) : 'Off — nothing is uploaded.'}</p>
        </div>
        <div className={prefs.control}>
          <input
            id="sync-enabled"
            type="checkbox"
            role="switch"
            className={prefs.toggle}
            checked={sync.enabled}
            onChange={(e) =>
              void run('toggle', async () =>
                apply(await cloudInvoke('sync:setEnabled', { enabled: e.target.checked })),
              )
            }
          />
          {sync.enabled && sync.keyState === 'unlocked' && (
            <button
              type="button"
              disabled={sync.state === 'syncing' || !!busy}
              onClick={() => void run('now', async () => apply(await cloudInvoke('sync:now', {})))}
            >
              <RefreshCw size={13} aria-hidden /> Sync now
            </button>
          )}
        </div>
        <span />
      </div>

      {recoveryKey && (
        <RecoveryKeyBox value={recoveryKey} account={account} onDone={() => setRecoveryKey(null)} />
      )}

      {sync.enabled && sync.keyState === 'missing' && (
        <PassphraseSetup
          busy={!!busy}
          onSubmit={(passphrase) =>
            void run('setup', async () => {
              const r = await cloudInvoke('sync:setupPassphrase', { passphrase });
              if (r.recoveryKey) setRecoveryKey(r.recoveryKey);
            })
          }
        />
      )}
      {sync.enabled && sync.keyState === 'locked' && (
        <Unlock
          busy={!!busy}
          onUnlock={(input) => void run('unlock', async () => apply(await cloudInvoke('sync:unlock', input)))}
          onReset={(passphrase) =>
            void run('reset', async () => {
              const ok = await confirm(
                'Reset sync data?',
                'This deletes all synced settings on the server and uploads this computer’s settings with the new passphrase. Other computers will ask for the new passphrase.',
                'Reset sync data',
                true,
              );
              if (!ok) return;
              const r = await cloudInvoke('sync:reset', { passphrase });
              setRecoveryKey(r.recoveryKey);
            })
          }
        />
      )}

      {sync.enabled && (
        <div className={s.stack}>
          {SYNC_DATA_CATEGORIES.map((c) => (
            <label key={c} className={s.inline}>
              <input
                type="checkbox"
                checked={sync.categories[c]}
                onChange={(e) =>
                  void run('cat', async () =>
                    apply(await cloudInvoke('sync:setEnabled', { categories: { [c]: e.target.checked } })),
                  )
                }
              />
              {SYNC_CATEGORY_LABELS[c]}
            </label>
          ))}
        </div>
      )}

      {sync.conflicts.length > 0 && (
        <div className={s.stack} role="region" aria-label="Sync conflicts">
          <strong>Conflicts</strong>
          <ul className={s.list}>
            {sync.conflicts.map((c) => (
              <li key={c.category} className={s.listItem}>
                <span className={s.grow}>
                  {SYNC_CATEGORY_LABELS[c.category]} changed here and on another computer
                  <span className={s.small}>
                    {' '}
                    ({c.keys.slice(0, 3).join(', ')}
                    {c.keys.length > 3 ? '…' : ''})
                  </span>
                </span>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void run('keep', async () =>
                      apply(
                        await cloudInvoke('sync:resolveConflict', { category: c.category, keep: 'local' }),
                      ),
                    )
                  }
                >
                  Keep this computer&apos;s
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void run('keep', async () =>
                      apply(
                        await cloudInvoke('sync:resolveConflict', { category: c.category, keep: 'remote' }),
                      ),
                    )
                  }
                >
                  Keep synced
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sync.skipped.map((x) => (
        <div key={x.category} className={s.bannerInfo}>
          {x.reason}
        </div>
      ))}

      {sync.reconnect.length > 0 && (
        <div className={s.stack} role="region" aria-label="Reconnect services">
          <strong>Connected on your other computers</strong>
          <ul className={s.list}>
            {sync.reconnect.map((h) => (
              <li key={h.key} className={s.listItem}>
                <span className={s.grow}>
                  {KIND_LABELS[h.kind] ?? h.kind}{' '}
                  <span className={s.small}>
                    ({h.host} · {h.login})
                  </span>
                </span>
                <button type="button" className="primary" onClick={() => openPreferencesAt('Integrations')}>
                  Reconnect {KIND_LABELS[h.kind] ?? h.kind}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run('dismiss', async () =>
                      apply(await cloudInvoke('sync:dismissReconnect', { key: h.key })),
                    )
                  }
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sync.enabled && sync.keyState === 'unlocked' && (
        <KeyTools
          sync={sync}
          busy={!!busy}
          onShowRecovery={(regenerate) =>
            void run('recovery', async () => {
              if (
                regenerate &&
                !(await confirm(
                  'Create a new recovery key?',
                  'The previous recovery key stops working.',
                  'Create new key',
                ))
              ) {
                return;
              }
              const r = await cloudInvoke('sync:exportRecoveryKey', { regenerate });
              setRecoveryKey(r.recoveryKey);
            })
          }
          onChangePassphrase={(passphrase) =>
            void run('change', async () => {
              await cloudInvoke('sync:setupPassphrase', { passphrase });
              setError(null);
            })
          }
        />
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function describeState(sync: SyncStatus): string {
  if (sync.keyState === 'missing') return 'Choose a sync passphrase to start syncing.';
  if (sync.keyState === 'locked') return 'Enter your sync passphrase to unlock sync on this computer.';
  if (sync.state === 'syncing') return 'Syncing…';
  if (sync.state === 'error') return sync.error ?? 'Sync failed.';
  return sync.lastSyncAt ? `Last synced ${relativeTime(sync.lastSyncAt)}.` : 'Not synced yet.';
}

function PassphraseSetup({ busy, onSubmit }: { busy: boolean; onSubmit(passphrase: string): void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const mismatch = b.length > 0 && a !== b;
  return (
    <form
      className={s.stack}
      onSubmit={(e) => {
        e.preventDefault();
        if (a.length >= 8 && a === b) onSubmit(a);
      }}
    >
      <strong>Create a sync passphrase</strong>
      <p className={s.muted}>
        Use the same passphrase on every computer. It never leaves this computer; if you lose it, your
        recovery key (shown next) can unlock sync.
      </p>
      <div className={s.inline}>
        <input
          type="password"
          aria-label="Sync passphrase"
          placeholder="Passphrase (8+ characters)"
          autoComplete="new-password"
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <input
          type="password"
          aria-label="Repeat sync passphrase"
          placeholder="Repeat passphrase"
          autoComplete="new-password"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || a.length < 8 || a !== b}>
          Set up sync
        </button>
      </div>
      {mismatch && <p className={prefs.error}>The passphrases don&apos;t match.</p>}
    </form>
  );
}

function Unlock({
  busy,
  onUnlock,
  onReset,
}: {
  busy: boolean;
  onUnlock(input: { passphrase?: string; recoveryKey?: string }): void;
  onReset(passphrase: string): void;
}) {
  const [mode, setMode] = useState<'passphrase' | 'recovery' | 'reset'>('passphrase');
  const [value, setValue] = useState('');
  return (
    <form
      className={s.stack}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value) return;
        if (mode === 'reset') onReset(value);
        else onUnlock(mode === 'recovery' ? { recoveryKey: value } : { passphrase: value });
      }}
    >
      <strong>
        {mode === 'reset' ? 'Reset sync data with a new passphrase' : 'Unlock sync on this computer'}
      </strong>
      <div className={s.inline}>
        <input
          type={mode === 'recovery' ? 'text' : 'password'}
          aria-label={mode === 'recovery' ? 'Recovery key' : 'Sync passphrase'}
          placeholder={
            mode === 'recovery'
              ? 'XXXX-XXXX-XXXX-…'
              : mode === 'reset'
                ? 'New passphrase (8+ characters)'
                : 'Sync passphrase'
          }
          autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className={mode === 'reset' ? undefined : 'primary'}
          disabled={busy || !value || (mode === 'reset' && value.length < 8)}
        >
          {mode === 'reset' ? 'Reset sync data…' : 'Unlock'}
        </button>
      </div>
      <div className={s.inline}>
        {mode !== 'passphrase' && (
          <button type="button" onClick={() => (setMode('passphrase'), setValue(''))}>
            Use passphrase
          </button>
        )}
        {mode !== 'recovery' && (
          <button type="button" onClick={() => (setMode('recovery'), setValue(''))}>
            Use recovery key
          </button>
        )}
        {mode !== 'reset' && (
          <button type="button" className={s.dangerButton} onClick={() => (setMode('reset'), setValue(''))}>
            Forgot both? Reset sync data
          </button>
        )}
      </div>
      <p className={s.muted}>A wrong passphrase never deletes anything.</p>
    </form>
  );
}

function KeyTools({
  sync,
  busy,
  onShowRecovery,
  onChangePassphrase,
}: {
  sync: SyncStatus;
  busy: boolean;
  onShowRecovery(regenerate: boolean): void;
  onChangePassphrase(passphrase: string): void;
}) {
  const [changing, setChanging] = useState(false);
  const [value, setValue] = useState('');
  return (
    <div className={s.stack}>
      <div className={s.inline}>
        {sync.hasRecoveryKey && (
          <button type="button" disabled={busy} onClick={() => onShowRecovery(false)}>
            Show recovery key
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onShowRecovery(true)}>
          Create new recovery key
        </button>
        <button type="button" disabled={busy} onClick={() => setChanging((c) => !c)}>
          Change passphrase
        </button>
      </div>
      {changing && (
        <form
          className={s.inline}
          onSubmit={(e) => {
            e.preventDefault();
            if (value.length < 8) return;
            onChangePassphrase(value);
            setValue('');
            setChanging(false);
          }}
        >
          <input
            type="password"
            aria-label="New sync passphrase"
            placeholder="New passphrase (8+ characters)"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || value.length < 8}>
            Save passphrase
          </button>
        </form>
      )}
    </div>
  );
}

// ---- danger zone -----------------------------------------------------------------------------------

function DangerZone() {
  const qc = useQueryClient();
  const { error, busy, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Danger zone</h3>
      <div className={s.dangerZone}>
        <div className={s.inline}>
          <span className={s.grow}>Delete all synced settings from the server and turn sync off.</span>
          <button
            type="button"
            className={s.dangerButton}
            disabled={!!busy}
            onClick={() =>
              void run('data', async () => {
                if (
                  !(await confirm(
                    'Delete cloud sync data?',
                    'Local settings are kept.',
                    'Delete sync data',
                    true,
                  ))
                )
                  return;
                setSyncStatus(qc, await cloudInvoke('sync:deleteCloudData', {}));
                setDone('Synced data was deleted from the server.');
              })
            }
          >
            Delete cloud data
          </button>
        </div>
        <div className={s.inline}>
          <span className={s.grow}>
            Delete your account and all of its cloud data (Cloud Patches, synced settings) within 7 days.
          </span>
          <button
            type="button"
            className={s.dangerButton}
            disabled={!!busy}
            onClick={() =>
              void run('account', async () => {
                if (
                  !(await confirm(
                    'Delete your GitHappens Cloud account?',
                    'This cannot be undone. You will be signed out on this computer.',
                    'Delete account',
                    true,
                  ))
                ) {
                  return;
                }
                const r = await cloudInvoke('cloud:deleteAccount', {});
                void qc.invalidateQueries({ queryKey: ck.status() });
                useToastStore.getState().push({
                  kind: 'info',
                  title: 'Account scheduled for deletion',
                  body: r.deleteAfter
                    ? `All data is removed by ${new Date(r.deleteAfter).toLocaleDateString()}.`
                    : undefined,
                });
              })
            }
          >
            Delete account
          </button>
        </div>
        {done && <p className={prefs.ok}>{done}</p>}
        <ErrorLine error={error} />
      </div>
    </div>
  );
}
