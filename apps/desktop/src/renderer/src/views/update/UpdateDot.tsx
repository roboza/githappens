import { useUpdateStatus } from './update-api';
import styles from './Update.module.css';

/** Class for the button hosting an {@link UpdateDot} (it is absolutely positioned). */
export const updateDotHost = styles.dotHost;

/**
 * Persistent "update ready" marker (spec 15 §4): shown on the app menu / Preferences buttons while a
 * downloaded update waits for a restart — it stays after the toast is dismissed with "Later".
 */
export function UpdateDot() {
  const status = useUpdateStatus();
  if (status?.state !== 'ready') return null;
  return (
    <span
      className={styles.dot}
      data-testid="update-dot"
      title={`Version ${status.version ?? ''} is ready — restart to update`}
    />
  );
}
