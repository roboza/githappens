import fs from 'node:fs';
import path from 'node:path';

import { APP_DIR_NAME } from '../app-names';
import type { GitOperation, OpOf } from '../ops/types';
import type { EntryPlan } from '../undo/plan';
import type { RefName, RepoSnapshot, SnapshotHead, SnapshotScope } from '../undo/types';
import type { GitService } from './git-service';

/**
 * Git Flow configuration and state (spec 05 §6.12, spec 12 §6.9, spec 13 §5.2). Config lives in the
 * standard git-flow AVH keys (`gitflow.branch.master|develop`, `gitflow.prefix.*`), so repos set up with
 * the git-flow extension work as-is. Flow types: feature and bugfix (from develop, finish into develop),
 * release (from develop) and hotfix (from production) finish into production + tag + develop (a hotfix
 * goes into the open release branch instead of develop, AVH), support (from a tag; never finished). Read-only helpers here; the mutating ops are in
 * `ops/executors/gitflow.ts`.
 */

export type GitflowBranchKind = 'feature' | 'bugfix' | 'release' | 'hotfix' | 'support';

/** Flow types in display order. */
export const GITFLOW_KINDS: readonly GitflowBranchKind[] = [
  'feature',
  'bugfix',
  'release',
  'hotfix',
  'support',
];

/**
 * Kinds that can be finished. Support branches are long-lived (AVH git-flow has no `support finish`):
 * they are only started, published and deleted.
 */
export type GitflowFinishKind = Exclude<GitflowBranchKind, 'support'>;

/** Release/hotfix finishes merge into production and tag; feature/bugfix finishes merge into develop. */
export const isTaggedFinish = (kind: GitflowBranchKind): kind is 'release' | 'hotfix' =>
  kind === 'release' || kind === 'hotfix';

/** spec 13 §5.2 `GitflowConfig`. Prefixes include their trailing `/`. */
export interface GitflowConfig {
  /** Production branch (`gitflow.branch.master`). */
  production: string;
  develop: string;
  feature: string;
  release: string;
  hotfix: string;
  bugfix: string;
  support: string;
  /** Version tag prefix (may be empty). */
  versionTag: string;
  initialized: boolean;
}

/** What `gitflow.init` writes (everything but `initialized`). */
export type GitflowSettings = Omit<GitflowConfig, 'initialized'>;

export const GITFLOW_DEFAULTS: GitflowSettings = {
  production: 'main',
  develop: 'develop',
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  bugfix: 'bugfix/',
  support: 'support/',
  versionTag: '',
};

/** git config key per setting. */
export const GITFLOW_KEYS: Record<keyof GitflowSettings, string> = {
  production: 'gitflow.branch.master',
  develop: 'gitflow.branch.develop',
  feature: 'gitflow.prefix.feature',
  release: 'gitflow.prefix.release',
  hotfix: 'gitflow.prefix.hotfix',
  bugfix: 'gitflow.prefix.bugfix',
  support: 'gitflow.prefix.support',
  versionTag: 'gitflow.prefix.versiontag',
};

/** Flow branches (full local branch names, e.g. `feature/login`) grouped by type. */
export type GitflowBranches = Record<GitflowBranchKind, string[]>;

export const emptyFlowBranches = (): GitflowBranches => ({
  feature: [],
  bugfix: [],
  release: [],
  hotfix: [],
  support: [],
});

/** A finish that stopped on a conflict (state file present). */
export interface GitflowPendingFinish {
  kind: GitflowFinishKind;
  name: string;
  branch: string;
  /** What the paused step does, e.g. "merge release/1.2 into develop". */
  step: string;
  /** Which git operation is waiting: a merge (commit it) or a rebase (continue it). */
  waitingOn: 'merge' | 'rebase';
  /** Steps left after the paused one. */
  remaining: string[];
  startedAt: number;
}

export interface GitflowStatus {
  config: GitflowConfig | null;
  branches: GitflowBranches;
  pendingFinish: GitflowPendingFinish | null;
}

// ---- finish state (persisted at <gitdir>/githappens/gitflow-finish.json) ----

export type GitflowFinishStep =
  | { t: 'rebase'; onto: string; branch: string }
  | { t: 'merge'; into: string; from: string }
  | { t: 'tag'; name: string; message: string; target: string }
  | { t: 'delete'; branch: string }
  | { t: 'push'; remote: string; refs: string[] };

export interface GitflowFinishState {
  version: 1;
  req: Omit<OpOf<'gitflow.finish'>, 'type'>;
  branch: string;
  /** Remaining steps; the first one is the step that stopped (re-run on continue, idempotent). */
  steps: GitflowFinishStep[];
  /** Undo snapshot scope of the whole finish, and the state before it started. */
  scope: SnapshotScope;
  before: RepoSnapshot;
  /** Values of `scope.refs` when the finish paused (abort only rolls back refs still at these values). */
  pausedRefs: Record<RefName, string | null>;
  /** Keep-alive refs for the `before` snapshot objects (`refs/githappens/gitflow/<n>`). */
  pins: RefName[];
  startedAt: number;
  /** Where the second merge goes: develop, or (hotfix, AVH) the open release branch. Absent = develop. */
  mergedInto?: string;
}

export const GITFLOW_PIN_NAMESPACE = 'refs/githappens/gitflow/';

export function finishStatePath(service: GitService): string {
  return path.join(service.repo.gitDir, APP_DIR_NAME, 'gitflow-finish.json');
}

export function readFinishState(service: GitService): GitflowFinishState | null {
  try {
    const data = JSON.parse(fs.readFileSync(finishStatePath(service), 'utf8')) as GitflowFinishState;
    if (data?.version !== 1 || !Array.isArray(data.steps) || !data.before || !data.scope) return null;
    return data;
  } catch {
    return null; // missing or unreadable
  }
}

export function writeFinishState(service: GitService, state: GitflowFinishState): void {
  const file = finishStatePath(service);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function clearFinishState(service: GitService): void {
  fs.rmSync(finishStatePath(service), { force: true });
}

export function describeFinishStep(s: GitflowFinishStep): string {
  switch (s.t) {
    case 'rebase':
      return `rebase ${s.branch} onto ${s.onto}`;
    case 'merge':
      return `merge ${s.from} into ${s.into}`;
    case 'tag':
      return `tag ${s.target} as ${s.name}`;
    case 'delete':
      return `delete ${s.branch}`;
    case 'push':
      return `push ${s.refs.map((r) => r.replace(/^refs\/(heads|tags)\//, '')).join(', ')} to ${s.remote}`;
  }
}

export function pendingFinish(state: GitflowFinishState | null): GitflowPendingFinish | null {
  const first = state?.steps[0];
  if (!state || !first) return null;
  return {
    kind: state.req.kind,
    name: state.req.name,
    branch: state.branch,
    step: describeFinishStep(first),
    waitingOn: first.t === 'rebase' ? 'rebase' : 'merge',
    remaining: state.steps.slice(1).map(describeFinishStep),
    startedAt: state.startedAt,
  };
}

// ---- config ----

/** Parse `git config -z --get-regexp '^gitflow\.'` output; null when Git Flow is not set up (no develop key). */
export function parseGitflowConfig(stdout: string): GitflowConfig | null {
  const values = new Map<string, string>();
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = (nl >= 0 ? rec.slice(0, nl) : rec).toLowerCase();
    values.set(key, nl >= 0 ? rec.slice(nl + 1) : '');
  }
  const develop = values.get(GITFLOW_KEYS.develop);
  if (!develop) return null;
  const out = { ...GITFLOW_DEFAULTS, initialized: false } as GitflowConfig;
  for (const [field, key] of Object.entries(GITFLOW_KEYS) as [keyof GitflowSettings, string][]) {
    const v = values.get(key);
    if (v !== undefined) out[field] = v;
  }
  out.initialized = values.has(GITFLOW_KEYS.production) && values.has(GITFLOW_KEYS.develop);
  return out;
}

/** The repo's Git Flow config (`git config --local`), or null when not initialized. */
export async function gitflowConfig(service: GitService): Promise<GitflowConfig | null> {
  const r = await service.runRead(['config', '--local', '-z', '--get-regexp', '^gitflow\\.'], {
    expectedExitCodes: [0, 1],
  });
  return r.exitCode === 0 ? parseGitflowConfig(r.stdout) : null;
}

/** Group local branch names by flow prefix. Empty prefixes match nothing. */
export function groupFlowBranches(
  branches: string[],
  cfg: Pick<GitflowConfig, GitflowBranchKind>,
): GitflowBranches {
  const out = emptyFlowBranches();
  for (const b of branches) {
    for (const kind of GITFLOW_KINDS) {
      const p = cfg[kind];
      if (p && b.startsWith(p) && b.length > p.length) {
        out[kind].push(b);
        break;
      }
    }
  }
  for (const k of GITFLOW_KINDS) out[k].sort((a, b) => a.localeCompare(b));
  return out;
}

/** Local flow branches of the repo, grouped by type. */
export async function localFlowBranches(service: GitService, cfg: GitflowConfig): Promise<GitflowBranches> {
  const r = await service.runRead(['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'], {
    expectedExitCodes: [0],
  });
  return groupFlowBranches(r.stdout.split('\n').filter(Boolean), cfg);
}

/**
 * The branch the second merge of a finish goes into. AVH git-flow: a hotfix finish merges into the open
 * release branch *instead of* develop when one exists (the release carries the fix to develop when it is
 * finished). Only applied when exactly one local release branch exists; otherwise develop.
 */
export function secondaryTarget(
  cfg: Pick<GitflowConfig, 'develop'>,
  kind: GitflowBranchKind,
  releases: readonly string[],
): string {
  return kind === 'hotfix' && releases.length === 1 ? releases[0]! : cfg.develop;
}

/** `secondaryTarget` for the repo's current local branches. */
export async function finishSecondaryTarget(
  service: GitService,
  cfg: GitflowConfig,
  kind: GitflowBranchKind,
): Promise<string> {
  if (kind !== 'hotfix') return cfg.develop;
  return secondaryTarget(cfg, kind, (await localFlowBranches(service, cfg)).release);
}

/** Config, flow branches and the paused finish (if any) for the left-panel section (spec 12 §4.9). */
export async function gitflowStatus(service: GitService): Promise<GitflowStatus> {
  const config = await gitflowConfig(service);
  const branches = config ? await localFlowBranches(service, config) : emptyFlowBranches();
  return { config, branches, pendingFinish: pendingFinish(readFinishState(service)) };
}

// ---- undo journal integration ----

/**
 * Snapshot scope of a finish: production, develop (or the release branch a hotfix merges into), the flow
 * branch and the tag, plus HEAD/index/worktree.
 */
export function finishScope(
  cfg: GitflowConfig,
  branch: string,
  tag?: string,
  secondary: string = cfg.develop,
): SnapshotScope {
  const refs = [`refs/heads/${secondary}`, `refs/heads/${branch}`];
  if (tag) refs.unshift(`refs/heads/${cfg.production}`);
  if (tag) refs.push(`refs/tags/${tag}`);
  return { head: 'set', refs, trees: true, stash: false, configBranches: [branch] };
}

const finishLabel = (kind: GitflowFinishKind, name: string): string => `Finish ${kind} ${name}`;

/**
 * Journal plan for the Git Flow ops (needs the repo's config, hence async). A finish is ONE entry covering
 * every ref it moves; a resumed finish (`gitflow.continue`) reuses the snapshot taken when the finish
 * started, so a single undo restores the pre-finish refs. Ops that push are not journaled (spec 05: undo
 * can't go past a push).
 */
export async function gitflowPlan(
  service: GitService,
  op: GitOperation,
  _head: SnapshotHead,
): Promise<EntryPlan | null> {
  switch (op.type) {
    case 'gitflow.start': {
      if (op.publish) return null;
      const cfg = await gitflowConfig(service);
      if (!cfg) return null;
      const branch = `${cfg[op.kind]}${op.name}`;
      return {
        kind: 'branch-create',
        label: `Start ${op.kind} ${op.name}`,
        scope: {
          head: 'switch',
          refs: [`refs/heads/${branch}`],
          trees: false,
          stash: false,
          configBranches: [branch],
        },
      };
    }
    case 'gitflow.finish': {
      if (op.push) return null;
      const cfg = await gitflowConfig(service);
      if (!cfg) return null;
      const tag = isTaggedFinish(op.kind) ? op.tag?.name.trim() : undefined;
      return {
        kind: 'gitflow-finish',
        label: finishLabel(op.kind, op.name),
        scope: finishScope(
          cfg,
          `${cfg[op.kind]}${op.name}`,
          tag,
          await finishSecondaryTarget(service, cfg, op.kind),
        ),
      };
    }
    case 'gitflow.continue': {
      const st = readFinishState(service);
      if (!st || st.req.push) return null;
      return {
        kind: 'gitflow-finish',
        label: finishLabel(st.req.kind, st.req.name),
        scope: st.scope,
        before: st.before,
      };
    }
    default:
      return null;
  }
}
