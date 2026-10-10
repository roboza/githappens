import { Building2, Check, LogIn, LogOut, RefreshCw, Settings, UserRound, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { SyncStatus } from '../../../../shared/ipc/cloud-contract';
import { UserAvatar } from '../../integrations/ui';
import { useToastStore } from '../../stores/toasts';
import { cloudErrorText, cloudInvoke, openPreferencesAt, relativeTime } from '../../cloud/api';
import { useCloudStatus, useSyncStatus } from '../../cloud/queries';
import s from './Account.module.css';
import { InviteHandler } from './InviteHandler';

/** One-line sync summary for the account menu ("Synced 2m ago", "Sync paused — enter passphrase"). */
export function syncSummary(
  st: SyncStatus | undefined,
  now = Date.now(),
): { text: string; tone: 'ok' | 'warn' | 'error' } | null {
  if (!st?.available || !st.enabled) return null;
  if (st.conflicts.length) return { text: 'Sync conflicts need your attention', tone: 'warn' };
  switch (st.state) {
    case 'syncing':
      return { text: 'Syncing…', tone: 'ok' };
    case 'locked':
      return {
        text: st.keyState === 'missing' ? 'Set up a sync passphrase' : 'Sync locked — enter your passphrase',
        tone: 'warn',
      };
    case 'error':
      return { text: st.error ?? 'Sync failed', tone: 'error' };
    default:
      return {
        text: st.lastSyncAt ? `Synced ${relativeTime(st.lastSyncAt, now)}` : 'Not synced yet',
        tone: 'ok',
      };
  }
}

const toast = (title: string, body?: string): void =>
  void useToastStore.getState().push({ kind: 'error', title, body });

/**
 * Title-bar account entry (spec 14 §4.1): avatar → menu with name/email, org switcher, sync status,
 * Manage organization and Sign out; "Sign in" opens Preferences → Account. No network calls when no
 * server is configured (status comes from main over IPC).
 */
export function AccountButton() {
  const { data: status } = useCloudStatus();
  const session = status?.session ?? null;
  const { data: sync } = useSyncStatus(!!session);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
    };
  }, [open]);

  if (!status) return null;

  const summary = syncSummary(sync);
  const act = (fn: () => Promise<unknown>, failTitle: string) => () => {
    setOpen(false);
    void fn().catch((e: unknown) => toast(failTitle, cloudErrorText(e)));
  };

  if (!session) {
    return (
      <div className={s.anchor}>
        <InviteHandler />
        <button
          type="button"
          className={s.trigger}
          title={
            status.serverUrl ? 'Sign in to GitHappens Cloud' : 'Set up a GitHappens Cloud account (optional)'
          }
          onClick={() => openPreferencesAt('Account')}
          data-testid="account-sign-in"
        >
          {status.signingIn ? <RefreshCw size={14} aria-hidden /> : <LogIn size={14} aria-hidden />}
          <span>{status.signingIn ? 'Signing in…' : 'Sign in'}</span>
        </button>
      </div>
    );
  }

  const dotClass = !summary
    ? null
    : summary.tone === 'ok'
      ? s.dotOk
      : summary.tone === 'warn'
        ? s.dotWarn
        : s.dotError;
  const user = {
    login: session.user.email,
    name: session.user.name,
    email: session.user.email,
    avatarUrl: session.user.avatarUrl,
  };

  return (
    <div className={s.anchor} ref={ref}>
      <InviteHandler />
      <button
        type="button"
        className={s.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${session.user.name}`}
        title={`${session.user.name} <${session.user.email}>${status.offline ? ' — offline' : ''}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="account-button"
      >
        {status.offline && <WifiOff size={13} aria-label="Offline" />}
        {dotClass && <span className={dotClass} aria-hidden />}
        <UserAvatar user={user} size={20} />
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label="Account">
          <div className={s.menuHeader}>
            <UserAvatar user={user} size={32} />
            <div className={s.menuHeaderText}>
              <div className={s.menuName}>{session.user.name}</div>
              <div className={s.menuSub}>{session.user.email}</div>
              <div className={s.menuSub}>{session.serverUrl.replace(/^https?:\/\//, '')}</div>
            </div>
          </div>
          {status.offline && (
            <div className={s.menuStatus}>
              <WifiOff size={13} aria-hidden /> Offline — showing cached account data
            </div>
          )}
          {session.orgs.length > 0 && (
            <>
              <div className={s.menuSep} />
              <div className={s.menuLabel}>Organization</div>
              {session.orgs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={o.id === session.activeOrgId}
                  className={s.menuItem}
                  onClick={act(
                    () => cloudInvoke('cloud:setActiveOrg', { orgId: o.id }),
                    'Could not switch organization',
                  )}
                >
                  <Building2 size={14} aria-hidden />
                  <span>{o.name}</span>
                  {o.id === session.activeOrgId && <Check size={14} className={s.check} aria-hidden />}
                </button>
              ))}
            </>
          )}
          {summary && (
            <>
              <div className={s.menuSep} />
              <button
                type="button"
                role="menuitem"
                className={s.menuItem}
                title="Sync now"
                onClick={act(async () => {
                  if (sync?.state === 'locked' || sync?.conflicts.length) openPreferencesAt('Account');
                  else await cloudInvoke('sync:now', {});
                }, 'Sync failed')}
              >
                <RefreshCw size={14} aria-hidden />
                <span className={s.grow}>{summary.text}</span>
                {dotClass && <span className={dotClass} aria-hidden />}
              </button>
            </>
          )}
          <div className={s.menuSep} />
          <button
            type="button"
            role="menuitem"
            className={s.menuItem}
            onClick={act(async () => openPreferencesAt('Account'), '')}
          >
            <Settings size={14} aria-hidden />
            Account &amp; sync settings
          </button>
          <button
            type="button"
            role="menuitem"
            className={s.menuItem}
            onClick={act(async () => openPreferencesAt('Account'), '')}
          >
            <UserRound size={14} aria-hidden />
            Manage organization
          </button>
          <button
            type="button"
            role="menuitem"
            className={s.menuItem}
            onClick={act(() => cloudInvoke('cloud:signOut', {}), 'Could not sign out')}
          >
            <LogOut size={14} aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
