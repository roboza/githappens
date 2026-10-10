import { FolderSearch, TriangleAlert } from 'lucide-react';

import { invoke } from '../lib/api';
import { useTabsStore } from '../stores/tabs';
import { requestCloseTab } from './tab-actions';
import { normPath } from './tab-model';
import styles from './ShellHost.module.css';

const MISSING_CODES = new Set(['NotARepository', 'RepositoryNotFound']);

/** Whether a repo-open failure means the folder is gone / no longer a repository. */
export function isMissingRepoError(code: string | undefined, message = ''): boolean {
  return (
    (!!code && MISSING_CODES.has(code)) ||
    /ENOENT|no such file|cannot find the path|does not exist/i.test(message)
  );
}

/** "Repository not found" tab state (spec 01 §8): Locate… points the tab at the new folder; Remove closes it. */
export function MissingRepo({ path, message }: { path: string; message: string }) {
  const tabId = useTabsStore(
    (s) =>
      s.tabs.find((t) => t.id === s.activeTabId && t.repoPath && normPath(t.repoPath) === normPath(path))?.id,
  );
  return (
    <div className={styles.missing} role="alert">
      <TriangleAlert size={28} className={styles.warnIcon} aria-hidden />
      <h2>Repository not found</h2>
      <p className="mono">{path}</p>
      <p className={styles.muted}>{message}</p>
      <div className={styles.blockingActions}>
        <button
          type="button"
          className="primary"
          disabled={!tabId}
          onClick={async () => {
            const dir = await invoke('repos:pickFolder', {});
            if (dir && tabId && (await useTabsStore.getState().relocate(tabId, dir))) {
              void invoke('repos:removeRecent', { path }).catch(() => undefined);
            }
          }}
        >
          <FolderSearch size={14} /> Locate…
        </button>
        <button
          type="button"
          disabled={!tabId}
          onClick={() => {
            void invoke('repos:removeRecent', { path }).catch(() => undefined);
            if (tabId) void requestCloseTab(tabId);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
