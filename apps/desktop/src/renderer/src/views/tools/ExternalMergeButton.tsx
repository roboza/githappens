import type { RepoId } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect } from 'react';

import { useSetting } from '../../stores/settings';
import {
  cancelExternalMergeTool,
  configuredMergeToolLabel,
  mergeWaitKey,
  openExternalMergeTool,
  useMergeToolWaits,
} from '../../tools/actions';
import { setMergeSession } from '../merge/conflict-queries';
import styles from './ExternalMergeButton.module.css';

/** Waiting state of the external merge tool for one file. */
export function useExternalMergeWait(repoId: RepoId, path: string) {
  return useMergeToolWaits((s) => s.waits[mergeWaitKey(repoId, path)]);
}

/**
 * Reload the conflicted file after the external tool exits (it may have rewritten the worktree file), dropping
 * the in-memory merge session so the built-in tool starts from the new contents.
 */
function useReloadAfterExternal(repoId: RepoId, path: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    const onDone = (e: Event): void => {
      const d = (e as CustomEvent<{ repoId: RepoId; path: string }>).detail;
      if (d?.repoId !== repoId || d.path !== path) return;
      setMergeSession(repoId, path, null);
      void qc.invalidateQueries({ queryKey: ['conflictFile', repoId, path] });
      void qc.invalidateQueries({ queryKey: ['conflictState', repoId] });
    };
    window.addEventListener('kl:external-merge-done', onDone);
    return () => window.removeEventListener('kl:external-merge-done', onDone);
  }, [qc, repoId, path]);
}

/** "Open in external tool" for the merge tool header (spec 08 §4.8). */
export function ExternalMergeButton({ repoId, path }: { repoId: RepoId; path: string }) {
  const tool = useSetting('tools.mergeTool') ?? 'none';
  const wait = useExternalMergeWait(repoId, path);
  useReloadAfterExternal(repoId, path);
  const configured = tool !== 'none';
  return (
    <button
      type="button"
      className={styles.button}
      disabled={!!wait}
      title={
        configured
          ? `Resolve this file in ${configuredMergeToolLabel()}`
          : 'Choose an external merge tool in Preferences → External Tools'
      }
      onClick={() => void openExternalMergeTool(repoId, path)}
    >
      {wait ? <Loader2 size={14} className={styles.spin} /> : <ExternalLink size={14} />}
      {wait ? 'Waiting…' : 'Open in external tool'}
    </button>
  );
}

/**
 * Covers the built-in merge tool while the external one runs: "Waiting for Beyond Compare… [Cancel wait]"
 * (spec 08 §4.8). Render inside a positioned container.
 */
export function ExternalMergeOverlay({ repoId, path }: { repoId: RepoId; path: string }) {
  const wait = useExternalMergeWait(repoId, path);
  if (!wait) return null;
  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.card}>
        <Loader2 size={20} className={styles.spin} aria-hidden />
        <span>Waiting for {wait.tool}…</span>
        <span className={styles.hint}>Save and close the tool to continue.</span>
        <button type="button" onClick={() => cancelExternalMergeTool(repoId, path)}>
          Cancel wait
        </button>
      </div>
    </div>
  );
}
