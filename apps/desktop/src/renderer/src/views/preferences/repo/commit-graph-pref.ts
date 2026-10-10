import type { RepoId } from '@githappens/git/types';

import type { ToastInput } from '../../../notifications/toast-model';

/**
 * "Write commit-graph on fetch" (spec 02 §6.15.1: offer `git config fetch.writeCommitGraph true` as an
 * opt-in checkbox). A repository-local setting, written through the queued `config.set` op
 * (`git:config:set` with a repoId) and read back with `git:config:get --local`.
 */

export const WRITE_ON_FETCH_KEY = 'fetch.writeCommitGraph';

type ConfigInvoke = {
  (channel: 'git:config:get', req: { repoId: RepoId; key: string; scope: 'local' }): Promise<string | null>;
  (
    channel: 'git:config:set',
    req: { repoId: RepoId; key: string; value: string | null; scope: 'local' },
  ): Promise<void>;
};

/** git's boolean config syntax (`true`/`yes`/`on`/`1`; a bare key is true). */
export function gitBool(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return /^(true|yes|on|1|)$/i.test(value.trim());
}

export async function readWriteOnFetch(invoke: ConfigInvoke, repoId: RepoId): Promise<boolean> {
  return gitBool(await invoke('git:config:get', { repoId, key: WRITE_ON_FETCH_KEY, scope: 'local' }));
}

/** On: `fetch.writeCommitGraph=true` in .git/config; off: the key is removed (git's default, false). */
export async function setWriteOnFetch(invoke: ConfigInvoke, repoId: RepoId, on: boolean): Promise<void> {
  await invoke('git:config:set', {
    repoId,
    key: WRITE_ON_FETCH_KEY,
    value: on ? 'true' : null,
    scope: 'local',
  });
}

/**
 * Completion toast of the background commit-graph write (spec 02 §6.15.1 "a non-blocking toast reports
 * completion"), offering the write-on-fetch opt-in when it is not on yet.
 */
export function commitGraphWrittenToast(o: {
  repoName?: string;
  writeOnFetch: boolean;
  enableWriteOnFetch: () => Promise<void>;
}): ToastInput {
  return {
    kind: 'success',
    key: `commit-graph-written:${o.repoName ?? ''}`,
    title: 'Commit-graph written',
    body: `${o.repoName ? `${o.repoName}: the` : 'The'} graph now loads faster.${
      o.writeOnFetch
        ? ''
        : ' Git can keep it up to date on every fetch (Repository Preferences › Performance).'
    }`,
    timeoutMs: 8000,
    ...(o.writeOnFetch ? {} : { actions: [{ label: 'Update on fetch', run: o.enableWriteOnFetch }] }),
  };
}
