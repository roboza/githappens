import { isHiddenRef } from '../app-names';
import type { RefInfo } from '../types';

/**
 * Parser for `git for-each-ref` (spec 02 §6.7). for-each-ref has no `-z`, so fields are
 * separated by `%00` and records by `%1e` + newline.
 */

const FIELDS = [
  '%(refname)',
  '%(objectname)',
  '%(objecttype)',
  '%(*objectname)',
  '%(upstream)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(symref)',
  '%(worktreepath)',
  '%(creatordate:unix)',
  '%(contents:subject)',
] as const;
const FIELD_COUNT = FIELDS.length;

/** Format with upstream tracking (expensive ahead/behind; only for refs/heads, spec 02 §6.15.5). */
export const REFS_FORMAT_TRACK = FIELDS.join('%00') + '%1e';
/** Same field layout with the two upstream fields left empty. */
export const REFS_FORMAT_NO_TRACK =
  FIELDS.map((f) => (f.startsWith('%(upstream') ? '' : f)).join('%00') + '%1e';

/** Upstream name without the (expensive) ahead/behind: the track field is left empty. */
export const REFS_FORMAT_UPSTREAM =
  FIELDS.map((f) => (f.startsWith('%(upstream:track') ? '' : f)).join('%00') + '%1e';
/** Ahead/behind of local branches: `refname NUL objectname NUL upstream NUL track RS` (parseTrackRecords). */
export const TRACK_ONLY_FORMAT = '%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%1e';

export interface TrackRecord extends TrackInfo {
  fullName: string;
  sha: string;
  upstream: string;
}

export function parseTrackRecords(text: string): TrackRecord[] {
  const out: TrackRecord[] = [];
  for (const raw of text.split('\x1e')) {
    const f = raw.replace(/^\r?\n/, '').split('\0');
    if (f.length !== 4 || !f[0]) continue;
    out.push({ fullName: f[0], sha: f[1]!, upstream: f[2]!, ...parseTrack(f[3]!) });
  }
  return out;
}

export interface TrackInfo {
  ahead: number;
  behind: number;
  gone: boolean;
}

/** `ahead 2, behind 1` / `ahead 2` / `behind 1` / `gone` / empty. */
export function parseTrack(s: string): TrackInfo {
  const t: TrackInfo = { ahead: 0, behind: 0, gone: false };
  if (s.trim() === 'gone') {
    t.gone = true;
    return t;
  }
  const a = /ahead (\d+)/.exec(s);
  const b = /behind (\d+)/.exec(s);
  if (a) t.ahead = Number(a[1]);
  if (b) t.behind = Number(b[1]);
  return t;
}

export function refType(fullName: string): RefInfo['type'] {
  if (fullName.startsWith('refs/heads/')) return 'local';
  if (fullName.startsWith('refs/remotes/')) return 'remote';
  if (fullName.startsWith('refs/tags/')) return 'tag';
  if (fullName === 'refs/stash') return 'stash';
  return 'other';
}

export function shortRefName(fullName: string): string {
  for (const p of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (fullName.startsWith(p)) return fullName.slice(p.length);
  }
  if (fullName.startsWith('refs/')) return fullName.slice('refs/'.length);
  return fullName;
}

export interface ParseRefsOptions {
  /** Normalizes `%(worktreepath)` (forward slashes on Windows) and drops the current worktree. */
  mapWorktreePath?: (p: string) => string | undefined;
  /** Called for malformed records (wrong field count). */
  onWarning?: (msg: string) => void;
}

export function parseForEachRef(text: string, o: ParseRefsOptions = {}): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const raw of text.split('\x1e')) {
    const rec = raw.replace(/^\r?\n/, '');
    if (!rec) continue;
    const f = rec.split('\0');
    if (f.length !== FIELD_COUNT) {
      o.onWarning?.(`for-each-ref: dropping malformed record (${f.length} fields)`);
      continue;
    }
    const [
      fullName,
      objectName,
      objectType,
      peeled,
      upstream,
      track,
      head,
      symref,
      worktreePath,
      creatorDate,
      subject,
    ] = f as [string, string, string, string, string, string, string, string, string, string, string];
    if (!fullName || isHiddenRef(fullName)) continue;

    const ref: RefInfo = {
      fullName,
      shortName: shortRefName(fullName),
      type: refType(fullName),
      sha: objectType === 'tag' && peeled ? peeled : objectName,
      isHead: head === '*',
    };
    if (objectType === 'tag') ref.tagObjectSha = objectName;
    if (upstream) ref.upstream = { fullName: upstream, ...parseTrack(track) };
    if (symref) ref.symrefTarget = symref;
    if (worktreePath) {
      const p = o.mapWorktreePath ? o.mapWorktreePath(worktreePath) : worktreePath;
      if (p) ref.worktreePath = p;
    }
    if (creatorDate) ref.creatorDate = Number(creatorDate);
    if (subject) ref.subject = subject;
    refs.push(ref);
  }
  return refs;
}
