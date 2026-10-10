import type {
  OrdinaryEntry,
  RenamedEntry,
  StatusCode,
  StatusEntry,
  StatusResult,
  SubmoduleStatusFlags,
  UnmergedEntry,
} from '../types';

/**
 * Parser for `git status --porcelain=v2 -z --branch [--show-stash]` (spec 02 §6.5).
 */

const ZERO_SHA = /^0+$/;

/** Split a header line on single spaces, keeping everything after the `limit - 1`th space as the last field. */
export function splitLimit(s: string, limit: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < limit - 1) {
    const i = s.indexOf(' ', start);
    if (i < 0) break;
    out.push(s.slice(start, i));
    start = i + 1;
  }
  out.push(s.slice(start));
  return out;
}

export function parseSubmoduleFlags(sub: string): SubmoduleStatusFlags | null {
  if (sub[0] !== 'S') return null;
  return { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U' };
}

const code = (c: string | undefined): StatusCode => (c ?? '.') as StatusCode;

/**
 * Split NUL-terminated output into decoded tokens. With a Buffer, tokens that are not valid UTF-8 keep
 * their raw bytes so paths can be addressed exactly (spec 02 §8 "raw bytes are kept").
 */
export function splitNulTokens(input: string | Buffer): { tokens: string[]; raw: (Buffer | undefined)[] } {
  if (typeof input === 'string') return { tokens: input.split('\0'), raw: [] };
  const tokens: string[] = [];
  const raw: (Buffer | undefined)[] = [];
  let start = 0;
  for (;;) {
    const end = input.indexOf(0, start);
    const buf = input.subarray(start, end < 0 ? input.length : end);
    const t = buf.toString('utf8');
    tokens.push(t);
    raw.push(t.includes('�') && !Buffer.from(t, 'utf8').equals(buf) ? buf : undefined);
    if (end < 0) break;
    start = end + 1;
  }
  return { tokens, raw };
}

/** Base64 of the trailing `path` bytes of a token whose header part is ASCII. */
function rawTail(token: string, raw: Buffer | undefined, path: string): string | undefined {
  if (!raw) return undefined;
  return raw.subarray(token.length - path.length).toString('base64');
}

export function parseStatusV2(input: string | Buffer): StatusResult {
  const result: StatusResult = { branch: { oid: null, head: null }, stashCount: 0, entries: [] };
  const { tokens, raw } = splitNulTokens(input);
  const withRaw = <E extends StatusEntry>(e: E, i: number, token: string): E => {
    const r = rawTail(token, raw[i], e.path);
    if (r) e.rawPath = r;
    return e;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const at = i;
    if (!t) continue;
    switch (t[0]) {
      case '#':
        parseHeader(t, result);
        break;
      case '1': {
        // 1 XY sub mH mI mW hH hI path
        const f = splitLimit(t, 9);
        result.entries.push(withRaw(ordinary(f, f[8]!), at, t));
        break;
      }
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
        const f = splitLimit(t, 10);
        const origPath = tokens[++i] ?? '';
        const origRaw = raw[i];
        const xscore = f[8]!;
        const entry: RenamedEntry = {
          ...ordinary(f, f[9]!),
          kind: 'renamed',
          origPath,
          op: xscore[0] === 'C' ? 'C' : 'R',
          score: Number(xscore.slice(1)) || 0,
        };
        if (origRaw) entry.origRawPath = origRaw.toString('base64');
        result.entries.push(withRaw(entry, at, t));
        break;
      }
      case 'u': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const f = splitLimit(t, 11);
        const stage = (sha: string | undefined): string | undefined =>
          sha && !ZERO_SHA.test(sha) ? sha : undefined;
        const stages: UnmergedEntry['stages'] = {};
        const base = stage(f[7]);
        const ours = stage(f[8]);
        const theirs = stage(f[9]);
        if (base) stages.base = base;
        if (ours) stages.ours = ours;
        if (theirs) stages.theirs = theirs;
        const entry: UnmergedEntry = {
          kind: 'unmerged',
          path: f[10]!,
          conflict: f[1] as UnmergedEntry['conflict'],
          submodule: parseSubmoduleFlags(f[2]!),
          stages,
        };
        result.entries.push(withRaw(entry, at, t));
        break;
      }
      case '?':
        result.entries.push(withRaw<StatusEntry>({ kind: 'untracked', path: t.slice(2) }, at, t));
        break;
      case '!':
        result.entries.push(withRaw<StatusEntry>({ kind: 'ignored', path: t.slice(2) }, at, t));
        break;
      default:
        // Unknown record type from a future git: ignore rather than fail.
        break;
    }
  }
  return result;
}

function ordinary(f: string[], path: string): OrdinaryEntry {
  const xy = f[1]!;
  return {
    kind: 'ordinary',
    path,
    index: code(xy[0]),
    worktree: code(xy[1]),
    submodule: parseSubmoduleFlags(f[2]!),
    modeHead: f[3]!,
    modeIndex: f[4]!,
    modeWorktree: f[5]!,
    shaHead: f[6]!,
    shaIndex: f[7]!,
  };
}

function parseHeader(t: string, r: StatusResult): void {
  const [, key, ...rest] = t.split(' ');
  const value = rest.join(' ');
  switch (key) {
    case 'branch.oid':
      r.branch.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      r.branch.head = value === '(detached)' ? null : value;
      break;
    case 'branch.upstream':
      r.branch.upstream = value;
      break;
    case 'branch.ab': {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) {
        r.branch.ahead = Number(m[1]);
        r.branch.behind = Number(m[2]);
      }
      break;
    }
    case 'stash':
      r.stashCount = Number(value) || 0;
      break;
  }
}

/** Count of untracked entries (used for the untracked-explosion fallback, spec 02 §6.15.3). */
export function countUntracked(entries: StatusEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.kind === 'untracked') n++;
  return n;
}
