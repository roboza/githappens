import { create } from 'zustand';

import type { ToastSpec } from '../../../shared/ipc/app-contract';
import { on } from '../lib/api';
import {
  addToast,
  timeoutOf,
  type NotificationEntry,
  type Toast,
  type ToastInput,
} from '../notifications/toast-model';

export type {
  NotificationEntry,
  Toast,
  ToastAction,
  ToastDetails,
  ToastInput,
} from '../notifications/toast-model';

interface ToastState {
  toasts: Toast[];
  /** Notification center (status bar bell): recent notifications, newest first. */
  history: NotificationEntry[];
  push(t: ToastInput): string;
  dismiss(id: string): void;
  markAllRead(): void;
  clearHistory(): void;
  /** Toast whose "Details" are open (modal), if any. */
  detailsFor: NotificationEntry | Toast | null;
  showDetails(t: NotificationEntry | Toast | null): void;
}

let seq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  history: [],
  detailsFor: null,
  push(t) {
    const { model, id } = addToast(
      { toasts: get().toasts, history: get().history },
      t,
      () => `toast-${++seq}`,
      Date.now(),
    );
    set(model);
    const old = timers.get(id);
    if (old) clearTimeout(old);
    timers.delete(id);
    const timeout = timeoutOf(t);
    if (timeout) {
      timers.set(
        id,
        setTimeout(() => get().dismiss(id), timeout),
      );
    }
    return id;
  },
  dismiss(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
  markAllRead() {
    set((s) => ({ history: s.history.map((e) => (e.read ? e : { ...e, read: true })) }));
  },
  clearHistory() {
    set({ history: [] });
  },
  showDetails(t) {
    set({ detailsFor: t });
  },
}));

/** Main-initiated toasts (`shell:toast`). */
on('shell:toast', (t: ToastSpec) => useToastStore.getState().push(t));
