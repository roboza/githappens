import fs from 'node:fs';
import path from 'node:path';

import type { CoAuthor, StoredDraft } from '../../shared/ipc/commit-contract';
import { repoKey } from '../repo-ui/repo-ui-store';
import { writeFileAtomic } from '../settings/atomic-file';

/** Drafts untouched for this long are pruned on load. */
export const DRAFT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 500;
const MAX_SUMMARY = 4096;
const MAX_DESCRIPTION = 256 * 1024;
const MAX_CO_AUTHORS = 50;

/** `<repoKey>\0<branch>`; a detached HEAD shares one "(detached)" draft. */
export function draftKey(repoPath: string, branch: string | null, platform?: NodeJS.Platform): string {
  return `${repoKey(repoPath, platform)}\0${branch ?? '(detached)'}`;
}

function cleanCoAuthors(v: unknown): CoAuthor[] {
  if (!Array.isArray(v)) return [];
  const out: CoAuthor[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const { name, email } = c as Partial<CoAuthor>;
    if (typeof name !== 'string' || typeof email !== 'string' || !email.trim()) continue;
    out.push({ name: name.slice(0, 256), email: email.slice(0, 256) });
    if (out.length >= MAX_CO_AUTHORS) break;
  }
  return out;
}

/** Validate an untrusted draft (renderer input or a hand-edited file); null when unusable. */
export function sanitizeDraft(v: unknown, now = Date.now()): StoredDraft | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Partial<StoredDraft>;
  const summary = typeof d.summary === 'string' ? d.summary.slice(0, MAX_SUMMARY) : '';
  const description = typeof d.description === 'string' ? d.description.slice(0, MAX_DESCRIPTION) : '';
  const coAuthors = cleanCoAuthors(d.coAuthors);
  if (!summary.trim() && !description.trim() && !coAuthors.length) return null;
  const updatedAt = typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) ? d.updatedAt : now;
  return { summary, description, coAuthors, updatedAt: Math.min(updatedAt, now) };
}

/**
 * Composer drafts per repository + branch in `userData/commit-drafts.json` (spec 06 §4.5): restored when
 * the composer reopens, across restarts. Writes are atomic; the renderer debounces (1 s).
 */
export class DraftStore {
  private cache: Map<string, StoredDraft> | null = null;

  constructor(
    private readonly userDataDir: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  get file(): string {
    return path.join(this.userDataDir(), 'commit-drafts.json');
  }

  private load(): Map<string, StoredDraft> {
    if (this.cache) return this.cache;
    const map = new Map<string, StoredDraft>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const now = this.now();
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const d = sanitizeDraft(v, now);
          if (d && now - d.updatedAt <= DRAFT_MAX_AGE_MS) map.set(k, d);
        }
      }
    } catch {
      /* missing or corrupt: start empty */
    }
    this.cache = map;
    return map;
  }

  private persist(map: Map<string, StoredDraft>): void {
    const entries = [...map.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_DRAFTS);
    if (entries.length < map.size) {
      map.clear();
      for (const [k, v] of entries) map.set(k, v);
    }
    writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(entries), null, 1));
  }

  get(repoPath: string, branch: string | null): StoredDraft | null {
    return this.load().get(draftKey(repoPath, branch)) ?? null;
  }

  /** Store (or clear with `null` / an empty draft). */
  set(repoPath: string, branch: string | null, draft: unknown): void {
    const map = this.load();
    const key = draftKey(repoPath, branch);
    const d =
      draft === null ? null : sanitizeDraft({ ...(draft as object), updatedAt: this.now() }, this.now());
    if (!d) {
      if (!map.delete(key)) return;
    } else map.set(key, d);
    this.persist(map);
  }
}
