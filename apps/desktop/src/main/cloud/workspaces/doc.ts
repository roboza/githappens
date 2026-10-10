import { createHash } from 'node:crypto';

import type { CloudWorkspaceDoc } from '@githappens/cloud-api/types';

import type { NewWorkspaceRepo, Workspace } from '../../../shared/ipc/workspaces-contract';

/** Remote URL without credentials / query (https `user:token@` is dropped; scp-like ssh is kept). */
export function sanitizeRemoteUrl(url: string | undefined): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  if (/^[^@/\s]+@[^:/\s]+:(?!\/)/.test(u)) return u; // git@host:owner/repo.git
  try {
    const parsed = new URL(u);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined; // local paths, file:, C:\…
    if (parsed.protocol === 'ssh:') {
      parsed.password = '';
    } else {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined; // a local path or something we cannot vouch for
  }
}

/** Cloud document of a local workspace: names and credential-free remote URLs, never local paths. */
export function workspaceToDoc(ws: Workspace): CloudWorkspaceDoc {
  return {
    format: 'githappens-workspace/1',
    name: ws.name,
    ...(ws.description ? { description: ws.description } : {}),
    ...(ws.color ? { color: ws.color } : {}),
    ...(ws.icon ? { icon: ws.icon } : {}),
    repos: ws.repos.map((r) => {
      const remoteUrl = sanitizeRemoteUrl(r.remoteUrl ?? r.provider?.cloneUrlHttps);
      const kind = r.provider?.integrationKey.split(':')[0];
      const host = r.provider?.integrationKey.split(':')[1];
      return {
        name: r.name,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(r.provider && kind && host
          ? {
              provider: {
                kind,
                host,
                owner: r.provider.owner,
                name: r.provider.name,
                ...(r.provider.webUrl ? { webUrl: r.provider.webUrl } : {}),
              },
            }
          : {}),
      };
    }),
  };
}

/** Validate a document read from the server (other clients may write anything). */
export function parseDoc(raw: unknown): CloudWorkspaceDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !Array.isArray(o.repos)) return null;
  const str = (v: unknown, max = 2000): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
  const repos: CloudWorkspaceDoc['repos'] = [];
  for (const r of o.repos.slice(0, 1000)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const name = str(x.name, 255);
    if (!name) continue;
    const remoteUrl = sanitizeRemoteUrl(str(x.remoteUrl));
    const p = x.provider as Record<string, unknown> | undefined;
    const provider =
      p && str(p.kind, 40) && str(p.host, 255) && str(p.owner, 255) && str(p.name, 255)
        ? {
            kind: p.kind as string,
            host: p.host as string,
            owner: p.owner as string,
            name: p.name as string,
            ...(str(p.webUrl) && /^https?:\/\//.test(p.webUrl as string)
              ? { webUrl: p.webUrl as string }
              : {}),
          }
        : undefined;
    repos.push({ name, ...(remoteUrl ? { remoteUrl } : {}), ...(provider ? { provider } : {}) });
  }
  return {
    format: 'githappens-workspace/1',
    name: o.name.slice(0, 200),
    ...(str(o.description, 2000) ? { description: o.description as string } : {}),
    ...(str(o.color, 40) ? { color: o.color as string } : {}),
    ...(str(o.icon, 40) ? { icon: o.icon as string } : {}),
    repos,
  };
}

/** Stable content hash (local-change detection). */
export function docHash(doc: CloudWorkspaceDoc): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);
}

/** Clone URLs for a provider repo when only owner/name are known. */
function cloneUrls(host: string, owner: string, name: string): { https: string; ssh: string } {
  const h = host.split('/')[0]!;
  return { https: `https://${h}/${owner}/${name}.git`, ssh: `git@${h}:${owner}/${name}.git` };
}

/**
 * New workspace repos for a cloud document. `integrationFor` maps a provider host to a connected
 * integration key on this computer; `localClone` finds an existing clone of a remote.
 */
export function docToNewRepos(
  doc: CloudWorkspaceDoc,
  o: {
    integrationFor(kind: string, host: string): string | undefined;
    localClone(remoteUrl: string): string | undefined;
  },
): NewWorkspaceRepo[] {
  return doc.repos.map((r) => {
    const p = r.provider;
    const key = p ? o.integrationFor(p.kind, p.host) : undefined;
    const urls = p ? cloneUrls(p.host, p.owner, p.name) : undefined;
    const remoteUrl = r.remoteUrl ?? urls?.https;
    const localPath = remoteUrl ? o.localClone(remoteUrl) : undefined;
    return {
      name: r.name,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(localPath ? { localPath } : {}),
      ...(p && key && urls
        ? {
            provider: {
              integrationKey: key,
              owner: p.owner,
              name: p.name,
              cloneUrlHttps: r.remoteUrl && /^https:/.test(r.remoteUrl) ? r.remoteUrl : urls.https,
              cloneUrlSsh: urls.ssh,
              webUrl: p.webUrl ?? `https://${p.host}/${p.owner}/${p.name}`,
            },
          }
        : {}),
    };
  });
}
