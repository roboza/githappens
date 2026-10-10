import type { CommandLogEntry, RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';

import { formatTime } from '../../lib/format';
import { behaviourInvoke, behaviourOn } from '../../notifications/api';
import { filterEntries, formatCommandLine, type ActivityFilter } from './format';
import styles from './Activity.module.css';

const MAX = 500;

interface ActivityUi {
  open: boolean;
  toggle(open?: boolean): void;
}

/** Activity drawer visibility (status bar button, spec 02 §2 "Activity / Output log"). */
export const useActivityStore = create<ActivityUi>((set) => ({
  open: false,
  toggle: (open) => set((s) => ({ open: open ?? !s.open })),
}));

function Row({ e }: { e: CommandLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const failed = e.exitCode !== 0;
  const hasOutput = !!(e.stderr || e.stdoutPreview);
  return (
    <li className={`${styles.row} ${failed ? styles.failed : ''}`}>
      <button
        type="button"
        className={styles.rowHead}
        aria-expanded={expanded}
        disabled={!hasOutput}
        onClick={() => setExpanded((x) => !x)}
      >
        {hasOutput ? (
          expanded ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )
        ) : (
          <span className={styles.chevronSpacer} />
        )}
        <time className={styles.time}>{formatTime(e.startedAt)}</time>
        <code className={styles.cmd} title={formatCommandLine(e.argv)}>
          {formatCommandLine(e.argv)}
        </code>
        {e.opId && <span className={styles.opTag}>op</span>}
        <span className={styles.duration}>{e.durationMs} ms</span>
        <span className={failed ? styles.exitBad : styles.exitOk}>
          {e.exitCode === null ? 'killed' : e.exitCode}
        </span>
      </button>
      {expanded && hasOutput && (
        <pre className={styles.output}>
          {e.stdoutPreview && <span>{e.stdoutPreview}</span>}
          {e.stdoutPreview && e.stderr && '\n'}
          {e.stderr && <span className={styles.stderr}>{e.stderr}</span>}
        </pre>
      )}
    </li>
  );
}

/** Bottom drawer listing each git invocation of the active repo (spec 02 §2, §5.3 `git:output:*`). */
export function ActivityDrawer({ repoId, repoLabel }: { repoId: RepoId | undefined; repoLabel?: string }) {
  const open = useActivityStore((s) => s.open);
  const toggle = useActivityStore((s) => s.toggle);
  // entries are tagged with the repo they belong to, so switching repos never shows stale rows
  const [log, setLog] = useState<{ repoId?: RepoId; entries: CommandLogEntry[] }>({ entries: [] });
  const entries = useMemo(() => (log.repoId === repoId ? log.entries : []), [log, repoId]);
  const [filter, setFilter] = useState<ActivityFilter>('ops');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !repoId) return;
    let live = true;
    const pending: CommandLogEntry[] = [];
    let loaded = false;
    const off = behaviourOn('git:output:append', (p) => {
      if (p.repoId !== repoId) return;
      if (!loaded) pending.push(p.entry);
      else
        setLog((cur) => ({
          repoId,
          entries: [...(cur.repoId === repoId ? cur.entries : []), p.entry].slice(-MAX),
        }));
    });
    behaviourInvoke('git:output:list', { repoId, limit: MAX })
      .then((list) => {
        if (!live) return;
        loaded = true;
        const seen = new Set(list.map((e) => e.id));
        setLog({ repoId, entries: [...list, ...pending.filter((e) => !seen.has(e.id))].slice(-MAX) });
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
      off();
    };
  }, [open, repoId]);

  const shown = useMemo(() => filterEntries(entries, filter, text).reverse(), [entries, filter, text]);

  if (!open) return null;
  return (
    <section className={styles.drawer} aria-label="Activity">
      <header className={styles.head}>
        <strong>Activity</strong>
        {repoLabel && <span className={styles.repo}>{repoLabel}</span>}
        <select
          aria-label="Show"
          value={filter}
          onChange={(e) => setFilter(e.target.value as ActivityFilter)}
          className={styles.select}
        >
          <option value="ops">Operations</option>
          <option value="all">All git commands</option>
          <option value="failed">Failed</option>
        </select>
        <input
          type="search"
          className={styles.search}
          placeholder="Filter"
          aria-label="Filter commands"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.headBtn}
          disabled={!repoId || entries.length === 0}
          onClick={() => {
            if (!repoId) return;
            void behaviourInvoke('git:output:clear', { repoId }).then(() => setLog({ repoId, entries: [] }));
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className={styles.headBtn}
          aria-label="Close activity"
          onClick={() => toggle(false)}
        >
          <X size={14} />
        </button>
      </header>
      {error ? (
        <p className={styles.empty}>Activity log unavailable: {error}</p>
      ) : !repoId ? (
        <p className={styles.empty}>Open a repository to see its git activity.</p>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>No {filter === 'failed' ? 'failed ' : ''}git commands yet.</p>
      ) : (
        <ul className={styles.list}>
          {shown.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </ul>
      )}
    </section>
  );
}
