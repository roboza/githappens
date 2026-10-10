import fs from 'node:fs';
import path from 'node:path';

import type { CloudWorkspace, OrgDetail, WorkspaceShare } from '@githappens/cloud-api/types';

import type {
  CloudWorkspaceInfo,
  CloudWorkspaceLinkStatus,
  CloudWorkspacesEventContract,
  ShareTargets,
} from '../../../shared/ipc/cloud-workspaces-contract';
import type {
  BulkOpRequest,
  CreateWorkspaceInput,
  NewWorkspaceRepo,
  Workspace,
} from '../../../shared/ipc/workspaces-contract';
import { normalizeRemoteUrl } from '../../workspaces/util';
import { CloudError, type CloudHttp } from '../cloud-http';
import { docHash, docToNewRepos, parseDoc, workspaceToDoc } from './doc';

/** The parts of the workspace layer (owned by spec 11's WorkspaceService) used here. */
export interface CloudWorkspaceHost {
  list(): Workspace[];
  create(input: CreateWorkspaceInput): Promise<Workspace>;
  addRepos(id: string, repos: NewWorkspaceRepo[]): Promise<Workspace>;
  startBulk(req: BulkOpRequest): { bulkId: string };
  onDidChange(cb: () => void): () => void;
  /** Optional: record the cloud link on the workspace itself (`Workspace.cloud`). */
  setCloudLink?(workspaceId: string, cloud: Workspace['cloud'] | undefined): void;
}

export interface CloudWorkspaceServiceDeps {
  cloud: CloudHttp;
  workspaces: CloudWorkspaceHost;
  /** Connected integrations (kind/host/key) to map provider repos to accounts on this computer. */
  integrations(): Array<{ key: string; kind: string; host: string }>;
  /** Known local repositories (recents / open) with their remote URLs, to locate existing clones. */
  knownRepos?(): Promise<Array<{ path: string; remotes: string[] }>>;
  /** Active profile directory: `cloud-workspaces.json` (local ↔ cloud links) lives there. */
  profileDir(): string;
  onChanged?(e: CloudWorkspacesEventContract['cloudWorkspace:changed']): void;
}

interface Link {
  remoteId: string;
  server: string;
  userId: string;
  version: number;
  /** Hash of the doc as last published / opened. */
  hash: string;
  syncedAt: string;
}

interface LinkFile {
  version: 1;
  links: Record<string, Link>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (message: string): Error => new Error(message);

/**
 * Cloud workspaces (spec 11 §6.6 / spec 14): publish a local workspace (paths stripped), share it with
 * the org, teams or members, open a shared one on another computer and clone what is missing.
 */
export class CloudWorkspaceService {
  constructor(private readonly d: CloudWorkspaceServiceDeps) {}

  private requireSignedIn(): { server: string; userId: string } {
    const server = this.d.cloud.serverUrl();
    if (!server) throw new CloudError('not_configured', 'No GitHappens Cloud server is configured.');
    const me = this.d.cloud.me();
    if (!me) throw new CloudError('signed_out', 'Sign in to GitHappens Cloud first.');
    return { server, userId: me.id };
  }

  // ---- link file ----

  private linkPath(): string {
    return path.join(this.d.profileDir(), 'cloud-workspaces.json');
  }

  private readLinks(): Record<string, Link> {
    try {
      const f = JSON.parse(fs.readFileSync(this.linkPath(), 'utf8')) as LinkFile;
      return f.version === 1 && f.links && typeof f.links === 'object' ? f.links : {};
    } catch {
      return {};
    }
  }

  private writeLinks(links: Record<string, Link>): void {
    fs.mkdirSync(this.d.profileDir(), { recursive: true });
    const tmp = `${this.linkPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, links } satisfies LinkFile, null, 2), 'utf8');
    fs.renameSync(tmp, this.linkPath());
  }

  /** Links for the signed-in account on the configured server (others are ignored, not deleted). */
  private links(): Map<string, Link> {
    const server = this.d.cloud.serverUrl();
    const me = this.d.cloud.me();
    const out = new Map<string, Link>();
    const existing = new Set(this.d.workspaces.list().map((w) => w.id));
    for (const [localId, l] of Object.entries(this.readLinks())) {
      if (l.server === server && l.userId === me?.id && existing.has(localId)) out.set(localId, l);
    }
    return out;
  }

  private setLink(localId: string, link: Link | undefined): void {
    const all = this.readLinks();
    if (link) all[localId] = link;
    else delete all[localId];
    this.writeLinks(all);
    try {
      this.d.workspaces.setCloudLink?.(
        localId,
        link ? { remoteId: link.remoteId, version: link.version, syncedAt: link.syncedAt } : undefined,
      );
    } catch {
      /* optional mirror only */
    }
  }

  // ---- list / info ----

  private info(w: CloudWorkspace, orgNames: Map<string, string>): CloudWorkspaceInfo {
    const me = this.d.cloud.me();
    const doc = parseDoc(w.doc);
    const localId = [...this.links().entries()].find(([, l]) => l.remoteId === w.id)?.[0];
    const role = me?.orgs.find((o) => o.id === w.orgId)?.role;
    return {
      id: w.id,
      name: doc?.name ?? 'Workspace',
      ...(doc?.description ? { description: doc.description } : {}),
      ownerUserId: w.ownerUserId,
      mine: w.ownerUserId === me?.id,
      canWrite: w.ownerUserId === me?.id || role === 'owner' || role === 'admin',
      ...(w.orgId ? { orgId: w.orgId } : {}),
      ...(w.orgId && orgNames.get(w.orgId) ? { orgName: orgNames.get(w.orgId) } : {}),
      version: w.version,
      updatedAt: w.updatedAt,
      shares: w.shares,
      repos: doc?.repos ?? [],
      ...(localId ? { localWorkspaceId: localId } : {}),
    };
  }

  private orgNames(): Map<string, string> {
    return new Map((this.d.cloud.me()?.orgs ?? []).map((o) => [o.id, o.name]));
  }

  async list(): Promise<{ items: CloudWorkspaceInfo[] }> {
    if (!this.d.cloud.serverUrl() || !this.d.cloud.me()) return { items: [] };
    const list = (await this.d.cloud.request<CloudWorkspace[]>('GET', '/v1/workspaces')).data;
    const names = this.orgNames();
    return { items: list.map((w) => this.info(w, names)) };
  }

  private async get(id: string): Promise<CloudWorkspace> {
    if (!UUID_RE.test(id)) throw fail('Unknown cloud workspace.');
    return (await this.d.cloud.request<CloudWorkspace>('GET', `/v1/workspaces/${id}`)).data;
  }

  // ---- publish / share ----

  async publish(workspaceId: string, orgId?: string, force = false): Promise<CloudWorkspaceInfo> {
    const { server, userId } = this.requireSignedIn();
    const ws = this.d.workspaces.list().find((w) => w.id === workspaceId);
    if (!ws) throw fail('Workspace not found.');
    if (ws.kind === 'directory')
      throw fail(
        'Folder-synced workspaces depend on a local folder; convert it to a regular workspace first.',
      );
    const doc = workspaceToDoc(ws);
    const link = this.links().get(workspaceId);
    let remote: CloudWorkspace;
    if (link) {
      try {
        remote = (
          await this.d.cloud.request<CloudWorkspace>('PUT', `/v1/workspaces/${link.remoteId}`, {
            body: { doc },
            ...(force ? {} : { headers: { 'if-match': String(link.version) } }),
          })
        ).data;
      } catch (e) {
        if (e instanceof CloudError && e.code === 'not_found') {
          this.setLink(workspaceId, undefined);
          return this.publish(workspaceId, orgId, force);
        }
        throw e;
      }
    } else {
      const org = orgId ?? this.d.cloud.activeOrgId() ?? undefined;
      remote = (
        await this.d.cloud.request<CloudWorkspace>('POST', '/v1/workspaces', {
          body: { doc, ...(org ? { orgId: org } : {}) },
        })
      ).data;
    }
    this.setLink(workspaceId, {
      remoteId: remote.id,
      server,
      userId,
      version: remote.version,
      hash: docHash(doc),
      syncedAt: new Date().toISOString(),
    });
    this.d.onChanged?.({ reason: 'published' });
    return this.info(remote, this.orgNames());
  }

  async share(id: string, shares: WorkspaceShare[]): Promise<CloudWorkspaceInfo> {
    this.requireSignedIn();
    const current = await this.get(id);
    const updated = (
      await this.d.cloud.request<CloudWorkspace>('PUT', `/v1/workspaces/${id}/shares`, {
        body: { shares },
        headers: { 'if-match': String(current.version) },
      })
    ).data;
    // keep the link's version current so the next publish does not see a false conflict
    for (const [localId, l] of this.links()) {
      if (l.remoteId === id && l.version === current.version)
        this.setLink(localId, { ...l, version: updated.version });
    }
    this.d.onChanged?.({ reason: 'shared' });
    return this.info(updated, this.orgNames());
  }

  async shareTargets(orgId?: string): Promise<ShareTargets> {
    this.requireSignedIn();
    const me = this.d.cloud.me()!;
    const orgs = orgId ? me.orgs.filter((o) => o.id === orgId) : me.orgs;
    const out: ShareTargets = { orgs: orgs.map((o) => ({ id: o.id, name: o.name })), teams: [], members: [] };
    for (const o of orgs) {
      const detail = (await this.d.cloud.request<OrgDetail>('GET', `/v1/orgs/${encodeURIComponent(o.id)}`))
        .data;
      out.teams.push(
        ...detail.teams.map((t) => ({
          id: t.id,
          orgId: o.id,
          name: t.name,
          memberCount: t.memberIds.length,
        })),
      );
      out.members.push(
        ...detail.members
          .filter((m) => m.user.id !== me.id)
          .map((m) => ({
            id: m.user.id,
            orgId: o.id,
            name: m.user.name,
            ...(m.user.email ? { email: m.user.email } : {}),
          })),
      );
    }
    return out;
  }

  // ---- open on another computer ----

  async open(id: string, cloneRoot?: string): Promise<{ workspace: Workspace; missing: string[] }> {
    const { server, userId } = this.requireSignedIn();
    const remote = await this.get(id);
    const doc = parseDoc(remote.doc);
    if (!doc) throw fail('This cloud workspace has an unknown format.');
    const accounts = this.d.integrations();
    const known = (await this.d.knownRepos?.().catch(() => [])) ?? [];
    const clones = new Map<string, string>();
    for (const k of known) for (const r of k.remotes) clones.set(normalizeRemoteUrl(r), k.path);
    const repos = docToNewRepos(doc, {
      integrationFor: (kind, host) =>
        accounts.find((a) => a.kind === kind && a.host.toLowerCase() === host.toLowerCase())?.key,
      localClone: (url) => {
        const p = clones.get(normalizeRemoteUrl(url));
        return p && fs.existsSync(p) ? p : undefined;
      },
    });
    const existingId = [...this.links().entries()].find(([, l]) => l.remoteId === id)?.[0];
    let ws: Workspace;
    if (existingId) {
      ws = await this.d.workspaces.addRepos(existingId, repos); // duplicates are ignored
    } else {
      ws = await this.d.workspaces.create({
        kind: 'cloud',
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        ...(doc.color ? { color: doc.color } : {}),
        ...(doc.icon ? { icon: doc.icon } : {}),
        repos,
        ...(cloneRoot ? { defaultCloneRoot: cloneRoot } : {}),
      });
    }
    this.setLink(ws.id, {
      remoteId: id,
      server,
      userId,
      version: remote.version,
      hash: docHash(workspaceToDoc(ws)),
      syncedAt: new Date().toISOString(),
    });
    this.d.onChanged?.({ reason: 'opened' });
    return { workspace: ws, missing: ws.repos.filter((r) => !r.localPath).map((r) => r.id) };
  }

  cloneMissing(
    workspaceId: string,
    cloneRoot?: string,
    protocol?: 'https' | 'ssh',
  ): { bulkId: string | null; count: number } {
    const ws = this.d.workspaces.list().find((w) => w.id === workspaceId);
    if (!ws) throw fail('Workspace not found.');
    const missing = ws.repos.filter((r) => !r.localPath || !fs.existsSync(r.localPath)).map((r) => r.id);
    if (!missing.length) return { bulkId: null, count: 0 };
    const root = cloneRoot ?? ws.defaultCloneRoot;
    if (!root) throw fail('Choose a folder to clone the missing repositories into.');
    const { bulkId } = this.d.workspaces.startBulk({
      workspaceId,
      repoIds: missing,
      op: 'clone',
      options: { cloneRoot: root, ...(protocol ? { protocol } : {}) },
    });
    return { bulkId, count: missing.length };
  }

  async status(workspaceId: string): Promise<CloudWorkspaceLinkStatus> {
    const ws = this.d.workspaces.list().find((w) => w.id === workspaceId);
    const missing = ws ? ws.repos.filter((r) => !r.localPath).length : 0;
    const link = this.links().get(workspaceId);
    if (!ws || !link) return { linked: null, localChanged: false, remoteChanged: false, missing };
    let remote: CloudWorkspace | undefined;
    try {
      remote = await this.get(link.remoteId);
    } catch (e) {
      if (e instanceof CloudError && e.code === 'not_found') {
        this.setLink(workspaceId, undefined);
        return { linked: null, localChanged: false, remoteChanged: false, missing };
      }
      throw e;
    }
    return {
      linked: this.info(remote, this.orgNames()),
      localChanged: docHash(workspaceToDoc(ws)) !== link.hash,
      remoteChanged: remote.version !== link.version,
      missing,
    };
  }

  unlink(workspaceId: string): null {
    this.setLink(workspaceId, undefined);
    this.d.onChanged?.({ reason: 'unlinked' });
    return null;
  }

  async delete(id: string): Promise<null> {
    this.requireSignedIn();
    if (!UUID_RE.test(id)) throw fail('Unknown cloud workspace.');
    await this.d.cloud.request('DELETE', `/v1/workspaces/${id}`);
    for (const [localId, l] of this.links()) if (l.remoteId === id) this.setLink(localId, undefined);
    this.d.onChanged?.({ reason: 'deleted' });
    return null;
  }
}
