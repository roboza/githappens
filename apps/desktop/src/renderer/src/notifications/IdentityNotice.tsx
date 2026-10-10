import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';

import { useSettingsStore } from '../stores/settings';
import { behaviourInvoke } from './api';
import styles from './Notifications.module.css';

const openProfiles = (): void => {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Profiles' }));
};

const who = (name?: string, email?: string): string =>
  [name, email ? `<${email}>` : ''].filter(Boolean).join(' ') || 'nobody';

/**
 * Commit composer identity notice (spec 13 §6/§8): repo-local `user.*` overrides the profile, or the
 * profile has no name/email (prompt to fix it).
 */
export function IdentityNotice({ repoId }: { repoId: RepoId }) {
  const profile = useSettingsStore((s) => s.profile);
  const status = useQuery({
    queryKey: ['identity:status', repoId, profile?.id, profile?.authorName, profile?.authorEmail],
    queryFn: () => behaviourInvoke('identity:status', { repoId }),
    staleTime: 15_000,
    retry: false,
  });
  const st = status.data;
  if (!st) return null;
  if (st.overridden) {
    return (
      <div className={styles.identityNotice} role="note">
        <span>
          This repository overrides your profile identity. Commits use{' '}
          <strong>{who(st.effective.name, st.effective.email)}</strong> (repository config).
        </span>
      </div>
    );
  }
  if (st.profileIncomplete) {
    const missing = !st.effective.name || !st.effective.email;
    return (
      <div className={styles.identityNotice} role={missing ? 'alert' : 'note'}>
        <span>
          {missing ? (
            <>
              Your profile has no {!st.profile.name ? 'name' : 'email'} and git has none either: commits will
              fail.
            </>
          ) : (
            <>
              Your profile has no{' '}
              {!st.profile.name && !st.profile.email ? 'name or email' : !st.profile.name ? 'name' : 'email'};
              commits use <strong>{who(st.effective.name, st.effective.email)}</strong> from git config.
            </>
          )}
        </span>
        <button type="button" onClick={openProfiles}>
          Set identity…
        </button>
      </div>
    );
  }
  return null;
}
