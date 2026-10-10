import { useEffect, useState } from 'react';

import type { GpgDetectResult, GpgKey } from '../../../../shared/ipc/prefs-contract';
import { invoke, IpcError } from '../../lib/api';
import { prefsInvoke, useSetting, useSettingsStore } from '../../stores/settings';
import s from '../preferences/PreferencesView.module.css';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Where to paste an exported key (no provider API for GPG keys in `packages/providers` yet). */
export const GPG_KEY_PAGES = [
  { label: 'GitHub', url: 'https://github.com/settings/gpg/new' },
  { label: 'GitLab', url: 'https://gitlab.com/-/user_settings/gpg_keys' },
] as const;

export const SSH_SIGNING_MIN_GIT: readonly [number, number] = [2, 34];

export const supportsSshSigning = (v: readonly number[] | undefined): boolean =>
  !!v &&
  (v[0]! > SSH_SIGNING_MIN_GIT[0] || (v[0] === SSH_SIGNING_MIN_GIT[0] && v[1]! >= SSH_SIGNING_MIN_GIT[1]));

const fmtDate = (ms: number | null): string => (ms ? new Date(ms).toLocaleDateString() : 'never');

export function keyLabel(k: GpgKey): string {
  const flags = [k.expired && 'expired', k.revoked && 'revoked', !k.canSign && 'cannot sign'].filter(Boolean);
  return `${k.uids[0] ?? '(no user id)'} — ${k.keyId}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

/**
 * Commit Signing helpers (spec 13 §4.2 Commit Signing): GPG detection, secret-key dropdown, key
 * generation, public-key export; for SSH signing the Git ≥ 2.34 gate and the allowed_signers helper.
 * The generic rows above still own the stored values; this panel fills them in.
 */
export function GpgPanel() {
  const format = useSetting('signing.format') ?? 'openpgp';
  return format === 'ssh' ? <SshSigningPanel /> : format === 'openpgp' ? <OpenPgpPanel /> : null;
}

function Status({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p className={msg.ok ? s.ok : s.error} role={msg.ok ? 'status' : 'alert'}>
      {msg.text}
    </p>
  );
}

function OpenPgpPanel() {
  const setSetting = useSettingsStore((st) => st.set);
  const program = useSetting('signing.gpgProgram') ?? '';
  const signingKey = useSetting('signing.signingKey') ?? '';
  const profile = useSettingsStore((st) => st.profile);
  const [detect, setDetect] = useState<GpgDetectResult | null>(null);
  const [keys, setKeys] = useState<GpgKey[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [gen, setGen] = useState<{
    name: string;
    email: string;
    passphrase: string;
    algo: 'ed25519' | 'rsa4096';
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadKeys = (): void => {
    prefsInvoke('gpg:listKeys', {}).then(setKeys, (e: unknown) => {
      setKeys([]);
      setMsg({ ok: false, text: errorText(e) });
    });
  };
  useEffect(() => {
    prefsInvoke('gpg:detect', {}).then(
      (r) => {
        setDetect(r);
        if (r.program) loadKeys();
      },
      (e: unknown) => setMsg({ ok: false, text: errorText(e) }),
    );
  }, [program]);

  const act = async (fn: () => Promise<string | void>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const usable = (keys ?? []).filter((k) => !k.revoked);
  return (
    <div className={s.group} aria-label="GPG keys" role="region">
      <h3 className={s.groupTitle}>GPG</h3>
      <p className={s.rowDesc}>
        {detect === null
          ? 'Looking for GnuPG…'
          : detect.program
            ? `Using ${detect.program} (GnuPG ${detect.version}).`
            : 'GnuPG was not found. Install Gpg4win (Windows), GPG Suite or Homebrew gnupg (macOS), or gnupg (Linux).'}
      </p>
      {detect && detect.candidates.length > 0 && !program && (
        <div className={s.toolbar}>
          <select
            aria-label="Detected GPG programs"
            defaultValue={detect.program}
            onChange={(e) => void setSetting('signing.gpgProgram', e.target.value)}
          >
            {detect.candidates.map((c) => (
              <option key={c.path} value={c.path}>
                {c.path} ({c.version})
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void setSetting('signing.gpgProgram', detect.program ?? '')}>
            Use for git (gpg.program)
          </button>
        </div>
      )}
      {detect?.program && (
        <>
          <div className={s.toolbar}>
            <select
              aria-label="Signing key"
              value={
                usable.some((k) => k.keyId === signingKey || k.fingerprint === signingKey) ? signingKey : ''
              }
              onChange={(e) => void setSetting('signing.signingKey', e.target.value)}
            >
              <option value="">
                {keys === null ? 'Loading keys…' : usable.length ? 'Choose a signing key…' : 'No secret keys'}
              </option>
              {usable.map((k) => (
                <option key={k.fingerprint || k.keyId} value={k.keyId} disabled={!k.canSign || k.expired}>
                  {keyLabel(k)} · expires {fmtDate(k.expires)}
                </option>
              ))}
            </select>
            <button type="button" onClick={loadKeys}>
              Refresh
            </button>
            <button
              type="button"
              onClick={() =>
                setGen({
                  name: profile?.authorName ?? '',
                  email: profile?.authorEmail ?? '',
                  passphrase: '',
                  algo: 'ed25519',
                })
              }
            >
              Generate new key…
            </button>
          </div>
          {signingKey && (
            <div className={s.toolbar}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const armored = await prefsInvoke('gpg:exportPublic', { keyId: signingKey });
                    await invoke('shell:copyText', { text: armored });
                    return 'Public key copied to the clipboard.';
                  })
                }
              >
                Copy public key
              </button>
              {GPG_KEY_PAGES.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={busy}
                  title={`Copies the key and opens ${p.label}'s "New GPG key" page`}
                  onClick={() =>
                    void act(async () => {
                      const armored = await prefsInvoke('gpg:exportPublic', { keyId: signingKey });
                      await invoke('shell:copyText', { text: armored });
                      await invoke('shell:openExternal', { url: p.url });
                      return `Public key copied — paste it on ${p.label}.`;
                    })
                  }
                >
                  Add to {p.label}…
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {gen && (
        <form
          className={s.form}
          aria-label="Generate GPG key"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const key = await prefsInvoke('gpg:generateKey', {
                name: gen.name,
                email: gen.email,
                passphrase: gen.passphrase || undefined,
                algo: gen.algo,
              });
              setGen(null);
              await setSetting('signing.signingKey', key.keyId);
              loadKeys();
              return `Created key ${key.keyId} and selected it for signing.`;
            });
          }}
        >
          <label>
            Name
            <input value={gen.name} onChange={(e) => setGen({ ...gen, name: e.target.value })} required />
          </label>
          <label>
            Email
            <input
              type="email"
              value={gen.email}
              onChange={(e) => setGen({ ...gen, email: e.target.value })}
              required
            />
          </label>
          <label>
            Passphrase (optional)
            <input
              type="password"
              autoComplete="new-password"
              value={gen.passphrase}
              onChange={(e) => setGen({ ...gen, passphrase: e.target.value })}
            />
          </label>
          <label>
            Key type
            <select
              value={gen.algo}
              onChange={(e) => setGen({ ...gen, algo: e.target.value as 'ed25519' | 'rsa4096' })}
            >
              <option value="ed25519">Ed25519 (recommended)</option>
              <option value="rsa4096">RSA 4096</option>
            </select>
          </label>
          <div className={s.toolbar}>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
            <button type="button" onClick={() => setGen(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <Status msg={msg} />
    </div>
  );
}

function SshSigningPanel() {
  const [version, setVersion] = useState<{ text: string; tuple: number[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    invoke('git:engine:info', {}).then(
      (i) => setVersion({ text: i.version, tuple: i.versionTuple }),
      () => setVersion(null),
    );
  }, []);
  const supported = version ? supportsSshSigning(version.tuple) : true;
  return (
    <div className={s.group} aria-label="SSH signing" role="region">
      <h3 className={s.groupTitle}>SSH signing</h3>
      {!supported && (
        <p className={s.error} role="alert">
          SSH signing needs Git 2.34 or newer; this app uses Git {version?.text}. Choose another git in
          Preferences › Git or use GPG.
        </p>
      )}
      <p className={s.rowDesc}>
        Set the signing key to your .pub file. To verify SSH signatures, git needs an allowed signers file
        listing your email and key.
      </p>
      <div className={s.toolbar}>
        <button
          type="button"
          disabled={!supported}
          onClick={() => {
            setMsg(null);
            prefsInvoke('signing:allowedSigners', {}).then(
              (r) =>
                setMsg({
                  ok: true,
                  text: r.added ? `Added your key to ${r.file}.` : `${r.file} already lists this key.`,
                }),
              (e: unknown) => setMsg({ ok: false, text: errorText(e) }),
            );
          }}
        >
          Create allowed_signers entry
        </button>
      </div>
      <Status msg={msg} />
    </div>
  );
}
