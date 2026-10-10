import type { RepoId } from '@githappens/git/types';

import { hasExperiment } from '../../../../../shared/settings/registry';
import { useSessionStore } from '../../../repo/sessions';
import { prefsInvoke, prefsOn, useSettingsStore } from '../../../stores/settings';

/**
 * Per-repo display encoding for the blob / file readers (spec 13 §6 "Encoding"). Returns the
 * `TextDecoder` label to use for files that are not valid UTF-8, or undefined for the default
 * behaviour (Latin-1, read-only). Gated by the `repoDisplayEncoding` experiment.
 */
const cache = new Map<string, Promise<string | undefined>>();

prefsOn('repoSettings:changed', () => cache.clear());

/** Absolute path of an open repository (worktree root, or git dir for bare repos). */
export function repoPathFor(repoId: RepoId): string | undefined {
  for (const s of Object.values(useSessionStore.getState().byPath)) {
    if (s.state === 'ready' && s.repoId === repoId) return s.info.worktreeRoot ?? s.info.gitDir;
  }
  return undefined;
}

export function displayEncodingFor(repoId: RepoId): Promise<string | undefined> {
  const flags = useSettingsStore.getState().values?.['experimental.flags'];
  if (!hasExperiment(flags, 'repoDisplayEncoding')) return Promise.resolve(undefined);
  const repoPath = repoPathFor(repoId);
  if (!repoPath) return Promise.resolve(undefined);
  let p = cache.get(repoPath);
  if (!p) {
    p = prefsInvoke('repoSettings:get', { repoPath })
      .then((r) => (r.encoding && r.encoding !== 'utf-8' ? r.encoding : undefined))
      .catch(() => undefined);
    cache.set(repoPath, p);
  }
  return p;
}
