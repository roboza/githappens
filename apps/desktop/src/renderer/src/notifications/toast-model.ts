import type { ToastSpec } from '../../../shared/ipc/app-contract';

/** Pure toast / notification-center model (spec 01 §4.10); the Zustand store wraps it. */

export interface ToastAction {
  label: string;
  run(): void | Promise<void>;
  /** Keep the toast after the action (e.g. "Details"); default dismisses it. */
  keepOpen?: boolean;
}

/** What "Details" shows: the git command and its full output (spec 01 §4.10 "Show full output"). */
export interface ToastDetails {
  command?: string;
  output?: string;
  repoId?: string;
  opId?: string;
}

export interface ToastInput extends ToastSpec {
  /** Identical toasts (same key) coalesce into one with a ×N counter. Default: kind + title + body. */
  key?: string;
  /** Up to 2 buttons (spec 01 §4.10), e.g. Details / Retry / Undo. */
  actions?: ToastAction[];
  details?: ToastDetails;
}

export interface Toast extends ToastInput {
  id: string;
  key: string;
  count: number;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationEntry {
  id: string;
  key: string;
  kind: ToastSpec['kind'];
  title: string;
  body?: string;
  details?: ToastDetails;
  count: number;
  at: number;
  read: boolean;
}

export const MAX_VISIBLE = 4;
export const MAX_HISTORY = 100;
export const MAX_ACTIONS = 2;

export const DEFAULT_TIMEOUT: Record<ToastSpec['kind'], number | null> = {
  success: 4000,
  info: 6000,
  warning: 10_000,
  error: null, // errors stay until dismissed
  progress: null,
};

export const toastKey = (t: Pick<ToastInput, 'key' | 'kind' | 'title' | 'body'>): string =>
  t.key ?? `${t.kind}\u0000${t.title}\u0000${t.body ?? ''}`;

export const timeoutOf = (t: Pick<ToastSpec, 'kind' | 'timeoutMs'>): number | null =>
  t.timeoutMs === undefined ? DEFAULT_TIMEOUT[t.kind] : t.timeoutMs;

export interface ToastModel {
  toasts: Toast[];
  history: NotificationEntry[];
}

/**
 * Add a toast: an explicit `id` replaces that toast; otherwise an identical visible toast (same key)
 * is coalesced (count + 1, refreshed). Every non-progress toast is recorded in the notification
 * center history, also coalesced by key while it is unread.
 */
export function addToast(
  model: ToastModel,
  input: ToastInput,
  newId: () => string,
  now: number,
): { model: ToastModel; id: string; coalesced: boolean } {
  const key = toastKey(input);
  const actions = input.actions?.slice(0, MAX_ACTIONS);
  let toasts: Toast[];
  let id: string;
  let coalesced = false;
  const byId = input.id ? model.toasts.find((t) => t.id === input.id) : undefined;
  const same = byId ?? (input.id ? undefined : model.toasts.find((t) => t.key === key));
  if (same) {
    id = same.id;
    coalesced = !byId || same.key === key;
    const count = same.key === key ? same.count + 1 : 1;
    const updated: Toast = { ...same, ...input, actions, id, key, count, updatedAt: now };
    // move to the newest position so it stays visible
    toasts = [...model.toasts.filter((t) => t.id !== id), updated];
  } else {
    id = input.id ?? newId();
    toasts = [...model.toasts, { ...input, actions, id, key, count: 1, createdAt: now, updatedAt: now }];
  }

  let history = model.history;
  if (input.kind !== 'progress') {
    const h = history.find((e) => e.key === key && !e.read);
    if (h) {
      history = [
        {
          ...h,
          kind: input.kind,
          title: input.title,
          body: input.body,
          details: input.details ?? h.details,
          count: h.count + 1,
          at: now,
        },
        ...history.filter((e) => e !== h),
      ];
    } else {
      history = [
        {
          id: `n-${id}-${now}`,
          key,
          kind: input.kind,
          title: input.title,
          body: input.body,
          details: input.details,
          count: 1,
          at: now,
          read: false,
        },
        ...history,
      ].slice(0, MAX_HISTORY);
    }
  }
  return { model: { toasts, history }, id, coalesced };
}

/** Toasts shown on screen: the newest MAX_VISIBLE. */
export const visibleToasts = (toasts: Toast[]): Toast[] => toasts.slice(-MAX_VISIBLE);

export const unreadCount = (history: NotificationEntry[]): number => history.filter((e) => !e.read).length;

/** Newest unread-or-read error within `withinMs` (status bar last-error indicator, spec 01 AC7). */
export function lastError(
  history: NotificationEntry[],
  now: number,
  withinMs = 30 * 60_000,
): NotificationEntry | null {
  return history.find((e) => e.kind === 'error' && now - e.at <= withinMs) ?? null;
}
