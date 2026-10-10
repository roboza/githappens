import type { GitOperation } from '@githappens/git/ops';

import type {
  GitflowBranches,
  GitflowBranchKind,
  GitflowConfig,
  GitflowFinishKind,
  GitflowSettings,
} from '../../../../shared/ipc/gitflow-contract';

/** Pure Git Flow helpers for the renderer (spec 12 §4.9). DOM-free so they can be unit-tested in node. */

export const FLOW_KINDS: GitflowBranchKind[] = ['feature', 'bugfix', 'release', 'hotfix', 'support'];

export const KIND_TITLE: Record<GitflowBranchKind, string> = {
  feature: 'Feature',
  bugfix: 'Bugfix',
  release: 'Release',
  hotfix: 'Hotfix',
  support: 'Support',
};

export const GROUP_TITLE: Record<GitflowBranchKind, string> = {
  feature: 'Features',
  bugfix: 'Bugfixes',
  release: 'Releases',
  hotfix: 'Hotfixes',
  support: 'Support',
};

/** Support branches are long-lived: AVH git-flow has no `support finish` (publish / delete them instead). */
export const isFinishable = (kind: GitflowBranchKind): kind is GitflowFinishKind => kind !== 'support';

/** Release/hotfix finishes tag the production branch; feature/bugfix finishes only merge into develop. */
export const isTaggedKind = (kind: GitflowBranchKind): boolean => kind === 'release' || kind === 'hotfix';

/** Feature and bugfix finishes can rebase onto develop first. */
export const canRebase = (kind: GitflowBranchKind): boolean => kind === 'feature' || kind === 'bugfix';

/**
 * Where the second merge of a finish goes (mirrors `secondaryTarget` in @githappens/git): develop, or —
 * AVH — the open release branch for a hotfix when exactly one release branch exists.
 */
export function finishTarget(
  cfg: Pick<GitflowConfig, 'develop'>,
  kind: GitflowBranchKind,
  releases: readonly string[],
): string {
  return kind === 'hotfix' && releases.length === 1 ? releases[0]! : cfg.develop;
}

/** Default base of a support branch: the most recent tag (by creation date), if any. */
export function defaultSupportBase(tags: readonly { shortName: string; creatorDate?: number }[]): string {
  let best: { shortName: string; creatorDate?: number } | undefined;
  for (const t of tags) if (!best || (t.creatorDate ?? 0) > (best.creatorDate ?? 0)) best = t;
  return best?.shortName ?? '';
}

/** spec 13 Gitflow section defaults (git-flow AVH). */
export const DEFAULT_GITFLOW_SETTINGS: GitflowSettings = {
  production: 'main',
  develop: 'develop',
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  bugfix: 'bugfix/',
  support: 'support/',
  versionTag: '',
};

/** Defaults for the init dialog: current config, else the defaults with the repo's main/master branch. */
export function initialSettings(cfg: GitflowConfig | null, localBranches: string[]): GitflowSettings {
  if (cfg) {
    const { initialized: _i, ...rest } = cfg;
    return rest;
  }
  const production = ['main', 'master'].find((b) => localBranches.includes(b)) ?? localBranches[0] ?? 'main';
  return { ...DEFAULT_GITFLOW_SETTINGS, production };
}

/** Group local branch names by flow prefix (mirrors the main-side grouping). */
export function groupFlowBranches(
  branches: string[],
  cfg: Pick<GitflowConfig, GitflowBranchKind>,
): GitflowBranches {
  const out: GitflowBranches = { feature: [], bugfix: [], release: [], hotfix: [], support: [] };
  for (const b of branches) {
    const kind = flowKindOf(b, cfg);
    if (kind) out[kind].push(b);
  }
  for (const k of FLOW_KINDS) out[k].sort((a, b) => a.localeCompare(b));
  return out;
}

/** Which flow type a branch belongs to (by prefix), if any. */
export function flowKindOf(
  branch: string,
  cfg: Pick<GitflowConfig, GitflowBranchKind>,
): GitflowBranchKind | null {
  for (const k of FLOW_KINDS) {
    const p = cfg[k];
    if (p && branch.startsWith(p) && branch.length > p.length) return k;
  }
  return null;
}

/** `feature/login` → `login`. */
export function flowName(branch: string, prefix: string): string {
  return prefix && branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
}

/** Tag name prefilled in the finish dialog: `<versiontagprefix><name>` (spec 12 §4.9). */
export function defaultTagName(cfg: Pick<GitflowConfig, 'versionTag'>, name: string): string {
  return `${cfg.versionTag}${name}`;
}

/** Client-side check of a flow name typed in the inline input (git validates again on start). */
export function validateFlowName(name: string): string | null {
  const v = name.trim();
  if (!v) return 'Enter a name.';
  if (v.startsWith('-')) return 'A name cannot start with "-".';
  if (/[\s~^:?*[\\\0-\x1f\x7f]/.test(v)) return 'Spaces and ~ ^ : ? * [ \\ are not allowed.';
  if (v.includes('..') || v.includes('@{') || v.includes('//')) return 'This is not a valid branch name.';
  if (v.endsWith('/') || v.endsWith('.') || v.endsWith('.lock') || v.startsWith('/'))
    return 'This is not a valid branch name.';
  return null;
}

/** Validate the init dialog fields; returns an error per field. */
export function validateSettings(s: GitflowSettings): Partial<Record<keyof GitflowSettings, string>> {
  const errors: Partial<Record<keyof GitflowSettings, string>> = {};
  for (const k of ['production', 'develop'] as const) {
    const e = validateFlowName(s[k]);
    if (e) errors[k] = e;
  }
  if (!errors.develop && s.production.trim() === s.develop.trim())
    errors.develop = 'Must differ from the production branch.';
  for (const k of ['feature', 'release', 'hotfix', 'bugfix', 'support'] as const) {
    if (!s[k].trim()) errors[k] = 'Cannot be empty.';
    else if (/\s/.test(s[k].trim()) || s[k].startsWith('-') || s[k].includes('..'))
      errors[k] = 'Invalid prefix.';
  }
  if (/\s/.test(s.versionTag.trim()) || s.versionTag.startsWith('-')) errors.versionTag = 'Invalid prefix.';
  return errors;
}

export interface FinishChoices {
  rebase: boolean;
  deleteBranch: boolean;
  push: boolean;
  tagName: string;
  tagMessage: string;
}

export function defaultFinishChoices(
  cfg: Pick<GitflowConfig, 'versionTag'>,
  kind: GitflowBranchKind,
  name: string,
): FinishChoices {
  return {
    rebase: false,
    deleteBranch: true,
    push: false,
    tagName: isTaggedKind(kind) ? defaultTagName(cfg, name) : '',
    tagMessage: '',
  };
}

/** Validate the finish dialog (spec 12 §4.9: tag message required for release/hotfix). */
export function finishError(kind: GitflowBranchKind, c: FinishChoices): string | null {
  if (!isTaggedKind(kind)) return null;
  if (!c.tagName.trim()) return 'Enter a tag name.';
  if (/\s/.test(c.tagName.trim()) || c.tagName.trim().startsWith('-')) return 'Invalid tag name.';
  if (!c.tagMessage.trim()) return 'A tag message is required.';
  return null;
}

/**
 * The local finish op. Pushing is done afterwards with separate `push` ops (see `finishPushOps`) so the
 * finish itself stays a single undoable journal entry and each push is a normal undo barrier.
 */
export function finishOp(kind: GitflowFinishKind, name: string, c: FinishChoices): GitOperation {
  return {
    type: 'gitflow.finish',
    kind,
    name,
    deleteBranch: c.deleteBranch,
    ...(isTaggedKind(kind)
      ? { tag: { name: c.tagName.trim(), message: c.tagMessage } }
      : { rebase: c.rebase }),
  };
}

/**
 * Pushes after a finish: develop (feature/bugfix); production, the second merge target (develop, or the
 * open release branch a hotfix went into — see `finishTarget`) and the tag (release/hotfix).
 */
export function finishPushOps(
  cfg: Pick<GitflowConfig, 'production' | 'develop'>,
  kind: GitflowBranchKind,
  tag: string,
  remote: string,
  target: string = cfg.develop,
): GitOperation[] {
  const branch = (b: string): GitOperation => ({ type: 'push', localRef: b, remote, remoteBranch: b });
  if (!isTaggedKind(kind)) return [branch(cfg.develop)];
  return [branch(cfg.production), branch(target), { type: 'push.tags', remote, tags: [tag.trim()] }];
}

/** The remote to publish/push to: `origin` when present, else the first one. */
export function pickRemote(remotes: string[]): string | null {
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}
