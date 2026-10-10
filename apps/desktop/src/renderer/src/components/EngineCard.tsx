import type { GitExecutableInfo } from '@githappens/git/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { invoke, IpcError, on } from '../lib/api';
import { shellInvoke } from '../shell/shell2-api';
import { useSetting } from '../stores/settings';
import s from './Card.module.css';

type Choice = 'bundled' | 'system' | 'custom';

const FEATURE_LABELS: Record<keyof GitExecutableInfo['features'], string> = {
  worktreeListZ: 'worktree list -z',
  statusShowStash: 'status --show-stash',
  pathspecFromFile: '--pathspec-from-file',
  forceIfIncludes: '--force-if-includes',
  mergeTreeWriteTree: 'merge-tree --write-tree',
  builtinFsmonitor: 'builtin fsmonitor',
  configShowScope: 'config --show-scope',
};
const FEATURE_KEYS = Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[];

const errorMessage = (e: Error | null): string | undefined =>
  e instanceof IpcError ? e.error.message : e?.message;

/** Git engine status + executable picker (spec 02 §6.1, spec 13 Git section). */
export function EngineCard() {
  const qc = useQueryClient();
  const engine = useQuery({
    queryKey: ['git:engine:info'],
    queryFn: () => invoke('git:engine:info', {}),
    retry: false,
  });
  const pref = useSetting('git.executable') ?? 'bundled';

  useEffect(() => on('git:engine:changed', (info) => qc.setQueryData(['git:engine:info'], info)), [qc]);

  const info = engine.data;
  const engineError = errorMessage(engine.error);

  return (
    <section className={s.card} aria-labelledby="engine-title">
      <h2 id="engine-title" className={s.title}>
        Git engine
      </h2>

      {engine.isLoading && <p className={s.muted}>Detecting Git…</p>}
      {engineError && (
        <p className={s.error} role="alert">
          <span className={s.badgeError}>Git not found</span> {engineError}
        </p>
      )}

      {info && (
        <dl className={s.rows}>
          <dt>Executable</dt>
          <dd>
            <span className={s.badge}>{info.kind}</span> Git {info.version}
          </dd>
          <dt>Path</dt>
          <dd className="mono">{info.path}</dd>
          <dt>Git LFS</dt>
          <dd>{info.lfsVersion ?? <span className={s.badgeOff}>not installed</span>}</dd>
          <dt>Features</dt>
          <dd className={s.chips}>
            {FEATURE_KEYS.map((k) => (
              <span
                key={k}
                className={info.features[k] ? s.badge : s.badgeOff}
                title={info.features[k] ? 'Available' : 'Unavailable'}
              >
                {FEATURE_LABELS[k]}
              </span>
            ))}
          </dd>
        </dl>
      )}

      {/* Re-mount when the saved preference changes so the form starts from it. */}
      <ExecutablePicker key={pref} pref={pref} />
      <ReloadShellEnv />
    </section>
  );
}

function ExecutablePicker({ pref }: { pref: string }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Choice>(pref === 'bundled' || pref === 'system' ? pref : 'custom');
  const [customPath, setCustomPath] = useState(pref === 'bundled' || pref === 'system' ? '' : pref);

  const apply = useMutation({
    mutationFn: () =>
      invoke(
        'git:engine:setExecutable',
        choice === 'custom' ? { kind: 'system', path: customPath.trim() } : { kind: choice },
      ),
    onSuccess: (info) => qc.setQueryData(['git:engine:info'], info),
  });
  const applyError = errorMessage(apply.error);

  return (
    <>
      <form
        className={s.controls}
        onSubmit={(e) => {
          e.preventDefault();
          apply.mutate();
        }}
      >
        {(['bundled', 'system', 'custom'] as const).map((c) => (
          <label key={c} className={s.radio}>
            <input
              type="radio"
              name="git-exe"
              value={c}
              checked={choice === c}
              onChange={() => setChoice(c)}
            />
            {c === 'bundled' ? 'Bundled' : c === 'system' ? 'System (PATH)' : 'Custom path'}
          </label>
        ))}
        {choice === 'custom' && (
          <input
            type="text"
            aria-label="Path to git executable"
            placeholder="/usr/local/bin/git"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
          />
        )}
        <button
          type="submit"
          className="primary"
          disabled={apply.isPending || (choice === 'custom' && !customPath.trim())}
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
        </button>
      </form>
      {applyError && (
        <p className={s.error} role="alert">
          {applyError}
        </p>
      )}
    </>
  );
}

/** "Reload shell environment" (spec 02): re-read the login-shell env (PATH, SSH_AUTH_SOCK…) and re-detect git. */
function ReloadShellEnv() {
  const qc = useQueryClient();
  const reload = useMutation({
    mutationFn: () => shellInvoke('shell:reloadEnv', {}),
    onSuccess: (info) => qc.setQueryData(['git:engine:info'], info),
  });
  return (
    <div className={s.controls}>
      <button type="button" disabled={reload.isPending} onClick={() => reload.mutate()}>
        {reload.isPending ? 'Reloading…' : 'Reload shell environment'}
      </button>
      {reload.isSuccess && <span className={s.muted}>Environment reloaded.</span>}
      {reload.error && (
        <span className={s.error} role="alert">
          {errorMessage(reload.error)}
        </span>
      )}
    </div>
  );
}
