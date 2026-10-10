import type { RepoIdentity } from '@githappens/cloud-api/types';
import type { GitService } from '@githappens/git';
import { parseRemoteUrl } from '@githappens/providers';

const PROVIDERS: Record<string, string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'dev.azure.com': 'azure-devops',
  'ssh.dev.azure.com': 'azure-devops',
};

/**
 * RepoIdentity of a remote URL (spec 14 §5.3): provider from well-known hosts (else `git`), owner =
 * every path segment but the last. Azure https (`org/project/_git/repo`) and ssh (`v3/org/project/repo`)
 * forms normalize to the same identity.
 */
export function identityFromUrl(url: string): Omit<RepoIdentity, 'initialCommitSha'> | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed?.host || !parsed.path) return null;
  let host = parsed.host;
  let segs = parsed.path.split('/').filter(Boolean);
  const provider = PROVIDERS[host] ?? (host.endsWith('.visualstudio.com') ? 'azure-devops' : 'git');
  if (provider === 'azure-devops') {
    if (host === 'ssh.dev.azure.com') host = 'dev.azure.com';
    if (segs[0] === 'v3') segs = segs.slice(1);
    segs = segs.filter((s) => s !== '_git');
  }
  if (segs.length < 2) return null;
  return { provider, host, owner: segs.slice(0, -1).join('/'), name: segs[segs.length - 1]! };
}

/** Identity of an open repo: `origin` (else the first remote with a parseable URL) + its root commit. */
export async function repoIdentity(svc: GitService): Promise<RepoIdentity | null> {
  const remotes = await svc.remotes();
  const ordered = [
    ...remotes.filter((r) => r.name === 'origin'),
    ...remotes.filter((r) => r.name !== 'origin'),
  ];
  for (const r of ordered) {
    const id = r.fetchUrl ? identityFromUrl(r.fetchUrl) : null;
    if (!id) continue;
    const roots = await svc.runRead(['rev-list', '--max-parents=0', 'HEAD'], { expectedExitCodes: [0, 128] });
    const root = String(roots.stdout).trim().split(/\r?\n/).filter(Boolean).pop();
    return root ? { ...id, initialCommitSha: root } : id;
  }
  return null;
}
