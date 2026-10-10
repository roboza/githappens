import type { RepoId } from '@githappens/git/types';
import { Copy, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { useEffect } from 'react';

import { closeExplain } from '../../ai/actions';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiRun } from '../../ai/hooks';
import { Markdown } from '../../integrations/ui';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import type { ExplainTarget } from '../../stores/repo-ui';
import s from './Ai.module.css';

function titleFor(t: ExplainTarget): string {
  switch (t.kind) {
    case 'commits':
      return t.shas.length === 1 ? `Explain ${shortSha(t.shas[0]!)}` : `Explain ${t.shas.length} commits`;
    case 'branch':
      return `Explain ${t.branch}${t.base ? ` vs ${t.base}` : ''}`;
    case 'wip':
      return 'Explain uncommitted changes';
  }
}

/**
 * AI Explain (spec 12 §4.4): streamed, sanitized markdown (Summary / Notable changes / Risks) for commits,
 * a branch (merge-base range, header "12 commits, 34 files vs main") or the WIP. Shown over the right panel.
 */
export function ExplainPanel({
  repoId,
  target,
  nonce,
}: {
  repoId: RepoId;
  target: ExplainTarget;
  nonce: number;
}) {
  const commits = useAiRun('explainCommits');
  const branch = useAiRun('explainBranch');
  const wip = useAiRun('explainWip');
  const run = target.kind === 'commits' ? commits : target.kind === 'branch' ? branch : wip;

  const start = (): void => {
    if (target.kind === 'commits') void commits.start({ repoId, shas: target.shas });
    else if (target.kind === 'branch')
      void branch.start({ repoId, branch: target.branch, base: target.base });
    else void wip.start({ repoId });
  };

  // (re)start whenever the panel is opened for a target
  useEffect(() => {
    const t = setTimeout(start, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const { state } = run;
  const markdown =
    state.status === 'done' && state.result && 'markdown' in state.result
      ? state.result.markdown
      : state.text;
  const range = branch.state.result?.range;

  return (
    <div className={s.explain}>
      <div className={s.explainHeader}>
        <Sparkles size={14} />
        <h2 title={titleFor(target)}>{titleFor(target)}</h2>
        {run.running ? (
          <button type="button" className={s.iconBtn} aria-label="Stop" title="Stop" onClick={run.cancel}>
            <Square size={14} />
          </button>
        ) : (
          <button
            type="button"
            className={s.iconBtn}
            aria-label="Regenerate"
            title="Regenerate"
            onClick={start}
          >
            <RefreshCw size={14} />
          </button>
        )}
        <button
          type="button"
          className={s.iconBtn}
          aria-label="Copy explanation"
          title="Copy"
          disabled={!markdown}
          onClick={() => void invoke('shell:copyText', { text: markdown })}
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="Close explanation"
          title="Close"
          onClick={() => closeExplain(repoId)}
        >
          <X size={14} />
        </button>
      </div>
      {target.kind === 'branch' && range && (
        <div className={s.explainMeta}>
          {range.commits} commit{range.commits === 1 ? '' : 's'}, {range.files} file
          {range.files === 1 ? '' : 's'} vs {range.baseRef}
        </div>
      )}
      <div className={s.explainBody} aria-live="polite" aria-busy={run.running}>
        {state.error ? (
          <p className={s.error} role="alert">
            {describeAiError(state.error)}{' '}
            {needsSettings(state.error) && (
              <button type="button" className={s.linkBtn} onClick={openAiPreferences}>
                Open AI settings
              </button>
            )}
          </p>
        ) : markdown ? (
          <Markdown text={markdown} />
        ) : (
          <p className={s.note}>{run.running ? 'Thinking…' : 'Nothing yet.'}</p>
        )}
        {state.status === 'done' && state.truncated && (
          <p className={s.note}>Based on a partial diff: some changes were too large to send.</p>
        )}
        {state.status === 'done' && !!state.omitted?.length && (
          <p className={s.note}>Not sent: {state.omitted.join(', ')}</p>
        )}
      </div>
    </div>
  );
}
