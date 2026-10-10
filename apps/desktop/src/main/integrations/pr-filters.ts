import path from 'node:path';

import type { PrFilter } from '@githappens/providers/types';

import type { SavedPrFilter } from '../../shared/ipc/integrations-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/** Custom PR filters (spec 10 §4.5), saved per profile in `pr-filters.json`. */

interface FiltersFile {
  version: 1;
  filters: SavedPrFilter[];
}

const PRESETS = new Set(['mine', 'review-requested', 'assigned', 'all']);
const STATES = new Set(['open', 'closed', 'merged', 'all']);
const MAX_FILTERS = 50;

/** Validate and normalize filters coming from the renderer; drops anything malformed. */
export function sanitizePrFilters(input: unknown): SavedPrFilter[] {
  if (!Array.isArray(input)) throw new Error('Invalid filters');
  const out: SavedPrFilter[] = [];
  const ids = new Set<string>();
  for (const raw of input.slice(0, MAX_FILTERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<SavedPrFilter>;
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : '';
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '';
    if (!id || !name || ids.has(id)) continue;
    const f = (r.filter ?? {}) as Record<string, unknown>;
    const filter: PrFilter = {};
    if (typeof f.preset === 'string' && PRESETS.has(f.preset)) filter.preset = f.preset as PrFilter['preset'];
    if (typeof f.state === 'string' && STATES.has(f.state)) filter.state = f.state as PrFilter['state'];
    for (const k of ['query', 'author', 'head'] as const) {
      const v = f[k];
      if (typeof v === 'string' && v.trim()) filter[k] = v.trim().slice(0, 500);
    }
    ids.add(id);
    out.push({ id, name, filter });
  }
  return out;
}

export class PrFilterStore {
  constructor(private readonly dir: () => string) {}

  private get file(): string {
    return path.join(this.dir(), 'pr-filters.json');
  }

  list(): SavedPrFilter[] {
    const r = readJson<FiltersFile>(this.file);
    if (r.kind !== 'ok' || !r.value) return [];
    try {
      return sanitizePrFilters(r.value.filters);
    } catch {
      return [];
    }
  }

  save(filters: unknown): SavedPrFilter[] {
    const clean = sanitizePrFilters(filters);
    const data: FiltersFile = { version: 1, filters: clean };
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
    return clean;
  }
}
