import type { BlameCommitInfo, RepoId, Sha } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Avatar } from '../../components/Avatar';
import { invoke } from '../../lib/api';
import { DateText } from '../../components/DateText';
import { fullDate, shortSha } from '../../lib/format';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useSetting } from '../../stores/settings';
import { codeStyle, useEditorPrefs } from '../diff/editor-prefs';
import { Code } from '../diff/HunkView';
import { LARGE_FILE_LINES } from '../diff/large-file';
import { displayEncodingFor } from '../preferences/repo/display-encoding';
import {
  applyBlameLines,
  ageIntensity,
  authorColor,
  isUncommitted,
  timeRange,
  toBlocks,
} from './blame-model';
import { decodeText, showFileText } from './codec';
import { filesInvoke, filesOn } from './files-api';
import styles from './FileView.module.css';

interface BlameState {
  lineShas: (string | undefined)[];
  commits: Record<Sha, BlameCommitInfo>;
  done: boolean;
  error: string | null;
  /** Bumped per chunk so memoized blocks recompute. */
  version: number;
  /** Which blame run (path, rev, options) the state belongs to. */
  run: string;
}

const EMPTY: BlameState = { lineShas: [], commits: {}, done: false, error: null, version: 0, run: '' };

/** File text at `rev` (undefined = working copy). */
async function loadText(repoId: RepoId, path: string, rev: string | undefined): Promise<string | null> {
  if (rev === undefined) {
    const r = await filesInvoke('fs:readWorktreeFile', { repoId, path });
    return r.bytes ? decodeText(r.bytes, await displayEncodingFor(repoId)).text : null;
  }
  const r = await invoke('git:show:file', { repoId, rev, path, maxBytes: 20 * 1024 * 1024 });
  return showFileText(r)?.text ?? null;
}

/**
 * Streaming blame (spec 07 §4.10, §6.8): `blame:start` + `blame:chunk` events fill the gutter progressively.
 * Blocks group consecutive lines of a commit; the bar colour is per author (or an age heatmap). Hovering a
 * block shows the commit card with Show commit / Blame prior revision / Show diff / Copy SHA.
 */
export function BlameView({
  repoId,
  path: initialPath,
  rev: initialRev,
}: {
  repoId: RepoId;
  path: string;
  rev?: string;
}) {
  const prefs = useEditorPrefs();
  const dateFormat = useSetting('ui.dateFormat');
  const [target, setTarget] = useState<{ path: string; rev?: string }>({
    path: initialPath,
    rev: initialRev,
  });
  const [history, setHistory] = useState<{ path: string; rev?: string }[]>([]);
  const [opts, setOpts] = useState({ ignoreWhitespace: false, detectMoves: false, detectCopies: false });
  const [color, setColor] = useState<'author' | 'age'>('author');
  const [force, setForce] = useState(false);
  const [hover, setHover] = useState<{ sha: string; top: number } | null>(null);
  const [stored, setState] = useState<BlameState>(EMPTY);
  const runKey = JSON.stringify([target.path, target.rev ?? null, opts]);
  // a new run starts from scratch; the previous run's state is ignored until its first chunk
  const state = stored.run === runKey ? stored : EMPTY;

  const text = useQuery({
    queryKey: ['blameText', repoId, target.path, target.rev ?? ':worktree'],
    queryFn: () => loadText(repoId, target.path, target.rev),
  });
  const ignoreRevs = useQuery({
    queryKey: ['blameIgnoreRevs', repoId],
    queryFn: () =>
      filesInvoke('fs:readWorktreeFile', { repoId, path: '.git-blame-ignore-revs', maxBytes: 1 }),
    staleTime: 60_000,
  });
  const lines = useMemo(() => {
    const t = text.data ?? '';
    const l = t.split('\n');
    if (t.endsWith('\n')) l.pop();
    return l;
  }, [text.data]);
  const tooBig = lines.length > LARGE_FILE_LINES && !force;

  // stream the blame
  useEffect(() => {
    if (text.isLoading || tooBig) return;
    let streamId: string | null = null;
    let cancelled = false;
    const pending: {
      lines?: Parameters<typeof applyBlameLines>[1];
      commits?: Record<Sha, BlameCommitInfo>;
      id: string;
      done?: boolean;
      error?: string;
    }[] = [];
    const table: (string | undefined)[] = [];
    let commits: Record<Sha, BlameCommitInfo> = {};
    let done = false;
    let error: string | null = null;
    let version = 0;
    const apply = (e: (typeof pending)[number]): void => {
      if (e.lines) applyBlameLines(table, e.lines);
      if (e.commits) commits = { ...commits, ...e.commits };
      done ||= !!e.done;
      error = e.error ?? error;
      setState({ lineShas: table, commits, done, error, version: ++version, run: runKey });
    };
    const handle = (e: (typeof pending)[number]): void => {
      if (cancelled) return;
      if (streamId === null) pending.push(e);
      else if (e.id === streamId) apply(e);
    };
    const offChunk = filesOn('blame:chunk', (c) =>
      handle({ id: c.streamId, lines: c.lines, commits: c.commits }),
    );
    const offDone = filesOn('blame:done', (d) => handle({ id: d.streamId, done: true, error: d.error }));
    filesInvoke('blame:start', {
      repoId,
      path: target.path,
      ...(target.rev ? { rev: target.rev } : {}),
      opts,
    })
      .then(({ streamId: id }) => {
        if (cancelled) {
          void filesInvoke('blame:cancel', { streamId: id });
          return;
        }
        streamId = id;
        for (const e of pending.splice(0)) if (e.id === id) apply(e);
      })
      .catch(async () => {
        // streaming channel unavailable: one-shot blame
        try {
          const r = await invoke('git:blame', {
            repoId,
            path: target.path,
            ...(target.rev ? { rev: target.rev } : {}),
            opts,
          });
          if (!cancelled) apply({ id: '', lines: r.lines, commits: r.commits, done: true });
        } catch (e) {
          if (!cancelled) apply({ id: '', done: true, error: (e as Error).message });
        }
      });
    return () => {
      cancelled = true;
      offChunk();
      offDone();
      if (streamId) void filesInvoke('blame:cancel', { streamId }).catch(() => undefined);
    };
  }, [repoId, target.path, target.rev, opts, text.isLoading, tooBig, runKey]);

  const blocks = useMemo(
    () => toBlocks(state.lineShas, lines.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` tracks the mutable table
    [state.version, state.run, lines.length],
  );
  const range = useMemo(() => timeRange(state.commits), [state.commits]);

  const go = (next: { path: string; rev?: string }): void => {
    setHistory((h) => [...h, target]);
    setTarget(next);
    setHover(null);
  };

  if (text.isLoading) return <p className={styles.message}>Loading file…</p>;
  if (text.error)
    return <p className={styles.message}>Could not read the file: {(text.error as Error).message}</p>;
  if (text.data === null)
    return <p className={styles.message}>This file does not exist at this revision or is binary.</p>;
  if (tooBig) {
    return (
      <p className={styles.message}>
        This file has {lines.length.toLocaleString()} lines. Blame may take a while.{' '}
        <button type="button" onClick={() => setForce(true)}>
          Blame anyway
        </button>
      </p>
    );
  }

  const hovered = hover ? state.commits[hover.sha] : undefined;

  return (
    <div className={styles.blameWrap}>
      <div className={styles.blameBar}>
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setTarget(history[history.length - 1]!);
              setHistory((h) => h.slice(0, -1));
            }}
          >
            ← Back
          </button>
        )}
        <span className={styles.byline}>
          {target.rev ? (
            <>
              Blame at <code>{/^[0-9a-f]{7,}/.test(target.rev) ? shortSha(target.rev, 10) : target.rev}</code>
            </>
          ) : (
            'Blame of the working copy'
          )}
          {target.path !== initialPath && <> · {target.path}</>}
          {!state.done && ' · streaming…'}
        </span>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={opts.ignoreWhitespace}
            onChange={(e) => setOpts({ ...opts, ignoreWhitespace: e.target.checked })}
          />
          Ignore whitespace (-w)
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={opts.detectMoves}
            onChange={(e) => setOpts({ ...opts, detectMoves: e.target.checked })}
          />
          Detect moves (-M)
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={opts.detectCopies}
            onChange={(e) => setOpts({ ...opts, detectCopies: e.target.checked })}
          />
          Detect copies (-C)
        </label>
        <select
          aria-label="Blame colouring"
          value={color}
          onChange={(e) => setColor(e.target.value as 'author' | 'age')}
        >
          <option value="author">Colour by author</option>
          <option value="age">Age heatmap</option>
        </select>
      </div>
      {ignoreRevs.data?.exists && (
        <p className={styles.note}>
          This repository has a <code>.git-blame-ignore-revs</code> file; revisions listed there are skipped
          when <code>blame.ignoreRevsFile</code> points to it.
        </p>
      )}
      {state.error && <p className={styles.note}>Blame failed: {state.error}</p>}
      <div
        className={styles.blame}
        role="table"
        aria-label="Blame"
        style={codeStyle(prefs)}
        onMouseLeave={() => setHover(null)}
      >
        {blocks.map((b) => {
          const c = state.commits[b.sha];
          const uncommitted = isUncommitted(b.sha);
          const bar = !b.sha
            ? 'transparent'
            : color === 'age'
              ? `color-mix(in srgb, var(--kl-text-accent) ${Math.round(100 * ageIntensity(c?.authorTime ?? 0, range.min, range.max))}%, transparent)`
              : authorColor(c?.authorMail ?? b.sha);
          return (
            <div key={`${b.start}`} className={styles.blameBlock} role="rowgroup">
              <div
                className={styles.blameGutter}
                style={{ borderLeft: `4px solid ${bar}` }}
                onMouseEnter={(e) =>
                  b.sha &&
                  !uncommitted &&
                  setHover({ sha: b.sha, top: (e.currentTarget as HTMLElement).offsetTop })
                }
              >
                {!b.sha ? (
                  <span className={styles.byline}>…</span>
                ) : uncommitted ? (
                  <span className={styles.byline}>You · Uncommitted</span>
                ) : (
                  <span className={styles.blameHead}>
                    <Avatar name={c?.author ?? ''} email={c?.authorMail ?? ''} size={16} />
                    <span className={styles.blameAuthor}>{c?.author}</span>
                    <span className={styles.byline} title={c ? fullDate(c.authorTime) : ''}>
                      {c ? <DateText unixSeconds={c.authorTime} format={dateFormat} /> : ''}
                    </span>
                  </span>
                )}
              </div>
              <div className={styles.blameLines}>
                {lines.slice(b.start - 1, b.start - 1 + b.count).map((content, i) => (
                  <div key={i} className={styles.blameLine} role="row">
                    {prefs.lineNumbers && <span className={styles.ln}>{b.start + i}</span>}
                    <span className={styles.code}>
                      <Code text={content} prefs={prefs} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {hover && hovered && (
          <div className={styles.hoverCard} style={{ top: hover.top }} role="dialog" aria-label="Commit">
            <strong>{hovered.summary}</strong>
            <span className={styles.byline}>
              <code>{shortSha(hovered.sha, 10)}</code> · {hovered.author} &lt;{hovered.authorMail}&gt; ·{' '}
              {fullDate(hovered.authorTime)}
            </span>
            <span className={styles.cardActions}>
              <button type="button" onClick={() => useRepoUiStore.getState().reveal(repoId, hovered.sha)}>
                Show commit
              </button>
              <button
                type="button"
                disabled={hovered.boundary && !hovered.previous}
                title="Blame the file as it was before this commit"
                onClick={() =>
                  go({
                    path: hovered.previous?.path ?? hovered.filename ?? target.path,
                    rev: `${hovered.sha}^`,
                  })
                }
              >
                Blame prior revision
              </button>
              <button
                type="button"
                onClick={() =>
                  useRepoUiStore.getState().update(repoId, () => ({
                    center: {
                      kind: 'diff',
                      spec: {
                        kind: 'commit',
                        sha: hovered.sha,
                        paths:
                          hovered.previous && hovered.previous.path !== hovered.filename
                            ? [hovered.previous.path, hovered.filename]
                            : [hovered.filename],
                      },
                      path: hovered.filename,
                      ...(hovered.previous && hovered.previous.path !== hovered.filename
                        ? { oldPath: hovered.previous.path }
                        : {}),
                      title: `${shortSha(hovered.sha)} · ${hovered.filename}`,
                      oldRev: hovered.previous?.sha ?? '',
                      newRev: hovered.sha,
                    },
                  }))
                }
              >
                Show diff
              </button>
              <button type="button" onClick={() => void invoke('shell:copyText', { text: hovered.sha })}>
                Copy SHA
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
