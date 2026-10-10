import { useState } from 'react';

import type { UpdateStatus } from '../../../../shared/ipc/update-contract';
import { useToastStore } from '../../stores/toasts';
import { errorText, openExternal, updateInvoke, useUpdateStatus } from './update-api';
import styles from './Update.module.css';

type CardKind = 'progress' | 'ready' | 'offer';

function cardFor(s: UpdateStatus | null): CardKind | null {
  if (!s) return null;
  if (s.state === 'ready') return 'ready';
  if (s.state === 'downloading') return 'progress';
  if (s.state === 'available' || (s.state === 'manual' && s.version)) return 'offer';
  return null;
}

/**
 * Persistent bottom-right update card (spec 15 §4): download progress, then
 * "Version X is ready — Restart now / Later". "Later" hides it for that version until next launch.
 */
export function UpdateNotifier() {
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const kind = cardFor(status);
  if (!status || !kind) return null;
  const key = `${kind}:${status.version ?? ''}`;
  if (dismissed.has(key)) return null;
  const later = (): void => setDismissed((d) => new Set(d).add(key));
  const version = status.version ?? 'A new version';
  const label = status.version ? `Version ${status.version}` : version;

  const run = async (): Promise<void> => {
    if (status.state === 'manual') {
      if (status.downloadUrl) openExternal(status.downloadUrl);
      later();
      return;
    }
    setBusy(true);
    try {
      await updateInvoke('update:install', {});
    } catch (e) {
      useToastStore.getState().push({ kind: 'error', title: 'Update failed', body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const pct = Math.round((status.progress ?? 0) * 100);
  return (
    <section
      className={`${styles.notifier} ${kind === 'ready' ? styles.ready : ''}`}
      role="status"
      aria-live="polite"
      data-testid="update-notifier"
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          {kind === 'ready' && <p className={styles.title}>{label} is ready</p>}
          {kind === 'progress' && <p className={styles.title}>Downloading {label.toLowerCase()}…</p>}
          {kind === 'offer' && <p className={styles.title}>{label} is available</p>}
          {kind === 'ready' && <p className={styles.sub}>Restart GitHappens to finish updating.</p>}
          {kind === 'progress' && <p className={styles.sub}>{pct}%</p>}
        </div>
        <button type="button" className={styles.close} aria-label="Dismiss" onClick={later}>
          ×
        </button>
      </div>
      {kind === 'progress' && (
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
      )}
      {kind !== 'progress' && (
        <div className={styles.actions}>
          <button type="button" onClick={later}>
            Later
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
            {kind === 'ready' ? 'Restart now' : 'Download'}
          </button>
        </div>
      )}
    </section>
  );
}
