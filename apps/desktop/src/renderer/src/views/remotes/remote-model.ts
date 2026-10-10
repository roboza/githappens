import type { RefInfo, RemoteInfo } from '@githappens/git/types';
import type { RemoteRepo } from '@githappens/providers/types';

/** Pure remote-management helpers (spec 09 §4.1/§4.3, spec 10 §4.3). DOM-free for tests. */

/** Remote names must be a single valid refname component (spec 09 §4.3 "valid refname component"). */
export function validateRemoteName(
  name: string,
  existing: readonly string[],
  current?: string,
): string | null {
  const n = name.trim();
  if (!n) return 'Enter a remote name.';
  if (n.length > 100) return 'The name is too long.';
  if (
    /[\s~^:?*[\\/\0]/.test(n) ||
    n.includes('..') ||
    n.includes('@{') ||
    n === '@' ||
    n.startsWith('-') ||
    n.startsWith('.') ||
    n.endsWith('.') ||
    n.endsWith('.lock')
  ) {
    return `"${n}" is not a valid remote name.`;
  }
  if (n !== current && existing.includes(n)) return `A remote named "${n}" already exists.`;
  return null;
}

const SCHEME_URL = /^(?:https?|ssh|git|git\+ssh|ssh\+git|ftps?|file):\/\/\S+$/i;
const SCP_URL = /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?![/\\]{2})\S+$/;
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])\S*/;

/** Fetch / push URL check: scheme URLs, scp-like `user@host:path`, or local paths. */
export function validateRemoteUrl(url: string, optional = false): string | null {
  const u = url.trim();
  if (!u) return optional ? null : 'Enter a URL.';
  if (/[\0\r\n\t ]/.test(u)) return 'The URL must not contain spaces.';
  if (u.startsWith('-')) return 'The URL must not start with "-".';
  if (SCHEME_URL.test(u) || LOCAL_PATH.test(u) || SCP_URL.test(u)) return null;
  return 'Enter a URL like https://host/owner/repo.git or git@host:owner/repo.git.';
}

/** `host/path` lowercased, without credentials, port, `.git` or trailing `/` — for "same repo" checks. */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const scheme = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
  const scp = /^(?:[^@]+@)?([^:/]+):(.*)$/.exec(u);
  if (scheme) u = `${scheme[1]}/${scheme[2]}`;
  else if (scp && !/^[A-Za-z]:[\\/]/.test(u)) u = `${scp[1]}/${scp[2]}`;
  return u
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/** Browser URL of a remote ("Open on provider"); null for local / unknown forms. */
export function remoteWebUrl(url: string): string | null {
  const u = url.trim();
  let host: string;
  let p: string;
  const scheme = /^(https?|ssh|git|git\+ssh):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  if (scheme) {
    host = scheme[2]!;
    p = scheme[3]!;
  } else if (scp && !/^[A-Za-z]:[\\/]/.test(u)) {
    host = scp[1]!;
    p = scp[2]!;
  } else return null;
  p = p.replace(/\/+$/, '').replace(/\.git$/i, '');
  // Azure DevOps SSH: ssh.dev.azure.com:v3/org/project/repo → dev.azure.com/org/project/_git/repo
  const az = /^v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(p);
  if (/(^|\.)ssh\.dev\.azure\.com$/i.test(host) && az)
    return `https://dev.azure.com/${az[1]}/${az[2]}/_git/${az[3]}`;
  if (/^vs-ssh\.visualstudio\.com$/i.test(host) && az)
    return `https://${az[1]}.visualstudio.com/${az[2]}/_git/${az[3]}`;
  // Bitbucket Data Center SSH clone URLs carry `scm/` only over HTTP; leave paths as-is otherwise
  host = host.replace(/^ssh\./i, '');
  return `https://${host}/${p.replace(/^\/+/, '')}`;
}

export interface ForkChoice {
  key: string;
  owner: string;
  fullName: string;
  /** URL for the chosen protocol. */
  url: string;
  httpsUrl: string;
  sshUrl: string;
  webUrl: string;
  isParent: boolean;
  /** Name of an existing remote pointing at this repo (disables the row). */
  addedAs: string | null;
  /** Suggested remote name (the owner login). */
  suggestedName: string;
}

/** Remote name suggestion from an owner login, unique among `existing`. */
export function suggestRemoteName(owner: string, existing: readonly string[]): string {
  const base =
    owner
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || 'fork';
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** Provider forks (+ the parent when the repo is a fork) → Add Remote rows (spec 10 §4.3). */
export function forkChoices(
  forks: readonly RemoteRepo[],
  remotes: readonly RemoteInfo[],
  protocol: 'https' | 'ssh',
  parent?: RemoteRepo | null,
): ForkChoice[] {
  const byUrl = new Map<string, string>();
  for (const r of remotes) {
    byUrl.set(normalizeRemoteUrl(r.fetchUrl), r.name);
    if (r.pushUrl) byUrl.set(normalizeRemoteUrl(r.pushUrl), r.name);
  }
  const names = remotes.map((r) => r.name);
  const seen = new Set<string>();
  const out: ForkChoice[] = [];
  const add = (repo: RemoteRepo, isParent: boolean): void => {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const addedAs =
      byUrl.get(normalizeRemoteUrl(repo.httpsUrl)) ??
      (repo.sshUrl ? byUrl.get(normalizeRemoteUrl(repo.sshUrl)) : undefined) ??
      null;
    out.push({
      key,
      owner: repo.ref.owner,
      fullName: repo.fullName,
      url: protocol === 'ssh' && repo.sshUrl ? repo.sshUrl : repo.httpsUrl,
      httpsUrl: repo.httpsUrl,
      sshUrl: repo.sshUrl,
      webUrl: repo.webUrl,
      isParent,
      addedAs,
      suggestedName: suggestRemoteName(repo.ref.owner, names),
    });
  };
  if (parent) add(parent, true);
  for (const f of [...forks].sort((a, b) => a.fullName.localeCompare(b.fullName))) add(f, false);
  return out;
}

export interface RemoteGroup {
  name: string;
  remote: RemoteInfo | null;
  refs: RefInfo[];
}

/**
 * REMOTE section rows: every configured remote (also those without branches, spec 09 §4.1) with its
 * remote-tracking branches; `refs/remotes/<r>/HEAD` symrefs are skipped. Refs of an unknown remote
 * (e.g. removed but refs left behind) get their own group. With `hideEmpty` (filter active), groups
 * without refs are dropped.
 */
export function groupRemotes(
  remotes: readonly RemoteInfo[],
  refs: readonly RefInfo[],
  hideEmpty = false,
): RemoteGroup[] {
  // longest names first so `a/b` wins over `a` for refs/remotes/a/b/x
  const names = [...remotes.map((r) => r.name)].sort((a, b) => b.length - a.length);
  const groups = new Map<string, RemoteGroup>();
  for (const r of remotes) groups.set(r.name, { name: r.name, remote: r, refs: [] });
  for (const ref of refs) {
    if (ref.type !== 'remote' || ref.symrefTarget) continue;
    const rest = ref.fullName.replace(/^refs\/remotes\//, '');
    const name = names.find((n) => rest.startsWith(`${n}/`)) ?? rest.split('/')[0]!;
    let g = groups.get(name);
    if (!g) {
      g = { name, remote: null, refs: [] };
      groups.set(name, g);
    }
    g.refs.push(ref);
  }
  const out = [...groups.values()];
  return hideEmpty ? out.filter((g) => g.refs.length > 0) : out;
}

const SHALLOW_FLAG = /^(?:--no-tags|--single-branch|--filter=[A-Za-z0-9:._+-]+)$/;

/** Custom fetch flags text (space separated) → validated list, or an error message. */
export function parseShallowFlags(text: string): { flags: string[] } | { error: string } {
  const flags = text.split(/\s+/).filter(Boolean);
  const bad = flags.find((f) => !SHALLOW_FLAG.test(f));
  return bad
    ? { error: `Not allowed: ${bad} (use --no-tags, --single-branch or --filter=<spec>).` }
    : { flags };
}

/** Split `origin/feature/x` using the configured remote names (remote names may contain `/`). */
export function splitRemoteBranch(short: string, remoteNames: readonly string[]): [string, string] | null {
  const name = [...remoteNames].sort((a, b) => b.length - a.length).find((n) => short.startsWith(`${n}/`));
  if (name) return [name, short.slice(name.length + 1)];
  const i = short.indexOf('/');
  return i > 0 ? [short.slice(0, i), short.slice(i + 1)] : null;
}
