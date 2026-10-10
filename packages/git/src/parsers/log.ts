import { StringDecoder } from 'node:string_decoder';

import type { CommitSummary } from '../types';

/**
 * Incremental parser for `git log -z --format=<LOG_FORMAT>` (spec 02 §6.6).
 *
 * Every field is terminated by our `%x00` and every record by git's `-z` NUL, so a record is
 * exactly N field tokens followed by one empty token. Partial records are buffered across chunks.
 */

const BASE_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'];

export function logFormat(o: { signature?: boolean } = {}): string {
  const fields = o.signature ? [...BASE_FIELDS, '%G?'] : BASE_FIELDS;
  return fields.map((f) => `${f}%x00`).join('');
}

export const LOG_FORMAT = logFormat();

const SIGNATURES = new Set(['G', 'B', 'U', 'X', 'Y', 'R', 'E', 'N']);

export function commitFromFields(f: string[]): CommitSummary {
  const c: CommitSummary = {
    sha: f[0]!,
    parents: f[1] ? f[1].split(' ') : [],
    authorName: f[2]!,
    authorEmail: f[3]!,
    authorTime: Number(f[4]),
    committerName: f[5]!,
    committerEmail: f[6]!,
    commitTime: Number(f[7]),
    subject: f[8]!,
  };
  const sig = f[9];
  if (sig && SIGNATURES.has(sig)) c.signature = sig as NonNullable<CommitSummary['signature']>;
  return c;
}

export class LogParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly fieldCount: number;
  private partial = '';
  private fields: string[] = [];

  constructor(o: { signature?: boolean } = {}) {
    this.fieldCount = BASE_FIELDS.length + (o.signature ? 1 : 0);
  }

  push(chunk: Buffer | string): CommitSummary[] {
    const text = this.partial + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const tokens = text.split('\0');
    this.partial = tokens.pop()!; // incomplete token (or '' when the chunk ended on a NUL)
    return this.consume(tokens);
  }

  /** Flush at end of stream. */
  end(): CommitSummary[] {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    const out = rest ? this.consume([rest]) : [];
    // A final record whose terminator never arrived is still complete if it has all its fields.
    if (this.fields.length === this.fieldCount) out.push(commitFromFields(this.fields));
    this.fields = [];
    return out;
  }

  private consume(tokens: string[]): CommitSummary[] {
    const out: CommitSummary[] = [];
    for (const t of tokens) {
      if (this.fields.length === this.fieldCount) {
        // record terminator; tolerate a missing one by treating t as the next record's sha
        out.push(commitFromFields(this.fields));
        this.fields = [];
        if (t === '') continue;
      }
      if (this.fields.length === 0 && t === '') continue; // stray separator
      this.fields.push(t);
    }
    return out;
  }
}

/** Parse a complete `git log -z --format=<LOG_FORMAT>` output. */
export function parseLog(text: string, o: { signature?: boolean } = {}): CommitSummary[] {
  const p = new LogParser(o);
  return [...p.push(text), ...p.end()];
}

/** `git show -s -z --format=<COMMIT_DETAIL_FORMAT>`: the log fields followed by the raw body. */
export const COMMIT_DETAIL_FORMAT = LOG_FORMAT + '%b';

export function parseCommitDetailHeader(text: string): { summary: CommitSummary; body: string } {
  const tokens = text.split('\0');
  const fields = tokens.slice(0, BASE_FIELDS.length);
  const body = trimEnd(tokens.slice(BASE_FIELDS.length).join('\0'));
  return { summary: commitFromFields(fields), body };
}

/** Strip trailing whitespace and NUL terminators. */
function trimEnd(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '\0' || /\s/.test(s[end - 1]!))) end--;
  return s.slice(0, end);
}
