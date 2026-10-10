import type { RepoId } from '@githappens/git/types';

import { invoke, on } from '../../../lib/api';
import { basename } from '../../../lib/format';
import { useSessionStore } from '../../../repo/sessions';
import { useToastStore } from '../../../stores/toasts';
import { commitGraphWrittenToast, readWriteOnFetch, setWriteOnFetch } from './commit-graph-pref';

const repoName = (repoId: RepoId): string | undefined => {
  for (const s of Object.values(useSessionStore.getState().byPath)) {
    if (s.state === 'ready' && s.repoId === repoId) {
      return basename(s.info.worktreeRoot ?? s.info.gitDir);
    }
  }
  return undefined;
};

/** Completion toast of the background `maintenance.commitGraph` op (spec 02 §6.15.1); installed once. */
on('git:op:state', (e) => {
  if (e.type !== 'maintenance.commitGraph' || e.state !== 'succeeded') return;
  const repoId = e.repoId;
  void readWriteOnFetch(invoke, repoId)
    .catch(() => true) // repo closed meanwhile: no opt-in offer
    .then((writeOnFetch) =>
      useToastStore.getState().push(
        commitGraphWrittenToast({
          repoName: repoName(repoId),
          writeOnFetch,
          enableWriteOnFetch: () =>
            setWriteOnFetch(invoke, repoId, true).catch((err: unknown) => {
              useToastStore.getState().push({
                kind: 'error',
                title: 'Could not set fetch.writeCommitGraph',
                body: err instanceof Error ? err.message : String(err),
              });
            }),
        }),
      ),
    );
});
