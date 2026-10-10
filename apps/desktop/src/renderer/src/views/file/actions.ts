import type { RepoId } from '@githappens/git/types';

import { prompt } from '../../components/Dialogs';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useToastStore } from '../../stores/toasts';
import { filesInvoke } from './files-api';

/** "New file…" (spec 07 §4.11): create an empty file at a chosen path and open it in the editor. */
export async function createNewFile(repoId: RepoId, dir = ''): Promise<void> {
  const r = await prompt({
    title: 'New file',
    label: 'Path relative to the repository root',
    initial: dir ? `${dir.replace(/\/+$/, '')}/` : '',
    okLabel: 'Create',
    validate: (v) =>
      !v.trim()
        ? 'Enter a file name.'
        : /(^|[\\/])\.\.([\\/]|$)/.test(v) || /^([a-zA-Z]:|[\\/])/.test(v)
          ? 'The path must stay inside the repository.'
          : /[\\/]$/.test(v)
            ? 'Enter a file name, not a folder.'
            : null,
  });
  if (!r) return;
  const path = r.value.trim().replace(/\\/g, '/');
  try {
    await filesInvoke('fs:createFile', { repoId, path });
  } catch (e) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not create the file', body: (e as Error).message });
    return;
  }
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'file', path, mode: 'edit' } }));
}
