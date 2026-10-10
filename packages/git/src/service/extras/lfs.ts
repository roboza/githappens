import fs from 'node:fs';
import nodePath from 'node:path';

import type { LfsStatus } from '../../types';
import type { GitService } from '../git-service';

export type LfsTracked = LfsStatus['tracked'][number];
export type LfsLock = LfsStatus['locks'][number];

/** Locks need the server: keep it short and never block the UI on it. */
export const LFS_LOCKS_TIMEOUT_MS = 5_000;

/** Env that keeps credential helpers / ssh from prompting during best-effort reads. */
export const NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

/** Split one `.gitattributes` line into pattern + attributes (handles `"quoted pattern"`). */
function splitAttrLine(line: string): { pattern: string; attrs: string[] } | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  let pattern: string;
  let rest: string;
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end < 0) return null;
    pattern = t.slice(1, end);
    rest = t.slice(end + 1);
  } else {
    const m = /^(\S+)(.*)$/.exec(t)!;
    pattern = m[1]!;
    rest = m[2]!;
  }
  return { pattern, attrs: rest.split(/\s+/).filter(Boolean) };
}

/**
 * LFS patterns in one `.gitattributes` file (spec 09 §6.8): lines with `filter=lfs` add a pattern,
 * later lines unsetting the filter for the same pattern remove it. `dir` (repo-relative, `/`-separated)
 * prefixes patterns from nested files.
 */
export function parseGitattributesLfs(text: string, dir = ''): LfsTracked[] {
  const map = new Map<string, LfsTracked>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = splitAttrLine(line);
    if (!parsed) continue;
    const pattern = dir ? `${dir.replace(/\/+$/, '')}/${parsed.pattern.replace(/^\//, '')}` : parsed.pattern;
    const filter = parsed.attrs.filter((a) => /^[-!]?filter(=|$)/.test(a)).pop();
    if (filter === 'filter=lfs') {
      const lockable = parsed.attrs.includes('lockable');
      map.delete(pattern);
      map.set(pattern, { pattern, lockable });
    } else if (filter !== undefined) {
      map.delete(pattern);
    } else if (map.has(pattern) && parsed.attrs.some((a) => /^[-!]?lockable$/.test(a))) {
      map.get(pattern)!.lockable = parsed.attrs.includes('lockable');
    }
  }
  return [...map.values()];
}

/**
 * Parse `git lfs track` (no args) output: a heading, then `    <pattern> (<file>)` lines, with
 * `[lockable]` markers; a "Listing excluded patterns" section is ignored.
 */
export function parseLfsTrackOutput(stdout: string): LfsTracked[] {
  const out: LfsTracked[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^Listing excluded patterns/i.test(raw)) break;
    const m = /^\s+(.+?)(\s+\[lockable\])?\s+\((.+)\)\s*$/.exec(raw);
    if (!m) continue;
    out.push({ pattern: m[1]!, lockable: !!m[2] });
  }
  return out;
}

/** Parse `git lfs locks --json` → `[{id, path, owner:{name}, locked_at}]`. Invalid input → []. */
export function parseLfsLocksJson(stdout: string): LfsLock[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim() || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: LfsLock[] = [];
  for (const it of data as Record<string, unknown>[]) {
    if (!it || typeof it !== 'object') continue;
    const owner = it.owner as { name?: unknown } | undefined;
    out.push({
      id: String(it.id ?? ''),
      path: String(it.path ?? ''),
      owner: typeof owner?.name === 'string' ? owner.name : '',
      lockedAt: String(it.locked_at ?? ''),
    });
  }
  return out;
}

/** `git lfs version` succeeds → git-lfs is usable. */
export async function lfsAvailable(service: GitService): Promise<boolean> {
  try {
    const r = await service.runRead(['lfs', 'version'], { expectedExitCodes: [0, 1, 2, 128, 129] });
    return r.exitCode === 0 && /git-lfs\//i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

async function gitPath(service: GitService, p: string): Promise<string | null> {
  const r = await service.runRead(['rev-parse', '--path-format=absolute', '--git-path', p], {
    expectedExitCodes: [0, 128],
  });
  return r.exitCode === 0 && r.stdout.trim() ? nodePath.resolve(r.stdout.trim()) : null;
}

async function lfsInitialized(service: GitService): Promise<boolean> {
  const hook = await gitPath(service, 'hooks/pre-push');
  if (hook) {
    try {
      if (/git[- ]lfs/.test(fs.readFileSync(hook, 'utf8'))) return true;
    } catch {
      /* no hook */
    }
  }
  const r = await service.runRead(['config', '--get', 'filter.lfs.process'], { expectedExitCodes: [0, 1] });
  return r.exitCode === 0 && r.stdout.trim() !== '';
}

async function trackedFromAttributes(service: GitService): Promise<LfsTracked[] | null> {
  const root = service.repo.worktreeRoot;
  if (!root) return null;
  const r = await service.runRead(
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '.gitattributes',
      ':(glob)**/.gitattributes',
    ],
    { env: { GIT_LITERAL_PATHSPECS: '0' }, expectedExitCodes: [0, 128] },
  );
  const files = new Set(r.exitCode === 0 ? r.stdout.split('\0').filter(Boolean) : []);
  files.add('.gitattributes');
  const sorted = [...files].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const out: LfsTracked[] = [];
  for (const f of sorted) {
    let text: string;
    try {
      text = fs.readFileSync(nodePath.join(root, ...f.split('/')), 'utf8');
    } catch {
      continue;
    }
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    for (const t of parseGitattributesLfs(text, dir)) {
      const i = out.findIndex((x) => x.pattern === t.pattern);
      if (i >= 0) out.splice(i, 1);
      out.push(t);
    }
  }
  return out;
}

async function lfsLocks(service: GitService): Promise<LfsLock[]> {
  try {
    const r = await service.runRead(['lfs', 'locks', '--json'], {
      timeoutMs: LFS_LOCKS_TIMEOUT_MS,
      env: NO_PROMPT_ENV,
      expectedExitCodes: [0, 1, 2, 128],
      priority: 'background',
    });
    return r.exitCode === 0 ? parseLfsLocksJson(r.stdout) : [];
  } catch {
    return [];
  }
}

/**
 * Git LFS state for this repo (spec 09 §6.8): availability, hook installation, tracked patterns
 * (`.gitattributes` parsing; `git lfs track` output as fallback, e.g. bare repos) and best-effort locks
 * (short timeout, never prompts; empty when the server or network is unavailable).
 */
export async function lfsStatus(service: GitService): Promise<LfsStatus> {
  const [available, initialized, fromAttrs] = await Promise.all([
    lfsAvailable(service),
    lfsInitialized(service).catch(() => false),
    trackedFromAttributes(service).catch(() => null),
  ]);
  let tracked = fromAttrs ?? [];
  if (fromAttrs === null && available) {
    try {
      const r = await service.runRead(['lfs', 'track'], { expectedExitCodes: [0, 1, 2] });
      if (r.exitCode === 0) tracked = parseLfsTrackOutput(r.stdout);
    } catch {
      /* ignore */
    }
  }
  let locks: LfsLock[] = [];
  if (available && tracked.length && (await service.remotes().catch(() => [])).length) {
    locks = await lfsLocks(service);
  }
  return { available, initialized, tracked, locks };
}
