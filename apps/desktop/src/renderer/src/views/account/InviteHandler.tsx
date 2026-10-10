import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { confirm } from '../../components/Dialogs';
import { useToastStore } from '../../stores/toasts';
import { cloudErrorText, cloudInvoke, cloudOn, openPreferencesAt } from '../../cloud/api';
import { ck, useCloudStatus } from '../../cloud/queries';

/** Invite tokens from `githappens://invite/<token>` waiting for confirmation (spec 14 §6.7). */
const usePendingInvites = create<{ tokens: string[]; add(t: string[]): void; drop(t: string): void }>(
  (set) => ({
    tokens: [],
    add: (t) => set((s) => ({ tokens: [...new Set([...s.tokens, ...t])] })),
    drop: (t) => set((s) => ({ tokens: s.tokens.filter((x) => x !== t) })),
  }),
);

/**
 * Invite deep links → confirmation dialog → accept. Mounted once (by AccountButton in the title
 * bar). Links that arrived before the UI was ready are taken from main on mount.
 */
export function InviteHandler() {
  const qc = useQueryClient();
  const { data: status } = useCloudStatus();
  const tokens = usePendingInvites((s) => s.tokens);
  const busy = useRef(false);
  const warnedSignedOut = useRef(false);

  useEffect(() => {
    const take = (): void =>
      void cloudInvoke('cloud:takeDeepLinks', { kinds: ['invite'] })
        .then((links) => {
          const t = links.flatMap((l) => (l.kind === 'invite' ? [l.token] : []));
          if (t.length) usePendingInvites.getState().add(t);
        })
        .catch(() => undefined);
    take();
    return cloudOn('cloud:deepLink', (link) => {
      if (link.kind === 'invite') take();
    });
  }, []);

  const signedIn = !!status?.session;
  useEffect(() => {
    const token = tokens[0];
    if (!token || busy.current) return;
    if (!signedIn) {
      if (!warnedSignedOut.current) {
        warnedSignedOut.current = true;
        useToastStore.getState().push({
          kind: 'info',
          title: 'Sign in to accept the invitation',
          body: 'Sign in to GitHappens Cloud in Preferences → Account; the invitation will be offered again.',
        });
        openPreferencesAt('Account');
      }
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        const ok = await confirm(
          'Join organization?',
          `You were invited to an organization on ${status?.session?.serverUrl ?? 'your cloud server'}. Joining shares your name and email with its members.`,
          'Accept invitation',
        );
        usePendingInvites.getState().drop(token);
        if (!ok) return;
        const org = await cloudInvoke('org:acceptInvite', { token });
        await cloudInvoke('cloud:setActiveOrg', { orgId: org.id }).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: ck.status() });
        useToastStore.getState().push({ kind: 'success', title: `You joined ${org.name}` });
      } catch (e) {
        useToastStore.getState().push({
          kind: 'error',
          title: 'Could not accept the invitation',
          body: cloudErrorText(e),
        });
      } finally {
        busy.current = false;
        warnedSignedOut.current = false;
        // Re-run for any invitation that arrived meanwhile.
        usePendingInvites.setState((s) => ({ tokens: [...s.tokens] }));
      }
    })();
  }, [tokens, signedIn, status?.session?.serverUrl, qc]);

  return null;
}
