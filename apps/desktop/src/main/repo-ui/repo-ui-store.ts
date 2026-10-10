import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { GraphColumnId, GraphColumnLayout, RepoUiState } from '../../shared/ipc/graph-contract';
import { sanitizeLeftPanelLayout } from '../../shared/left-panel/layout';
import { writeFileAtomic } from '../settings/atomic-file';

/**
 * Per-repository graph UI state (spec 04 §4.2 column layout, §2.6 hide/solo/pin; spec 01 §4.5):
 * `userData/repos/<repoKey>/graph.json`. The key is derived from the repository's common git dir so
 * linked worktrees of one repository share their visibility state.
 */

export const DEFAULT_REPO_UI: Readonly<RepoUiState> = Object.freeze({
  hiddenRefs: [],
  soloRefs: [],
  pinnedRefs: [],
  columns: null,
  leftPanel: null,
});

const COLUMN_IDS: readonly GraphColumnId[] = ['refs', 'graph', 'message', 'author', 'date', 'sha'];
const MAX_REFS = 5000;
const MAX_NAME = 1024;

/** `<sha1(path)[0..16]>-<folder name>`; case-insensitive on Windows/macOS. */
export function repoKey(repoPath: string, platform: NodeJS.Platform = process.platform): string {
  const norm = path.resolve(repoPath).replace(/[\\/]+$/, '');
  const id = platform === 'linux' ? norm : norm.toLowerCase();
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 16);
  const base = path
    .basename(id.replace(/[\\/]\.git$/i, ''))
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 40);
  return base ? `${hash}-${base}` : hash;
}

function cleanNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x || x.length > MAX_NAME || /[\0\n\r]/.test(x) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

function cleanColumns(v: unknown): GraphColumnLayout | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Partial<GraphColumnLayout>;
  const order: GraphColumnId[] = [];
  for (const id of Array.isArray(c.order) ? c.order : []) {
    if (COLUMN_IDS.includes(id) && !order.includes(id)) order.push(id);
  }
  for (const id of COLUMN_IDS) if (!order.includes(id)) order.push(id);
  const widths: GraphColumnLayout['widths'] = {};
  const visible: GraphColumnLayout['visible'] = {};
  for (const id of COLUMN_IDS) {
    const w = c.widths?.[id];
    if (typeof w === 'number' && Number.isFinite(w)) widths[id] = Math.max(24, Math.min(2000, Math.round(w)));
    const vis = c.visible?.[id];
    if (typeof vis === 'boolean') visible[id] = vis;
  }
  visible.message = true; // the message column always stays visible (§4.2)
  return { order, widths, visible };
}

/** Validates untrusted input (renderer patch or a hand-edited file) into a partial state. */
export function sanitizeRepoUi(v: unknown): Partial<RepoUiState> {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: Partial<RepoUiState> = {};
  const hidden = cleanNames(o.hiddenRefs);
  const solo = cleanNames(o.soloRefs);
  const pinned = cleanNames(o.pinnedRefs);
  const columns = cleanColumns(o.columns);
  const leftPanel = o.leftPanel === null ? null : sanitizeLeftPanelLayout(o.leftPanel);
  if (hidden) out.hiddenRefs = hidden;
  if (solo) out.soloRefs = solo;
  if (pinned) out.pinnedRefs = pinned;
  if (columns !== undefined) out.columns = columns;
  if (leftPanel !== undefined) out.leftPanel = leftPanel;
  return out;
}

export class RepoUiStore {
  private readonly cache = new Map<string, RepoUiState>();

  /** `dir` is `userData/repos`. */
  constructor(
    private readonly dir: () => string,
    private readonly log?: (m: string, e?: unknown) => void,
  ) {}

  fileFor(repoPath: string): string {
    return path.join(this.dir(), repoKey(repoPath), 'graph.json');
  }

  get(repoPath: string): RepoUiState {
    const file = this.fileFor(repoPath);
    const hit = this.cache.get(file);
    if (hit) return clone(hit);
    let state: RepoUiState = { ...DEFAULT_REPO_UI };
    try {
      state = { ...DEFAULT_REPO_UI, ...sanitizeRepoUi(JSON.parse(fs.readFileSync(file, 'utf8'))) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.(`ignoring unreadable ${file}`, e);
    }
    this.cache.set(file, state);
    return clone(state);
  }

  save(repoPath: string, patch: unknown): RepoUiState {
    const file = this.fileFor(repoPath);
    const next: RepoUiState = { ...this.get(repoPath), ...sanitizeRepoUi(patch) };
    this.cache.set(file, next);
    writeFileAtomic(file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    return clone(next);
  }
}

function clone(s: RepoUiState): RepoUiState {
  return {
    hiddenRefs: [...s.hiddenRefs],
    soloRefs: [...s.soloRefs],
    pinnedRefs: [...s.pinnedRefs],
    columns: s.columns
      ? { order: [...s.columns.order], widths: { ...s.columns.widths }, visible: { ...s.columns.visible } }
      : null,
    leftPanel: s.leftPanel
      ? {
          ...s.leftPanel,
          collapsed: [...s.leftPanel.collapsed],
          hidden: [...s.leftPanel.hidden],
          enabled: [...s.leftPanel.enabled],
          heights: { ...s.leftPanel.heights },
        }
      : null,
  };
}
