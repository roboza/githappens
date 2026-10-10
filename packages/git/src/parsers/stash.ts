import type { StashEntry } from '../types';

/**
 * Parser for `git stash list -z --format=<STASH_FORMAT>` (spec 02 §6.11). Each field is terminated by
 * our `%x00` and each record by git's `-z` NUL, so a record is 5 tokens plus one empty token.
 */

export const STASH_FORMAT = '%gd%x00%H%x00%P%x00%gs%x00%ct%x00';
const FIELDS = 5;

export function parseStashList(text: string): StashEntry[] {
  const tokens = text.split('\0');
  const out: StashEntry[] = [];
  let i = 0;
  while (i + FIELDS <= tokens.length) {
    if (tokens[i] === '') {
      i++;
      continue;
    }
    const [ref, sha, parents, message, time] = tokens.slice(i, i + FIELDS) as [
      string,
      string,
      string,
      string,
      string,
    ];
    i += FIELDS;
    const m = /\{(\d+)\}$/.exec(ref);
    out.push({
      index: m ? Number(m[1]) : out.length,
      ref,
      sha,
      parents: parents ? parents.split(' ') : [],
      message,
      time: Number(time),
    });
  }
  return out;
}
