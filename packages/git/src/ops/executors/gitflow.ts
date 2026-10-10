import { GitError, makeError } from '../../errors/classify';
import type { GitProcessRunner } from '../../process/runner';
import type { GitService } from '../../service/git-service';
import {
  clearFinishState,
  describeFinishStep,
  finishScope,
  finishSecondaryTarget,
  GITFLOW_KEYS,
  GITFLOW_PIN_NAMESPACE,
  gitflowConfig,
  isTaggedFinish,
  readFinishState,
  writeFinishState,
  type GitflowBranchKind,
  type GitflowConfig,
  type GitflowFinishState,
  type GitflowFinishStep,
  type GitflowSettings,
} from '../../service/gitflow';
import { UndoGit } from '../../undo/git';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { validateBranchName } from './branch';
import { requireIdle, requireResolved } from './history-util';
import { assertSafeName, define, fail, git, isUnbornHead, read, unmergedPaths } from './util';

/**
 * Git Flow commands, implemented natively (spec 05 §6.12, spec 12 §6.9). A finish is one composite op
 * (one undo-journal entry, see `gitflowPlan`). When a merge/rebase step conflicts, the remaining steps are
 * persisted to `<gitdir>/githappens/gitflow-finish.json` and the repo is left in the merge/rebase state;
 * `gitflow.continue` resumes, `gitflow.abort` aborts and rolls back.
 *
 * Flow types (AVH git-flow semantics): feature and bugfix start from develop and finish into develop
 * (optional rebase first); release starts from develop, hotfix from production, both finish into
 * production + annotated tag + develop, except that a hotfix finish merges into the open release branch
 * instead of develop when exactly one exists. Support branches start from a base ref (usually a version
 * tag) and are long-lived: there is no support finish (publish / delete them like any branch).
 * `gitflow.reset` removes the `gitflow.*` config.
 */

export interface GitflowStartOutcome {
  branch: string;
}
export interface GitflowFinishOutcome {
  branch: string;
  tag?: string;
  /** Hotfix finished into the open release branch instead of develop (AVH). */
  mergedInto?: string;
  /** True when the finish stopped on a conflict (only reported through the error; kept for symmetry). */
  paused?: boolean;
}

const KIND_NOUN: Record<GitflowBranchKind, string> = {
  feature: 'feature',
  bugfix: 'bugfix',
  release: 'release',
  hotfix: 'hotfix',
  support: 'support branch',
};

const undoGit = (svc: GitService): UndoGit => new UndoGit(svc, svc['runner'] as GitProcessRunner);

async function requireConfig(ctx: OpContext): Promise<GitflowConfig> {
  const cfg = await gitflowConfig(ctx.service);
  if (!cfg) {
    throw fail('Unknown', 'Git Flow is not initialized in this repository.', { hint: 'gitflow.init' });
  }
  return cfg;
}

async function branchSha(svc: GitService, name: string): Promise<string | null> {
  return svc.revParse(`refs/heads/${name}`);
}

/** Missing develop/production branch → error with a hint the UI turns into a button (spec 12 §8). */
async function requireBaseBranch(svc: GitService, cfg: GitflowConfig, which: 'develop' | 'production') {
  const name = which === 'develop' ? cfg.develop : cfg.production;
  if (await branchSha(svc, name)) return;
  throw fail(
    'Unknown',
    which === 'develop'
      ? `The develop branch "${name}" does not exist. Create it from ${cfg.production} first.`
      : `The production branch "${name}" does not exist.`,
    { hint: which === 'develop' ? 'gitflow.createDevelop' : 'gitflow.missingProduction', branch: name },
  );
}

async function requireValidBranch(svc: GitService, name: string): Promise<void> {
  const v = await validateBranchName(svc, name);
  if (!v.valid) throw fail('InvalidRefName', v.reason);
}

function assertPrefix(value: string, what: string): void {
  if (value.startsWith('-') || /[\0\r\n\s]/.test(value) || value.includes('..')) {
    throw fail('InvalidRefName', `Invalid ${what}: "${value}".`);
  }
}

// ---- init ----

async function init(ctx: OpContext, op: OpOf<'gitflow.init'>): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  const s: GitflowSettings = {
    production: op.production.trim(),
    develop: op.develop.trim(),
    feature: op.feature.trim(),
    release: op.release.trim(),
    hotfix: op.hotfix.trim(),
    bugfix: (op.bugfix ?? 'bugfix/').trim(),
    support: op.support.trim(),
    versionTag: (op.versionTag ?? '').trim(),
  };
  assertSafeName(s.production, 'production branch');
  assertSafeName(s.develop, 'develop branch');
  await requireValidBranch(svc, s.production);
  await requireValidBranch(svc, s.develop);
  if (s.production === s.develop) throw fail('Unknown', 'The production and develop branches must differ.');
  for (const k of ['feature', 'release', 'hotfix', 'bugfix', 'support'] as const) {
    assertPrefix(s[k], `${k} prefix`);
    if (!s[k]) throw fail('Unknown', `The ${k} prefix cannot be empty.`);
  }
  assertPrefix(s.versionTag, 'version tag prefix');

  const prod = await branchSha(svc, s.production);
  const dev = await branchSha(svc, s.develop);
  const unborn = await isUnbornHead(svc);
  if (!prod && !dev && !unborn) {
    throw fail('Unknown', `The production branch "${s.production}" does not exist.`, {
      hint: 'gitflow.missingProduction',
      branch: s.production,
    });
  }
  for (const [field, key] of Object.entries(GITFLOW_KEYS) as [keyof GitflowSettings, string][]) {
    await git(ctx, ['config', '--local', key, s[field]]);
  }
  const warnings: string[] = [];
  let created = false;
  if (!dev) {
    if (prod) {
      await git(ctx, ['branch', '--no-track', '--', s.develop, s.production]);
      created = true;
    } else {
      // empty repo: nothing to branch from yet (spec 12 §6.9 "skip")
      warnings.push(`${s.develop} will be created once ${s.production} has a commit.`);
    }
  }
  return {
    summary: created ? `Initialized Git Flow (created ${s.develop})` : 'Initialized Git Flow',
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---- start ----

async function start(
  ctx: OpContext,
  op: OpOf<'gitflow.start'>,
): Promise<Omit<OpResult<GitflowStartOutcome>, 'opId'>> {
  const svc = ctx.service;
  const cfg = await requireConfig(ctx);
  assertSafeName(op.name, `${op.kind} name`);
  const branch = `${cfg[op.kind]}${op.name.trim()}`;
  await requireValidBranch(svc, branch);
  if (await branchSha(svc, branch)) {
    throw fail('BranchAlreadyExists', `A branch named ${branch} already exists.`, { branch });
  }
  let base = op.base?.trim();
  if (base) {
    assertSafeName(base, 'base');
    if (!(await svc.revParse(base))) throw fail('Unknown', `Unknown revision "${base}".`);
  } else if (op.kind === 'support') {
    throw fail('Unknown', 'A support branch starts from a tag or commit: choose a base.', {
      hint: 'gitflow.supportBase',
    });
  } else {
    await requireBaseBranch(svc, cfg, op.kind === 'hotfix' ? 'production' : 'develop');
    base = op.kind === 'hotfix' ? cfg.production : cfg.develop;
  }
  if (op.publish) assertSafeName(op.publish.remote, 'remote');
  await git(ctx, ['switch', '--no-track', '-c', branch, base]);
  if (op.publish) {
    await git(
      ctx,
      ['push', '--porcelain', '-u', op.publish.remote, `refs/heads/${branch}:refs/heads/${branch}`],
      {
        network: 'push',
      },
    );
  }
  return {
    summary: `Started ${KIND_NOUN[op.kind]} ${branch}${op.publish ? ` and pushed it to ${op.publish.remote}` : ''}`,
    data: { branch },
  };
}

// ---- finish ----

/**
 * The steps of a finish. `secondary` is develop, or the open release branch for a hotfix (AVH merges the
 * hotfix there *instead of* develop; develop gets it when the release is finished).
 */
function finishSteps(
  cfg: GitflowConfig,
  op: OpOf<'gitflow.finish'>,
  branch: string,
  secondary: string,
): GitflowFinishStep[] {
  const steps: GitflowFinishStep[] = [];
  const push: string[] = [];
  if (!isTaggedFinish(op.kind)) {
    if (op.rebase) steps.push({ t: 'rebase', onto: cfg.develop, branch });
    steps.push({ t: 'merge', into: cfg.develop, from: branch });
    push.push(`refs/heads/${cfg.develop}`);
  } else {
    const tag = op.tag!;
    steps.push({ t: 'merge', into: cfg.production, from: branch });
    steps.push({ t: 'tag', name: tag.name, message: tag.message, target: cfg.production });
    steps.push({ t: 'merge', into: secondary, from: branch });
    push.push(`refs/heads/${cfg.production}`, `refs/heads/${secondary}`, `refs/tags/${tag.name}`);
  }
  if (op.deleteBranch) steps.push({ t: 'delete', branch });
  if (op.push) steps.push({ t: 'push', remote: op.push.remote, refs: push });
  return steps;
}

async function requireCleanTracked(svc: GitService, what: string): Promise<void> {
  const r = await read(svc, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (r.stdout.trim()) {
    throw fail('DirtyWorktree', `Commit or stash your changes before you ${what}.`);
  }
}

async function finish(
  ctx: OpContext,
  op: OpOf<'gitflow.finish'>,
): Promise<Omit<OpResult<GitflowFinishOutcome>, 'opId'>> {
  const svc = ctx.service;
  const cfg = await requireConfig(ctx);
  if (readFinishState(svc)) {
    throw fail('Unknown', 'Another Git Flow finish is paused. Continue or abort it first.', {
      hint: 'gitflow.pending',
    });
  }
  if ((op.kind as GitflowBranchKind) === 'support') {
    throw fail(
      'Unknown',
      'Support branches are long-lived and cannot be finished. Publish or delete the branch instead.',
      { hint: 'gitflow.supportFinish' },
    );
  }
  assertSafeName(op.name, `${op.kind} name`);
  const branch = `${cfg[op.kind]}${op.name}`;
  const what = `finish ${branch}`;
  await requireIdle(ctx, what);
  await requireCleanTracked(svc, what);
  if (!(await branchSha(svc, branch))) throw fail('Unknown', `Branch ${branch} does not exist.`, { branch });
  const secondary = await finishSecondaryTarget(svc, cfg, op.kind);
  if (secondary === cfg.develop) await requireBaseBranch(svc, cfg, 'develop');
  let tag: string | undefined;
  if (isTaggedFinish(op.kind)) {
    await requireBaseBranch(svc, cfg, 'production');
    if (!op.tag?.name.trim()) throw fail('Unknown', 'A tag name is required to finish a release or hotfix.');
    if (!op.tag.message.trim()) throw fail('EmptyCommitMessage', 'A tag message is required.');
    tag = op.tag.name.trim();
    assertSafeName(tag, 'tag name');
    const fmt = await read(svc, ['check-ref-format', `refs/tags/${tag}`], { expectedExitCodes: [0, 1, 128] });
    if (fmt.exitCode !== 0) throw fail('InvalidRefName', `"${tag}" is not a valid tag name.`);
    const exists = await read(svc, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      expectedExitCodes: [0, 1, 128],
    });
    if (exists.exitCode === 0) {
      throw fail('TagAlreadyExists', `A tag named ${tag} already exists. Choose a different name.`, { tag });
    }
  }
  if (op.push) assertSafeName(op.push.remote, 'remote');
  const req = { ...op, ...(tag ? { tag: { name: tag, message: op.tag!.message } } : {}) };
  const { type: _type, ...rest } = req;
  const scope = finishScope(cfg, branch, tag, secondary);
  const ug = undoGit(svc);
  const state: GitflowFinishState = {
    version: 1,
    req: rest,
    branch,
    steps: finishSteps(cfg, req, branch, secondary),
    scope,
    before: await ug.snapshot(scope),
    pausedRefs: {},
    pins: [],
    startedAt: Date.now(),
    ...(secondary !== cfg.develop ? { mergedInto: secondary } : {}),
  };
  return runSteps(ctx, state, ug);
}

async function runStep(ctx: OpContext, step: GitflowFinishStep): Promise<void> {
  const svc = ctx.service;
  switch (step.t) {
    case 'rebase':
      await git(ctx, ['rebase', step.onto, step.branch]);
      return;
    case 'merge': {
      const head = await read(svc, ['symbolic-ref', '-q', '--short', 'HEAD'], { expectedExitCodes: [0, 1] });
      if (head.stdout.trim() !== step.into) await git(ctx, ['switch', '--quiet', step.into]);
      await git(ctx, ['merge', '--no-ff', '--no-edit', step.from]);
      return;
    }
    case 'tag':
      await git(
        ctx,
        ['tag', '-a', '--cleanup=whitespace', '-F', '-', step.name, `refs/heads/${step.target}`],
        {
          stdin: Buffer.from(step.message, 'utf8'),
        },
      );
      return;
    case 'delete':
      await git(ctx, ['branch', '-d', '--', step.branch]);
      return;
    case 'push':
      await git(ctx, ['push', '--porcelain', step.remote, ...step.refs.map((r) => `${r}:${r}`)], {
        network: 'push',
      });
      return;
  }
}

/** A merge/rebase step that stopped with git's operation still in progress (i.e. it can be resumed). */
async function stoppedMidStep(svc: GitService, step: GitflowFinishStep): Promise<boolean> {
  const st = (await svc.refreshRepoInfo()).state;
  if (step.t === 'merge') return st === 'merging';
  if (step.t === 'rebase') return st === 'rebasing' || st === 'rebasing-interactive';
  return false;
}

async function pause(svc: GitService, state: GitflowFinishState, ug: UndoGit): Promise<never> {
  if (!state.pins.length) {
    // keep the objects of the pre-finish snapshot alive until the finish is resumed or aborted
    const shas = new Set<string>();
    if (state.before.headSha) shas.add(state.before.headSha);
    for (const v of Object.values(state.before.touchedRefs)) if (v) shas.add(v);
    if (state.before.indexTree) shas.add(await ug.wrapTree(state.before.indexTree, 'gitflow index'));
    if (state.before.worktreeTree) shas.add(await ug.wrapTree(state.before.worktreeTree, 'gitflow worktree'));
    const pins = [...shas].map((sha, i) => ({ ref: `${GITFLOW_PIN_NAMESPACE}${i}`, sha }));
    await ug.createPins(pins);
    state.pins = pins.map((p) => p.ref);
  }
  state.pausedRefs = await ug.readRefs(state.scope.refs);
  writeFinishState(svc, state);
  const step = state.steps[0]!;
  const files = await unmergedPaths(svc).catch(() => [] as string[]);
  throw new GitError(
    makeError(
      step.t === 'rebase' ? 'RebaseConflict' : 'MergeConflict',
      { argv: [] },
      'Git Flow finish paused: resolve conflicts then Continue.',
      { files, gitflow: 'paused', step: describeFinishStep(step) },
    ),
  );
}

async function done(svc: GitService, state: GitflowFinishState, ug: UndoGit): Promise<void> {
  clearFinishState(svc);
  await ug.deletePins(state.pins).catch(() => undefined);
  state.pins = [];
}

async function runSteps(
  ctx: OpContext,
  state: GitflowFinishState,
  ug: UndoGit,
): Promise<Omit<OpResult<GitflowFinishOutcome>, 'opId'>> {
  const svc = ctx.service;
  while (state.steps.length) {
    const step = state.steps[0]!;
    try {
      await runStep(ctx, step);
    } catch (e) {
      if (await stoppedMidStep(svc, step)) return pause(svc, state, ug);
      // a hard failure (e.g. local changes in the way): a resumed finish stays paused so it can be retried
      if (state.pins.length) writeFinishState(svc, state);
      throw e;
    }
    state.steps.shift();
  }
  await done(svc, state, ug);
  await svc.refreshRepoInfo();
  const tag = isTaggedFinish(state.req.kind) ? state.req.tag?.name : undefined;
  const into = state.mergedInto;
  const notes = [tag ? `tagged ${tag}` : '', into ? `merged into ${into}` : ''].filter(Boolean);
  return {
    summary: `Finished ${KIND_NOUN[state.req.kind]} ${state.branch}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    data: { branch: state.branch, ...(tag ? { tag } : {}), ...(into ? { mergedInto: into } : {}) },
  };
}

// ---- continue / abort ----

function requirePaused(svc: GitService): GitflowFinishState {
  const state = readFinishState(svc);
  if (!state) throw fail('Unknown', 'There is no paused Git Flow finish.');
  return state;
}

async function cont(ctx: OpContext): Promise<Omit<OpResult<GitflowFinishOutcome>, 'opId'>> {
  const svc = ctx.service;
  const state = requirePaused(svc);
  const ug = undoGit(svc);
  const info = await svc.refreshRepoInfo();
  const step = state.steps[0];
  if (info.state === 'merging') {
    await requireResolved(svc, 'MergeConflict');
    await git(ctx, ['commit', '-q', '--no-edit', '--cleanup=strip']);
  } else if (info.state === 'rebasing' || info.state === 'rebasing-interactive') {
    await requireResolved(svc, 'RebaseConflict');
    try {
      await git(ctx, ['rebase', '--continue']);
    } catch (e) {
      if (step && (await stoppedMidStep(svc, step))) return pause(svc, state, ug);
      throw e;
    }
  } else {
    // the user committed / continued it already (or aborted it: the step is simply re-run)
    await requireIdle(ctx, 'continue the Git Flow finish');
  }
  await requireCleanTracked(svc, 'continue the Git Flow finish');
  // the stopped step is re-run: a merge that is already done is a no-op ("Already up to date")
  return runSteps(ctx, state, ug);
}

async function abort(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  const state = requirePaused(svc);
  const ug = undoGit(svc);
  const info = await svc.refreshRepoInfo();
  if (info.state === 'merging') await git(ctx, ['merge', '--abort']);
  else if (info.state === 'rebasing' || info.state === 'rebasing-interactive')
    await git(ctx, ['rebase', '--abort']);

  // roll back the steps already done — only refs still where the finish left them
  const warnings: string[] = [];
  const cur = await ug.readRefs(state.scope.refs);
  const changes: { ref: string; from: string | null; to: string | null }[] = [];
  for (const ref of state.scope.refs) {
    const want = state.before.touchedRefs[ref] ?? null;
    const have = cur[ref] ?? null;
    if (have === want) continue;
    if (have !== (state.pausedRefs[ref] ?? null)) {
      warnings.push(
        `${ref.replace(/^refs\/(heads|tags)\//, '')} changed since the finish paused; left as is.`,
      );
      continue;
    }
    changes.push({ ref, from: have, to: want });
  }
  const { head } = await ug.head();
  const headRef = head.kind === 'branch' ? `refs/heads/${head.name}` : null;
  const headChange = changes.find((c) => c.ref === headRef);
  // the checked-out branch moves with the worktree (clean after the abort above)
  if (headChange?.to) await git(ctx, ['reset', '--keep', '-q', headChange.to]);
  await ug.updateRefs(
    changes.filter((c) => c !== headChange),
    'githappens: abort Git Flow finish',
  );
  const b = state.before.head;
  if (b.kind === 'branch' && !(head.kind === 'branch' && head.name === b.name)) {
    await git(ctx, ['switch', '--quiet', b.name]);
  } else if (b.kind === 'detached' && b.sha) await git(ctx, ['switch', '--quiet', '--detach', b.sha]);
  await done(svc, state, ug);
  await svc.refreshRepoInfo();
  return {
    summary: `Aborted finishing ${state.branch}`,
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---- reset ----

/**
 * Remove the Git Flow configuration: every section holding a `gitflow.*` key (`gitflow.branch`,
 * `gitflow.prefix`, AVH extras such as `gitflow.feature.finish`, plain `[gitflow]`). Missing sections are
 * tolerated; branches and tags are left alone. Refused while a finish is paused (its state needs the config).
 */
async function reset(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  if (readFinishState(svc)) {
    throw fail('Unknown', 'A Git Flow finish is paused. Continue or abort it first.', {
      hint: 'gitflow.pending',
    });
  }
  const r = await read(svc, ['config', '--local', '--name-only', '--get-regexp', '^gitflow\\.'], {
    expectedExitCodes: [0, 1],
  });
  const keys =
    r.exitCode === 0
      ? r.stdout
          .split('\n')
          .map((k) => k.trim())
          .filter(Boolean)
      : [];
  const sections = new Set(['gitflow.branch', 'gitflow.prefix']);
  for (const k of keys) sections.add(k.slice(0, k.lastIndexOf('.')));
  // subsections first, then the bare [gitflow] section
  const ordered = [...sections].sort((a, b) => b.length - a.length);
  for (const section of ordered) {
    // exit 128 "no such section": tolerated
    await git(ctx, ['config', '--local', '--remove-section', section], { expectedExitCodes: [0, 1, 128] });
  }
  return {
    summary: keys.length ? 'Removed the Git Flow configuration' : 'Git Flow was not configured',
  };
}

const FLOW_TOUCHES = ['refs', 'graph', 'status', 'repoState', 'conflicts'] as const;

export const gitflowOps = {
  'gitflow.init': define(
    'gitflow.init',
    { label: () => 'Initialize Git Flow', touches: ['refs', 'graph', 'config'] },
    (ctx, op) => init(ctx, op),
  ),
  'gitflow.start': define(
    'gitflow.start',
    {
      label: (op) => `Start ${op.kind} ${op.name}`,
      touches: ['refs', 'graph', 'status', 'repoState'],
      network: true,
      undoable: true,
    },
    (ctx, op) => start(ctx, op),
  ),
  'gitflow.finish': define(
    'gitflow.finish',
    {
      label: (op) => `Finish ${op.kind} ${op.name}`,
      touches: [...FLOW_TOUCHES],
      network: true,
      undoable: true,
    },
    (ctx, op) => finish(ctx, op),
  ),
  'gitflow.continue': define(
    'gitflow.continue',
    { label: () => 'Continue Git Flow finish', touches: [...FLOW_TOUCHES], network: true, undoable: true },
    (ctx) => cont(ctx),
  ),
  'gitflow.abort': define(
    'gitflow.abort',
    { label: () => 'Abort Git Flow finish', touches: [...FLOW_TOUCHES] },
    (ctx) => abort(ctx),
  ),
  'gitflow.reset': define(
    'gitflow.reset',
    { label: () => 'Reset Git Flow configuration', touches: ['config'] },
    (ctx) => reset(ctx),
  ),
};
