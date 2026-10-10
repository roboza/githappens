import type { GitService } from '@githappens/git';

import type { TargetSource } from '../../shared/ipc/conflicts-contract';

/** Per-branch override written by "Change target…" (spec 14 §6.5). */
export const targetConfigKey = (branch: string): string => `branch.${branch}.githappens-target`;

export const HEURISTIC_TARGETS = ['main', 'master', 'develop'] as const;

export interface ResolvedTarget {
  /** Short ref as shown to the user, e.g. `origin/main` or `main`. */
  ref: string;
  source: TargetSource;
  /** null when the ref does not exist locally (configured / PR targets only). */
  sha: string | null;
}

/** PR base lookup for a branch (open PR on a remote of this repo), or null. */
export type PrBaseLookup = (branch: string) => Promise<{ remote: string; branch: string } | null>;

async function config(svc: GitService, key: string): Promise<string | null> {
  const r = await svc.runRead(['config', '--get', key], { expectedExitCodes: [0, 1] });
  const v = r.exitCode === 0 ? String(r.stdout).trim() : '';
  return v || null;
}

async function remoteNames(svc: GitService): Promise<string[]> {
  return (await svc.remotes()).map((r) => r.name);
}

/** Resolve a user-facing ref (`origin/main`, `main`, `refs/…`) to a commit, preferring remote refs. */
async function resolveRef(svc: GitService, ref: string): Promise<string | null> {
  if (ref.startsWith('refs/')) return svc.revParse(ref);
  return (await svc.revParse(`refs/remotes/${ref}`)) ?? (await svc.revParse(`refs/heads/${ref}`));
}

const shortName = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '');

/** Branch part of a target ref given the known remotes (`origin/main` → `main`). */
function branchPart(ref: string, remotes: string[]): string {
  const r = remotes.find((x) => ref.startsWith(`${x}/`));
  return r ? ref.slice(r.length + 1) : ref;
}

/**
 * Target resolution (spec 14 §6.5): per-branch config → PR base → the upstream remote's default
 * branch (`refs/remotes/<remote>/HEAD`) → main/master/develop on that remote → local main/master/develop.
 * A target naming the branch itself is skipped. Null for detached / unborn / bare repos.
 */
export async function resolveTarget(
  svc: GitService,
  branch: string,
  prBase?: PrBaseLookup,
): Promise<ResolvedTarget | null> {
  if (!branch || svc.repo.isBare) return null;
  const remotes = await remoteNames(svc);
  const configured = await config(svc, targetConfigKey(branch));
  if (configured)
    return { ref: shortName(configured), source: 'config', sha: await resolveRef(svc, configured) };

  if (prBase) {
    const pr = await prBase(branch).catch(() => null);
    if (pr && pr.branch !== branch) {
      const ref = `${pr.remote}/${pr.branch}`;
      return { ref, source: 'pr', sha: await svc.revParse(`refs/remotes/${ref}`) };
    }
  }

  const upstreamRemote = await config(svc, `branch.${branch}.remote`);
  const remote =
    upstreamRemote && upstreamRemote !== '.' && remotes.includes(upstreamRemote)
      ? upstreamRemote
      : remotes.includes('origin')
        ? 'origin'
        : remotes[0];
  if (remote) {
    const sym = await svc.runRead(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
      expectedExitCodes: [0, 1, 128],
    });
    const head = sym.exitCode === 0 ? shortName(String(sym.stdout).trim()) : '';
    if (head && branchPart(head, remotes) !== branch) {
      const sha = await svc.revParse(`refs/remotes/${head}`);
      if (sha) return { ref: head, source: 'remote-default', sha };
    }
    for (const name of HEURISTIC_TARGETS) {
      if (name === branch) continue;
      const sha = await svc.revParse(`refs/remotes/${remote}/${name}`);
      if (sha) return { ref: `${remote}/${name}`, source: 'heuristic', sha };
    }
  }
  for (const name of HEURISTIC_TARGETS) {
    if (name === branch) continue;
    const sha = await svc.revParse(`refs/heads/${name}`);
    if (sha) return { ref: name, source: 'heuristic', sha };
  }
  return null;
}

/** Persist (or clear with null) the per-branch target. */
export async function writeTargetConfig(
  svc: GitService,
  branch: string,
  target: string | null,
): Promise<void> {
  if (!branch || /[\0\n\r]/.test(branch)) throw new Error('Invalid branch');
  if (target !== null && (!target.trim() || target.startsWith('-') || /[\0\n\r]/.test(target))) {
    throw new Error('Invalid target');
  }
  const key = targetConfigKey(branch);
  if (target === null)
    await svc.runWrite(['config', '--local', '--unset-all', key], { expectedExitCodes: [0, 5] });
  else await svc.runWrite(['config', '--local', '--replace-all', key, target.trim()]);
}
