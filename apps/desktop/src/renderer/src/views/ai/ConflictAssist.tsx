import type { RepoId } from '@githappens/git/types';
import { useState, type ReactNode } from 'react';

import type { ConflictProposal } from '../../../../shared/ipc/ai-contract';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiEnabled, useAiRun } from '../../ai/hooks';
import { hasMarkers, type ConflictSegment } from '../merge/merge-model';
import { SparkleButton } from './SparkleButton';
import s from './Ai.module.css';

type CardState = 'open' | 'editing' | 'accepted' | 'rejected';

const toLines = (text: string): string[] => {
  const t = text.replace(/\r\n/g, '\n');
  if (t === '') return [];
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
};

/**
 * Conflict assist for the merge tool (spec 12 §4.4, spec 08): "Resolve with AI" proposes a resolution
 * per conflicted hunk with an explanation and a confidence badge. Nothing is written until Accept, which
 * hands the lines to the merge tool's output model as a manual edit of that chunk.
 */
export function useConflictAssist(o: {
  repoId: RepoId;
  path: string;
  chunks: ConflictSegment[];
  onAccept(updates: { index: number; lines: string[] }[]): void;
}): { button: ReactNode; panel: ReactNode } {
  const enabled = useAiEnabled();
  const run = useAiRun('conflictResolve');
  const [cards, setCards] = useState<Record<string, { state: CardState; text: string }>>({});
  const [open, setOpen] = useState(false);

  if (!enabled) return { button: null, panel: null };

  const start = async (): Promise<void> => {
    setOpen(true);
    setCards({});
    const r = await run.start({
      repoId: o.repoId,
      path: o.path,
      hunks: o.chunks.map((c) => ({
        hunkId: String(c.id),
        ours: c.a.join('\n'),
        theirs: c.b.join('\n'),
        ...(c.hasBase ? { base: c.base.join('\n') } : {}),
      })),
    });
    if (r) {
      setCards(
        Object.fromEntries(r.proposals.map((p) => [p.hunkId, { state: 'open', text: p.resolvedText }])),
      );
    }
  };

  const proposals: ConflictProposal[] = run.state.result?.proposals ?? [];
  const accept = (ids: string[]): void => {
    const updates = ids.flatMap((id) => {
      const card = cards[id];
      const index = Number(id);
      if (!card || hasMarkers(card.text) || !o.chunks.some((c) => c.id === index)) return [];
      return [{ index, lines: toLines(card.text) }];
    });
    if (!updates.length) return;
    o.onAccept(updates);
    setCards((c) => {
      const next = { ...c };
      for (const u of updates) next[String(u.index)] = { ...next[String(u.index)]!, state: 'accepted' };
      return next;
    });
  };
  const set = (id: string, patch: Partial<{ state: CardState; text: string }>): void =>
    setCards((c) => ({ ...c, [id]: { ...c[id]!, ...patch } }));

  const highIds = proposals
    .filter((p) => p.confidence === 'high' && cards[p.hunkId]?.state === 'open')
    .map((p) => p.hunkId);

  const button = (
    <SparkleButton
      label="Resolve conflicts with AI"
      text="Resolve with AI"
      disabled={!o.chunks.length}
      running={run.running}
      onRun={() => void start()}
      onCancel={run.cancel}
    />
  );

  const panel = !open ? null : (
    <div className={s.assist} aria-label="AI conflict proposals">
      <div className={s.assistHead}>
        <strong>
          {run.running
            ? 'Asking the AI for proposals…'
            : proposals.length
              ? `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} — review each one; nothing changes until you accept`
              : 'AI conflict proposals'}
        </strong>
        {highIds.length > 0 && (
          <button type="button" onClick={() => accept(highIds)}>
            Accept all high-confidence ({highIds.length})
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            run.cancel();
            setOpen(false);
          }}
        >
          Close
        </button>
      </div>
      {run.state.error && (
        <p className={s.error} role="alert">
          {describeAiError(run.state.error)}{' '}
          {needsSettings(run.state.error) && (
            <button type="button" className={s.linkBtn} onClick={openAiPreferences}>
              Open AI settings
            </button>
          )}
        </p>
      )}
      {run.state.status === 'done' && !proposals.length && (
        <p className={s.note}>The AI did not propose a resolution for any conflict.</p>
      )}
      {proposals.map((p) => {
        const card = cards[p.hunkId];
        if (!card || card.state === 'rejected') return null;
        const markers = hasMarkers(card.text);
        return (
          <div key={p.hunkId} className={`${s.card} ${card.state === 'accepted' ? s.accepted : ''}`}>
            <div className={s.cardHead}>
              <span>Conflict {Number(p.hunkId) + 1}</span>
              <span className={s[p.confidence]} title="How sure the AI is about this resolution">
                {p.confidence}
              </span>
              {card.state === 'accepted' ? (
                <span className={s.ok}>Accepted</span>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={markers}
                    title={markers ? 'Remove the conflict markers first' : 'Use this text for the conflict'}
                    onClick={() => accept([p.hunkId])}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => set(p.hunkId, { state: card.state === 'editing' ? 'open' : 'editing' })}
                  >
                    {card.state === 'editing' ? 'Done' : 'Edit'}
                  </button>
                  <button type="button" onClick={() => set(p.hunkId, { state: 'rejected' })}>
                    Reject
                  </button>
                </>
              )}
            </div>
            <p className={s.note}>{p.explanation}</p>
            {p.warning && <p className={s.error}>{p.warning}</p>}
            {card.state === 'editing' ? (
              <textarea
                className={s.textarea}
                aria-label={`Proposed text for conflict ${Number(p.hunkId) + 1}`}
                rows={Math.min(16, Math.max(3, toLines(card.text).length + 1))}
                value={card.text}
                onChange={(e) => set(p.hunkId, { text: e.target.value })}
              />
            ) : (
              <pre className={s.code}>{card.text || '(empty)'}</pre>
            )}
          </div>
        );
      })}
    </div>
  );

  return { button, panel };
}
