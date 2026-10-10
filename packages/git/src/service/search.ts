/**
 * Full-history graph search (spec 12 §6.7, §11; spec 04 §6.8.2): turns ANDed query terms into one
 * `git log` invocation plus an in-process post-filter for what git cannot AND by itself, and keeps a
 * registry of running searches so they can be cancelled (`graph:search:cancel`) and polled for partial
 * results (`graph:search:progress`).
 */
import type { SearchProgress, SearchQuery, SearchTerm, Sha } from '../types';

/** Record terminator / field separator of the search `--format` (ASCII RS / US: not in sha, time or names). */
const RS = '\x1e';
const US = '\x1f';

/** The legacy single-kind query as terms. */
export function searchTerms(q: Pick<SearchQuery, 'kind' | 'text' | 'terms'>): SearchTerm[] {
  const terms: SearchTerm[] = q.terms
    ? q.terms
    : [
        q.kind === 'file'
          ? { field: 'path', text: q.text }
          : q.kind === 'regex'
            ? { field: 'content', text: q.text, regex: true }
            : { field: q.kind, text: q.text },
      ];
  return terms.filter((t) => typeof t?.text === 'string' && t.text.length > 0);
}

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

export interface SearchPlan {
  /** Filter flags for `git log` (before the rev set). */
  filter: string[];
  /** Pathspecs (after `--`). */
  paths: string[];
  /** `GIT_LITERAL_PATHSPECS` (off only for `file:` globs). */
  literalPathspecs: boolean;
  /** Terms git cannot AND (several authors, `any`, `sha`): checked on the streamed records. */
  post: SearchTerm[];
  /** `--format` of each record. Post-filtering needs author and message. */
  format: string;
  caseSensitive: boolean;
}

/** Escape a literal for a POSIX ERE (`-E` mode). */
export function escapeEre(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/** Pathspec for a `file:` term: a glob when it has wildcards, else a substring of any path. */
export function pathspecFor(text: string, caseSensitive: boolean): string[] {
  const magic = caseSensitive ? ':(glob)' : ':(glob,icase)';
  if (/[*?[]/.test(text)) {
    const g = text.replace(/^\/+/, '');
    return text.includes('/') ? [`${magic}${g}`] : [`${magic}**/${g}`];
  }
  const lit = text.replace(/[*?[\]\\]/g, '\\$&');
  return [`${magic}**/*${lit}*`, `${magic}**/*${lit}*/**`];
}

/**
 * Build the `git log` arguments for ANDed terms (spec 12 §11):
 * - message terms → one `--grep` each + `--all-match`; any `/regex/` switches to `-E` (literals escaped),
 *   otherwise `--fixed-strings`;
 * - one author term → `--author` (several are ORed by git even with `--all-match`, so they post-filter);
 * - `~text` → `-S`, `=regex` → `-G` (one per search: git allows a single pickaxe);
 * - `file:` → pathspec (one per search: pathspecs are ORed);
 * - `any` (message | author | sha prefix) and `#sha` terms → post-filter on the streamed records.
 */
export function buildSearchPlan(terms: readonly SearchTerm[], caseSensitive = false): SearchPlan {
  const by = (f: SearchTerm['field']) => terms.filter((t) => t.field === f);
  const message = by('message');
  const authors = by('author');
  const content = by('content');
  const paths = by('path');
  if (content.length > 1) throw new SearchQueryError('Only one content (~ or =) term per search');
  if (paths.length > 1) throw new SearchQueryError('Only one file: term per search');

  const regexMode = message.some((t) => t.regex);
  const lit = (s: string): string => (regexMode ? escapeEre(s) : s);
  const filter: string[] = [];
  for (const t of message) filter.push(`--grep=${t.regex ? t.text : lit(t.text)}`);
  if (message.length > 1) filter.push('--all-match');
  const post: SearchTerm[] = terms.filter((t) => t.field === 'any' || t.field === 'sha');
  if (authors.length === 1) filter.push(`--author=${lit(authors[0]!.text)}`);
  else post.push(...authors);
  if (message.length || authors.length === 1)
    filter.push(regexMode ? '--extended-regexp' : '--fixed-strings');
  const c = content[0];
  if (c) filter.push(c.regex ? `-G${c.text}` : `-S${c.text}`);
  if (!caseSensitive) filter.push('--regexp-ignore-case');

  const p = paths[0];
  return {
    filter,
    paths: p ? pathspecFor(p.text, caseSensitive) : [],
    literalPathspecs: !p,
    post,
    format: post.length ? `--format=%H${US}%ct${US}%an${US}%ae${US}%B${RS}` : `--format=%H${US}%ct${RS}`,
    caseSensitive,
  };
}

export interface SearchRecord {
  sha: Sha;
  time: number;
  authorName: string;
  authorEmail: string;
  message: string;
}

/** Incremental parser of the `--format` records (split across stdout chunks). */
export class SearchRecordParser {
  private buf = '';
  push(chunk: string): SearchRecord[] {
    this.buf += chunk;
    const parts = this.buf.split(RS);
    this.buf = parts.pop() ?? '';
    return parts.filter((p) => p.trim()).map(parseRecord);
  }
  end(): SearchRecord[] {
    const rest = this.buf;
    this.buf = '';
    return rest.trim() ? [parseRecord(rest)] : [];
  }
}

function parseRecord(s: string): SearchRecord {
  // each record is terminated by RS; `--format` (tformat) adds a newline after it
  const [sha = '', time = '0', authorName = '', authorEmail = '', ...msg] = s.replace(/^\r?\n/, '').split(US);
  return {
    sha: sha.trim(),
    time: Number(time) || 0,
    authorName,
    authorEmail,
    message: msg.join(US),
  };
}

/** Post-filter: every term must match (substring; `sha` = prefix). */
export function recordMatches(r: SearchRecord, terms: readonly SearchTerm[], caseSensitive = false): boolean {
  const norm = (s: string): string => (caseSensitive ? s : s.toLowerCase());
  return terms.every((t) => {
    const needle = norm(t.text);
    const sha = r.sha.startsWith(t.text.toLowerCase());
    const author = norm(r.authorName).includes(needle) || norm(r.authorEmail).includes(needle);
    switch (t.field) {
      case 'sha':
        return sha;
      case 'author':
        return author;
      case 'message':
        return norm(r.message).includes(needle);
      case 'any':
        return sha || author || norm(r.message).includes(needle);
      default:
        return true; // path / content are always applied by git
    }
  });
}

// ---- registry: cancel + progress (process-wide; search ids are renderer-generated UUIDs) ----

interface Entry {
  controller: AbortController;
  progress: Omit<SearchProgress, 'searchId'>;
}
const running = new Map<string, Entry>();
const finished = new Map<string, Omit<SearchProgress, 'searchId'>>();
const FINISHED_KEEP = 32;

export interface SearchHandle {
  signal: AbortSignal;
  progress: Omit<SearchProgress, 'searchId'>;
  finish(cancelled: boolean): void;
}

/** Register a search; the returned signal aborts on `cancelSearch(searchId)` or the caller's signal. */
export function registerSearch(searchId: string | undefined, signal?: AbortSignal): SearchHandle {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const progress: Omit<SearchProgress, 'searchId'> = {
    scanned: 0,
    shas: [],
    total: 0,
    reachedTime: null,
    done: false,
    cancelled: false,
  };
  if (searchId) {
    running.get(searchId)?.controller.abort();
    running.set(searchId, { controller, progress });
  }
  return {
    signal: combined,
    progress,
    finish: (cancelled) => {
      progress.done = true;
      progress.cancelled = cancelled;
      if (!searchId || running.get(searchId)?.progress !== progress) return;
      running.delete(searchId);
      finished.set(searchId, progress);
      while (finished.size > FINISHED_KEEP) finished.delete(finished.keys().next().value!);
    },
  };
}

/** Abort a running search (`graph:search:cancel`); its `graph:search` rejects with `Cancelled`. */
export function cancelSearch(searchId: string): boolean {
  const e = running.get(searchId);
  if (!e) return false;
  e.controller.abort();
  return true;
}

/** Progress snapshot with matches from index `from` on (`graph:search:progress`); null if unknown. */
export function searchProgress(searchId: string, from = 0): SearchProgress | null {
  const p = running.get(searchId)?.progress ?? finished.get(searchId);
  if (!p) return null;
  return { searchId, ...p, shas: p.shas.slice(Math.max(0, Math.floor(from) || 0)) };
}
