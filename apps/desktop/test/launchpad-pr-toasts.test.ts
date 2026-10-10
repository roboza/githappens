import type { PrNotification } from '@githappens/launchpad';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as Mod from '../src/renderer/src/launchpad/pr-notifications';
import type * as Tabs from '../src/renderer/src/stores/tabs';
import type * as Toasts from '../src/renderer/src/stores/toasts';

/** Renderer side of PR notifications: `launchpad:prNotifications` → toasts; clicks open the PR / Launchpad. */

const listeners = new Map<string, (p: unknown) => void>();
let mod: typeof Mod;
let toasts: typeof Toasts;
let tabs: typeof Tabs;

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: {
      invoke: async () => ({ ok: true, data: null }),
      on: (e: string, cb: (p: unknown) => void) => {
        listeners.set(e, cb);
        return () => undefined;
      },
      platform: 'linux',
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
  mod = await import('../src/renderer/src/launchpad/pr-notifications');
  toasts = await import('../src/renderer/src/stores/toasts');
  tabs = await import('../src/renderer/src/stores/tabs');
});

const single: PrNotification = {
  id: 'pr:x|checks-failed|a',
  kind: 'checks-failed',
  title: 'Checks failed: acme/app#2',
  body: 'PR 2',
  count: 1,
  item: { uid: 'pr:x' } as PrNotification['item'],
};
const batch: PrNotification = {
  id: 'batch|k|4',
  kind: 'batch',
  title: '4 pull requests need attention',
  count: 4,
};

describe('PR notification toasts', () => {
  it('prToast: one toast per notification with an Open action', () => {
    const open = vi.fn();
    const t = mod.prToast(single, open);
    expect(t).toMatchObject({ kind: 'warning', key: 'pr-event:pr:x|checks-failed|a', title: single.title });
    t.actions![0]!.run();
    expect(open).toHaveBeenCalledWith(single.item);
    const b = mod.prToast(batch, open);
    expect(b.kind).toBe('info');
    expect(b.actions![0]!.label).toBe('Open Launchpad');
  });

  it('launchpad:prNotifications pushes toasts', () => {
    listeners.get('launchpad:prNotifications')!({ notifications: [single, batch] });
    const titles = toasts.useToastStore.getState().toasts.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining([single.title, batch.title]));
  });

  it('launchpad:openNotification without an item opens the Launchpad PR tab', () => {
    const spy = vi.spyOn(tabs.useTabsStore.getState(), 'openLaunchpad').mockImplementation(() => undefined);
    listeners.get('launchpad:openNotification')!({ id: batch.id });
    expect(spy).toHaveBeenCalledWith({ tab: 'prs', mode: 'personal' });
  });
});
