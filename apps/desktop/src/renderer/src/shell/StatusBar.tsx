import { useQuery } from '@tanstack/react-query';
import { Loader2, ScrollText, TriangleAlert, X } from 'lucide-react';
import { useEffect } from 'react';

import { invoke } from '../lib/api';
import { basename } from '../lib/format';
import { behaviourInvoke } from '../notifications/api';
import { LastErrorIndicator, NotificationBell } from '../notifications/NotificationCenter';
import { useSession } from '../repo/sessions';
import { useRepoOps } from '../stores/ops';
import { useSetting, useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { ActivityDrawer, useActivityStore } from '../views/activity/ActivityDrawer';
import { LaunchpadStatusIndicator } from '../views/launchpad/LaunchpadStatusIndicator';
// completion toast of the background commit-graph write (spec 02 §6.15.1)
import '../views/preferences/repo/commit-graph-toast';
import styles from './StatusBar.module.css';

/** Zoom presets (spec 01 §4.12). */
export const ZOOM_PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.5, 3];

function ZoomSelector() {
  const zoom = useSetting('ui.zoom') ?? 1;
  const set = useSettingsStore((s) => s.set);
  const options = ZOOM_PRESETS.includes(zoom) ? ZOOM_PRESETS : [...ZOOM_PRESETS, zoom].sort((a, b) => a - b);
  return (
    <select
      className={styles.zoom}
      aria-label="Zoom"
      title="Zoom (Ctrl+= / Ctrl+- / Ctrl+0)"
      value={String(zoom)}
      onChange={(e) => void set('ui.zoom', Number(e.target.value))}
    >
      {options.map((z) => (
        <option key={z} value={String(z)}>
          {Math.round(z * 100)}%
        </option>
      ))}
    </select>
  );
}

/** 'File watching unavailable' while the repo's watcher fell back to polling (spec 02 §6.14). */
function WatchWarning({ repoId }: { repoId: string }) {
  const state = useQuery({
    queryKey: ['watchState', repoId],
    queryFn: () => invoke('git:watch:state', { repoId }),
    refetchInterval: 15_000,
    retry: false,
  });
  if (state.data?.mode !== 'polling') return null;
  return (
    <span
      className={styles.watchWarning}
      role="status"
      title="File watching is unavailable for this repository; changes are detected by polling every 5 seconds and on window focus."
    >
      <TriangleAlert size={12} aria-hidden />
      File watching unavailable
    </span>
  );
}

/**
 * Status bar (spec 01 §4.7): running operation with progress + cancel, Activity (git output log) toggle,
 * last error, notification bell, zoom selector, Launchpad summary and versions.
 */
export function StatusBar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const session = useSession(active?.repoPath);
  const repoId = session?.state === 'ready' ? session.repoId : undefined;
  const ops = useRepoOps(repoId);
  const op = ops.find((o) => o.state === 'running') ?? ops[0];
  const activityOpen = useActivityStore((s) => s.open);
  const toggleActivity = useActivityStore((s) => s.toggle);
  const version = useQuery({
    queryKey: ['app:getVersionInfo'],
    queryFn: () => invoke('app:getVersionInfo', {}),
    retry: false,
  });
  const pct = op?.progress?.overall;

  // Background tabs auto-fetch less often (spec 09 §6.2 step 3).
  useEffect(() => {
    void behaviourInvoke('autofetch:setActive', { repoId: repoId ?? null }).catch(() => undefined);
  }, [repoId]);

  return (
    <>
      <ActivityDrawer repoId={repoId} repoLabel={active?.repoPath ? basename(active.repoPath) : undefined} />
      <footer className={styles.bar}>
        {op ? (
          <span className={styles.op} role="status">
            <Loader2 size={12} className={styles.spin} aria-hidden />
            {op.label}
            {op.progress?.phase ? ` · ${op.progress.phase}` : ''}
            {typeof pct === 'number' ? ` ${Math.round(pct * 100)}%` : ''}
            {ops.length > 1 && <span className={styles.queued}>+{ops.length - 1} queued</span>}
            {repoId && (
              <button
                type="button"
                className={styles.cancel}
                aria-label={`Cancel ${op.label}`}
                title="Cancel"
                onClick={() => void invoke('git:op:cancel', { repoId, opId: op.opId })}
              >
                <X size={11} />
              </button>
            )}
            {typeof pct === 'number' && (
              <span className={styles.progress} aria-hidden>
                <span style={{ width: `${Math.round(pct * 100)}%` }} />
              </span>
            )}
          </span>
        ) : (
          <span className={styles.path} title={active?.repoPath}>
            {active?.kind === 'launchpad' ? 'Launchpad' : (active?.repoPath ?? 'No repository open')}
          </span>
        )}
        <span className={styles.right}>
          {repoId && <WatchWarning repoId={repoId} />}
          <LastErrorIndicator />
          <button
            type="button"
            className={`${styles.sbButton} ${activityOpen ? styles.sbButtonOn : ''}`}
            aria-pressed={activityOpen}
            title="Activity: git commands and their output"
            onClick={() => toggleActivity()}
          >
            <ScrollText size={12} aria-hidden />
            Activity
          </button>
          <span className={styles.launchpad}>
            <LaunchpadStatusIndicator />
          </span>
          <ZoomSelector />
          <NotificationBell />
          {version.data && (
            <span className={styles.versions}>
              Git {version.data.git} · GitHappens {version.data.app}
            </span>
          )}
        </span>
      </footer>
    </>
  );
}
