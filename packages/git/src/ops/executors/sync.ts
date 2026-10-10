import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { classifyError, GitError, makeError } from '../../errors/classify';
import { normalizeGitPath } from '../../parsers/revparse';
import type { GitRunResult } from '../../process/runner';
import type { GitService } from '../../service/git-service';
import type { CommitSummary, GitErrorCode, Sha } from '../../types';
import type { OpContext } from '../queue';
import type { FetchOutcome, OpOf, OpResult, PullOutcome, PullStrategy, PushOutcome } from '../types';
import {
  assertSafeName,
  define,
  fail,
  git,
  read,
  splitRemoteRef,
  unmergedPaths,
  withConflictFiles,
} from './util';

type PushRef = PushOutcome['refs'][number];

/** Parse `git push --porcelain` stdout (spec 09 §6.5 step 4). */
export function parsePorcelainPush(stdout: string): PushRef[] {
  const refs: PushRef[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const spec = m[2]!;
    const colon = spec.indexOf(':');
    refs.push({
      flag: m[1]!,
      from: colon >= 0 ? spec.slice(0, colon) : spec,
      to: colon >= 0 ? spec.slice(colon + 1) : spec,
      summary: m[3]!,
    });
  }
  return refs;
}

/** `remote:` lines of a push/fetch (spec 09 §6.5 step 5), trimmed, ANSI-free, empty lines dropped. */
export function parseRemoteMessages(stderr: string): string[] {
  const out: string[] = [];
  for (const raw of stderr.split(/\r?\n|\r/)) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const m = /^remote:\s?(.*)$/.exec(line);
    if (!m) continue;
    const t = m[1]!.trim();
    if (t && !/^(?:Counting|Compressing|Enumerating|Total|Resolving)\b/.test(t)) out.push(t);
  }
  return out;
}

const PR_URL =
  /(https?:\/\/[^\s'"<>]+?(?:\/pull\/new\/|\/-?\/?merge_requests\/new|\/pull-requests\/new|\/pullrequestcreate|\/compare\/)[^\s'"<>]*)/i;

/**
 * "Create a pull request" URL printed by the remote after a push (spec 09 §6.5 step 5): GitHub
 * `/pull/new/<b>`, GitLab `/-/merge_requests/new?…`, Bitbucket `/pull-requests/new?source=…`, Azure DevOps
 * `/pullrequestcreate?sourceRef=…`, Gitea/Forgejo `/compare/<base>...<b>`.
 */
export function parsePrUrlHint(messages: string[]): string | undefined {
  for (const line of messages) {
    const m = PR_URL.exec(line);
    if (m) return m[1]!.replace(/[.,;)]+$/, '');
  }
  return undefined;
}

/** `hint: The '<path>' hook was ignored because it's not set as executable.` (spec 09 §6.12). */
export function ignoredHookHints(stderr: string): string[] {
  const out: string[] = [];
  for (const m of stderr.matchAll(
    /hint: The '([^']+)' hook was ignored because it's not set as executable/g,
  )) {
    const name = m[1]!.split(/[\\/]/).pop()!;
    out.push(`The ${name} hook was ignored because it is not executable (chmod +x ${m[1]}).`);
  }
  return out;
}

function rejectionCode(r: PushRef, stderr: string): GitErrorCode {
  const s = r.summary;
  if (/stale info/i.test(s)) return 'PushRejectedStaleLease';
  if (/non-fast-forward|fetch first/i.test(s)) return 'PushRejectedNonFastForward';
  if (/remote rejected/i.test(s)) {
    const c = classifyError({ argv: ['push'], exitCode: 1, stderr: `${stderr}\n${s}` }).code;
    return c === 'ProtectedBranch' ? 'ProtectedBranch' : 'PushRejectedByRemote';
  }
  return 'PushRejectedByRemote';
}

function hookFile(gitPathOut: string): { exists: boolean; executable: boolean } {
  try {
    const st = fs.statSync(normalizeGitPath(gitPathOut));
    if (!st.isFile()) return { exists: false, executable: false };
    return { exists: true, executable: process.platform === 'win32' || (st.mode & 0o111) !== 0 };
  } catch {
    return { exists: false, executable: false };
  }
}

/**
 * Turn a push run (expected exit 0/1) into success or a classified GitError. Rejected refs map to
 * PushRejected* (details.refs lists them); a failure before any ref line with a pre-push hook present is
 * HookFailed (spec 09 §6.12).
 */
export function pushOrThrow(
  argv: string[],
  r: GitRunResult<string>,
  refs: PushRef[],
  opId?: string,
  prePushHook?: boolean,
): void {
  if (r.exitCode === 0) return;
  const rejected = refs.filter((x) => x.flag === '!');
  const base = { argv, exitCode: r.exitCode, stderr: r.stderr, opId };
  if (rejected.length) {
    const code = rejectionCode(rejected[0]!, r.stderr);
    const err = makeError(code, base, undefined, {
      refs: rejected.map((x) => `${x.to} ${x.summary}`),
      ref: rejected[0]!.to,
    });
    throw new GitError(err);
  }
  const c = classifyError(base);
  if (prePushHook && !refs.length && c.code === 'Unknown' && /failed to push some refs/i.test(r.stderr)) {
    throw new GitError({
      ...makeError('HookFailed', base, 'The pre-push hook failed.', {
        hook: 'pre-push',
        output: r.stderr.trim(),
      }),
    });
  }
  throw new GitError(c);
}

export interface HookInfo {
  name: string;
  /** Absolute path (honours `core.hooksPath`). */
  path: string;
  exists: boolean;
  /** Always true on Windows (git runs hooks through sh there). */
  executable: boolean;
}

export const KNOWN_HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-push',
  'pre-rebase',
  'post-checkout',
  'post-merge',
] as const;

/**
 * Hook discovery (spec 09 §6.12): `rev-parse --git-path hooks/<name>` honours `core.hooksPath` (the repo
 * "Git hooks path" preference). A hook that exists but is not executable is ignored by git (POSIX).
 */
export async function hookInfo(
  service: GitService,
  names: readonly string[] = KNOWN_HOOKS,
): Promise<HookInfo[]> {
  if (!names.length) return [];
  for (const n of names) assertSafeName(n, 'hook');
  const r = await read(
    service,
    ['rev-parse', '--path-format=absolute', ...names.flatMap((n) => ['--git-path', `hooks/${n}`])],
    { expectedExitCodes: [0, 128] },
  );
  if (r.exitCode !== 0) return [];
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  return names.map((name, i) => {
    const p = normalizeGitPath(lines[i] ?? '');
    return { name, path: p, ...(p ? hookFile(p) : { exists: false, executable: false }) };
  });
}

async function hasPrePushHook(service: GitService): Promise<boolean> {
  const [h] = await hookInfo(service, ['pre-push']);
  return !!h?.exists && h.executable;
}

// ---- fetch (spec 09 §6.2) ----

type UpdatedRef = FetchOutcome['updatedRefs'][number];

/** `git fetch --porcelain` stdout (git ≥ 2.41): `<flag> <old> <new> <local ref>`. */
export function parseFetchPorcelain(stdout: string): UpdatedRef[] {
  const out: UpdatedRef[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([ +\-t*!=]) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S.*)$/.exec(line);
    if (!m) continue;
    const zero = (s: string): boolean => /^0+$/.test(s);
    out.push({
      flag: m[1]!,
      ref: m[4]!,
      ...(zero(m[2]!) ? {} : { old: m[2]! }),
      ...(zero(m[3]!) ? {} : { new: m[3]! }),
    });
  }
  return out;
}

/**
 * The stderr summary of a non-porcelain fetch (spec 09 §6.2): ` + a..b  main -> origin/main (forced update)`,
 * ` * [new branch] x -> origin/x`, ` - [deleted] (none) -> origin/y`, ` t [tag update] v1 -> v1`. `From <url>`
 * headers start a new remote; progress lines are ignored.
 */
export function parseFetchStderr(stderr: string): UpdatedRef[] {
  const out: UpdatedRef[] = [];
  for (const raw of stderr.split(/\r?\n|\r/)) {
    const m =
      /^ ([ +\-t*!=]) (\[[^\]]+\]|[0-9a-f]+\.{2,3}[0-9a-f]+)\s+(.+?)\s+->\s+(\S+)(?:\s+\((.+)\))?\s*$/.exec(
        raw,
      );
    if (!m) continue;
    const range = /^([0-9a-f]+)\.{2,3}([0-9a-f]+)$/.exec(m[2]!);
    const ref = m[4]!.includes('/') || m[1] === 't' ? m[4]! : m[4]!;
    out.push({
      flag: m[1]!,
      ref,
      ...(range ? { old: range[1]!, new: range[2]! } : {}),
      summary: m[5] ?? m[2]!.replace(/^\[|\]$/g, ''),
    });
  }
  return out;
}

/** Toast text for a fetch result: "Fetched 3 updates on origin" (spec 09 §6.2). */
export function fetchSummary(o: FetchOutcome): string {
  const where = o.remotes.length === 1 ? o.remotes[0]! : `${o.remotes.length} remotes`;
  const n = o.updatedRefs.filter((r) => r.flag !== '=').length;
  if (!n) return `Fetched ${where} — no updates`;
  return `Fetched ${n} update${n === 1 ? '' : 's'} on ${where}`;
}

async function fetch(
  ctx: OpContext,
  remote: string,
  prune?: boolean,
): Promise<Omit<OpResult<FetchOutcome>, 'opId'>> {
  const tail: string[] = [];
  if (prune) tail.push('--prune');
  if (remote === 'all') tail.push('--all');
  else {
    assertSafeName(remote, 'remote');
    tail.push('--', remote);
  }
  // --porcelain needs git 2.41; older git rejects the option (exit 129) before touching the network
  let r = await git(ctx, ['fetch', '--progress', '--porcelain', ...tail], {
    network: 'fetch',
    expectedExitCodes: [0, 129],
  });
  let updatedRefs: UpdatedRef[];
  if (r.exitCode === 129) {
    if (!/porcelain/i.test(r.stderr)) throw classifyErrorOf(['fetch', ...tail], r, ctx.opId);
    r = await git(ctx, ['fetch', '--progress', ...tail], { network: 'fetch' });
    updatedRefs = parseFetchStderr(r.stderr);
  } else updatedRefs = parseFetchPorcelain(r.stdout);
  updatedRefs = updatedRefs.filter((u) => u.flag !== '=');
  const remotes = remote === 'all' ? (await ctx.service.remotes()).map((x) => x.name) : [remote];
  const outcome: FetchOutcome = {
    remotes,
    updatedRefs,
    pruned: updatedRefs.filter((u) => u.flag === '-').map((u) => u.ref),
  };
  return { summary: fetchSummary(outcome), data: outcome };
}

function classifyErrorOf(argv: string[], r: GitRunResult<string>, opId?: string): GitError {
  return new GitError(
    classifyError({ argv, exitCode: r.exitCode, stderr: r.stderr, stdout: r.stdout, opId }),
  );
}

// ---- pull = fetch + integrate (spec 09 §6.4) ----

async function upstreamOf(
  ctx: OpContext,
  branch: string,
): Promise<{ remote: string; ref: string; short: string }> {
  const svc = ctx.service;
  const cfg = async (key: string): Promise<string | null> => {
    const r = await read(svc, ['config', '--get', key], { expectedExitCodes: [0, 1] });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };
  const remote = await cfg(`branch.${branch}.remote`);
  const merge = await cfg(`branch.${branch}.merge`);
  if (!remote || !merge) {
    throw new GitError(makeError('NoUpstream', { argv: ['pull'], opId: ctx.opId }, undefined, { branch }));
  }
  if (remote === '.') return { remote, ref: merge, short: merge.replace(/^refs\/heads\//, '') };
  const r = await read(svc, ['rev-parse', '--symbolic-full-name', `refs/heads/${branch}@{upstream}`], {
    expectedExitCodes: [0, 128],
  });
  const ref =
    r.exitCode === 0 && r.stdout.trim()
      ? r.stdout.trim()
      : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}`;
  return { remote, ref, short: ref.replace(/^refs\/remotes\//, '') };
}

async function aheadBehind(
  service: GitService,
  a: string,
  b: string,
): Promise<{ ahead: number; behind: number }> {
  const r = await read(service, ['rev-list', '--left-right', '--count', `${a}...${b}`, '--']);
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

const AUTOSTASH_CONFLICT = /Applying autostash resulted in conflicts/i;

async function pull(
  ctx: OpContext,
  op: {
    strategy: PullStrategy;
    remote?: string;
    branch?: string;
    autostash?: boolean;
    rebaseMerges?: boolean;
  },
): Promise<Omit<OpResult<PullOutcome>, 'opId'>> {
  const svc = ctx.service;
  const info = await svc.refreshRepoInfo();
  if (info.head.kind !== 'branch')
    throw fail('DetachedHead', 'Pull needs a checked-out branch (HEAD is detached).');
  if (!info.head.sha) throw fail('UnbornBranch');
  if (info.state !== 'clean') {
    throw fail('Unknown', 'Finish or abort the operation in progress before pulling.', { state: info.state });
  }
  let target: { remote: string; ref: string; short: string };
  if (op.remote && op.branch) {
    assertSafeName(op.remote, 'remote');
    assertSafeName(op.branch, 'branch');
    const b = op.branch.replace(/^refs\/heads\//, '');
    target = { remote: op.remote, ref: `refs/remotes/${op.remote}/${b}`, short: `${op.remote}/${b}` };
  } else target = await upstreamOf(ctx, info.head.name);

  if (target.remote !== '.') {
    const args = ['fetch', '--progress', '--', target.remote];
    if (op.remote && op.branch) {
      const b = op.branch.replace(/^refs\/heads\//, '');
      args.push(`+refs/heads/${b}:refs/remotes/${target.remote}/${b}`);
    }
    await git(ctx, args, { network: 'fetch' });
  }
  if (!(await svc.revParse(target.ref))) {
    throw new GitError(
      makeError('UpstreamGone', { argv: ['pull'], opId: ctx.opId }, undefined, { upstream: target.short }),
    );
  }
  const { ahead, behind } = await aheadBehind(svc, 'HEAD', target.ref);
  if (behind === 0) return { summary: 'Already up to date', data: { result: 'up-to-date' } };

  const autostash = op.autostash ? ['--autostash'] : [];
  const warnings: string[] = [];
  let flattenedMerges = 0;
  let result: PullOutcome['result'];
  let r: GitRunResult<string>;
  try {
    if (op.strategy === 'rebase') {
      if (ahead > 0 && !op.rebaseMerges) {
        // spec 09 §8: without --rebase-merges local merge commits are flattened
        const merges = await read(svc, ['rev-list', '--merges', '--count', `${target.ref}..HEAD`, '--']);
        flattenedMerges = Number(merges.stdout.trim()) || 0;
        if (flattenedMerges > 0) {
          warnings.push(
            `${flattenedMerges} local merge commit${flattenedMerges === 1 ? ' was' : 's were'} flattened by the rebase. Turn on "Preserve merges when pulling with rebase" to keep them.`,
          );
        }
      }
      r = await git(ctx, [
        'rebase',
        ...(op.rebaseMerges ? ['--rebase-merges'] : []),
        ...autostash,
        target.ref,
      ]);
      result = ahead === 0 ? 'fast-forward' : 'rebase';
    } else if (op.strategy === 'merge-no-ff') {
      const msg = `Merge remote-tracking branch '${target.short}'`;
      r = await git(ctx, ['merge', '--no-ff', '--no-edit', ...autostash, '-m', msg, target.ref]);
      result = 'merge';
    } else if (op.strategy === 'ff-only' || ahead === 0) {
      try {
        r = await git(ctx, ['merge', '--ff-only', ...autostash, target.ref]);
      } catch (e) {
        if (e instanceof GitError && e.code === 'NotFastForwardable') {
          // spec 09 §6.4: explain why and let the UI offer Merge / Rebase
          const s = e.serialized;
          throw new GitError({
            ...s,
            message: `Can't fast-forward: ${info.head.name} and ${target.short} have diverged (${ahead} ahead, ${behind} behind).`,
            details: { ...s.details, ahead, behind, upstream: target.short, branch: info.head.name },
          });
        }
        throw e;
      }
      result = 'fast-forward';
    } else {
      const msg = `Merge remote-tracking branch '${target.short}'`;
      r = await git(ctx, ['merge', '--ff', '--no-edit', ...autostash, '-m', msg, target.ref]);
      result = 'merge';
    }
  } catch (e) {
    await svc.refreshRepoInfo();
    return withConflictFiles(svc, e, op.strategy === 'rebase' ? 'RebaseConflict' : 'MergeConflict');
  }
  await svc.refreshRepoInfo();
  if (op.autostash) {
    // the integrate succeeded but re-applying the autostash conflicted: the stash is kept (spec 08 §8)
    const files = await unmergedPaths(svc);
    if (files.length || AUTOSTASH_CONFLICT.test(r.stderr + r.stdout)) {
      throw fail(
        'StashConflict',
        'Pulled, but your autostashed changes conflicted; the stash was kept as stash@{0}.',
        { files, stash: 'stash@{0}' },
      );
    }
  }
  const label = {
    'fast-forward': 'Fast-forwarded',
    merge: 'Merged',
    rebase: 'Rebased',
    'up-to-date': 'Up to date',
  }[result];
  return {
    summary: `${label} ${info.head.name} from ${target.short}`,
    ...(warnings.length ? { warnings } : {}),
    data: {
      result,
      ...(flattenedMerges ? { flattenedMerges } : {}),
      ...(op.autostash && /autostash/i.test(r.stderr + r.stdout) ? { autostashed: true } : {}),
    },
  };
}

// ---- fast-forward a branch (spec 09 §6.4, spec 05 §6.6) ----

async function fastForwardBranch(
  ctx: OpContext,
  local: string,
  upstream: string,
): Promise<Omit<OpResult, 'opId'>> {
  assertSafeName(local, 'branch name');
  assertSafeName(upstream, 'upstream');
  const svc = ctx.service;
  const short = upstream.replace(/^refs\/remotes\//, '');
  const remoteRef = `refs/remotes/${short}`;
  const split = await splitRemoteRef(svc, short);
  if (split) {
    await git(ctx, ['fetch', '--progress', '--', split.remote, `+refs/heads/${split.branch}:${remoteRef}`], {
      network: 'fetch',
    });
  }
  const upRef = split ? remoteRef : short;
  const info = await svc.refreshRepoInfo();
  if (info.head.kind === 'branch' && info.head.name === local) {
    await git(ctx, ['merge', '--ff-only', '-q', upRef]);
  } else {
    // refuses non-ff (no '+') and branches checked out in other worktrees
    await git(ctx, ['fetch', '.', `${upRef}:refs/heads/${local}`]);
  }
  await svc.refreshRepoInfo();
  return { summary: `Fast-forwarded ${local} to ${short}` };
}

// ---- push (spec 09 §6.5) ----

function localRefOf(localRef: string): string {
  if (localRef === 'HEAD' || localRef.startsWith('refs/')) return localRef;
  return `refs/heads/${localRef}`;
}

function featureOf(service: GitService, name: 'forceIfIncludes'): boolean {
  const f = (service['opts'] as { features?: Partial<Record<string, boolean>> } | undefined)?.features;
  return f?.[name] !== false;
}

/** Remote messages, PR hint and ignored-hook hints of a push run. */
function pushExtras(r: GitRunResult<string>): {
  remoteMessages: string[];
  prUrlHint?: string;
  hints: string[];
} {
  const remoteMessages = parseRemoteMessages(r.stderr);
  const prUrlHint = parsePrUrlHint(remoteMessages);
  return { remoteMessages, ...(prUrlHint ? { prUrlHint } : {}), hints: ignoredHookHints(r.stderr) };
}

async function push(ctx: OpContext, op: OpOf<'push'>): Promise<Omit<OpResult<PushOutcome>, 'opId'>> {
  const svc = ctx.service;
  assertSafeName(op.localRef, 'branch');
  const src = localRefOf(op.localRef);
  let remote = op.remote;
  let remoteBranch = op.remoteBranch;
  if (!remote || !remoteBranch) {
    // no explicit target: use the configured upstream, else NoUpstream so the UI prompts (spec 09 §6.5 step 1)
    const branch = src.replace(/^refs\/heads\//, '');
    const cfg = async (key: string): Promise<string | null> => {
      const r = await read(svc, ['config', '--get', key], { expectedExitCodes: [0, 1] });
      return r.exitCode === 0 ? r.stdout.trim() : null;
    };
    const cr = src.startsWith('refs/heads/') ? await cfg(`branch.${branch}.remote`) : null;
    const cm = src.startsWith('refs/heads/') ? await cfg(`branch.${branch}.merge`) : null;
    if (!cr || !cm || cr === '.') {
      throw new GitError(makeError('NoUpstream', { argv: ['push'], opId: ctx.opId }, undefined, { branch }));
    }
    remote = remote || cr;
    remoteBranch = remoteBranch || cm.replace(/^refs\/heads\//, '');
  }
  assertSafeName(remote, 'remote');
  assertSafeName(remoteBranch, 'remote branch');
  const dst = `refs/heads/${remoteBranch.replace(/^refs\/heads\//, '')}`;
  const args = ['push', '--progress', '--porcelain'];
  if (op.setUpstream) args.push('--set-upstream');
  if (op.followTags) args.push('--follow-tags');
  if (op.noVerify) args.push('--no-verify');
  if (op.force === 'lease') {
    if (op.expectedRemoteSha === undefined) args.push(`--force-with-lease=${dst}`);
    else {
      if (op.expectedRemoteSha !== null && !/^[0-9a-f]{40,64}$/.test(op.expectedRemoteSha))
        throw fail('Unknown', `Invalid expected remote sha "${op.expectedRemoteSha}".`);
      args.push(`--force-with-lease=${dst}:${op.expectedRemoteSha ?? ''}`);
    }
    if (op.forceIfIncludes && featureOf(svc, 'forceIfIncludes')) args.push('--force-if-includes');
  }
  args.push('--', remote, `${src}:${dst}`);
  const prePush = op.noVerify ? false : await hasPrePushHook(svc);
  const r = await git(ctx, args, { network: 'push', expectedExitCodes: [0, 1] });
  const refs = parsePorcelainPush(r.stdout);
  pushOrThrow(args, r, refs, ctx.opId, prePush);
  const { remoteMessages, prUrlHint, hints } = pushExtras(r);
  const warnings = [...remoteMessages.filter((m) => !prUrlHint || !m.includes(prUrlHint)), ...hints];
  return {
    summary: `Pushed ${src.replace(/^refs\/heads\//, '')} to ${remote}/${dst.replace(/^refs\/heads\//, '')}`,
    ...(warnings.length ? { warnings } : {}),
    data: { refs, remoteMessages, ...(prUrlHint ? { prUrlHint } : {}) },
  };
}

async function pushTags(
  ctx: OpContext,
  remote: string,
  tags: string[] | 'all',
  noVerify?: boolean,
): Promise<Omit<OpResult<PushOutcome>, 'opId'>> {
  assertSafeName(remote, 'remote');
  const args = ['push', '--progress', '--porcelain'];
  if (noVerify) args.push('--no-verify');
  if (tags === 'all') args.push('--tags', '--', remote);
  else {
    if (!tags.length) return { data: { refs: [] } };
    for (const t of tags) assertSafeName(t, 'tag');
    args.push('--', remote, ...tags.map((t) => `refs/tags/${t.replace(/^refs\/tags\//, '')}`));
  }
  const r = await git(ctx, args, { network: 'push', expectedExitCodes: [0, 1] });
  const refs = parsePorcelainPush(r.stdout);
  pushOrThrow(args, r, refs, ctx.opId, noVerify ? false : await hasPrePushHook(ctx.service));
  const { remoteMessages, hints } = pushExtras(r);
  return {
    summary: `Pushed tags to ${remote}`,
    ...(hints.length ? { warnings: hints } : {}),
    data: { refs, remoteMessages },
  };
}

async function pushDelete(
  ctx: OpContext,
  remote: string,
  refs: string[],
  noVerify?: boolean,
): Promise<Omit<OpResult<PushOutcome>, 'opId'>> {
  assertSafeName(remote, 'remote');
  if (!refs.length) return { data: { refs: [] } };
  for (const r of refs) assertSafeName(r, 'ref');
  const full = refs.map((r) => (r.startsWith('refs/') ? r : `refs/heads/${r}`));
  const args = ['push', '--progress', '--porcelain', ...(noVerify ? ['--no-verify'] : [])];
  args.push('--delete', '--', remote, ...full);
  const r = await git(ctx, args, { network: 'push', expectedExitCodes: [0, 1] });
  const parsed = parsePorcelainPush(r.stdout);
  pushOrThrow(args, r, parsed, ctx.opId, noVerify ? false : await hasPrePushHook(ctx.service));
  return {
    summary: `Deleted ${full.length === 1 ? full[0] : `${full.length} refs`} on ${remote}`,
    data: { refs: parsed, remoteMessages: parseRemoteMessages(r.stderr) },
  };
}

// ---- push preview / force push (spec 09 §4.3 "Force push confirm", §6.5 step 6) ----

export interface PushPreviewRequest {
  localRef: string;
  remote: string;
  remoteBranch: string;
}

export interface PushPreview {
  /** Sha of the remote branch right now (fresh `ls-remote`), null when it does not exist. */
  remoteSha: Sha | null;
  localSha: Sha | null;
  /** Remote commits a force push would drop (`<local>..<remote>`), newest first, at most `limit`. */
  wouldLose: CommitSummary[];
  /** More commits would be lost than listed. */
  truncated: boolean;
  isFastForward: boolean;
  /** Use as `expectedRemoteSha` for `--force-with-lease` (the sha the user saw). */
  leaseSha: Sha | null;
}

export interface PushPreviewOptions {
  /** Credentials / askpass env for the network commands. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  limit?: number;
}

const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x1e';

function parseLog(stdout: string): CommitSummary[] {
  const out: CommitSummary[] = [];
  for (const rec of stdout.split('\x1e')) {
    const f = rec.replace(/^\r?\n/, '').split('\0');
    if (f.length < 9 || !f[0]) continue;
    out.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2]!,
      authorEmail: f[3]!,
      authorTime: Number(f[4]),
      committerName: f[5]!,
      committerEmail: f[6]!,
      commitTime: Number(f[7]),
      subject: f[8]!,
    });
  }
  return out;
}

/**
 * `git:push:preview` (spec 09 §5): a fresh `ls-remote` of the target branch, then — when that commit isn't
 * local yet — a fetch of just that ref into a temporary ref, so the commits a force push would overwrite
 * (`rev-list <local>..<remote>`) can be listed and the lease uses exactly the sha the user saw.
 */
export async function pushPreview(
  service: GitService,
  req: PushPreviewRequest,
  o: PushPreviewOptions = {},
): Promise<PushPreview> {
  assertSafeName(req.localRef, 'branch');
  assertSafeName(req.remote, 'remote');
  assertSafeName(req.remoteBranch, 'remote branch');
  const limit = o.limit ?? 100;
  const dst = `refs/heads/${req.remoteBranch.replace(/^refs\/heads\//, '')}`;
  const localSha = await service.revParse(localRefOf(req.localRef));
  const net = { env: o.env ?? {}, signal: o.signal, timeoutMs: 120_000 };
  const ls = await service.runWrite(['ls-remote', '--exit-code', '--', req.remote, dst], {
    ...net,
    expectedExitCodes: [0, 2],
  });
  const line = ls.stdout.split(/\r?\n/).find((l) => l.endsWith(`\t${dst}`));
  let remoteSha: Sha | null = line ? line.split('\t')[0]!.trim() : null;
  if (!remoteSha) {
    return {
      remoteSha: null,
      localSha,
      wouldLose: [],
      truncated: false,
      isFastForward: true,
      leaseSha: null,
    };
  }
  const has = await read(service, ['cat-file', '-e', `${remoteSha}^{commit}`], {
    expectedExitCodes: [0, 1, 128],
  });
  if (has.exitCode !== 0) {
    const tmp = `refs/githappens/push-preview/${randomUUID()}`;
    try {
      await service.runWrite(
        ['fetch', '--no-tags', '--no-write-fetch-head', '--', req.remote, `+${dst}:${tmp}`],
        {
          ...net,
        },
      );
      // the remote may have moved since ls-remote: what we fetched is what the user will see
      remoteSha = (await service.revParse(tmp)) ?? remoteSha;
    } finally {
      await service
        .runWrite(['update-ref', '-d', tmp], { expectedExitCodes: [0, 1, 128] })
        .catch(() => undefined);
    }
  }
  let wouldLose: CommitSummary[] = [];
  let truncated = false;
  let isFastForward = true;
  if (localSha) {
    const r = await read(service, [
      'log',
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit + 1}`,
      `${localSha}..${remoteSha}`,
      '--',
    ]);
    wouldLose = parseLog(r.stdout);
    truncated = wouldLose.length > limit;
    if (truncated) wouldLose = wouldLose.slice(0, limit);
    isFastForward = wouldLose.length === 0;
  }
  return { remoteSha, localSha, wouldLose, truncated, isFastForward, leaseSha: remoteSha };
}

const pushDef = define(
  'push',
  {
    label: (op) => `Push ${op.localRef.replace(/^refs\/heads\//, '')}${op.remote ? ` to ${op.remote}` : ''}`,
    touches: ['refs', 'graph', 'config'],
    network: true,
  },
  (ctx, op) => push(ctx, op),
);

export const syncOps = {
  fetch: define(
    'fetch',
    {
      label: (op) => (op.remote === 'all' ? 'Fetch all remotes' : `Fetch ${op.remote}`),
      touches: ['refs', 'graph'],
      network: true,
    },
    (ctx, op) => fetch(ctx, op.remote, op.prune),
  ),
  pull: define(
    'pull',
    {
      label: (op) => `Pull (${op.strategy})`,
      touches: ['status', 'refs', 'graph', 'repoState', 'conflicts', 'stash'],
      network: true,
    },
    (ctx, op) => pull(ctx, op),
  ),
  fastForwardBranch: define(
    'fastForwardBranch',
    {
      label: (op) => `Fast-forward ${op.localBranch} to ${op.upstream}`,
      touches: ['refs', 'graph', 'status'],
      network: true,
    },
    (ctx, op) => fastForwardBranch(ctx, op.localBranch, op.upstream),
  ),
  push: pushDef,
  'push.tags': define(
    'push.tags',
    {
      label: (op) => `Push ${op.tags === 'all' ? 'all tags' : op.tags.join(', ')} to ${op.remote}`,
      touches: ['refs', 'graph'],
      network: true,
    },
    (ctx, op) => pushTags(ctx, op.remote, op.tags, op.noVerify),
  ),
  'push.delete': define(
    'push.delete',
    {
      label: (op) => `Delete ${op.refs.join(', ')} on ${op.remote}`,
      touches: ['refs', 'graph'],
      network: true,
    },
    (ctx, op) => pushDelete(ctx, op.remote, op.refs, op.noVerify),
  ),
};
