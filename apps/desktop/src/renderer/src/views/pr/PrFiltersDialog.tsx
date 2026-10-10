import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { confirm } from '../../components/Dialogs';
import { Modal } from '../../components/Modal';
import type { SavedPrFilter } from '../../../../shared/ipc/integrations-contract';
import { errorLine, intInvoke } from '../../integrations/api';
import {
  describeFilter,
  draftToFilter,
  filterToDraft,
  newFilterId,
  removeFilter,
  upsertFilter,
  validateFilterDraft,
  type FilterDraft,
  type PrStateFilter,
} from '../../integrations/pr-filter-helpers';
import { ik, usePrFilters } from '../../integrations/queries';
import { uiStyles } from '../../integrations/ui';
import s from './PrFiltersDialog.module.css';

const EMPTY: SavedPrFilter[] = [];
const BLANK: FilterDraft = { name: '', query: '', author: '', state: 'open' };

/**
 * "Manage filters…" (spec 10 §4.5): list, add, rename / edit and delete custom PR filters of the active
 * profile. GitHub remotes get a search-query field (`label:bug is:draft`); other providers use the
 * structured author / state fields.
 */
export function PrFiltersDialog({
  open,
  onClose,
  queryCapable,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  /** Show the GitHub search-query field. */
  queryCapable: boolean;
  /** Called with the id of a newly added filter (e.g. to select it). */
  onCreated?(id: string): void;
}) {
  return (
    <Modal title="Pull request filters" open={open} onClose={onClose}>
      <FiltersEditor queryCapable={queryCapable} onCreated={onCreated} />
    </Modal>
  );
}

function FiltersEditor({ queryCapable, onCreated }: { queryCapable: boolean; onCreated?(id: string): void }) {
  const qc = useQueryClient();
  const filters = usePrFilters();
  const saved = filters.data ?? EMPTY;
  const [editing, setEditing] = useState<string | null>(null); // id, or null = new
  const [draft, setDraft] = useState<FilterDraft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const validation = validateFilterDraft(draft, saved, editing ?? undefined);

  const persist = async (next: SavedPrFilter[]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await intInvoke('pr:saveFilters', { filters: next });
      qc.setQueryData(ik.prFilters(), res);
      void qc.invalidateQueries({ queryKey: ['pr', 'list'] });
      return true;
    } catch (e) {
      setError(errorLine(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setEditing(null);
    setDraft(BLANK);
    setTouched(false);
  };

  const save = async (): Promise<void> => {
    setTouched(true);
    if (validation) return;
    const id = editing ?? newFilterId(saved);
    const entry: SavedPrFilter = {
      id,
      name: draft.name.trim(),
      filter: draftToFilter(queryCapable ? draft : { ...draft, query: undefined }),
    };
    if (await persist(upsertFilter(saved, entry))) {
      if (!editing) onCreated?.(id);
      reset();
    }
  };

  const remove = async (f: SavedPrFilter): Promise<void> => {
    if (!(await confirm(`Delete filter “${f.name}”?`, 'The saved filter is removed.', 'Delete', true)))
      return;
    if ((await persist(removeFilter(saved, f.id))) && editing === f.id) reset();
  };

  const set = (patch: Partial<FilterDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className={s.root}>
      <section aria-label="Saved filters">
        {filters.isPending ? (
          <p className={s.hint}>Loading filters…</p>
        ) : saved.length === 0 ? (
          <p className={s.hint}>No custom filters yet.</p>
        ) : (
          <ul className={s.list}>
            {saved.map((f) => (
              <li key={f.id} className={`${s.item} ${editing === f.id ? s.itemActive : ''}`}>
                <div className={s.itemMain}>
                  <span className={s.name}>{f.name}</span>
                  <span className={s.detail}>{describeFilter(f.filter)}</span>
                </div>
                <button
                  type="button"
                  className={s.iconBtn}
                  title="Edit filter"
                  aria-label={`Edit ${f.name}`}
                  onClick={() => {
                    setEditing(f.id);
                    setDraft(filterToDraft(f));
                    setTouched(false);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className={s.iconBtn}
                  title="Delete filter"
                  aria-label={`Delete ${f.name}`}
                  disabled={busy}
                  onClick={() => void remove(f)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className={s.form}
        aria-label={editing ? 'Edit filter' : 'New filter'}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>{editing ? 'Edit filter' : 'New filter'}</h3>
        <label className={s.field}>
          Name
          <input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        {queryCapable && (
          <label className={s.field}>
            Search query
            <input
              type="text"
              value={draft.query ?? ''}
              spellCheck={false}
              placeholder="label:bug is:draft review:required"
              onChange={(e) => set({ query: e.target.value })}
            />
            <span className={s.hint}>GitHub search qualifiers; the repository is added automatically.</span>
          </label>
        )}
        <div className={s.row}>
          <label className={s.field}>
            Author
            <input
              type="text"
              value={draft.author ?? ''}
              spellCheck={false}
              placeholder="login"
              onChange={(e) => set({ author: e.target.value })}
            />
          </label>
          <label className={s.field}>
            State
            <select
              value={draft.state ?? 'open'}
              onChange={(e) => set({ state: e.target.value as PrStateFilter })}
            >
              <option value="open">Open</option>
              <option value="merged">Merged</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>
        {touched && validation && <p className={s.error}>{validation}</p>}
        {error && <p className={s.error}>{error}</p>}
        <div className={s.actions}>
          {editing && (
            <button type="button" onClick={reset}>
              Cancel edit
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || (touched && !!validation)}>
            {busy ? <Loader2 size={14} className={uiStyles.spin} /> : editing ? null : <Plus size={14} />}{' '}
            {editing ? 'Save changes' : 'Add filter'}
          </button>
        </div>
      </form>
    </div>
  );
}
