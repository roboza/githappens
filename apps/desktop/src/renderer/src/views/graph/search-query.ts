/**
 * Graph search query grammar (spec 12 §11, shared with `GraphSearchReq`; spec 04 §4.12 prefixes).
 * Pure: no React, no IPC.
 *
 * | Input       | Term                         |
 * |-------------|------------------------------|
 * | `text`      | message + author + SHA prefix |
 * | `@name`     | author name / email (`@me` = profile email) |
 * | `#abc123`   | SHA prefix (≥ 4 hex) or ref name |
 * | `file:glob` | commits touching a path      |
 * | `~text`     | content added / removed (pickaxe `-S`) |
 * | `=regex`    | content regex (`-G`)         |
 * | `/regex/`   | message regex (`--grep -E`)  |
 *
 * Terms separated by spaces are ANDed; quoted strings keep spaces (`"fix bug"`, `@"Ann Lee"`,
 * `file:"my dir"`); an unknown prefix (`foo:bar`) is plain text.
 */
import type { CommitSummary, SearchField, SearchKind, SearchQuery, SearchTerm } from '@githappens/git/types';

export interface QueryTerm extends SearchTerm {
  regex: boolean;
}

export interface ParsedQuery {
  /** Trimmed input. */
  text: string;
  /** ANDed terms; empty for a blank query. */
  terms: QueryTerm[];
  /** Union of the fields searched (spec 12 `GraphSearchReq.fields`). */
  fields: Exclude<SearchField, 'any'>[];
  /** Needs a git-side search over the entire history (path / content terms, `#ref`). */
  deep: boolean;
  /** Inline error (bad regex, unsupported combination); the query matches nothing while set. */
  error: string | null;
}

export interface ParseOptions {
  /** Profile email for `@me`. */
  me?: string | null;
}

/** Split on whitespace outside quotes; `/regex/` tokens may contain spaces. */
export function tokenize(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /\s/.test(raw[i]!)) i++;
    if (i >= n) break;
    if (raw[i] === '/') {
      const end = closingSlash(raw, i + 1);
      if (end > i + 1) {
        out.push(raw.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    let tok = '';
    while (i < n && !/\s/.test(raw[i]!)) {
      if (raw[i] === '"') {
        const close = closingQuote(raw, i + 1);
        tok += raw.slice(i, close + 1);
        i = close + 1;
      } else tok += raw[i++];
    }
    out.push(tok);
  }
  return out;
}

/** Index of the `/` closing a regex opened before `from` (followed by whitespace / end), or -1. */
function closingSlash(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '/' && (j + 1 === s.length || /\s/.test(s[j + 1]!))) return j;
  }
  return -1;
}

/** Index of the closing `"` (or the last index when unterminated). */
function closingQuote(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '"') j++;
    else if (s[j] === '"') return j;
  }
  return s.length - 1;
}

/** Remove quote delimiters (`\"` = a literal quote). */
export function unquote(s: string): string {
  let out = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '"') out += s[++j];
    else if (s[j] !== '"') out += s[j];
  }
  return out;
}

const HEX = /^[0-9a-f]+$/i;

function termOf(tok: string, o: ParseOptions): QueryTerm | null {
  if (tok.length > 2 && tok.startsWith('/') && tok.endsWith('/')) {
    return { field: 'message', text: tok.slice(1, -1).replace(/\\\//g, '/'), regex: true };
  }
  const prefixed = (field: QueryTerm['field'], rest: string, regex = false): QueryTerm | null => {
    const text = unquote(rest);
    return text ? { field, text, regex } : null;
  };
  if (tok.startsWith('@')) {
    const t = prefixed('author', tok.slice(1));
    if (t && t.text.toLowerCase() === 'me' && o.me) t.text = o.me;
    return t;
  }
  if (tok.startsWith('#')) return prefixed('sha', tok.slice(1));
  if (/^file:/i.test(tok)) return prefixed('path', tok.slice(5));
  if (tok.startsWith('~')) return prefixed('content', tok.slice(1));
  if (tok.startsWith('=')) return prefixed('content', tok.slice(1), true);
  return prefixed('any', tok); // unknown prefixes (`foo:bar`) are plain text
}

export function parseQuery(raw: string, o: ParseOptions = {}): ParsedQuery {
  const text = raw.trim();
  const terms = tokenize(text)
    .map((t) => termOf(t, o))
    .filter((t): t is QueryTerm => !!t);
  const fields = new Set<ParsedQuery['fields'][number]>();
  for (const t of terms) {
    if (t.field === 'any') ['message', 'author', 'sha'].forEach((f) => fields.add(f as 'message'));
    else fields.add(t.field);
  }
  let error: string | null = null;
  for (const t of terms) {
    if (!t.regex) continue;
    try {
      new RegExp(t.text);
    } catch (e) {
      error = `Invalid regular expression: ${t.text} (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  if (terms.filter((t) => t.field === 'content').length > 1) error ??= 'Only one ~ or = term per search';
  if (terms.filter((t) => t.field === 'path').length > 1) error ??= 'Only one file: term per search';
  const deep = terms.some(
    (t) => t.field === 'path' || t.field === 'content' || (t.field === 'sha' && !HEX.test(t.text)),
  );
  return { text, terms, fields: [...fields], deep, error };
}

/** In-memory match on a loaded commit: every term must match (case-insensitive). */
export function matchesCommit(c: CommitSummary, q: ParsedQuery): boolean {
  if (!q.terms.length || q.error) return false;
  return q.terms.every((t) => termMatches(c, t));
}

function termMatches(c: CommitSummary, t: QueryTerm): boolean {
  const needle = t.text.toLowerCase();
  const message = (): string => (c.body ? `${c.subject}\n${c.body}` : c.subject);
  const author = (): boolean =>
    c.authorName.toLowerCase().includes(needle) || c.authorEmail.toLowerCase().includes(needle);
  const sha = (): boolean => c.sha.startsWith(needle);
  switch (t.field) {
    case 'any':
      return message().toLowerCase().includes(needle) || author() || sha();
    case 'message':
      return t.regex ? new RegExp(t.text, 'im').test(message()) : message().toLowerCase().includes(needle);
    case 'author':
      return author();
    case 'sha':
      return sha();
    default:
      return false; // path / content need git (deep search)
  }
}

const LEGACY_KIND: Record<SearchField, SearchKind> = {
  any: 'message',
  message: 'message',
  author: 'author',
  sha: 'sha',
  path: 'file',
  content: 'content',
};

/** `graph:search` request for a parsed query (deep search, spec 12 §6.7). */
export function toSearchQuery(
  q: ParsedQuery,
  extra: { searchId?: string; limit?: number } = {},
): SearchQuery {
  const first = q.terms[0];
  const kind: SearchKind = first
    ? first.field === 'content' && first.regex
      ? 'regex'
      : LEGACY_KIND[first.field]
    : 'message';
  return {
    kind,
    text: first?.text ?? '',
    terms: q.terms.map(({ field, text, regex }) => ({ field, text, regex })),
    ...extra,
  };
}
