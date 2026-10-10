/// <reference lib="dom" />
import fs from 'node:fs';
import path from 'node:path';

import {
  openPatchBlob,
  parsePatchLink,
  patchDeepLink,
  PATCH_FORMAT,
  repoIdentityKey,
  sealPatchBundle,
  sha256Hex,
  type OrgDetail,
  type Page,
  type PatchBundle,
  type PatchCreate,
  type PatchCreated,
  type PatchMeta,
  type PatchUpdate,
  type PatchWithDownload,
  type RepoIdentity,
  type ServerInfo,
} from '@githappens/cloud-api';
import {
  GitError,
  makeError,
  parseDiff,
  type FileDiff,
  type GitOperation,
  type GitService,
  type OpResult,
  type PatchApplyOutcome,
  type RepoId,
  type Sha,
} from '@githappens/git';

import type {
  CloudPatch,
  OpenedPatch,
  PatchApplyReq,
  PatchApplyRes,
  PatchAvailability,
  PatchCreateReq,
  PatchCreateRes,
  PatchDraft,
  PatchesEventContract,
  PatchesIpcContract,
  PatchOpenRes,
  PatchRepoCandidate,
  PatchSource,
} from '../../../shared/ipc/patches-contract';
import { CloudError, type CloudHttp } from '../cloud-http';
import { buildPatch } from './patch-text';

/** Spec 14 §6.3: refuse > 25 MB compressed unless the server says otherwise. */
export const DEFAULT_PATCH_MAX_BYTES = 25 * 1024 * 1024;

export interface PatchRepos {
  get(repoId: RepoId): GitService;
  list(): GitService[];
  runOp(repoId: RepoId, op: GitOperation): Promise<OpResult>;
}

export interface PatchServiceDeps {
  cloud: CloudHttp;
  repos: PatchRepos;
  /** provider/host/owner/name of a repo (from its remotes); `initialCommitSha` is added here. */
  resolveRepoIdentity(repoId: RepoId): Promise<RepoIdentity | undefined>;
  appVersion: string;
  /** Directory for the "created by me" cache and temporary patch files. */
  cacheDir(): string;
  onChanged?(e: PatchesEventContract['patch:changed']): void;
  /**
   * Persistent e2e keys of the user's OWN patches (SecretStore, see `createPatchKeyStore`) so "Copy link"
   * still yields a complete link after a restart. Keys of patches opened from others are never stored.
   */
  keyStore?: PatchKeyStore;
}

export interface PatchKeyStore {
  get(patchId: string): string | null;
  set(patchId: string, key: string): void;
  delete(patchId: string): void;
}

interface CacheEntry {
  meta: PatchMeta;
  localTitle?: string;
}

interface CacheFile {
  version: 1;
  server: string;
  userId: string;
  items: CacheEntry[];
}

interface Opened {
  meta: PatchMeta;
  bundle: PatchBundle;
  key?: string;
}

const err = (message: string, details?: Record<string, string | number>): GitError =>
  new GitError(makeError('Unknown', { argv: [] }, message, details));

const normServer = (u: string | null | undefined): string | null =>
  u ? u.trim().replace(/\/+$/, '').toLowerCase() : null;

/** Patch ids are base62; anything else never reaches a path or URL. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw err('Invalid Cloud Patch id.');
  return id;
}

/**
 * Cloud Patches (spec 14 §6.3): build / seal / upload patches, list and manage them, open links (download,
 * verify, decrypt, match a local repo) and apply them through the `patch.apply` op. The e2e key is never
 * sent to the server; it lives in returned links, in memory for this session and — for the user's own
 * patches only — in the OS-protected SecretStore (`keyStore`).
 */
export class PatchService {
  private readonly keys = new Map<string, string>();
  private readonly opened = new Map<string, Opened>();
  private readonly identities = new Map<RepoId, Promise<RepoIdentity | undefined>>();
  private serverInfo: { server: string; info: ServerInfo | null } | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly d: PatchServiceDeps) {
    this.unsubscribe = d.cloud.onSessionChange(() => {
      this.identities.clear();
      d.onChanged?.({ reason: 'session' });
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.opened.clear();
    this.keys.clear();
  }

  // ---- availability ----

  availability(): PatchAvailability {
    const me = this.d.cloud.me();
    return {
      configured: !!this.d.cloud.serverUrl(),
      signedIn: !!me,
      serverUrl: this.d.cloud.serverUrl(),
      ...(me
        ? { user: { id: me.id, name: me.name, ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}) } }
        : {}),
      orgs: (me?.orgs ?? []).map((o) => ({ id: o.id, name: o.name, role: o.role })),
      activeOrgId: me ? this.d.cloud.activeOrgId() : null,
    };
  }

  private requireSignedIn(): void {
    if (!this.d.cloud.serverUrl())
      throw new CloudError('not_configured', 'No GitHappens Cloud server is configured.');
    if (!this.d.cloud.me()) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
  }

  /** Server patch size limit (`/.well-known/githappens-cloud`), cached per server. */
  async maxBytes(): Promise<number> {
    const server = this.d.cloud.serverUrl();
    if (!server) return DEFAULT_PATCH_MAX_BYTES;
    if (this.serverInfo?.server !== server) {
      let info: ServerInfo | null = null;
      try {
        info = (
          await this.d.cloud.request<ServerInfo>('GET', '/.well-known/githappens-cloud', { auth: false })
        ).data;
      } catch {
        /* offline: use the default and retry next time */
      }
      if (!info) return DEFAULT_PATCH_MAX_BYTES;
      this.serverInfo = { server, info };
    }
    return this.serverInfo.info?.limits.patchMaxBytes || DEFAULT_PATCH_MAX_BYTES;
  }

  // ---- create ----

  async preview(repoId: RepoId, source: PatchSource): Promise<PatchDraft> {
    const built = await buildPatch(this.d.repos.get(repoId), source);
    return {
      kind: built.kind,
      title: built.title,
      baseSha: built.baseSha,
      ...(built.baseBranch ? { baseBranch: built.baseBranch } : {}),
      files: built.files,
      warnings: built.warnings,
      size: built.size,
      maxBytes: await this.maxBytes(),
    };
  }

  async create(req: PatchCreateReq): Promise<PatchCreateRes> {
    this.requireSignedIn();
    const title = req.title.trim();
    if (!title) throw err('Enter a title for the Cloud Patch.');
    const svc = this.d.repos.get(req.repoId);
    const built = await buildPatch(svc, req.source);
    const e2e = req.e2e ?? req.visibility === 'link';
    const description = req.description?.trim() || undefined;
    const bundle: PatchBundle = {
      format: PATCH_FORMAT,
      title,
      ...(description ? { description } : {}),
      kind: req.kind ?? built.kind,
      baseSha: built.baseSha,
      ...(built.baseBranch ? { baseBranch: built.baseBranch } : {}),
      createdWith: `GitHappens ${this.d.appVersion}`,
      patch: built.text,
      files: built.files,
    };
    const sealed = await sealPatchBundle(bundle, { e2e });
    const max = await this.maxBytes();
    if (sealed.bytes.length > max) {
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
      throw err(
        `The patch is too large to share (${mb(sealed.bytes.length)}, limit ${mb(max)}). Push a branch instead.`,
      );
    }
    let orgId: string | undefined;
    if (req.visibility !== 'link') {
      orgId = req.orgId ?? this.d.cloud.activeOrgId() ?? this.d.cloud.me()?.orgs[0]?.id;
      if (!orgId) throw err('Join or create an organization to share with its members.');
    }
    if (req.visibility === 'collaborators' && !req.collaborators?.length)
      throw err('Choose at least one person to share the patch with.');
    const repo = await this.identity(req.repoId);
    const body: PatchCreate = {
      title: e2e && !req.shareTitle ? 'Encrypted patch' : title,
      ...(description && !e2e ? { description } : {}),
      kind: req.kind ?? built.kind,
      ...(orgId ? { orgId } : {}),
      ...(repo ? { repo } : {}),
      baseSha: built.baseSha,
      ...(built.baseBranch && !e2e ? { baseBranch: built.baseBranch } : {}),
      ...(e2e ? {} : { files: built.files }),
      e2e,
      size: sealed.bytes.length,
      sha256: sealed.sha256,
      visibility: req.visibility,
      ...(req.visibility === 'collaborators' ? { collaborators: req.collaborators } : {}),
      ...(req.expiresInDays
        ? { expiresAt: new Date(Date.now() + req.expiresInDays * 86_400_000).toISOString() }
        : {}),
    };
    const created = (await this.d.cloud.request<PatchCreated>('POST', '/v1/patches', { body })).data;
    const id = safeId(created.id);
    await this.d.cloud.upload(created.uploadUrl, sealed.bytes);
    const meta = (await this.d.cloud.request<PatchMeta>('POST', `/v1/patches/${id}/complete`)).data;
    if (sealed.key) {
      this.keys.set(id, sealed.key);
      try {
        this.d.keyStore?.set(id, sealed.key);
      } catch {
        /* secure storage unavailable: the link stays complete for this session only */
      }
    }
    this.cacheUpsert([{ meta, ...(e2e && body.title !== title ? { localTitle: title } : {}) }]);
    // the sender has the bundle already: opening its own link needs no download
    this.opened.set(id, { meta, bundle, key: sealed.key });
    this.d.onChanged?.({ reason: 'created' });
    const patch = this.toCloudPatch(meta);
    return { patch, shareUrl: patch.shareUrl, deepLink: patch.deepLink, warnings: built.warnings };
  }

  // ---- list / get / update / delete ----

  async list(req: PatchesIpcContract['patch:list']['req']): Promise<PatchesIpcContract['patch:list']['res']> {
    if (!this.d.cloud.serverUrl() || !this.d.cloud.me()) return { items: [] };
    let repoKey: string | undefined;
    if (req.repoId) {
      const id = await this.identity(req.repoId).catch(() => undefined);
      if (id) repoKey = repoIdentityKey(id);
    }
    try {
      const items: PatchMeta[] = [];
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ scope: req.scope, limit: '200' });
        if (repoKey) q.set('repo', repoKey);
        if (cursor) q.set('cursor', cursor);
        const page = (await this.d.cloud.request<Page<PatchMeta>>('GET', `/v1/patches?${q.toString()}`)).data;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && items.length < 1000);
      if (req.scope === 'mine')
        this.cacheUpsert(
          items.map((meta) => ({ meta })),
          !repoKey,
        );
      return { items: items.map((m) => this.toCloudPatch(m)) };
    } catch (e) {
      if (req.scope === 'mine' && e instanceof CloudError && e.code === 'network') {
        const cached = this.cacheRead().filter(
          (c) => !repoKey || (c.meta.repo && repoIdentityKey(c.meta.repo) === repoKey),
        );
        return { items: cached.map((c) => this.toCloudPatch(c.meta)), offline: true };
      }
      throw e;
    }
  }

  async get(id: string): Promise<CloudPatch> {
    const meta = (
      await this.d.cloud.request<PatchWithDownload>('GET', `/v1/patches/${safeId(id)}`, { auth: 'optional' })
    ).data;
    return this.toCloudPatch(stripDownload(meta));
  }

  async update(req: PatchesIpcContract['patch:update']['req']): Promise<CloudPatch> {
    this.requireSignedIn();
    const id = safeId(req.id);
    const body: PatchUpdate = {};
    if (req.title !== undefined) body.title = req.title;
    if (req.description !== undefined) body.description = req.description;
    if (req.visibility !== undefined) body.visibility = req.visibility;
    if (req.collaborators !== undefined) body.collaborators = req.collaborators;
    if (req.expiresInDays !== undefined)
      body.expiresAt = req.expiresInDays
        ? new Date(Date.now() + req.expiresInDays * 86_400_000).toISOString()
        : null;
    const meta = (await this.d.cloud.request<PatchMeta>('PATCH', `/v1/patches/${id}`, { body })).data;
    this.cacheUpsert([{ meta }]);
    this.d.onChanged?.({ reason: 'updated' });
    return this.toCloudPatch(meta);
  }

  async delete(id: string): Promise<null> {
    this.requireSignedIn();
    await this.d.cloud.request<unknown>('DELETE', `/v1/patches/${safeId(id)}`);
    this.cacheRemove(id);
    this.keys.delete(id);
    try {
      this.d.keyStore?.delete(id);
    } catch {
      /* ignore */
    }
    this.opened.delete(id);
    this.d.onChanged?.({ reason: 'deleted' });
    return null;
  }

  // ---- open ----

  async open(url: string, allowOtherServer = false): Promise<PatchOpenRes> {
    const link = parsePatchLink(url);
    if (!link) throw err('This is not a Cloud Patch link.');
    const id = safeId(link.id);
    const configured = normServer(this.d.cloud.serverUrl());
    const linkServer = normServer(link.server);
    let foreign: string | null = null;
    if (linkServer && linkServer !== configured) {
      if (!allowOtherServer) return { status: 'server-mismatch', linkServer, configuredServer: configured };
      foreign = link.server!.replace(/\/+$/, '');
    }
    if (!foreign && !configured)
      throw new CloudError('not_configured', 'No GitHappens Cloud server is configured.');

    const key = link.key ?? this.keys.get(id);
    let meta: PatchMeta;
    let bundle: PatchBundle;
    const cached = this.opened.get(id);
    if (cached && !foreign) {
      meta = cached.meta;
      bundle = cached.bundle;
    } else {
      let full: PatchWithDownload;
      if (foreign) {
        // another server: anonymous only (CloudHttp never sends our token elsewhere)
        const raw = await this.d.cloud.download(`${foreign}/v1/patches/${id}`);
        full = JSON.parse(new TextDecoder().decode(raw)) as PatchWithDownload;
      } else {
        full = (
          await this.d.cloud.request<PatchWithDownload>('GET', `/v1/patches/${id}`, { auth: 'optional' })
        ).data;
      }
      const bytes = await this.d.cloud.download(full.downloadUrl);
      if ((await sha256Hex(bytes)) !== full.sha256)
        throw err('The downloaded patch does not match its checksum. Try again.', { patchError: 'checksum' });
      bundle = await openPatchBlob(bytes, key);
      meta = stripDownload(full);
    }
    if (key && link.key) this.keys.set(id, key);
    this.opened.set(id, { meta, bundle, ...(key ? { key } : {}) });
    const parsed = parseBundleDiff(bundle);
    const candidates = await this.matchRepos(meta, bundle);
    const remote = candidates.filter((c) => c.match === 'remote');
    const best = candidates.length === 1 ? candidates[0] : remote.length === 1 ? remote[0] : undefined;
    const warnings: string[] = [];
    if (!candidates.length)
      warnings.push('No open repository matches this patch. Choose one to apply it to.');
    const opened: OpenedPatch = {
      patch: this.toCloudPatch(meta, bundle.title),
      bundle: {
        title: bundle.title,
        ...(bundle.description ? { description: bundle.description } : {}),
        kind: bundle.kind,
        baseSha: bundle.baseSha,
        ...(bundle.baseBranch ? { baseBranch: bundle.baseBranch } : {}),
        createdWith: bundle.createdWith,
        files: bundle.files,
        patch: bundle.patch,
      },
      diff: parsed,
      localMatch: {
        ...(best ? { repoId: best.repoId } : {}),
        baseAvailable: best?.baseAvailable ?? false,
        candidates,
      },
      warnings,
    };
    return { status: 'opened', opened };
  }

  private async matchRepos(meta: PatchMeta, bundle: PatchBundle): Promise<PatchRepoCandidate[]> {
    const wantKey = meta.repo ? repoIdentityKey(meta.repo) : null;
    const wantRoot = meta.repo?.initialCommitSha;
    const out: PatchRepoCandidate[] = [];
    for (const svc of this.d.repos.list()) {
      if (svc.repo.isBare) continue;
      const id = await this.identity(svc.repo.id).catch(() => undefined);
      let match: PatchRepoCandidate['match'] | null = null;
      if (wantKey && id && repoIdentityKey(id) === wantKey) match = 'remote';
      else if (wantRoot && id?.initialCommitSha === wantRoot) match = 'root-commit';
      if (!match) continue;
      out.push(await this.candidate(svc, bundle.baseSha, match));
    }
    return out;
  }

  private async candidate(
    svc: GitService,
    baseSha: Sha,
    match: PatchRepoCandidate['match'],
  ): Promise<PatchRepoCandidate> {
    const root = svc.repo.worktreeRoot ?? svc.repo.gitDir;
    return {
      repoId: svc.repo.id,
      path: root,
      name: path.basename(root),
      match,
      baseAvailable: await hasCommit(svc, baseSha),
    };
  }

  async checkRepo(patchId: string, repoId: RepoId): Promise<PatchRepoCandidate> {
    const o = this.requireOpened(patchId);
    const svc = this.d.repos.get(repoId);
    const matches = await this.matchRepos(o.meta, o.bundle);
    const m = matches.find((c) => c.repoId === repoId);
    return m ?? this.candidate(svc, o.bundle.baseSha, 'chosen');
  }

  async fetchBase(patchId: string, repoId: RepoId): Promise<{ baseAvailable: boolean }> {
    const o = this.requireOpened(patchId);
    const svc = this.d.repos.get(repoId);
    if (!(await hasCommit(svc, o.bundle.baseSha)))
      await this.d.repos.runOp(repoId, { type: 'fetch', remote: 'all' });
    return { baseAvailable: await hasCommit(svc, o.bundle.baseSha) };
  }

  // ---- apply ----

  async apply(req: PatchApplyReq): Promise<PatchApplyRes> {
    const o = this.requireOpened(req.patchId);
    const svc = this.d.repos.get(req.repoId);
    const { bundle } = o;
    const warnings: string[] = [];
    let target = req.target;
    if (target.kind === 'new-branch' && !target.base) {
      if (await hasCommit(svc, bundle.baseSha)) target = { ...target, base: bundle.baseSha };
      else warnings.push('The patch base commit is not available locally, so the branch starts at HEAD.');
    }
    const commit = target.kind !== 'worktree' && (req.commit ?? bundle.kind === 'commit');
    const mode = commit && bundle.kind === 'commit' ? 'am' : 'apply';
    const message = bundle.description ? `${bundle.title}\n\n${bundle.description}` : bundle.title;
    const dir = path.join(this.d.cacheDir(), 'patches');
    fs.mkdirSync(dir, { recursive: true });
    const patchFile = path.join(dir, `${safeId(req.patchId)}-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, bundle.patch, 'utf8');
    try {
      const r = await this.d.repos.runOp(req.repoId, {
        type: 'patch.apply',
        patchFile,
        mode,
        target,
        threeWay: req.threeWay ?? true,
        ...(req.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
        ...(req.reject ? { reject: true } : {}),
        ...(commit && mode === 'apply' ? { commitMessage: message } : {}),
        title: bundle.title,
      });
      const data = (r.data ?? { applied: true, conflicts: [], rejects: [] }) as PatchApplyOutcome;
      return {
        applied: data.applied,
        conflicts: data.conflicts,
        rejects: data.rejects,
        ...(data.branch ? { branch: data.branch } : {}),
        ...(data.commit ? { commit: data.commit } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
        warnings: [...warnings, ...(r.warnings ?? [])],
      };
    } finally {
      fs.rmSync(patchFile, { force: true });
    }
  }

  // ---- org members ----

  async collaboratorCandidates(
    orgId?: string,
  ): Promise<PatchesIpcContract['patch:collaboratorCandidates']['res']> {
    this.requireSignedIn();
    const me = this.d.cloud.me()!;
    const id = orgId ?? this.d.cloud.activeOrgId() ?? me.orgs[0]?.id ?? null;
    if (!id) return { orgId: null, members: [] };
    const org = (await this.d.cloud.request<OrgDetail>('GET', `/v1/orgs/${encodeURIComponent(id)}`)).data;
    return { orgId: id, members: org.members.map((m) => m.user).filter((u) => u.id !== me.id) };
  }

  // ---- helpers ----

  /** Decrypted bundle of a patch opened (or created) in this session (Code Suggest per-file apply). */
  openedBundle(patchId: string): PatchBundle {
    return this.requireOpened(patchId).bundle;
  }

  /** Complete share link of one of the user's own e2e patches (memory, then SecretStore). */
  keyFor(patchId: string): string | undefined {
    let key = this.keys.get(patchId);
    if (!key) {
      try {
        key = this.d.keyStore?.get(patchId) ?? undefined;
      } catch {
        key = undefined;
      }
      if (key) this.keys.set(patchId, key);
    }
    return key;
  }

  private requireOpened(patchId: string): Opened {
    const o = this.opened.get(patchId);
    if (!o) throw err('Open the Cloud Patch link again.');
    return o;
  }

  /** Repo identity incl. the root commit (cached per repo for the session). */
  private identity(repoId: RepoId): Promise<RepoIdentity | undefined> {
    let p = this.identities.get(repoId);
    if (!p) {
      p = (async () => {
        const svc = this.d.repos.get(repoId);
        const [id, root] = await Promise.all([
          this.d.resolveRepoIdentity(repoId).catch(() => undefined),
          rootCommit(svc),
        ]);
        if (!id) return undefined;
        return { ...id, ...(root ? { initialCommitSha: root } : {}) };
      })();
      this.identities.set(repoId, p);
      p.catch(() => this.identities.delete(repoId));
    }
    return p;
  }

  private toCloudPatch(meta: PatchMeta, title?: string): CloudPatch {
    const mine = meta.author.id === this.d.cloud.me()?.id;
    const key = mine && meta.e2e ? this.keyFor(meta.id) : this.keys.get(meta.id);
    const local = this.cacheRead().find((c) => c.meta.id === meta.id);
    const localTitle = title ?? local?.localTitle;
    return {
      ...meta,
      deepLink: patchDeepLink(meta.id, key),
      shareUrl: key ? `${meta.webUrl}#k=${key}` : meta.webUrl,
      hasKey: !!key,
      mine,
      ...(localTitle && localTitle !== meta.title ? { localTitle } : {}),
    };
  }

  // ---- "created by me" cache (metadata only; never keys) ----

  private cachePath(): string {
    return path.join(this.d.cacheDir(), 'cloud-patches.json');
  }

  private cacheRead(): CacheEntry[] {
    const server = this.d.cloud.serverUrl();
    const me = this.d.cloud.me();
    if (!server || !me) return [];
    try {
      const f = JSON.parse(fs.readFileSync(this.cachePath(), 'utf8')) as CacheFile;
      if (f.version !== 1 || f.server !== server || f.userId !== me.id || !Array.isArray(f.items)) return [];
      const now = Date.now();
      return f.items.filter((c) => !c.meta.expiresAt || Date.parse(c.meta.expiresAt) > now);
    } catch {
      return [];
    }
  }

  private cacheWrite(items: CacheEntry[]): void {
    const server = this.d.cloud.serverUrl();
    const me = this.d.cloud.me();
    if (!server || !me) return;
    const f: CacheFile = { version: 1, server, userId: me.id, items: items.slice(0, 500) };
    try {
      fs.mkdirSync(this.d.cacheDir(), { recursive: true });
      fs.writeFileSync(this.cachePath(), JSON.stringify(f), 'utf8');
    } catch {
      /* cache only */
    }
  }

  /** Insert/update entries (newest first); `replace` drops mine that the server no longer lists. */
  private cacheUpsert(entries: CacheEntry[], replace = false): void {
    const me = this.d.cloud.me();
    const mine = entries.filter((e) => e.meta.author.id === me?.id);
    const current = this.cacheRead();
    const byId = new Map(current.map((c) => [c.meta.id, c]));
    const next: CacheEntry[] = mine.map((e) => ({
      meta: e.meta,
      ...((e.localTitle ?? byId.get(e.meta.id)?.localTitle)
        ? { localTitle: e.localTitle ?? byId.get(e.meta.id)?.localTitle }
        : {}),
    }));
    const ids = new Set(next.map((e) => e.meta.id));
    if (!replace) next.push(...current.filter((c) => !ids.has(c.meta.id)));
    next.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
    this.cacheWrite(next);
  }

  private cacheRemove(id: string): void {
    this.cacheWrite(this.cacheRead().filter((c) => c.meta.id !== id));
  }
}

function stripDownload(m: PatchWithDownload | PatchMeta): PatchMeta {
  const { downloadUrl: _drop, ...meta } = m as PatchWithDownload;
  void _drop;
  return meta;
}

async function hasCommit(svc: GitService, sha: Sha): Promise<boolean> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  const r = await svc.runRead(['cat-file', '-e', `${sha}^{commit}`], { expectedExitCodes: [0, 1, 128] });
  return r.exitCode === 0;
}

async function rootCommit(svc: GitService): Promise<string | undefined> {
  const r = await svc.runRead(['rev-list', '--max-parents=0', 'HEAD'], { expectedExitCodes: [0, 128] });
  if (r.exitCode !== 0) return undefined;
  return r.stdout.trim().split('\n').filter(Boolean).at(-1);
}

/** FileDiff list for the read-only viewer; paths/status come from the bundle (quoting-safe). */
export function parseBundleDiff(bundle: Pick<PatchBundle, 'patch' | 'files'>): FileDiff[] {
  const diff = parseDiff(bundle.patch);
  return diff.map((f, i) => {
    const pf = bundle.files[i];
    if (!pf) return f;
    return {
      ...f,
      newPath: pf.status === 'D' ? null : pf.path,
      oldPath: pf.status === 'A' ? null : pf.status === 'R' ? f.oldPath : pf.path,
      status: pf.status,
      binary: f.binary || !!pf.binary,
    };
  });
}
