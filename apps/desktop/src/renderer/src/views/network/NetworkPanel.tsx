import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { choose } from '../../components/Dialogs';
import { useSetting } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import s from '../ssh/SshPanel.module.css';
import { errorText, netInvoke } from './api';

/**
 * Preferences → Network actions (spec 09 §6.11, spec 13 Network): what proxy git and the app use right now,
 * and the proxy login (stored encrypted per proxy host). Mode/URL/bypass/certificates are the generic rows.
 */
export function NetworkPanel() {
  const deps = [
    useSetting('network.proxyMode'),
    useSetting('network.proxyUrl'),
    useSetting('network.noProxy'),
    useSetting('network.useOsCertStore'),
    useSetting('network.caBundlePath'),
    useSetting('git.useCredentialHelpers'),
  ];
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['net', 'status', ...deps],
    queryFn: () => netInvoke('net:status', {}),
  });
  const st = status.data;
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['net'] });
  const saveAuth = async (): Promise<void> => {
    setError(null);
    try {
      await netInvoke('net:proxyAuth:set', { username: user, password });
      setPassword('');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const clearAuth = async (): Promise<void> => {
    await netInvoke('net:proxyAuth:clear', {}).catch((e: unknown) => setError(errorText(e)));
    await refresh();
  };

  return (
    <div className={s.panel}>
      <section className={s.card} aria-label="Proxy status">
        <h3 className={s.title}>
          <Globe size={14} aria-hidden /> In use now
          <button type="button" title="Re-detect the system proxy" onClick={() => void refresh()}>
            {status.isFetching ? <Loader2 size={13} className={s.spin} /> : <RefreshCw size={13} />}
          </button>
        </h3>
        {status.error && <p className={s.error}>{errorText(status.error)}</p>}
        {st && (
          <>
            <p className={s.line}>
              Git: {st.gitProxy ? <code className={s.code}>{st.gitProxy}</code> : 'direct connection'}
              {st.mode === 'system' && !st.gitProxy && ' (or your own git/environment proxy settings)'}
            </p>
            {st.mode === 'system' && (
              <p className={s.muted}>
                System proxy for https://github.com: {st.systemProxy ?? 'DIRECT'}
                {st.resolvedAt ? ` · checked ${new Date(st.resolvedAt).toLocaleTimeString()}` : ''}
              </p>
            )}
            {st.gitConfig.length > 0 && (
              <p className={s.muted}>
                Git config for network commands: <code className={s.code}>{st.gitConfig.join('  ')}</code>
              </p>
            )}
            <p className={s.muted}>
              Integrations, AI, Cloud and updates use the same proxy setting through the app&apos;s network
              stack.
            </p>
            {st.warnings.map((w) => (
              <p key={w} className={s.warn}>
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      {st && st.mode !== 'none' && (
        <section className={s.card} aria-label="Proxy login">
          <h3 className={s.title}>
            <KeyRound size={14} aria-hidden /> Proxy login
          </h3>
          {st.proxyAuth ? (
            <div className={s.row}>
              <span className={s.grow}>
                Saved login <b>{st.proxyAuth.username}</b> for {st.proxyAuth.host}
              </span>
              <button type="button" onClick={() => void clearAuth()}>
                <Trash2 size={14} /> Remove
              </button>
            </div>
          ) : !st.gitProxy ? (
            <p className={s.muted}>No proxy is in use, so no login is needed.</p>
          ) : (
            <form
              className={s.form}
              onSubmit={(e) => {
                e.preventDefault();
                void saveAuth();
              }}
            >
              <label className={s.field}>
                <span>User name</span>
                <input value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
              </label>
              <label className={s.field}>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <div className={s.row}>
                <button type="submit" className="primary" disabled={!user.trim()}>
                  Save login
                </button>
                <span className={s.muted}>Stored encrypted on this computer, never in settings files.</span>
              </div>
            </form>
          )}
          {error && <p className={s.error}>{error}</p>}
        </section>
      )}
      <CredentialsPanel />
    </div>
  );
}

const KIND_LABEL = {
  git: 'Git login',
  'ssh-passphrase': 'SSH key passphrase',
  proxy: 'Proxy login',
  integration: 'Connected account',
} as const;

/**
 * Saved credentials + "Forget all credentials" (spec 09 §6.6). Removes only what GitHappens saved; your own
 * git credential helpers (Git Credential Manager, osxkeychain…) are untouched.
 */
export function CredentialsPanel() {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const list = useQuery({ queryKey: ['net', 'credentials'], queryFn: () => netInvoke('cred:list', {}) });
  const saved = (list.data ?? []).filter((c) => c.source === 'prompt');
  const accounts = (list.data ?? []).filter((c) => c.source === 'integration');

  const forget = async (id: string): Promise<void> => {
    try {
      await netInvoke('cred:forget', { id });
    } catch (e) {
      push({ kind: 'error', title: 'Could not forget the credential', body: errorText(e) });
    }
    await qc.invalidateQueries({ queryKey: ['net'] });
  };
  const forgetAll = async (): Promise<void> => {
    const r = await choose({
      title: 'Forget all credentials?',
      message:
        'Removes every git login, SSH key passphrase and proxy login GitHappens saved for this profile. Connected accounts and your own git credential helpers are not affected.',
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'ok', label: 'Forget all', danger: true },
      ],
    });
    if (r?.value !== 'ok') return;
    try {
      const { removed } = await netInvoke('cred:forgetAll', {});
      push({ kind: 'success', title: `Forgot ${removed} saved credential${removed === 1 ? '' : 's'}` });
    } catch (e) {
      push({ kind: 'error', title: 'Could not forget credentials', body: errorText(e) });
    }
    await qc.invalidateQueries({ queryKey: ['net'] });
  };

  return (
    <section className={s.card} aria-label="Saved credentials">
      <h3 className={s.title}>
        <KeyRound size={14} aria-hidden /> Saved credentials
      </h3>
      {list.error && <p className={s.error}>{errorText(list.error)}</p>}
      {list.data && !saved.length && <p className={s.muted}>Nothing saved for this profile.</p>}
      {saved.map((c) => (
        <div key={c.id} className={s.row}>
          <span className={s.grow}>
            {KIND_LABEL[c.kind]} · {c.host}
            {c.username && <span className={s.muted}> ({c.username})</span>}
          </span>
          <button type="button" title="Forget" onClick={() => void forget(c.id)}>
            <Trash2 size={14} /> Forget
          </button>
        </div>
      ))}
      {accounts.length > 0 && (
        <p className={s.muted}>
          Also used for HTTPS: {accounts.map((a) => `${a.username}@${a.host}`).join(', ')} (manage in
          Integrations).
        </p>
      )}
      <div className={s.row}>
        <button type="button" disabled={!saved.length} onClick={() => void forgetAll()}>
          <Trash2 size={14} /> Forget all credentials
        </button>
      </div>
    </section>
  );
}
