import type { ClassifiedItem, PrNotification } from '@githappens/launchpad';

import type { ToastInput } from '../notifications/toast-model';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { lpOn } from './api';

/**
 * Pull request notifications (spec 13 `notifications.prEvents`). Main diffs every background
 * Launchpad refresh and sends `launchpad:prNotifications` (→ one toast each, "Open" opens the PR or,
 * for a batch, the Launchpad) and `launchpad:openNotification` when its OS notification is clicked.
 * Imported once by ToastHost (always mounted).
 */

/** Open a notified PR like a Launchpad row (PR view in its repo, else the browser); batch → Launchpad. */
export function openPrNotification(item: ClassifiedItem | undefined): void {
  if (!item) {
    useTabsStore.getState().openLaunchpad({ tab: 'prs', mode: 'personal' });
    return;
  }
  // Lazy: the row actions pull in dialogs and PR views the toast host doesn't otherwise need.
  void import('./actions').then((m) => m.openItem(item)).catch(() => undefined);
}

/** Toast for one notification (pure, unit-tested). */
export function prToast(n: PrNotification, open: (item?: ClassifiedItem) => void): ToastInput {
  return {
    kind: n.kind === 'checks-failed' ? 'warning' : 'info',
    key: `pr-event:${n.id}`,
    title: n.title,
    body: n.body,
    actions: [{ label: n.item ? 'Open' : 'Open Launchpad', run: () => open(n.item) }],
  };
}

const hasBridge = typeof window !== 'undefined' && !!(window as { api?: unknown }).api;
if (hasBridge) {
  lpOn('launchpad:prNotifications', ({ notifications }) => {
    for (const n of notifications) useToastStore.getState().push(prToast(n, openPrNotification));
  });
  lpOn('launchpad:openNotification', ({ item }) => openPrNotification(item));
}
