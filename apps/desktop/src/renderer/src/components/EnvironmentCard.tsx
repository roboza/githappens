import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { invoke } from '../lib/api';
import { behaviourInvoke } from '../notifications/api';
import { useSettingsStore } from '../stores/settings';
import { fetchBundledGit } from './about-api';
import { BrandWordmark } from './BrandLogo';
import s from './Card.module.css';
import { formatDiagnostics } from './diagnostics';

/** About dialog (spec 15 §4): app/Electron/Chromium/Node, active + bundled git, copy diagnostics. */
export function EnvironmentCard() {
  const versions = useQuery({
    queryKey: ['app:getVersionInfo'],
    queryFn: () => invoke('app:getVersionInfo', {}),
    retry: false,
  });
  const secrets = useQuery({
    queryKey: ['app:secretStoreStatus'],
    queryFn: () => invoke('app:secretStoreStatus', {}),
  });
  const profile = useSettingsStore((st) => st.profile);
  const extendedLogging = useSettingsStore((st) => st.values?.['general.extendedLogging']);
  const engine = useQuery({
    queryKey: ['git:engine:info'],
    queryFn: () => invoke('git:engine:info', {}),
    retry: false,
  });
  const bundledQ = useQuery({ queryKey: ['app:bundledGit'], queryFn: fetchBundledGit, retry: false });
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const v = versions.data;
  const active = engine.data;
  // Without the app:bundledGit channel, the active executable still tells us about the bundled one.
  const bundled =
    bundledQ.data ??
    (active?.kind === 'bundled' ? { available: true, version: active.version, path: active.path } : null);

  const copyDiagnostics = async (): Promise<void> => {
    const text = formatDiagnostics({
      versions: v,
      engine: active,
      bundled,
      secrets: secrets.data,
      platform: window.api.platform,
      userAgent: navigator.userAgent,
    });
    try {
      await invoke('shell:copyText', { text });
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <section className={s.card} aria-labelledby="env-title">
      <BrandWordmark size={22} />
      <h2 id="env-title" className={s.title}>
        Environment
      </h2>
      <dl className={s.rows}>
        <dt>Profile</dt>
        <dd>
          {profile?.name ?? '…'}
          {profile?.authorEmail ? (
            <span className="mono">
              {' '}
              · {profile.authorName} &lt;{profile.authorEmail}&gt;
            </span>
          ) : null}
        </dd>
        <dt>Secure storage</dt>
        <dd>
          {secrets.data ? (
            <span className={secrets.data.available ? s.badge : s.badgeError}>
              {secrets.data.available ? 'available' : 'unavailable'} · {secrets.data.backend}
            </span>
          ) : (
            '…'
          )}
        </dd>
        {v && (
          <>
            <dt>App</dt>
            <dd>{v.app}</dd>
            <dt>Electron</dt>
            <dd>{v.electron}</dd>
            <dt>Chromium</dt>
            <dd>{v.chrome}</dd>
            <dt>Node</dt>
            <dd>{v.node}</dd>
            <dt>Git</dt>
            <dd>
              {active ? <span className={s.badge}>{active.kind}</span> : null} Git {v.git}
            </dd>
            <dt>Git path</dt>
            <dd className="mono">{v.gitPath}</dd>
          </>
        )}
        <dt>Bundled Git</dt>
        <dd>
          {bundled ? (
            bundled.available ? (
              <>
                Git {bundled.version} <span className="mono">{bundled.path}</span>
              </>
            ) : (
              <span className={s.badgeOff}>{bundled.error ?? 'unavailable'}</span>
            )
          ) : (
            '…'
          )}
        </dd>
        <dt>Platform</dt>
        <dd>{window.api.platform}</dd>
        <dt>Logs</dt>
        <dd>
          <button type="button" onClick={() => void behaviourInvoke('logs:open', {}).catch(() => undefined)}>
            Open logs folder
          </button>{' '}
          {extendedLogging ? 'extended logging on' : 'extended logging off (General)'}
        </dd>
      </dl>
      <div className={s.controls}>
        <button type="button" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </button>
        {copied === 'copied' && (
          <span className={s.muted} role="status">
            Diagnostics copied to the clipboard.
          </span>
        )}
        {copied === 'failed' && (
          <span className={s.error} role="alert">
            Could not copy diagnostics.
          </span>
        )}
      </div>
    </section>
  );
}
