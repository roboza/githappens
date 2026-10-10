import type { ComposeSource } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { ArrowDown, ArrowUp, Combine, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent } from 'react';

import type { ComposeHunkInfo, ComposeResult } from '../../../../shared/ipc/ai-contract';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiEnabled, useAiRun } from '../../ai/hooks';
import { shortSha } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useIsRunning } from '../../stores/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import s from './Ai.module.css';

interface Draft {
  key: number;
  summary: string;
  description: string;
  hunks: string[];
}

const DRAG_TYPE = 'application/x-kl-hunk';
let keySeq = 0;

function fromResult(r: ComposeResult): { commits: Draft[]; unassigned: string[] } {
  return {
    commits: r.commits.map((c) => ({
      key: ++keySeq,
      summary: c.summary,
      description: c.description,
      hunks: c.hunks.map((h) => h.hunkId),
    })),
    unassigned: r.unassigned.map((h) => h.hunkId),
  };
}

const message = (d: Draft): string =>
  d.description.trim() ? `${d.summary.trim()}\n\n${d.description.trim()}\n` : `${d.summary.trim()}\n`;

/**
 * Commit Composer (spec 12 §4.6): the AI proposes how to split the staged changes (or a range ending at
 * HEAD) into commits; the user edits messages, drags hunk chips between commits, reorders, squashes and
 * deletes. Nothing happens until "Create commits", which runs the single-undo `ai.compose` op.
 */
export default function CommitComposerView({ repoId, source }: { repoId: RepoId; source: ComposeSource }) {
  const enabled = useAiEnabled();
  const run = useAiRun('composeCommits');
  const busy = useIsRunning(repoId, ['ai.compose']);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [commits, setCommits] = useState<Draft[]>([]);
  const [unassigned, setUnassigned] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<number | 'unassigned' | null>(null);
  const [runHooks, setRunHooks] = useState(false);

  const close = (): void => {
    run.cancel();
    useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
  };

  const generate = async (): Promise<void> => {
    const r = await run.start({ repoId, source });
    if (!r) return;
    setResult(r);
    const st = fromResult(r);
    setCommits(st.commits);
    setUnassigned(st.unassigned);
    setSelected(r.hunks[0]?.hunkId ?? null);
  };

  // propose once when opened (RepoView keys this view by its source); deferred out of the effect body
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => void generate(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const byId = useMemo(() => new Map((result?.hunks ?? []).map((h) => [h.hunkId, h])), [result]);
  const stats = useMemo(() => {
    const hs = result?.hunks ?? [];
    return {
      files: new Set(hs.map((h) => h.path)).size,
      lines: hs.reduce((n, h) => n + h.additions + h.deletions, 0),
    };
  }, [result]);

  // ---- editing ----

  const moveHunk = (id: string, to: number | 'unassigned'): void => {
    setCommits((cs) =>
      cs.map((c) => {
        const without = c.hunks.filter((h) => h !== id);
        return c.key === to ? { ...c, hunks: [...without, id] } : { ...c, hunks: without };
      }),
    );
    setUnassigned((u) =>
      to === 'unassigned' ? [...u.filter((h) => h !== id), id] : u.filter((h) => h !== id),
    );
  };
  const patch = (key: number, p: Partial<Draft>): void =>
    setCommits((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const move = (i: number, dir: -1 | 1): void =>
    setCommits((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const squashUp = (i: number): void =>
    setCommits((cs) => {
      if (i === 0) return cs;
      const above = cs[i - 1]!;
      const cur = cs[i]!;
      const merged: Draft = {
        ...above,
        description: [
          above.description.trim(),
          `${cur.summary}${cur.description.trim() ? `\n\n${cur.description.trim()}` : ''}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        hunks: [...above.hunks, ...cur.hunks],
      };
      return [...cs.slice(0, i - 1), merged, ...cs.slice(i + 1)];
    });
  const remove = (i: number): void => {
    const c = commits[i];
    if (!c) return;
    setUnassigned((u) => [...u, ...c.hunks]);
    setCommits((cs) => cs.filter((_, k) => k !== i));
  };
  const addCommit = (): void =>
    setCommits((cs) => [...cs, { key: ++keySeq, summary: '', description: '', hunks: [] }]);

  const dropProps = (target: number | 'unassigned') => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropOn !== target) setDropOn(target);
    },
    onDragLeave: () => setDropOn((d) => (d === target ? null : d)),
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropOn(null);
      if (id) {
        e.preventDefault();
        moveHunk(id, target);
      }
    },
  });

  // ---- apply ----

  const problems: string[] = [];
  commits.forEach((c, i) => {
    if (!c.summary.trim()) problems.push(`Commit ${i + 1} needs a summary.`);
    if (!c.hunks.length) problems.push(`Commit ${i + 1} has no changes — delete it or drop changes onto it.`);
  });
  if (!commits.length) problems.push('Add at least one commit.');

  const create = async (): Promise<void> => {
    if (!result || problems.length) return;
    const r = await runOp(
      repoId,
      {
        type: 'ai.compose',
        source: result.source,
        diffHash: result.diffHash,
        skipHooks: !runHooks,
        commits: commits.map((c) => ({
          message: message(c),
          hunks: c.hunks.map((hunkId) => ({
            path: byId.get(hunkId)?.path ?? hunkId.replace(/#\d+$/, ''),
            hunkId,
          })),
        })),
      },
      { successToast: (res) => res.summary ?? 'Commits created' },
    ).catch(() => null);
    if (r) close();
  };

  // ---- render ----

  const title =
    source.kind === 'range'
      ? `Recompose ${shortSha(source.from)}…${source.to === 'HEAD' ? 'HEAD' : shortSha(source.to)}`
      : 'Compose commits';
  const chip = (id: string) => {
    const h = byId.get(id);
    return (
      <button
        key={id}
        type="button"
        className={s.chip}
        draggable
        aria-pressed={selected === id}
        title={h ? `${h.path} — ${h.header}` : id}
        onClick={() => setSelected(id)}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        {h ? `${h.path}${h.kind === 'hunk' ? ` #${Number(id.slice(id.lastIndexOf('#') + 1)) + 1}` : ''}` : id}
        {h && (
          <>
            <span className={s.add}>+{h.additions}</span>
            <span className={s.del}>−{h.deletions}</span>
          </>
        )}
      </button>
    );
  };

  if (!enabled) {
    return (
      <div className={s.center}>
        <p>AI features are turned off.</p>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className={s.composer}>
      <div className={s.composerHeader}>
        <Sparkles size={16} />
        <h2>
          {title}
          {result
            ? ` — ${stats.files} file${stats.files === 1 ? '' : 's'}, ${stats.lines} line${stats.lines === 1 ? '' : 's'}`
            : ''}
        </h2>
        <label className={s.note} title="Hooks that change files between commits would break the plan">
          <input type="checkbox" checked={runHooks} onChange={(e) => setRunHooks(e.target.checked)} /> Run
          commit hooks
        </label>
        <button type="button" disabled={run.running || busy} onClick={() => void generate()}>
          Regenerate
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!result || run.running || busy || problems.length > 0}
          title={
            problems.join('\n') ||
            `Create ${commits.length} commit${commits.length === 1 ? '' : 's'} (one undo restores everything)`
          }
          onClick={() => quiet(create())}
        >
          {busy ? 'Creating…' : `Create ${commits.length || ''} commit${commits.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className={s.iconBtn} aria-label="Close composer" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {!result ? (
        <div className={s.center}>
          {run.state.error ? (
            <div>
              <p className={s.error} role="alert">
                {describeAiError(run.state.error)}
              </p>
              {needsSettings(run.state.error) && (
                <button type="button" className={s.linkBtn} onClick={openAiPreferences}>
                  Open AI settings
                </button>
              )}
            </div>
          ) : (
            <p>{run.running ? 'Asking the AI how to split your changes…' : 'No proposal yet.'}</p>
          )}
        </div>
      ) : (
        <div className={s.composerMain}>
          <div className={s.proposals}>
            {run.state.truncated && (
              <p className={s.note}>
                Some hunks were shortened for the AI; the proposal may be less precise.
              </p>
            )}
            {commits.map((c, i) => (
              <section
                key={c.key}
                className={`${s.proposal} ${dropOn === c.key ? s.dropTarget : ''}`}
                aria-label={`Proposed commit ${i + 1}`}
                {...dropProps(c.key)}
              >
                <div className={s.proposalHead}>
                  <span>Commit {i + 1}</span>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="Move down"
                    disabled={i === commits.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="Squash into the commit above"
                    title="Squash into above"
                    disabled={i === 0}
                    onClick={() => squashUp(i)}
                  >
                    <Combine size={13} />
                  </button>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="Delete commit (its changes go to Unassigned)"
                    title="Delete — changes return to Unassigned"
                    onClick={() => remove(i)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  className={s.input}
                  aria-label={`Commit ${i + 1} summary`}
                  placeholder="Summary"
                  value={c.summary}
                  onChange={(e) => patch(c.key, { summary: e.target.value })}
                />
                <textarea
                  className={s.input}
                  aria-label={`Commit ${i + 1} description`}
                  placeholder="Description"
                  rows={2}
                  value={c.description}
                  onChange={(e) => patch(c.key, { description: e.target.value })}
                />
                <div className={s.chips}>{c.hunks.map(chip)}</div>
              </section>
            ))}
            <button type="button" onClick={addCommit}>
              <Plus size={13} /> Add commit
            </button>
            <section
              className={`${s.unassigned} ${dropOn === 'unassigned' ? s.dropTarget : ''}`}
              aria-label="Unassigned changes"
              {...dropProps('unassigned')}
            >
              <div className={s.proposalHead}>
                <span>Unassigned ({unassigned.length})</span>
              </div>
              {unassigned.length ? (
                <p className={s.note}>
                  These changes are not in any commit and will stay staged. Drag them onto a commit to include
                  them.
                </p>
              ) : (
                <p className={s.note}>Drop changes here to leave them out of the new commits.</p>
              )}
              <div className={s.chips}>{unassigned.map(chip)}</div>
            </section>
            {!runHooks && <p className={s.note}>Commits are created with --no-verify (hooks skipped).</p>}
          </div>
          <HunkPreview hunk={selected ? byId.get(selected) : undefined} />
        </div>
      )}
    </div>
  );
}

function HunkPreview({ hunk }: { hunk: ComposeHunkInfo | undefined }) {
  if (!hunk) return <div className={s.center}>Select a change to preview it.</div>;
  if (hunk.binary) return <div className={s.center}>{hunk.path}: binary file</div>;
  return (
    <pre className={s.preview} aria-label={`Preview of ${hunk.path}`}>
      {hunk.preview.split('\n').map((l, i) => {
        const cls =
          l.startsWith('+') && !l.startsWith('+++')
            ? s.add
            : l.startsWith('-') && !l.startsWith('---')
              ? s.del
              : undefined;
        return cls ? (
          <span key={i} className={cls}>
            {l}
          </span>
        ) : (
          `${l}\n`
        );
      })}
    </pre>
  );
}
