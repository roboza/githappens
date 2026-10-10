import type { RepoId } from '@githappens/git/types';
import { useState } from 'react';

import { runOp } from '../../lib/ops';
import { Field, FormDialog } from '../remotes/FormDialog';
import { validateRemoteUrl } from '../remotes/remote-model';
import { submodulePathFromUrl, validateSubmodulePath } from './submodule-model';

/** Add Submodule (spec 09 §4.3): URL, path (relative, inside the repo), optional branch. */
export function AddSubmoduleDialog({ repoId, onClose }: { repoId: RepoId; onClose(): void }) {
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [branch, setBranch] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const effectivePath = pathEdited ? path : submodulePathFromUrl(url);
  const urlError = validateRemoteUrl(url);
  const pathError = validateSubmodulePath(effectivePath);
  const branchError = branch && /^-|[\s~^:?*[\\]|\.\./.test(branch.trim()) ? 'Invalid branch name.' : null;

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (urlError || pathError || branchError) return;
    setBusy(true);
    try {
      await runOp(
        repoId,
        {
          type: 'submodule.add',
          url: url.trim(),
          path: effectivePath.trim(),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
        },
        {
          successToast: `Added submodule ${effectivePath.trim()} — commit .gitmodules and the new path to record it`,
        },
      );
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title="Add submodule"
      okLabel="Add submodule"
      onCancel={onClose}
      onSubmit={() => void submit()}
      busy={busy}
    >
      <Field label="Repository URL" error={touched || url ? urlError : null}>
        <input
          type="text"
          autoFocus
          value={url}
          placeholder="https://github.com/owner/lib.git"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field
        label="Path"
        hint="Relative to the repository root"
        error={touched || pathEdited ? pathError : null}
      >
        <input
          type="text"
          value={effectivePath}
          spellCheck={false}
          onChange={(e) => {
            setPathEdited(true);
            setPath(e.target.value);
          }}
        />
      </Field>
      <Field label="Branch (optional)" hint="Tracked by “Update to latest remote”" error={branchError}>
        <input type="text" value={branch} spellCheck={false} onChange={(e) => setBranch(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

/** Edit Submodule URL (spec 09 §6.9): `submodule.setUrl` (set-url + sync, stages `.gitmodules`). */
export function SubmoduleUrlDialog({
  repoId,
  path,
  url: initial,
  onClose,
}: {
  repoId: RepoId;
  path: string;
  url: string;
  onClose(): void;
}) {
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const error = validateRemoteUrl(url);
  const submit = async (): Promise<void> => {
    if (error) return;
    setBusy(true);
    try {
      await runOp(
        repoId,
        { type: 'submodule.setUrl', path, url: url.trim() },
        { successToast: `Changed the URL of ${path} (.gitmodules staged)` },
      );
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      title={`Edit URL of ${path}`}
      okLabel="Save"
      onCancel={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      okDisabled={url.trim() === initial}
    >
      <Field
        label="Repository URL"
        error={url ? error : null}
        hint="Updates .gitmodules and syncs the submodule's remote"
      >
        <input
          type="text"
          autoFocus
          value={url}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
