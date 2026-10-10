import { AlertCircle, Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { formatTime } from '../lib/format';
import { useToastStore } from '../stores/toasts';
import { lastError, unreadCount } from './toast-model';
import styles from './Notifications.module.css';

/** Status bar bell (spec 01 §4.10 notification center): recent notifications with an unread badge. */
export function NotificationBell() {
  const history = useToastStore((s) => s.history);
  const markAllRead = useToastStore((s) => s.markAllRead);
  const clear = useToastStore((s) => s.clearHistory);
  const showDetails = useToastStore((s) => s.showDetails);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = unreadCount(history);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      markAllRead();
    };
  }, [open, markAllRead]);

  return (
    <div className={styles.bellWrap} ref={ref}>
      <button
        type="button"
        className={styles.sbButton}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={12} />
        {unread > 0 && <span className={styles.unread}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className={styles.center} role="dialog" aria-label="Notification center">
          <header className={styles.centerHead}>
            <strong>Notifications</strong>
            {history.length > 0 && (
              <button type="button" className={styles.linkBtn} onClick={clear}>
                Clear all
              </button>
            )}
          </header>
          {history.length === 0 ? (
            <p className={styles.empty}>No notifications yet.</p>
          ) : (
            <ul className={styles.centerList}>
              {history.map((n) => (
                <li
                  key={n.id}
                  className={`${styles.item} ${styles[n.kind] ?? ''} ${n.read ? '' : styles.itemUnread}`}
                >
                  <div className={styles.itemHead}>
                    <span className={styles.itemTitle}>
                      {n.title}
                      {n.count > 1 && <span className={styles.itemCount}>×{n.count}</span>}
                    </span>
                    <time className={styles.itemTime}>{formatTime(n.at)}</time>
                  </div>
                  {n.body && <p className={styles.itemBody}>{n.body}</p>}
                  {n.details && (
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => {
                        setOpen(false);
                        showDetails(n);
                      }}
                    >
                      Details
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Last error in the status bar (spec 01 AC7); click opens its details. */
export function LastErrorIndicator() {
  const history = useToastStore((s) => s.history);
  const showDetails = useToastStore((s) => s.showDetails);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const err = lastError(history, Math.max(now, history[0]?.at ?? 0));
  if (!err) return null;
  return (
    <button
      type="button"
      className={`${styles.sbButton} ${styles.lastError}`}
      title={`Last error (${formatTime(err.at)}): ${err.title}`}
      onClick={() => showDetails(err)}
    >
      <AlertCircle size={12} />
      <span className={styles.lastErrorText}>{err.title}</span>
    </button>
  );
}
