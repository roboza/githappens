import type { CoAuthor } from '../../shared/ipc/commit-contract';

/** Parse `git shortlog -sne` output (`   12\tName <email>`), most commits first. */
export function parseShortlog(stdout: string): (CoAuthor & { commits: number })[] {
  const out: (CoAuthor & { commits: number })[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*?)\s*<([^>]*)>\s*$/.exec(line);
    if (!m || !m[3]!.trim()) continue;
    out.push({ commits: Number(m[1]), name: m[2]!.trim(), email: m[3]!.trim() });
  }
  return out.sort((a, b) => b.commits - a.commits);
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Merge history authors with provider collaborators, dedupe by email (case-insensitive; history wins),
 * drop `exclude` emails (the committer), filter by `q` on name or email, cap at `limit`. Prefix matches
 * rank before substring matches; ties keep the input order (commit count).
 */
export function filterCoAuthors(
  sources: CoAuthor[][],
  q: string,
  o: { limit?: number; exclude?: string[] } = {},
): CoAuthor[] {
  const limit = o.limit ?? 20;
  const exclude = new Set((o.exclude ?? []).map(lower));
  const seen = new Set<string>();
  const all: CoAuthor[] = [];
  for (const list of sources) {
    for (const c of list) {
      const key = lower(c.email.trim());
      if (!key || seen.has(key) || exclude.has(key) || key.endsWith('@users.noreply.localhost')) continue;
      seen.add(key);
      all.push({ name: c.name.trim() || c.email.trim(), email: c.email.trim() });
    }
  }
  const t = lower(q.trim());
  if (!t) return all.slice(0, limit);
  const prefix: CoAuthor[] = [];
  const contains: CoAuthor[] = [];
  for (const c of all) {
    const n = lower(c.name);
    const e = lower(c.email);
    if (n.startsWith(t) || e.startsWith(t) || n.split(/\s+/).some((w) => w.startsWith(t))) prefix.push(c);
    else if (n.includes(t) || e.includes(t)) contains.push(c);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** Per-repo TTL cache for the (potentially slow) shortlog over all refs. */
export class ShortlogCache {
  private readonly entries = new Map<string, { at: number; value: Promise<CoAuthor[]> }>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<CoAuthor[]>): Promise<CoAuthor[]> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = load().catch((e: unknown) => {
      this.entries.delete(key);
      throw e;
    });
    this.entries.set(key, { at: this.now(), value });
    return value;
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
