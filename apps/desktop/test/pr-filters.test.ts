import { describe, expect, it } from 'vitest';

import type { SavedPrFilter } from '../src/shared/ipc/integrations-contract';
import {
  BUILTIN_PR_FILTERS,
  customSelection,
  describeFilter,
  draftToFilter,
  effectiveSelection,
  emptyListText,
  filterToDraft,
  newFilterId,
  parseSelection,
  removeFilter,
  resolvePrFilter,
  selectionLabel,
  upsertFilter,
  validateFilterDraft,
} from '../src/renderer/src/integrations/pr-filter-helpers';

const saved: SavedPrFilter[] = [
  { id: 'f-1', name: 'Bugs', filter: { preset: 'all', state: 'open', query: 'label:bug' } },
  { id: 'f-2', name: 'Alice merged', filter: { preset: 'all', state: 'merged', author: 'alice' } },
];

describe('pr filter selections', () => {
  it('parses selection ids', () => {
    expect(parseSelection('preset:mine')).toEqual({ kind: 'preset', preset: 'mine' });
    expect(parseSelection('state:merged')).toEqual({ kind: 'state', state: 'merged' });
    expect(parseSelection('custom:f-1')).toEqual({ kind: 'custom', id: 'f-1' });
    expect(parseSelection('preset:nope')).toBeNull();
    expect(parseSelection('state:open')).toBeNull();
    expect(parseSelection('custom:')).toBeNull();
    expect(parseSelection('garbage')).toBeNull();
    expect(parseSelection(null)).toBeNull();
  });

  it('falls back to the preset when the stored custom filter is gone', () => {
    expect(effectiveSelection('custom:f-1', 'assigned', saved)).toBe('custom:f-1');
    expect(effectiveSelection('custom:gone', 'assigned', saved)).toBe('preset:assigned');
    expect(effectiveSelection('state:closed', 'mine', saved)).toBe('state:closed');
    expect(effectiveSelection(null, 'all', saved)).toBe('preset:all');
  });

  it('resolves built-in, state and custom filters', () => {
    expect(resolvePrFilter('preset:review-requested', saved)).toEqual({
      preset: 'review-requested',
      state: 'open',
    });
    expect(resolvePrFilter('state:merged', saved)).toEqual({ preset: 'all', state: 'merged' });
    expect(resolvePrFilter(customSelection('f-1'), saved)).toEqual({
      preset: 'all',
      state: 'open',
      query: 'label:bug',
    });
    expect(resolvePrFilter(customSelection('f-2'), saved)).toEqual({
      preset: 'all',
      state: 'merged',
      author: 'alice',
    });
    expect(resolvePrFilter('custom:gone', saved)).toBeNull();
  });

  it('labels selections', () => {
    expect(selectionLabel('preset:all', saved)).toBe('All open');
    expect(selectionLabel('state:merged', saved)).toBe('Recently merged');
    expect(selectionLabel('custom:f-2', saved)).toBe('Alice merged');
    expect(BUILTIN_PR_FILTERS.map((b) => b.id)).toContain('state:closed');
  });

  it('describes filters and empty states', () => {
    expect(describeFilter({ query: 'label:bug  is:draft' })).toBe('label:bug  is:draft');
    expect(describeFilter({ author: 'bob', state: 'closed' })).toBe('author: bob · state: closed');
    expect(describeFilter({})).toBe('state: open');
    expect(emptyListText({ state: 'merged' })).toBe('No recently merged pull requests');
    expect(emptyListText({ state: 'open', query: 'x' })).toBe('No pull requests match this filter');
    expect(emptyListText(null)).toBe('No open pull requests');
  });
});

describe('saved filter editing', () => {
  it('validates drafts', () => {
    expect(validateFilterDraft({ name: '', query: 'x' }, saved)).toMatch(/name/);
    expect(validateFilterDraft({ name: 'bugs', query: 'x' }, saved)).toMatch(/already exists/);
    expect(validateFilterDraft({ name: 'bugs', query: 'x' }, saved, 'f-1')).toBeNull();
    expect(validateFilterDraft({ name: 'Mine', query: 'x' }, saved)).toMatch(/built-in/);
    expect(validateFilterDraft({ name: 'X', query: 'repo:a/b is:open' }, saved)).toMatch(/repo:/);
    expect(validateFilterDraft({ name: 'X' }, saved)).toMatch(/Add a query/);
    expect(validateFilterDraft({ name: 'X', state: 'closed' }, saved)).toBeNull();
    expect(validateFilterDraft({ name: 'X', query: 'q'.repeat(300) }, saved)).toMatch(/at most/);
  });

  it('builds filters from drafts and back', () => {
    expect(
      draftToFilter({ name: 'n', query: '  label:bug   is:draft ', author: ' ', state: 'open' }),
    ).toEqual({
      preset: 'all',
      state: 'open',
      query: 'label:bug is:draft',
    });
    expect(filterToDraft(saved[1]!)).toEqual({
      name: 'Alice merged',
      query: '',
      author: 'alice',
      state: 'merged',
    });
  });

  it('generates unique ids', () => {
    const now = 1_700_000_000_000;
    const a = newFilterId([], now);
    expect(a).toBe(`f-${now.toString(36)}`);
    const b = newFilterId([{ id: a, name: 'a', filter: {} }], now);
    expect(b).toBe(`${a}-2`);
  });

  it('upserts and removes', () => {
    const next = upsertFilter(saved, { id: 'f-1', name: 'Renamed', filter: { query: 'x' } });
    expect(next.map((f) => f.name)).toEqual(['Renamed', 'Alice merged']);
    expect(upsertFilter(saved, { id: 'f-3', name: 'New', filter: {} })).toHaveLength(3);
    expect(removeFilter(saved, 'f-1').map((f) => f.id)).toEqual(['f-2']);
  });
});
