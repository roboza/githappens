import { choose } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { useSettingsStore } from '../../stores/settings';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import { errorText, reposInvoke } from './api';

/**
 * Open a folder as a repo tab with the spec 03 recovery flows instead of an error toast:
 *  - not a repository → "Initialize a repository here?" (non-destructive `git init`, existing files kept);
 *  - dubious ownership → explicit consent to `git config --global --add safe.directory <path>` (the exact
 *    command is shown);
 *  - missing folder → toast.
 * Resolves true when a tab was opened / activated.
 */
export async function openRepoWithRecovery(path: string): Promise<boolean> {
  const toast = useToastStore.getState().push;
  let v;
  try {
    v = await reposInvoke('repos:validate', { path });
  } catch {
    // Main not wired for repos:validate yet (or failed): fall back to the plain open.
    return useTabsStore.getState().openRepo(path);
  }
  if (v.ok) return useTabsStore.getState().openRepo(v.repo.path);

  if (v.reason === 'notARepo') {
    const r = await choose({
      title: 'Not a Git repository',
      message: (
        <>
          <code>{v.path}</code> is not a Git repository. Initialize a new repository in this folder? Existing
          files are kept and nothing is committed.
        </>
      ),
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'init', label: 'Initialize here', primary: true },
      ],
    });
    if (r?.value !== 'init') return false;
    const sep = Math.max(v.path.lastIndexOf('/'), v.path.lastIndexOf('\\'));
    const head = v.path.slice(0, sep);
    const parentDir = /^[a-z]:$/i.test(head) ? `${head}\\` : head || '/';
    const name = v.path.slice(sep + 1);
    const branch =
      String(useSettingsStore.getState().values?.['general.defaultBranchName'] ?? '').trim() || 'main';
    try {
      const res = await reposInvoke('repos:init2', {
        parentDir,
        name,
        defaultBranch: branch,
        gitignoreTemplates: [],
        createReadme: false,
        initialCommit: false,
        bare: false,
      });
      return useTabsStore.getState().openRepo(res.path);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not initialize repository', body: errorText(e) });
      return false;
    }
  }

  if (v.reason === 'unsafeDirectory' && v.safeDirectory) {
    const sd = v.safeDirectory;
    const r = await choose({
      title: 'Repository owned by another user',
      message: (
        <>
          Git refuses to open <code>{v.path}</code> because it is owned by a different user (a protection
          against CVE-2022-24765). If you trust this folder, GitHappens can add it to your global Git
          configuration by running:
          <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
            <code>{sd.command}</code>
          </pre>
          This changes your global <code>~/.gitconfig</code> and applies to every Git tool on this machine.
        </>
      ),
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'trust', label: 'Trust and open', primary: true },
      ],
    });
    if (r?.value !== 'trust') return false;
    try {
      await reposInvoke('repos:safeDirectory:add', { path: sd.path });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not update safe.directory', body: errorText(e) });
      return false;
    }
    return useTabsStore.getState().openRepo(v.path);
  }

  toast({ kind: 'error', title: 'Could not open repository', body: v.message });
  return false;
}

/** Browse for a folder, then open it with the recovery flows. */
export async function browseAndOpen(): Promise<boolean> {
  const dir = await invoke('repos:pickFolder', {});
  return dir ? openRepoWithRecovery(dir) : false;
}
