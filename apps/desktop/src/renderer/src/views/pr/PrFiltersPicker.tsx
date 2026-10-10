import type { RepoId } from '@githappens/git/types';
import type { PrFilter } from '@githappens/providers/types';
import { ChevronDown, Filter, Settings2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import type { SavedPrFilter } from '../../../../shared/ipc/integrations-contract';
import {
  BUILTIN_PR_FILTERS,
  customSelection,
  describeFilter,
  effectiveSelection,
  parseSelection,
  resolvePrFilter,
  selectionLabel,
} from '../../integrations/pr-filter-helpers';
import { usePrFilters } from '../../integrations/queries';
import { useIntegrationPrefs } from '../../integrations/stores';
import { FilterDropdown, type DropdownItem } from '../../shell/FilterDropdown';
import s from './PullRequestsSection.module.css';

const EMPTY: SavedPrFilter[] = [];
const storeKey = (repoId: RepoId): string => `kl.pr.filterSelection.${repoId}`;

function loadStored(repoId: RepoId): string | null {
  try {
    return window.localStorage.getItem(storeKey(repoId));
  } catch {
    return null;
  }
}

function writeStored(repoId: RepoId, sel: string | null): void {
  try {
    if (sel) window.localStorage.setItem(storeKey(repoId), sel);
    else window.localStorage.removeItem(storeKey(repoId));
  } catch {
    // storage unavailable: the selection lasts for this session only
  }
}

export interface PrFilterSelection {
  /** Selection id (`preset:mine`, `state:merged`, `custom:<id>`). */
  selection: string;
  filter: PrFilter;
  label: string;
  saved: SavedPrFilter[];
  /** False while a stored custom filter is still loading (avoid listing the fallback preset). */
  ready: boolean;
  select(sel: string): void;
}

/**
 * The PR-list filter of a repo (spec 10 §4.5). Presets live in `useIntegrationPrefs` (as before); state
 * and custom selections are remembered per repo in localStorage and win over the preset while they
 * resolve.
 */
export function usePrFilterSelection(repoId: RepoId): PrFilterSelection {
  const preset = useIntegrationPrefs((st) => st.prPreset[repoId] ?? 'mine');
  const setPreset = useIntegrationPrefs((st) => st.setPrPreset);
  const filters = usePrFilters();
  const saved = filters.data ?? EMPTY;
  const [stored, setStored] = useState(() => loadStored(repoId));
  const parsed = parseSelection(stored);
  const ready = !(parsed?.kind === 'custom' && filters.isPending);
  const selection = effectiveSelection(stored, preset, saved);
  const select = useCallback(
    (sel: string) => {
      const p = parseSelection(sel);
      if (!p) return;
      if (p.kind === 'preset') {
        setPreset(repoId, p.preset);
        setStored(null);
        writeStored(repoId, null);
      } else {
        setStored(sel);
        writeStored(repoId, sel);
      }
    },
    [repoId, setPreset],
  );
  return {
    selection,
    filter: resolvePrFilter(selection, saved) ?? { preset, state: 'open' },
    label: selectionLabel(selection, saved),
    saved,
    ready,
    select,
  };
}

/** Toolbar button that opens the filter dropdown (presets, state filters, saved filters, manage). */
export function PrFiltersButton({ sel, onManage }: { sel: PrFilterSelection; onManage(): void }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  // The dropdown closes on any outside mousedown — including one on this button — so a click right
  // after that close must not reopen it.
  const closedAt = useRef(0);
  const close = useCallback(() => {
    closedAt.current = Date.now();
    setAnchor(null);
  }, []);
  const items: DropdownItem[] = [
    ...BUILTIN_PR_FILTERS.map((b) => ({
      id: b.id,
      label: b.label,
      group: b.group === 'Presets' ? 'Open pull requests' : 'By state',
      current: b.id === sel.selection,
    })),
    ...sel.saved.map((f) => ({
      id: customSelection(f.id),
      label: f.name,
      detail: describeFilter(f.filter),
      group: 'Saved filters',
      current: customSelection(f.id) === sel.selection,
    })),
  ];
  return (
    <>
      <button
        type="button"
        className={s.filterBtn}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        title="Filter pull requests"
        onClick={(e) => {
          if (anchor || Date.now() - closedAt.current < 300) return;
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: r.left, top: r.bottom + 2 });
        }}
      >
        <Filter size={12} aria-hidden />
        <span className={s.filterLabel}>{sel.label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {anchor && (
        <FilterDropdown
          anchor={anchor}
          items={items}
          label="Pull request filter"
          placeholder="Filter…"
          actions={[
            {
              label: 'Manage filters…',
              icon: <Settings2 size={13} />,
              onSelect: () => {
                close();
                onManage();
              },
            },
          ]}
          onPick={(id) => {
            sel.select(id);
            close();
          }}
          onClose={close}
        />
      )}
    </>
  );
}
