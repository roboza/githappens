import type { RepoIdentity } from '@githappens/cloud-api';
import { parseRemoteUrl } from '@githappens/providers';

/** Remote as returned by `IntegrationService.resolveRemotes` (only the fields used here). */
export interface RemoteLike {
  remote: string;
  url: string;
  kind?: string | null;
  owner?: string;
  name?: string;
}

const PUBLIC: Record<string, string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'dev.azure.com': 'azure-devops',
  'ssh.dev.azure.com': 'azure-devops',
};

/**
 * Repo identity of a repository from its remotes (spec 14 §6.3 "Match local repo"): `origin` first, then
 * the first remote with a known provider, then any parseable remote. `provider` falls back to 'git' for
 * unknown hosts. Main wires `resolveRepoIdentity: async (id) => repoIdentityFromRemotes(await
 * integrations.resolveRemotes(id))`; `PatchService` adds `initialCommitSha` itself.
 */
export function repoIdentityFromRemotes(remotes: RemoteLike[]): RepoIdentity | undefined {
  const ordered = [
    ...remotes.filter((r) => r.remote === 'origin'),
    ...remotes.filter((r) => r.remote !== 'origin' && r.kind),
    ...remotes.filter((r) => r.remote !== 'origin' && !r.kind),
  ];
  for (const r of ordered) {
    const parsed = parseRemoteUrl(r.url);
    if (!parsed) continue;
    const host = parsed.host === 'ssh.dev.azure.com' ? 'dev.azure.com' : parsed.host;
    const parts = parsed.path.replace(/^v3\//, '').split('/').filter(Boolean);
    const name = r.name ?? parts.at(-1);
    const owner =
      r.owner ??
      parts
        .slice(0, -1)
        .filter((p) => p !== '_git')
        .join('/');
    if (!name || !owner) continue;
    return { provider: r.kind ?? PUBLIC[parsed.host] ?? 'git', host, owner, name };
  }
  return undefined;
}
