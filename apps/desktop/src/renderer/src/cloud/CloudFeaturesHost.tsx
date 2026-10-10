import { useEffect } from 'react';

import type { CloudDeepLink } from '../../../shared/ipc/cloud-contract';
import { useSessionStore } from '../repo/sessions';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { openSuggestionView, SuggestModeBanner } from '../views/suggest';
import { cloudInvoke, cloudOn } from './api';

/** Repo of the active tab (where a suggestion opened from a link is applied). */
function activeRepoId(): string | undefined {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab?.kind !== 'repo' || !tab.repoPath) return undefined;
  const key = tab.repoPath.replace(/\\/g, '/').toLowerCase();
  const session = useSessionStore.getState().byPath[key];
  return session?.state === 'ready' ? session.repoId : undefined;
}

function openSuggestionLink(link: Extract<CloudDeepLink, { kind: 'suggestion' }>): void {
  const repoId = activeRepoId();
  if (!repoId) {
    useToastStore.getState().push({
      kind: 'info',
      title: 'Open the repository first',
      body: 'Open the repository the code suggestion belongs to, then open the link again.',
    });
    return;
  }
  void openSuggestionView({ repoId, url: link.url });
}

/**
 * App-level host for the spec 14 extras: the Suggest-mode banner (active tab is a suggestion worktree)
 * and `githappens://suggestion/<id>#k=` deep links. Mount once in App: `<CloudFeaturesHost />`.
 */
export function CloudFeaturesHost() {
  useEffect(() => {
    let live = true;
    void cloudInvoke('cloud:takeDeepLinks', { kinds: ['suggestion'] })
      .then((links) => {
        if (!live) return;
        for (const l of links) if (l.kind === 'suggestion') openSuggestionLink(l);
      })
      .catch(() => undefined);
    const off = cloudOn('cloud:deepLink', (link) => {
      if (link.kind !== 'suggestion') return;
      // consume it so a later mount does not open it twice
      void cloudInvoke('cloud:takeDeepLinks', { kinds: ['suggestion'] }).catch(() => undefined);
      openSuggestionLink(link);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return <SuggestModeBanner />;
}
