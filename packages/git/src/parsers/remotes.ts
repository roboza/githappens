import type { RemoteInfo } from '../types';

/**
 * Parser for `git config -z --get-regexp '^remote\..+\.(url|pushurl|fetch)$'` (spec 02 §6.11):
 * tokens `key\nvalue\0`. A remote name may contain dots, so the key is parsed as
 * `remote.` + name + `.` + last segment.
 */

export const REMOTES_CONFIG_REGEXP = '^remote\\..+\\.(url|pushurl|fetch)$';

export function parseRemotesConfig(text: string): RemoteInfo[] {
  const byName = new Map<string, { url?: string; pushUrl?: string; fetch: string[] }>();
  for (const tok of text.split('\0')) {
    if (!tok) continue;
    const nl = tok.indexOf('\n');
    const key = nl < 0 ? tok : tok.slice(0, nl);
    const value = nl < 0 ? '' : tok.slice(nl + 1);
    if (!key.startsWith('remote.')) continue;
    const dot = key.lastIndexOf('.');
    const name = key.slice('remote.'.length, dot);
    const field = key.slice(dot + 1).toLowerCase();
    if (!name) continue;
    let r = byName.get(name);
    if (!r) byName.set(name, (r = { fetch: [] }));
    if (field === 'url') r.url ??= value;
    else if (field === 'pushurl') r.pushUrl ??= value;
    else if (field === 'fetch') r.fetch.push(value);
  }
  return [...byName].map(([name, r]) => ({
    name,
    fetchUrl: r.url ?? '',
    pushUrl: r.pushUrl ?? r.url ?? '',
    fetchRefspecs: r.fetch,
  }));
}

/** Parser for `git remote -v`: `name\turl (fetch|push)` lines (fetch refspecs not included). */
export function parseRemoteVerbose(text: string): RemoteInfo[] {
  const byName = new Map<string, RemoteInfo>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const [, name, url, kind] = m as unknown as [string, string, string, string];
    let r = byName.get(name);
    if (!r) byName.set(name, (r = { name, fetchUrl: '', pushUrl: '', fetchRefspecs: [] }));
    if (kind === 'fetch') r.fetchUrl = url;
    else r.pushUrl = url;
  }
  return [...byName.values()];
}
