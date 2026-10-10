import type { FileDiff } from '@githappens/git/types';

import s from './Suggest.module.css';

/** Read-only unified diff of one file (suggestion review). */
export function DiffPreview({ diff }: { diff: FileDiff | undefined }) {
  if (!diff) return <div className={s.diff} />;
  if (diff.binary) return <div className={`${s.diff} ${s.muted}`}>Binary file — not shown.</div>;
  if (!diff.hunks.length) return <div className={`${s.diff} ${s.muted}`}>No textual changes.</div>;
  return (
    <div className={s.diff} role="table" aria-label="Changes">
      {diff.hunks.map((h, i) => (
        <div key={i} role="rowgroup">
          <div className={s.hunkHeader}>{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              role="row"
              className={`${s.line} ${l.type === 'add' ? s.lineAdd : l.type === 'del' ? s.lineDel : ''}`}
            >
              <span>{l.oldLineNo ?? ''}</span>
              <span>{l.newLineNo ?? ''}</span>
              <span>
                {l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'nonewline' ? '\\' : ' '}
              </span>
              <span>{l.content}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
