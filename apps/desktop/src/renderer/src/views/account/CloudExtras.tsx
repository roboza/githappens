import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { createElement, useEffect, useRef, useState } from 'react';

import type { CertificateInfo } from '../../../../shared/ipc/cloud-contract';
import { mountDialog } from '../../ai/mount';
import { cloudErrorText, cloudInvoke } from '../../cloud/api';
import { invoke } from '../../lib/api';
import { useToastStore } from '../../stores/toasts';
import prefs from '../preferences/PreferencesView.module.css';
import s from './Account.module.css';

// ---- self-signed server trust ----------------------------------------------------------------------

/**
 * Self-signed / private-CA server (spec 14 §8): shows the certificate the server presents and pins its
 * fingerprint for that server only after explicit confirmation. Rendered under the server URL field.
 */
export function CertificateTrustBox({
  url,
  error,
  onTrusted,
}: {
  url: string;
  error: string | null;
  onTrusted(): void;
}) {
  const [probe, setProbe] = useState<{ url: string; info: CertificateInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const cert = probe?.url === url ? probe.info : null;
  const err = failure?.url === url ? failure.message : null;
  const setCert = (info: CertificateInfo | null): void => setProbe(info ? { url, info } : null);
  const setErr = (message: string | null): void => setFailure(message ? { url, message } : null);
  const https = /^https:\/\//i.test(url.trim());
  const looksLikeCert = !!error && /cert|ssl|tls|self.signed|authority/i.test(error);
  if (!https || (!error && !cert)) return null;

  const inspect = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      setCert(await cloudInvoke('cloud:inspectCertificate', { url: url.trim() }));
    } catch (e) {
      setErr(cloudErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const trust = async (): Promise<void> => {
    if (!cert) return;
    setBusy(true);
    try {
      await cloudInvoke('cloud:trustCertificate', { url: url.trim(), fingerprint256: cert.fingerprint256 });
      useToastStore.getState().push({ kind: 'success', title: `Certificate trusted for ${cert.origin}` });
      onTrusted();
    } catch (e) {
      setErr(cloudErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.stack} role="group" aria-label="Server certificate">
      {!cert && (
        <p className={s.muted}>
          <ShieldAlert size={12} aria-hidden />{' '}
          {looksLikeCert
            ? 'The server’s certificate is not trusted by this computer (self-signed or private CA).'
            : 'If this server uses a self-signed certificate, you can review and trust it.'}{' '}
          <button type="button" disabled={busy} onClick={() => void inspect()}>
            {busy ? 'Checking…' : 'Review certificate…'}
          </button>
        </p>
      )}
      {cert && (
        <div className={s.stack}>
          <p className={s.muted}>
            {cert.trustedBySystem ? (
              <>
                <ShieldCheck size={12} aria-hidden /> This certificate is already trusted by your system.
              </>
            ) : (
              <>
                <ShieldAlert size={12} aria-hidden /> Only trust this certificate if you can confirm the
                fingerprint with the server’s administrator.
              </>
            )}
          </p>
          <dl className={s.small}>
            <dt>Server</dt>
            <dd>{cert.origin}</dd>
            <dt>Subject / issuer</dt>
            <dd>
              {cert.subject} / {cert.issuer}
              {cert.selfSigned ? ' (self-signed)' : ''}
            </dd>
            <dt>Valid</dt>
            <dd>
              {new Date(cert.validFrom).toLocaleDateString()} – {new Date(cert.validTo).toLocaleDateString()}
            </dd>
            <dt>SHA-256 fingerprint</dt>
            <dd style={{ fontFamily: 'var(--kl-font-mono)', overflowWrap: 'anywhere' }}>
              {cert.fingerprint256}
            </dd>
            {cert.error && (
              <>
                <dt>Problem</dt>
                <dd>{cert.error}</dd>
              </>
            )}
          </dl>
          {!cert.trustedBySystem && !cert.pinned && (
            <div className={s.inline}>
              <button type="button" className="primary" disabled={busy} onClick={() => void trust()}>
                Trust this certificate for {cert.origin}
              </button>
              <button type="button" disabled={busy} onClick={() => setCert(null)}>
                Cancel
              </button>
            </div>
          )}
          {cert.pinned && <p className={prefs.ok}>You trust this certificate for this server.</p>}
        </div>
      )}
      {err && <p className={prefs.error}>{err}</p>}
    </div>
  );
}

// ---- "Also connect GitHub integration" ------------------------------------------------------------

/**
 * After signing in to the cloud with GitHub (spec 14 §6.1): the cloud sign-in does NOT give the app GitHub
 * API access (tokens never reach our server); offer the separate GitHub integration OAuth.
 */
export async function offerGithubIntegration(): Promise<void> {
  try {
    const accounts = await invoke('auth:list', {});
    if (accounts.some((a) => a.kind === 'github' && a.host === 'github.com')) return;
  } catch {
    return;
  }
  await mountDialog<void>((done) => createElement(GithubOffer, { onClose: () => done() }));
}

function GithubOffer({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const connect = async (): Promise<void> => {
    setBusy(true);
    try {
      await invoke('auth:startOAuth', { kind: 'github', host: 'github.com' });
      onClose();
    } catch (e) {
      setError(cloudErrorText(e));
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      aria-label="Connect GitHub"
      style={{
        maxWidth: 460,
        padding: 16,
        border: '1px solid var(--kl-default-border)',
        borderRadius: 12,
        background: 'var(--kl-panel__bg0)',
        color: 'var(--kl-text-normal)',
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Also connect the GitHub integration?</h2>
      <p className={s.muted}>
        Signing in to GitHappens Cloud with GitHub only proves who you are; it does not let this app use
        GitHub (pull requests, issues, Launchpad, Code Suggest). Connect the GitHub integration separately —
        its token stays on this computer and is never sent to the cloud server.
      </p>
      {error && <p className={prefs.error}>{error}</p>}
      <div className={s.inline} style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" onClick={onClose} disabled={busy}>
          Not now
        </button>
        <button type="button" className="primary" onClick={() => void connect()} disabled={busy}>
          Connect GitHub
        </button>
      </div>
    </dialog>
  );
}
