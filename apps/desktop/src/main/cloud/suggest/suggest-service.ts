import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parsePatchLink, type Suggestion, type SuggestionCreate } from '@githappens/cloud-api';
import { GitError, makeError, type GitService, type RepoId, type Sha } from '@githappens/git';
import { integrationKey, type HostingProvider, type RepoRef, type TimelineItem } from '@githappens/providers';

import type { ResolvedRemote } from '../../../shared/ipc/integrations-contract';
import type {
  OpenedSuggestion,
  SuggestApplyReq,
  SuggestApplyRes,
  SuggestEventContract,
  SuggestionInfo,
  SuggestionStatus,
  SuggestPr,
  SuggestSession,
  SuggestSubmitReq,
} from '../../../shared/ipc/suggest-contract';
import { CloudError, type CloudHttp } from '../cloud-http';
import type { PatchRepos, PatchService } from '../patches/patch-service';
import {
  coAuthorFromLogin,
  filterPatch,
  formatSuggestionComment,
  parseSuggestionComment,
  splitPatchByFile,
  suggestionCommitMessage,
  suggestionDeepLink,
  SUGGESTION_LABEL,
} from './suggest-text';

export interface SuggestIntegrations {
  provider(key: string): HostingProvider;
  resolveRemotes(repoId: RepoId): Promise<ResolvedRemote[]>;
}

export interface SuggestServiceDeps {
  cloud: CloudHttp;
  patches: PatchService;
  repos: PatchRepos & {
    /** Open a repository by path (ref-counted; paired with `close`). */
    open(dir: string): Promise<RepoId>;
    close(id: RepoId): Promise<void>;
  };
  integrations: SuggestIntegrations;
  /** `app.getPath('userData')`; worktrees live in `<userData>/suggest/<id>`. */
  userDataDir(): string;
  onChanged?(e: SuggestEventContract['suggest:changed']): void;
  log?(message: string): void;
}

interface SessionFile {
  version: 1;
  sessions: SuggestSession[];
}

const fail = (message: string, details?: Record<string, string | number>): GitError =>
  new GitError(makeError('Unknown', { argv: [] }, message, details));

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Code Suggest (spec 14 §6.4). Sessions are isolated detached worktrees of the PR head; submitting turns
 * the worktree diff (incl. untracked files, built on a temporary index) into a Cloud Patch of kind
 * `suggestion`, records it on the server when possible and posts a PR comment with the links.
 */
export class SuggestService {
  constructor(private readonly d: SuggestServiceDeps) {}

  private root(): string {
    return path.join(this.d.userDataDir(), 'suggest');
  }

  private file(): string {
    return path.join(this.root(), 'sessions.json');
  }

  sessions(): SuggestSession[] {
    try {
      const f = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as SessionFile;
      if (f.version !== 1 || !Array.isArray(f.sessions)) return [];
      return f.sessions.filter((s) => fs.existsSync(s.worktreePath));
    } catch {
      return [];
    }
  }

  private save(list: SuggestSession[]): void {
    fs.mkdirSync(this.root(), { recursive: true });
    fs.writeFileSync(
      this.file(),
      JSON.stringify({ version: 1, sessions: list } satisfies SessionFile),
      'utf8',
    );
  }

  private session(id: string): SuggestSession {
    const s = this.sessions().find((x) => x.sessionId === id);
    if (!s) throw fail('This suggestion session no longer exists.');
    return s;
  }

  // ---- reviewer side ----

  async start(repoId: RepoId, pr: SuggestPr): Promise<SuggestSession> {
    if (!SHA_RE.test(pr.headSha)) throw fail('The pull request head is unknown.');
    const svc = this.d.repos.get(repoId);
    if (!(await hasCommit(svc, pr.headSha))) {
      await this.d.repos.runOp(repoId, { type: 'fetch', remote: 'all' }).catch(() => undefined);
    }
    if (!(await hasCommit(svc, pr.headSha))) {
      // fork PRs: fetch the provider's PR ref into a local branch (no checkout)
      await this.prBranch(repoId, pr).catch((e: unknown) => this.d.log?.(`suggest fetch: ${String(e)}`));
    }
    if (!(await hasCommit(svc, pr.headSha)))
      throw fail(`The pull request head ${pr.headSha.slice(0, 7)} is not available locally. Fetch it first.`);
    const sessionId = randomUUID();
    const worktreePath = path.join(this.root(), sessionId);
    fs.mkdirSync(this.root(), { recursive: true });
    await this.d.repos.runOp(repoId, {
      type: 'worktree.add',
      path: worktreePath,
      detach: true,
      startPoint: pr.headSha,
    });
    const session: SuggestSession = {
      sessionId,
      repoId,
      pr,
      worktreePath,
      createdAt: new Date().toISOString(),
    };
    this.save([...this.sessions(), session]);
    this.d.onChanged?.({ reason: 'started' });
    return session;
  }

  async changes(sessionId: string): Promise<{ files: SuggestionInfoFiles; warnings: string[] }> {
    const s = this.session(sessionId);
    return this.withWorktree(s, async (wt) => {
      const draft = await this.d.patches.preview(wt, { kind: 'wip', stagedOnly: false });
      return { files: draft.files, warnings: draft.warnings };
    });
  }

  async submit(req: SuggestSubmitReq): Promise<{
    suggestion: SuggestionInfo;
    commentPosted: boolean;
    warnings: string[];
  }> {
    const s = this.session(req.sessionId);
    const title = req.title.trim();
    if (!title) throw fail('Enter a title for the suggestion.');
    const warnings: string[] = [];
    const identity = await gitIdentity(this.d.repos.get(s.repoId));
    const created = await this.withWorktree(s, async (wt) => {
      const draft = await this.d.patches.preview(wt, { kind: 'wip', stagedOnly: false });
      if (!draft.files.length) throw fail('You have not changed any file yet.');
      const visibility = req.visibility ?? 'link';
      const res = await this.d.patches.create({
        repoId: wt,
        source: { kind: 'wip', stagedOnly: false },
        title,
        ...(req.description ? { description: req.description } : {}),
        visibility,
        ...(req.orgId ? { orgId: req.orgId } : {}),
        ...(req.collaborators ? { collaborators: req.collaborators } : {}),
        e2e: visibility === 'link',
        kind: 'suggestion',
      });
      return { res, fileCount: draft.files.length };
    });
    const patch = created.res.patch;
    const key = this.d.patches.keyFor(patch.id);

    // Server record (optional: older servers / outages fall back to comment-only discovery).
    let server: Suggestion | undefined;
    const body: SuggestionCreate = {
      patchId: patch.id,
      provider: s.pr.ref.integration.kind,
      host: s.pr.ref.integration.host,
      owner: s.pr.ref.owner,
      repo: s.pr.ref.name,
      prNumber: s.pr.number,
      prHeadSha: s.pr.headSha,
      title,
      ...(identity ? { coAuthor: identity } : {}),
    };
    try {
      server = (await this.d.cloud.request<Suggestion>('POST', '/v1/suggestions', { body })).data;
    } catch (e) {
      warnings.push(
        `The suggestion was not recorded on the server (${(e as Error).message}); the PR comment links still work.`,
      );
    }

    let commentPosted = false;
    let commentId: string | undefined;
    const provider = this.providerFor(s.pr.ref);
    const comment = formatSuggestionComment({
      title,
      fileCount: created.fileCount,
      ...(server ? { id: server.id } : {}),
      patchId: patch.id,
      webUrl: patch.webUrl,
      ...(key ? { key } : {}),
    });
    try {
      const item = await provider.addComment(s.pr.ref, s.pr.number, comment);
      commentPosted = true;
      commentId = 'id' in item ? item.id : undefined;
    } catch (e) {
      warnings.push(`Could not comment on the pull request: ${(e as Error).message}`);
    }
    if (server && commentId) {
      await this.d.cloud
        .request('PATCH', `/v1/suggestions/${server.id}`, { body: { commentId } })
        .catch(() => undefined);
    }
    if (req.addLabel) {
      try {
        const pr = await provider.getPullRequest(s.pr.ref, s.pr.number);
        if (pr !== 'not-modified' && !pr.labels.some((l) => l.name === SUGGESTION_LABEL)) {
          await provider.updatePullRequest(s.pr.ref, s.pr.number, {
            labels: [...pr.labels.map((l) => l.name), SUGGESTION_LABEL],
          });
        }
      } catch (e) {
        warnings.push(`Could not add the "${SUGGESTION_LABEL}" label: ${(e as Error).message}`);
      }
    }
    if (!req.keepWorktree) await this.discard(s.sessionId).catch((e: unknown) => warnings.push(String(e)));
    this.d.onChanged?.({ reason: 'submitted' });
    const info: SuggestionInfo = {
      key: server?.id ?? patch.id,
      ...(server ? { id: server.id } : {}),
      patchId: patch.id,
      title,
      author: { name: patch.author.name },
      createdAt: patch.createdAt,
      status: 'open',
      prHeadSha: s.pr.headSha,
      webUrl: key ? `${patch.webUrl}#k=${key}` : patch.webUrl,
      deepLink: suggestionDeepLink(server?.id ?? patch.id, key),
      missingKey: patch.e2e && !key,
      ...(identity ? { coAuthor: identity } : {}),
      source: server ? 'both' : 'comment',
      ...(commentId ? { commentId } : {}),
    };
    return { suggestion: info, commentPosted, warnings };
  }

  async discard(sessionId: string): Promise<null> {
    const s = this.session(sessionId);
    try {
      await this.d.repos.runOp(s.repoId, { type: 'worktree.remove', path: s.worktreePath, force: true });
    } catch (e) {
      // the main repo may be closed: remove the directory and prune later
      this.d.log?.(`suggest discard: ${(e as Error).message}`);
      fs.rmSync(s.worktreePath, { recursive: true, force: true });
      await this.d.repos.runOp(s.repoId, { type: 'worktree.prune' }).catch(() => undefined);
    }
    this.save(this.sessions().filter((x) => x.sessionId !== sessionId));
    this.d.onChanged?.({ reason: 'discarded' });
    return null;
  }

  // ---- author side ----

  async list(repoId: RepoId, pr: SuggestPr): Promise<{ items: SuggestionInfo[]; serverAvailable: boolean }> {
    void repoId;
    const byPatch = new Map<string, SuggestionInfo>();
    // 1. PR comments (no server needed)
    try {
      const provider = this.providerFor(pr.ref);
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await provider.getTimeline(pr.ref, pr.number, cursor);
        for (const item of res.items) {
          for (const c of commentsOf(item)) {
            const parsed = parseSuggestionComment(c.body);
            if (!parsed) continue;
            const web = parsed.webUrl || '';
            byPatch.set(parsed.patchId, {
              key: parsed.id ?? parsed.patchId,
              ...(parsed.id ? { id: parsed.id } : {}),
              patchId: parsed.patchId,
              title: parsed.title ?? 'Code suggestion',
              author: { login: c.author.login, ...(c.author.name ? { name: c.author.name } : {}) },
              createdAt: c.createdAt,
              status: 'open',
              webUrl: parsed.key ? `${web}#k=${parsed.key}` : web,
              deepLink: suggestionDeepLink(parsed.id ?? parsed.patchId, parsed.key),
              missingKey: false,
              coAuthor: coAuthorFromLogin(c.author.login, pr.ref.integration.host),
              source: 'comment',
              commentId: c.id,
            });
          }
        }
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
    } catch (e) {
      this.d.log?.(`suggest list (comments): ${(e as Error).message}`);
    }
    // 2. server list
    let serverAvailable = false;
    if (this.d.cloud.serverUrl()) {
      try {
        const q = new URLSearchParams({
          provider: pr.ref.integration.kind,
          host: pr.ref.integration.host,
          owner: pr.ref.owner,
          repo: pr.ref.name,
          pr: String(pr.number),
        });
        const list = (
          await this.d.cloud.request<Suggestion[]>('GET', `/v1/suggestions?${q.toString()}`, {
            auth: 'optional',
          })
        ).data;
        serverAvailable = true;
        for (const sg of list) {
          const fromComment = byPatch.get(sg.patchId);
          const key = fromComment
            ? parsePatchLink(fromComment.webUrl)?.key
            : this.d.patches.keyFor(sg.patchId);
          byPatch.set(sg.patchId, {
            key: sg.id,
            id: sg.id,
            patchId: sg.patchId,
            title: sg.title,
            author: {
              ...(fromComment?.author.login ? { login: fromComment.author.login } : {}),
              name: sg.author.name,
            },
            createdAt: sg.createdAt,
            status: sg.status,
            prHeadSha: sg.prHeadSha,
            webUrl: key ? `${sg.webUrl}#k=${key}` : sg.webUrl,
            deepLink: suggestionDeepLink(sg.id, key),
            missingKey: !key,
            ...(sg.coAuthor
              ? { coAuthor: sg.coAuthor }
              : fromComment?.coAuthor
                ? { coAuthor: fromComment.coAuthor }
                : {}),
            source: fromComment ? 'both' : 'server',
            ...((sg.commentId ?? fromComment?.commentId)
              ? { commentId: sg.commentId ?? fromComment?.commentId }
              : {}),
          });
        }
      } catch (e) {
        if (!(e instanceof CloudError)) throw e;
      }
    }
    const items = [...byPatch.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { items, serverAvailable };
  }

  async open(req: { url?: string; info?: SuggestionInfo; prHeadSha?: Sha }): Promise<OpenedSuggestion> {
    let info = req.info;
    let url = req.url ?? info?.webUrl;
    if (!url) throw fail('Nothing to open.');
    const deep = /^githappens:\/\/suggestion\/([A-Za-z0-9-]{6,64})(?:#k=([A-Za-z0-9_-]+))?$/.exec(url.trim());
    if (deep) {
      const idOrPatch = deep[1]!;
      if (/^[A-Za-z0-9]{22}$/.test(idOrPatch)) {
        const server = this.d.cloud.serverUrl();
        if (!server) throw new CloudError('not_configured', 'No GitHappens Cloud server is configured.');
        url = `${server}/p/${idOrPatch}${deep[2] ? `#k=${deep[2]}` : ''}`;
      } else {
        const sg = (
          await this.d.cloud.request<Suggestion>('GET', `/v1/suggestions/${encodeURIComponent(idOrPatch)}`, {
            auth: 'optional',
          })
        ).data;
        url = `${sg.webUrl}${deep[2] ? `#k=${deep[2]}` : ''}`;
        info ??= {
          key: sg.id,
          id: sg.id,
          patchId: sg.patchId,
          title: sg.title,
          author: { name: sg.author.name },
          createdAt: sg.createdAt,
          status: sg.status,
          prHeadSha: sg.prHeadSha,
          webUrl: url,
          deepLink: suggestionDeepLink(sg.id, deep[2]),
          missingKey: !deep[2],
          ...(sg.coAuthor ? { coAuthor: sg.coAuthor } : {}),
          source: 'server',
        };
      }
    }
    const r = await this.d.patches.open(url, true);
    if (r.status !== 'opened') throw fail('This suggestion is on another server.');
    const o = r.opened;
    info ??= {
      key: o.patch.id,
      patchId: o.patch.id,
      title: o.bundle.title,
      author: { name: o.patch.author.name },
      createdAt: o.patch.createdAt,
      status: 'open',
      webUrl: o.patch.shareUrl,
      deepLink: suggestionDeepLink(o.patch.id),
      missingKey: false,
      source: 'comment',
    };
    const suggestedOn = info.prHeadSha;
    return {
      suggestion: { ...info, title: o.bundle.title || info.title },
      title: o.bundle.title,
      ...(o.bundle.description ? { description: o.bundle.description } : {}),
      baseSha: o.bundle.baseSha,
      files: o.bundle.files,
      diff: o.diff,
      ...(suggestedOn && req.prHeadSha && suggestedOn !== req.prHeadSha
        ? { outdated: { suggestedOn, currentHead: req.prHeadSha } }
        : {}),
    };
  }

  async apply(req: SuggestApplyReq): Promise<SuggestApplyRes> {
    const bundle = this.d.patches.openedBundle(req.patchId);
    const wanted = new Set(req.paths);
    const keep = new Set<number>();
    bundle.files.forEach((f, i) => {
      if (wanted.has(f.path)) keep.add(i);
    });
    if (!keep.size) throw fail('Accept at least one file to apply.');
    const chunks = splitPatchByFile(bundle.patch);
    if (chunks.length !== bundle.files.length) throw fail('The suggestion patch could not be split by file.');
    const text = keep.size === chunks.length ? bundle.patch : filterPatch(bundle.patch, keep);
    const svc = this.d.repos.get(req.repoId);
    const warnings: string[] = [];
    const dir = path.join(this.root(), 'patches');
    fs.mkdirSync(dir, { recursive: true });
    const patchFile = path.join(dir, `${req.patchId}-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, text, 'utf8');
    try {
      let target:
        | { kind: 'worktree' }
        | { kind: 'new-branch'; name: string; base?: string }
        | { kind: 'existing-branch'; name: string; autostash?: boolean };
      let commitMessage: string | undefined;
      let push: { remote: string; branch: string; remoteBranch: string } | undefined;
      if (req.target.kind === 'current') target = { kind: 'worktree' };
      else if (req.target.kind === 'new-branch') {
        target = {
          kind: 'new-branch',
          name: req.target.name,
          ...((await hasCommit(svc, bundle.baseSha)) ? { base: bundle.baseSha } : {}),
        };
        commitMessage = suggestionCommitMessage(req.title, req.coAuthor);
      } else {
        const pr = req.target.pr;
        if (pr.isCrossRepository)
          throw fail('This pull request comes from a fork; ask its author to apply the suggestion.');
        const b = await this.prBranch(req.repoId, pr);
        target = { kind: 'existing-branch', name: b.branch, autostash: true };
        commitMessage = suggestionCommitMessage(req.title, req.coAuthor);
        push = { remote: b.remote, branch: b.branch, remoteBranch: pr.headBranch };
      }
      const r = await this.d.repos.runOp(req.repoId, {
        type: 'patch.apply',
        patchFile,
        mode: 'apply',
        target,
        threeWay: true,
        ...(commitMessage ? { commitMessage } : {}),
        title: `Code suggestion: ${req.title}`,
      });
      const data = (r.data ?? { applied: true, conflicts: [], rejects: [] }) as {
        applied: boolean;
        conflicts: string[];
        rejects: string[];
        branch?: string;
        commit?: Sha;
      };
      warnings.push(...(r.warnings ?? []));
      let pushed = false;
      if (push && data.applied && data.commit && !data.conflicts.length && !data.rejects.length) {
        await this.d.repos.runOp(req.repoId, {
          type: 'push',
          localRef: push.branch,
          remote: push.remote,
          remoteBranch: push.remoteBranch,
        });
        pushed = true;
      } else if (push) warnings.push('The suggestion did not apply cleanly, so nothing was pushed.');
      if (data.applied && req.suggestionId && this.d.cloud.me()) {
        await this.setStatus(req.suggestionId, 'applied').catch(() => undefined);
      }
      this.d.onChanged?.({ reason: 'applied' });
      return {
        applied: data.applied,
        conflicts: data.conflicts,
        rejects: data.rejects,
        ...(data.branch ? { branch: data.branch } : {}),
        ...(data.commit ? { commit: data.commit } : {}),
        ...(push ? { pushed } : {}),
        warnings,
      };
    } finally {
      fs.rmSync(patchFile, { force: true });
    }
  }

  async setStatus(id: string, status: SuggestionStatus): Promise<null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail('This suggestion is not recorded on the server.');
    await this.d.cloud.request('PATCH', `/v1/suggestions/${id}`, { body: { status } });
    this.d.onChanged?.({ reason: 'status' });
    return null;
  }

  // ---- helpers ----

  private providerFor(ref: RepoRef): HostingProvider {
    return this.d.integrations.provider(integrationKey(ref.integration));
  }

  /** Local branch for the PR head (created from the provider's PR ref without checking it out). */
  private async prBranch(repoId: RepoId, pr: SuggestPr): Promise<{ branch: string; remote: string }> {
    const remotes = await this.d.integrations.resolveRemotes(repoId);
    const base = remotes.find(
      (r) =>
        r.ref &&
        r.ref.owner.toLowerCase() === pr.ref.owner.toLowerCase() &&
        r.ref.name.toLowerCase() === pr.ref.name.toLowerCase(),
    );
    if (!base) throw fail(`No remote points at ${pr.ref.owner}/${pr.ref.name}.`);
    const sameRepo = !pr.isCrossRepository;
    const localBranch = sameRepo
      ? pr.headBranch
      : `pr/${pr.number}-${pr.headBranch}`.replace(/[^\w./-]+/g, '-');
    const svc = this.d.repos.get(repoId);
    const exists = await svc.runRead(['rev-parse', '--verify', '-q', `refs/heads/${localBranch}`], {
      expectedExitCodes: [0, 1],
    });
    if (exists.exitCode === 0) {
      await this.d.repos.runOp(repoId, { type: 'fetch', remote: base.remote }).catch(() => undefined);
      return { branch: localBranch, remote: base.remote };
    }
    const provider = this.providerFor(pr.ref);
    const r = await this.d.repos.runOp(repoId, {
      type: 'pr.checkout',
      remote: base.remote,
      number: pr.number,
      headBranch: pr.headBranch,
      sameRepo,
      refspec: provider.capabilities.prRefspec,
      ...(pr.headCloneUrl ? { headCloneUrl: pr.headCloneUrl } : {}),
      localBranch,
      checkout: false,
    });
    return {
      branch: (r.data as { branch?: string } | undefined)?.branch ?? localBranch,
      remote: base.remote,
    };
  }

  private async withWorktree<T>(s: SuggestSession, fn: (wt: RepoId) => Promise<T>): Promise<T> {
    if (!fs.existsSync(s.worktreePath)) throw fail('The suggestion worktree was removed.');
    const id = await this.d.repos.open(s.worktreePath);
    try {
      return await fn(id);
    } finally {
      await this.d.repos.close(id).catch(() => undefined);
    }
  }
}

type SuggestionInfoFiles = Awaited<ReturnType<PatchService['preview']>>['files'];

function commentsOf(
  item: TimelineItem,
): Array<{ id: string; body: string; createdAt: string; author: { login: string; name?: string } }> {
  if (item.kind === 'comment' || item.kind === 'review') {
    return [{ id: item.id, body: item.body, createdAt: item.createdAt, author: item.author }];
  }
  if (item.kind === 'thread') return item.comments.map((c) => ({ ...c }));
  return [];
}

async function hasCommit(svc: GitService, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  const r = await svc.runRead(['cat-file', '-e', `${sha}^{commit}`], { expectedExitCodes: [0, 1, 128] });
  return r.exitCode === 0;
}

async function gitIdentity(svc: GitService): Promise<{ name: string; email: string } | undefined> {
  const read = async (key: string): Promise<string> => {
    const r = await svc.runRead(['config', '--get', key], { expectedExitCodes: [0, 1] });
    return r.exitCode === 0 ? String(r.stdout).trim() : '';
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return name && email ? { name, email } : undefined;
}
