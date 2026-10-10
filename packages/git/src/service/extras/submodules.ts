import fs from 'node:fs';
import nodePath from 'node:path';

import type { Sha, SubmoduleInfo } from '../../types';
import type { GitService } from '../git-service';

export const GITMODULES_REGEXP = '^submodule\\..*\\.(path|url|branch)$';

export interface DeclaredSubmodule {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
}

/**
 * Parse `git config -z --file .gitmodules --get-regexp '^submodule\..*\.(path|url|branch)$'`
 * (`key\nvalue\0` records). Names may contain dots: the field is the last key segment.
 */
export function parseGitmodulesConfig(stdout: string): DeclaredSubmodule[] {
  const byName = new Map<string, DeclaredSubmodule>();
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? '' : rec.slice(nl + 1);
    if (!key.startsWith('submodule.')) continue;
    const dot = key.lastIndexOf('.');
    const name = key.slice('submodule.'.length, dot);
    const field = key.slice(dot + 1).toLowerCase();
    if (!name) continue;
    const m = byName.get(name) ?? { name };
    if (field === 'path') m.path = value;
    else if (field === 'url') m.url = value;
    else if (field === 'branch') m.branch = value;
    byName.set(name, m);
  }
  return [...byName.values()];
}

export interface SubmoduleStatusLine {
  flag: ' ' | '-' | '+' | 'U';
  sha: Sha;
  path: string;
  describe?: string;
}

/**
 * Parse `git submodule status [--recursive]` lines: `<flag><sha> <path>( (<describe>))?`. `knownPaths`
 * disambiguates a path that itself ends in `" (...)"`.
 */
export function parseSubmoduleStatus(stdout: string, knownPaths?: Set<string>): SubmoduleStatusLine[] {
  const out: SubmoduleStatusLine[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^([ +\-U])([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/.exec(line);
    if (!m) continue;
    const flag = m[1] as SubmoduleStatusLine['flag'];
    let rest = m[3]!;
    let describe: string | undefined;
    const d = / \(([^()]*)\)$/.exec(rest);
    if (d && !knownPaths?.has(rest)) {
      describe = d[1];
      rest = rest.slice(0, d.index);
    }
    out.push({ flag, sha: m[2]!, path: rest, ...(describe !== undefined ? { describe } : {}) });
  }
  return out;
}

const STATE: Record<SubmoduleStatusLine['flag'], SubmoduleInfo['state']> = {
  ' ': 'in-sync',
  '-': 'uninitialized',
  '+': 'out-of-sync',
  U: 'conflict',
};

async function readGitmodules(
  service: GitService,
  repoDir: string,
  isTop: boolean,
): Promise<DeclaredSubmodule[]> {
  const file = nodePath.join(repoDir, '.gitmodules');
  let args: string[] | null = null;
  if (fs.existsSync(file)) args = ['config', '-z', '--file', file, '--get-regexp', GITMODULES_REGEXP];
  else if (isTop) args = ['config', '-z', '--blob', 'HEAD:.gitmodules', '--get-regexp', GITMODULES_REGEXP];
  if (!args) return [];
  const r = await service.runRead(args, { expectedExitCodes: [0, 1, 128] });
  return r.exitCode === 0 ? parseGitmodulesConfig(r.stdout) : [];
}

/** Gitlink shas recorded in the index of `repoDir` (stage 0), keyed by repo-relative path. */
async function indexGitlinks(service: GitService, repoDir: string): Promise<Map<string, Sha>> {
  const r = await service.runRead(['-C', repoDir, 'ls-files', '-s', '-z'], {
    expectedExitCodes: [0, 128],
    maxBuffer: 256 * 1024 * 1024,
  });
  const map = new Map<string, Sha>();
  if (r.exitCode !== 0) return map;
  for (const rec of r.stdout.split('\0')) {
    const m = /^160000 ([0-9a-f]+) 0\t(.*)$/.exec(rec);
    if (m) map.set(m[2]!, m[1]!);
  }
  return map;
}

/**
 * Submodules of this repo, recursively (spec 02 §6.11, spec 09 §6.9): `.gitmodules` for name/url/branch
 * (the nested module's own `.gitmodules` for nested ones) + `git submodule status --recursive` for the
 * state + the index for the recorded gitlink.
 */
export async function listSubmodules(service: GitService): Promise<SubmoduleInfo[]> {
  const root = service.repo.worktreeRoot;
  if (!root) return [];
  const top = await readGitmodules(service, root, true);
  if (!top.length && !fs.existsSync(nodePath.join(root, '.gitmodules'))) {
    // no declared modules: still honor stray gitlinks via status below, but skip work when none exist
    const links = await indexGitlinks(service, root);
    if (!links.size) return [];
  }
  const r = await service.runRead(['submodule', 'status', '--recursive'], {
    expectedExitCodes: [0, 1, 128],
    timeoutMs: 120_000,
  });
  const knownTop = new Set(top.map((m) => m.path).filter((p): p is string => !!p));
  const entries = parseSubmoduleStatus(r.stdout, knownTop);

  const declared = new Map<string, DeclaredSubmodule[]>([['', top]]);
  const gitlinks = new Map<string, Map<string, Sha>>();
  const containerOf = (p: string): string => {
    let best = '';
    for (const e of entries) {
      if (e.path !== p && p.startsWith(`${e.path}/`) && e.path.length > best.length) best = e.path;
    }
    return best;
  };

  const out: SubmoduleInfo[] = [];
  for (const e of entries) {
    const container = containerOf(e.path);
    const containerDir = container ? nodePath.join(root, ...container.split('/')) : root;
    if (!declared.has(container)) declared.set(container, await readGitmodules(service, containerDir, false));
    if (!gitlinks.has(container)) gitlinks.set(container, await indexGitlinks(service, containerDir));
    const rel = container ? e.path.slice(container.length + 1) : e.path;
    const decl = declared.get(container)!.find((m) => m.path === rel);
    const recorded = gitlinks.get(container)!.get(rel) ?? null;
    const state = STATE[e.flag];
    const zero = /^0+$/.test(e.sha);
    out.push({
      name: decl?.name ?? rel,
      path: e.path,
      url: decl?.url ?? '',
      ...(decl?.branch ? { branch: decl.branch } : {}),
      recordedSha: state === 'conflict' ? null : (recorded ?? (zero ? null : e.sha)),
      checkedOutSha: state === 'uninitialized' || state === 'conflict' || zero ? null : e.sha,
      state,
      ...(e.describe !== undefined ? { describe: e.describe } : {}),
    });
  }
  return out;
}
