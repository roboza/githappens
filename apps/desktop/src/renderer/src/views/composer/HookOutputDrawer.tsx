import type { RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { useComposer, useComposerStore } from './composer-store';
import { cleanHookOutput } from './helpers';
import s from './Composer.module.css';

/**
 * Hook output drawer (spec 06 §4.6): streams `commit:hookOutput` while hooks run, auto-expands on a
 * hook failure with Retry / "Commit skipping hooks".
 */
export function HookOutputDrawer(props: { repoId: RepoId; onRetry(): void; onSkipHooks(): void }) {
  const { repoId } = props;
  const hook = useComposer(repoId, (c) => c.hook);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [hook.output, hook.open]);

  if (!hook.running && !hook.failed && !hook.output) return null;
  const setOpen = (open: boolean): void =>
    useComposerStore.getState().update(repoId, (c) => ({ hook: { ...c.hook, open } }));
  const dismiss = (): void =>
    useComposerStore
      .getState()
      .update(repoId, () => ({ hook: { running: false, output: '', failed: null, open: false } }));

  return (
    <div className={`${s.hookDrawer} ${hook.failed ? s.hookFailed : ''}`}>
      {hook.failed && (
        <div className={s.hookBanner} role="alert">
          <span>
            {hook.failed.hook} hook failed
            {hook.failed.exitCode !== null ? ` (exit ${hook.failed.exitCode})` : ''}. Your message was kept.
          </span>
          <span className={s.hookActions}>
            <button type="button" onClick={props.onRetry}>
              Retry
            </button>
            <button type="button" onClick={props.onSkipHooks}>
              Commit skipping hooks
            </button>
          </span>
        </div>
      )}
      <div className={s.hookHeader}>
        <button
          type="button"
          className={s.hookToggle}
          aria-expanded={hook.open}
          onClick={() => setOpen(!hook.open)}
        >
          {hook.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {hook.running ? (
            <>
              <Loader2 size={12} className={s.spin} /> Running hooks…
            </>
          ) : (
            'Hook output'
          )}
        </button>
        {!hook.running && (
          <button type="button" className={s.linkBtn} onClick={dismiss}>
            Clear
          </button>
        )}
      </div>
      {hook.open && (
        <pre ref={preRef} className={s.hookOutput} aria-live="polite" aria-label="Hook output">
          {cleanHookOutput(hook.output) || (hook.running ? 'Waiting for output…' : '(no output)')}
        </pre>
      )}
    </div>
  );
}
