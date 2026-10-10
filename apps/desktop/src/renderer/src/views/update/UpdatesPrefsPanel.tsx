import { useState } from 'react';

import type { UpdateChannel, UpdateStatus } from '../../../../shared/ipc/update-contract';
import { useSettingsStore } from '../../stores/settings';
import prefs from '../preferences/PreferencesView.module.css';
import { errorText, openExternal, updateInvoke, useUpdateStatus } from './update-api';
import styles from './Update.module.css';
import { showWhatsNew } from './WhatsNewDialog';

function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return 'Updates are disabled in development builds.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${s.version ?? '?'} is available.`;
    case 'not-available':
      return 'GitHappens is up to date.';
    case 'downloading':
      return `Downloading ${s.version ?? 'update'}… ${Math.round((s.progress ?? 0) * 100)}%`;
    case 'ready':
      return `Version ${s.version ?? '?'} is ready — restart to finish updating.`;
    case 'error':
      return `Update check failed: ${s.error ?? 'unknown error'}`;
    case 'manual':
      return s.version
        ? `Version ${s.version} is available. This package type can't update itself — download it.`
        : "This package type can't update itself; new versions are linked here.";
    default:
      return '';
  }
}

/** Preferences › General › Updates (spec 15 §4): channel, auto-download, check now, status. */
export function UpdatesPrefsPanel() {
  const status = useUpdateStatus();
  const channel = useSettingsStore((s) => s.values?.['updates.channel']) ?? 'stable';
  const autoDownload = useSettingsStore((s) => s.values?.['updates.autoDownload']) ?? true;
  const setSetting = useSettingsStore((s) => s.set);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const checkNow = async (): Promise<void> => {
    setChecking(true);
    await guard(() => updateInvoke('update:check', {}));
    setChecking(false);
  };

  const disabled = !status || status.state === 'disabled';
  const busy = checking || status?.state === 'checking' || status?.state === 'downloading';
  const tone =
    status?.state === 'error' ? styles.statusError : status?.state === 'not-available' ? styles.statusOk : '';

  return (
    <div className={prefs.group} data-testid="updates-prefs">
      <h3 className={prefs.groupTitle}>Updates</h3>

      <div className={prefs.row}>
        <div className={prefs.rowText}>
          <label htmlFor="updates-channel" className={prefs.rowTitle}>
            Update channel
          </label>
          <p className={prefs.rowDesc}>Stable receives tested releases; Preview receives nightly builds.</p>
        </div>
        <div className={prefs.control}>
          <select
            id="updates-channel"
            value={channel}
            onChange={(e) => void guard(() => setSetting('updates.channel', e.target.value as UpdateChannel))}
          >
            <option value="stable">Stable</option>
            <option value="preview">Preview</option>
          </select>
        </div>
        <span />
      </div>

      <div className={prefs.row}>
        <div className={prefs.rowText}>
          <label htmlFor="updates-auto" className={prefs.rowTitle}>
            Automatically download updates
          </label>
          <p className={prefs.rowDesc}>Download updates in the background and prompt to restart.</p>
        </div>
        <div className={prefs.control}>
          <input
            id="updates-auto"
            type="checkbox"
            role="switch"
            className={prefs.toggle}
            checked={autoDownload}
            disabled={status?.state === 'manual'}
            onChange={(e) => void guard(() => setSetting('updates.autoDownload', e.target.checked))}
          />
        </div>
        <span />
      </div>

      <div className={styles.statusLine} role="status" aria-live="polite">
        <span>Current version {status?.currentVersion ?? '—'}.</span>
        <span className={tone}>{status ? describe(status) : 'Update service unavailable.'}</span>
        <span className={prefs.spacer} />
        {status?.state === 'ready' && (
          <button
            type="button"
            className="primary"
            onClick={() => void guard(() => updateInvoke('update:install', {}))}
          >
            Restart now
          </button>
        )}
        {status?.state === 'available' && (
          <button type="button" onClick={() => void guard(() => updateInvoke('update:install', {}))}>
            Download
          </button>
        )}
        {status?.state === 'manual' && status.downloadUrl && (
          <button type="button" onClick={() => openExternal(status.downloadUrl ?? '')}>
            Open downloads
          </button>
        )}
        <button type="button" onClick={() => void showWhatsNew()}>
          What&apos;s new
        </button>
        <button type="button" disabled={disabled || busy} onClick={() => void checkNow()}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {error && (
        <p className={prefs.rowError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
