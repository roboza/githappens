import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { invoke, IpcError, on } from '../lib/api';
import { prefsInvoke } from '../stores/settings';
import { shellInvoke } from './shell2-api';
import styles from './ShellHost.module.css';

const BLOCKING = new Set(['GitNotFound', 'GitTooOld']);

/**
 * Blocking full-window state when no usable git executable was found (spec 02 §8 / spec 01): Locate git…,
 * Use bundled, Retry (re-resolves the shell environment and re-detects). Disappears as soon as an
 * executable is selected (`git:engine:changed`).
 */
export function GitNotFound() {
  const qc = useQueryClient();
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke('git:engine:info', {}).then(
      () => setProblem(null),
      (e: unknown) => {
        if (e instanceof IpcError && BLOCKING.has(e.code)) setProblem({ code: e.code, message: e.message });
      },
    );
    return on('git:engine:changed', (info) => {
      qc.setQueryData(['git:engine:info'], info);
      setProblem(null);
    });
  }, [qc]);

  if (!problem) return null;

  const attempt = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setProblem(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.blocking} role="alertdialog" aria-modal="true" aria-labelledby="git-missing-title">
      <div className={styles.blockingCard}>
        <TriangleAlert size={32} className={styles.warnIcon} aria-hidden />
        <h1 id="git-missing-title">
          {problem.code === 'GitTooOld' ? 'Git is too old' : 'Git was not found'}
        </h1>
        <p>{problem.message}</p>
        <p className={styles.muted}>
          GitHappens needs a git executable. Point it at your installation, use the bundled git, or install
          git and retry.
        </p>
        <div className={styles.blockingActions}>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void attempt(async () => {
                const p = await prefsInvoke('prefs:pickPath', {
                  kind: 'file',
                  title: 'Locate the git executable',
                });
                if (!p) throw new Error('No file selected.');
                await invoke('git:engine:setExecutable', { kind: 'system', path: p });
              })
            }
          >
            Locate git…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void attempt(() => invoke('git:engine:setExecutable', { kind: 'bundled' }))}
          >
            Use bundled
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void attempt(() =>
                shellInvoke('shell:reloadEnv', {}).catch(() =>
                  invoke('git:engine:setExecutable', { kind: 'system' }),
                ),
              )
            }
          >
            {busy ? 'Checking…' : 'Retry'}
          </button>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
