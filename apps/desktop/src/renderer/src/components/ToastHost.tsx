import '../notifications/settings-bridge';
import '../launchpad/pr-notifications';

import { DetailsModal } from '../notifications/DetailsModal';
import { visibleToasts, type Toast } from '../notifications/toast-model';
import { useSetting } from '../stores/settings';
import { useToastStore } from '../stores/toasts';
import styles from './ToastHost.module.css';

const LOCATION_CLASS = {
  'bottom-left': styles.bottomLeft,
  'bottom-right': styles.bottomRight,
  'top-left': styles.topLeft,
  'top-right': styles.topRight,
} as const;

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className={`${styles.toast} ${styles[t.kind] ?? ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
      <div className={styles.body}>
        <strong>
          {t.title}
          {t.count > 1 && (
            <span className={styles.count} aria-label={`${t.count} times`}>
              ×{t.count}
            </span>
          )}
        </strong>
        {t.body && <p>{t.body}</p>}
        {!!t.actions?.length && (
          <div className={styles.actions}>
            {t.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className={styles.action}
                onClick={() => {
                  if (!a.keepOpen) dismiss(t.id);
                  void Promise.resolve(a.run()).catch(() => undefined);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        ×
      </button>
    </div>
  );
}

/**
 * Toast stack (spec 01 §4.10): location from `ui.notificationLocation`, max 4 visible, identical toasts
 * coalesced (×N), up to two action buttons, and the "Details" modal.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const location = useSetting('ui.notificationLocation') ?? 'bottom-left';
  const shown = visibleToasts(toasts);
  const top = location.startsWith('top');
  return (
    <>
      <div
        className={`${styles.host} ${LOCATION_CLASS[location] ?? styles.bottomLeft}`}
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {(top ? [...shown].reverse() : shown).map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </div>
      <DetailsModal />
    </>
  );
}
