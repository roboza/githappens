import type { ClassifiedItem } from '@githappens/launchpad';
import type { MergeMethod } from '@githappens/providers/types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { MERGE_METHOD_LABEL } from '../../integrations/helpers';
import { mergeItem } from '../../launchpad/actions';
import { lk } from '../../launchpad/queries';
import s from './Launchpad.module.css';

/** Confirm popover for "Merge" from the Ready to merge group (spec 11 §4.2). */
export function MergePopover({
  item,
  anchor,
  onClose,
}: {
  item: ClassifiedItem;
  anchor: DOMRect;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const methods = item.type === 'pr' ? item.pr.allowedMergeMethods : [];
  const [method, setMethod] = useState<MergeMethod | undefined>(methods[0]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  if (item.type !== 'pr') return null;
  const left = Math.max(8, Math.min(anchor.right - 260, window.innerWidth - 268));
  const top = anchor.bottom + 160 > window.innerHeight ? Math.max(8, anchor.top - 150) : anchor.bottom + 4;

  return (
    <div ref={ref} className={s.popover} style={{ left, top }} role="dialog" aria-label="Merge pull request">
      <h3>Merge #{item.pr.number}?</h3>
      <span title={item.title}>{item.title}</span>
      <label>
        Method{' '}
        <select
          className={s.select}
          value={method}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          autoFocus
        >
          {methods.map((m) => (
            <option key={m} value={m}>
              {MERGE_METHOD_LABEL[m] ?? m}
            </option>
          ))}
        </select>
      </label>
      <div className={s.popoverActions}>
        <button type="button" className={s.secondaryBtn} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={s.primaryBtn}
          disabled={!method || busy}
          onClick={async () => {
            if (!method) return;
            setBusy(true);
            await mergeItem(item, method, () => void qc.invalidateQueries({ queryKey: lk.all() }));
            setBusy(false);
            onClose();
          }}
        >
          {busy ? 'Merging…' : 'Merge'}
        </button>
      </div>
    </div>
  );
}
