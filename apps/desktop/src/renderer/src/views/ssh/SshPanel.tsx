import type { ConnectedIntegration } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, KeyRound, Loader2, PlugZap, Upload } from 'lucide-react';
import { useState } from 'react';

import type { SshKeyType, SshTestResult } from '../../../../shared/ipc/network-contract';
import { copyText, intInvoke, openExternal } from '../../integrations/api';
import { providerLabel } from '../../integrations/helpers';
import { useIntegrations } from '../../integrations/queries';
import { useSetting } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import {
  errorText,
  HOSTING_KINDS,
  netInvoke,
  sshKeysPageUrl,
  sshTestHost,
  SSH_UPLOAD_KINDS,
} from '../network/api';
import s from './SshPanel.module.css';

/** Status depends on these settings; refetch when any changes. */
function useSshStatus() {
  const deps = [
    useSetting('ssh.useLocalAgent'),
    useSetting('ssh.privateKeyPath'),
    useSetting('ssh.publicKeyPath'),
    useSetting('ssh.useSshConfig'),
    useSetting('ssh.windowsAgent'),
  ];
  return useQuery({ queryKey: ['ssh', 'status', ...deps], queryFn: () => netInvoke('ssh:status', {}) });
}

function usePublicKey(enabled: boolean, pubPath: string) {
  return useQuery({
    queryKey: ['ssh', 'publicKey', pubPath],
    queryFn: () => netInvoke('ssh:key:publicKey', {}),
    enabled,
    retry: false,
  });
}

const MODE_TEXT = {
  key: 'Git uses your SSH key file.',
  agent: 'Git uses keys from your SSH agent.',
  default: "Git uses ssh's default keys and agent (no key selected).",
} as const;

/**
 * Preferences → SSH actions (spec 09 §6.7, spec 13 SSH): effective key/agent selection, public key copy,
 * key generation, connection test and "Add to <provider>". The settings themselves are the generic rows.
 */
export function SshPanel() {
  const status = useSshStatus();
  const st = status.data;
  const pub = usePublicKey(!!st?.publicKeyExists, st?.publicKeyPath ?? '');

  return (
    <div className={s.panel}>
      <section className={s.card} aria-label="SSH status">
        <h3 className={s.title}>
          <KeyRound size={14} aria-hidden /> Current SSH setup
        </h3>
        {status.isPending && <span className={s.muted}>Checking…</span>}
        {status.error && <span className={s.error}>{errorText(status.error)}</span>}
        {st && (
          <>
            <p className={s.line}>
              {MODE_TEXT[st.mode]}
              {st.client === 'windows-openssh' && ' (Windows OpenSSH client)'}
            </p>
            {st.agentPipes && st.mode === 'agent' && (
              <p className={s.muted}>
                OpenSSH agent: {st.agentPipes.openssh ? 'running' : 'not running'} · Pageant:{' '}
                {st.agentPipes.pageant ? 'running' : 'not running'}
              </p>
            )}
            {st.sshCommand && (
              <p className={s.muted}>
                GIT_SSH_COMMAND: <code className={s.code}>{st.sshCommand}</code>
              </p>
            )}
            {st.warnings.map((w) => (
              <p key={w} className={s.warn}>
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      <section className={s.card} aria-label="Public key">
        <h3 className={s.title}>Public key</h3>
        {!st?.publicKeyExists ? (
          <span className={s.muted}>No public key configured. Choose a key above or generate one below.</span>
        ) : pub.error ? (
          <span className={s.error}>{errorText(pub.error)}</span>
        ) : pub.data ? (
          <>
            <textarea
              className={s.key}
              readOnly
              rows={3}
              value={pub.data.publicKey}
              aria-label="Public key"
            />
            <div className={s.row}>
              <span className={s.muted}>
                {pub.data.fingerprint} · {pub.data.path}
              </span>
              <button type="button" onClick={() => copyText(pub.data.publicKey)}>
                <Copy size={14} /> Copy public key
              </button>
            </div>
          </>
        ) : (
          <span className={s.muted}>Loading…</span>
        )}
      </section>

      <GenerateKey
        defaultPath={st?.defaultKeyPath ?? ''}
        defaultComment={st?.defaultComment ?? ''}
        canGenerate={!!st?.keygenPath}
      />
      <TestConnection />
      {pub.data && <ProviderUploads publicKey={pub.data.publicKey} />}
    </div>
  );
}

function GenerateKey({
  defaultPath,
  defaultComment,
  canGenerate,
}: {
  defaultPath: string;
  defaultComment: string;
  canGenerate: boolean;
}) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<SshKeyType>('ed25519');
  const [comment, setComment] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [useAsDefault, setUseAsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const key = await netInvoke('ssh:key:generate', {
        type,
        comment: comment.trim() || undefined,
        passphrase: passphrase || undefined,
        path: keyPath.trim() || undefined,
        useAsDefault,
      });
      setPassphrase('');
      setOpen(false);
      push({
        kind: 'success',
        title: 'SSH key generated',
        body: `${key.fingerprint}\n${key.privateKeyPath}`,
      });
      await qc.invalidateQueries({ queryKey: ['ssh'] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.card} aria-label="Generate SSH key">
      <h3 className={s.title}>Generate a new key</h3>
      {!open ? (
        <div className={s.row}>
          <button type="button" disabled={!canGenerate} onClick={() => setOpen(true)}>
            <KeyRound size={14} /> Generate new key…
          </button>
          {!canGenerate && <span className={s.muted}>ssh-keygen was not found on this computer.</span>}
        </div>
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <label className={s.field}>
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as SshKeyType)}>
              <option value="ed25519">Ed25519 (recommended)</option>
              <option value="rsa-4096">RSA 4096</option>
            </select>
          </label>
          <label className={s.field}>
            <span>Comment</span>
            <input
              value={comment}
              placeholder={defaultComment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <label className={s.field}>
            <span>File</span>
            <input value={keyPath} placeholder={defaultPath} onChange={(e) => setKeyPath(e.target.value)} />
          </label>
          <label className={s.field}>
            <span>Passphrase</span>
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              placeholder="Optional (5+ characters)"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={useAsDefault}
              onChange={(e) => setUseAsDefault(e.target.checked)}
            />{' '}
            Use this key for git (sets the key paths above)
          </label>
          {error && <p className={s.error}>{error}</p>}
          <div className={s.row}>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? <Loader2 size={14} className={s.spin} /> : <KeyRound size={14} />} Generate
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Shows an `ssh -T` result; shared with the Integrations account rows. */
export function SshTestResultLine({ result }: { result: SshTestResult }) {
  return (
    <div className={result.ok ? s.ok : s.warn}>
      {result.message}
      {result.output && (
        <details>
          <summary className={s.muted}>ssh output</summary>
          <pre className={s.output}>{result.output}</pre>
        </details>
      )}
    </div>
  );
}

function TestConnection() {
  const [host, setHost] = useState('github.com');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SshTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await netInvoke('ssh:testConnection', { host }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.card} aria-label="Test SSH connection">
      <h3 className={s.title}>Test connection</h3>
      <form
        className={s.row}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          aria-label="SSH host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="github.com"
        />
        <button type="submit" disabled={busy || !host.trim()}>
          {busy ? <Loader2 size={14} className={s.spin} /> : <PlugZap size={14} />} Test
        </button>
      </form>
      {error && <p className={s.error}>{error}</p>}
      {result && <SshTestResultLine result={result} />}
    </section>
  );
}

function ProviderUploads({ publicKey }: { publicKey: string }) {
  const integrations = useIntegrations();
  const accounts = (integrations.data ?? []).filter((a) => HOSTING_KINDS.has(a.kind));
  if (!accounts.length) return null;
  return (
    <section className={s.card} aria-label="Add key to provider">
      <h3 className={s.title}>Add this key to an account</h3>
      {accounts.map((a) => (
        <div key={a.key} className={s.row}>
          <span className={s.grow}>
            {providerLabel(a.kind)} · {a.login} <span className={s.muted}>({a.host})</span>
          </span>
          <AddSshKeyButton account={a} publicKey={publicKey} />
        </div>
      ))}
    </section>
  );
}

/**
 * "Add to <provider>": uploads through the integrations `ssh:upload` channel where the API allows it,
 * otherwise copies the key and opens the provider's SSH keys page (spec 10 §6.5).
 */
export function AddSshKeyButton({
  account,
  publicKey,
}: {
  account: ConnectedIntegration;
  publicKey?: string;
}) {
  const push = useToastStore((st) => st.push);
  const [busy, setBusy] = useState(false);
  const label = providerLabel(account.kind);
  const canUpload = SSH_UPLOAD_KINDS.has(account.kind);

  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      const key = publicKey ?? (await netInvoke('ssh:key:publicKey', {})).publicKey;
      if (canUpload) {
        try {
          await intInvoke('ssh:upload', { integrationKey: account.key, title: 'GitHappens', publicKey: key });
          push({ kind: 'success', title: `SSH key added to ${label}`, body: account.login });
          return;
        } catch (e) {
          push({
            kind: 'warning',
            title: `Could not upload to ${label}`,
            body: `${errorText(e)} Opening the SSH keys page instead.`,
          });
        }
      }
      copyText(key);
      const url = sshKeysPageUrl(account.kind, account.host);
      if (url) openExternal(url);
      push({ kind: 'info', title: 'Public key copied', body: `Paste it into ${label}'s SSH keys page.` });
    } catch (e) {
      push({ kind: 'error', title: 'No SSH public key', body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void add()}
      title={canUpload ? undefined : 'Copies the key and opens the provider page'}
    >
      {busy ? (
        <Loader2 size={14} className={s.spin} />
      ) : canUpload ? (
        <Upload size={14} />
      ) : (
        <ExternalLink size={14} />
      )}{' '}
      Add SSH key to {label}
    </button>
  );
}

/** Integrations account row extras: add the configured key, test SSH to the account's host. */
export function IntegrationSshActions({ account }: { account: ConnectedIntegration }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SshTestResult | null>(null);
  if (!HOSTING_KINDS.has(account.kind)) return null;
  const test = async (): Promise<void> => {
    setBusy(true);
    try {
      setResult(await netInvoke('ssh:testConnection', { host: sshTestHost(account.kind, account.host) }));
    } catch (e) {
      setResult({ ok: false, kind: 'unknown', message: errorText(e), output: '' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.integration}>
      <div className={s.row}>
        <AddSshKeyButton account={account} />
        <button type="button" disabled={busy} onClick={() => void test()}>
          {busy ? <Loader2 size={14} className={s.spin} /> : <PlugZap size={14} />} Test SSH
        </button>
      </div>
      {result && <SshTestResultLine result={result} />}
    </div>
  );
}
