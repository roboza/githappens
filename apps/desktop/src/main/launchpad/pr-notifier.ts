import path from 'node:path';

import {
  diffPrEvents,
  parsePrNotifyState,
  planPrNotifications,
  PR_NOTIFY_MAX_INDIVIDUAL,
  type ClassifiedItem,
  type PrNotification,
  type PrNotifyState,
} from '@githappens/launchpad';

import type { LaunchpadEventContract } from '../../shared/ipc/launchpad-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/** What the app provides for PR notifications (wired in `main/index.ts`). */
export interface PrNotificationDeps {
  /** `notifications.prEvents`. Off → nothing at all. */
  enabled(): boolean;
  /** `notifications.desktop`: OS notifications (the in-app toast doesn't depend on it). */
  desktopEnabled(): boolean;
  /** Electron `net.isOnline()`; offline → no events (§6.5: no requests while offline). */
  isOnline(): boolean;
  /** Any app window focused (no OS notification then; the toast is enough). */
  isFocused(): boolean;
  /** `new Notification({ title, body }).show()`; false when `Notification.isSupported()` is false. */
  showNotification(n: { title: string; body?: string; onClick?: () => void }): boolean;
  /** Bring the main window to the front (notification click). */
  focusWindow?(): void;
  /** Batch threshold (default 3). */
  maxIndividual?: number;
  /**
   * `launchpad.refreshMinutes`: interval of the main-process background refresh that keeps PR
   * notifications flowing while the renderer's polling is paused (blurred window). Floor 3 min.
   */
  refreshMinutes?(): number;
}

export interface PrNotifierOptions extends PrNotificationDeps {
  profileDir(): string;
  emit<E extends keyof LaunchpadEventContract>(event: E, payload: LaunchpadEventContract[E]): void;
  now(): number;
}

export const PR_NOTIFY_FILE = 'launchpad-notifications.json';

/** List fields only: notification payloads don't need PR / issue bodies. */
function slim(item: ClassifiedItem): ClassifiedItem {
  if (item.type === 'pr') return { ...item, pr: { ...item.pr, body: '' } };
  if (item.type === 'issue') return { ...item, issue: { ...item.issue, body: '' } };
  return item;
}

/**
 * Pull request notifications (spec 13 `notifications.prEvents`): diffs each personal Launchpad
 * refresh against the snapshot persisted per profile (`launchpad-notifications.json`, so a restart
 * doesn't re-notify), then shows an in-app toast (renderer, `launchpad:prNotifications`) and — when
 * unfocused and `notifications.desktop` is on — an OS notification whose click focuses the app and
 * opens the PR (`launchpad:openNotification`). Pure rules live in `@githappens/launchpad` notify.ts.
 */
export class PrNotifier {
  private cache: { dir: string; state: PrNotifyState | null } | null = null;

  constructor(private readonly o: PrNotifierOptions) {}

  private get file(): string {
    return path.join(this.o.profileDir(), PR_NOTIFY_FILE);
  }

  private load(): PrNotifyState | null {
    const dir = this.o.profileDir();
    if (this.cache?.dir !== dir) {
      const r = readJson<unknown>(path.join(dir, PR_NOTIFY_FILE));
      this.cache = { dir, state: r.kind === 'ok' ? parsePrNotifyState(r.value) : null };
    }
    return this.cache.state;
  }

  private save(state: PrNotifyState): void {
    this.cache = { dir: this.o.profileDir(), state };
    try {
      writeFileAtomic(this.file, JSON.stringify(state));
    } catch {
      /* best effort: worst case a restart re-baselines silently */
    }
  }

  private safe(fn: () => boolean): boolean {
    try {
      return fn();
    } catch {
      return false;
    }
  }

  /**
   * After a personal refresh. `okAccounts` = accounts whose PR source succeeded. Returns what was
   * notified (tests).
   */
  onRefresh(items: readonly ClassifiedItem[], okAccounts: readonly string[]): PrNotification[] {
    // Offline: no events and no snapshot update (the next online refresh diffs against the old one).
    if (!this.safe(() => this.o.isOnline())) return [];
    const silent = !this.safe(() => this.o.enabled());
    const { state, events, changed } = diffPrEvents(this.load(), {
      items,
      okAccounts,
      now: this.o.now(),
      silent,
    });
    if (changed) this.save(state);
    if (silent || !events.length) return [];
    const planned = planPrNotifications(events, this.o.maxIndividual ?? PR_NOTIFY_MAX_INDIVIDUAL).map((n) =>
      n.item ? { ...n, item: slim(n.item) } : n,
    );
    this.o.emit('launchpad:prNotifications', { notifications: planned });
    if (this.safe(() => this.o.desktopEnabled()) && !this.safe(() => this.o.isFocused())) {
      for (const n of planned) {
        try {
          this.o.showNotification({
            title: n.title,
            body: n.body,
            onClick: () => {
              this.o.focusWindow?.();
              this.o.emit('launchpad:openNotification', { id: n.id, ...(n.item ? { item: n.item } : {}) });
            },
          });
        } catch {
          /* unsupported platform */
        }
      }
    }
    return planned;
  }
}
