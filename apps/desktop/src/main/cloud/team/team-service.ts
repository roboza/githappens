import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  repoIdentityKey,
  type Footprint,
  type OrgDetail,
  type RepoIdentity,
  type TeamView,
} from '@githappens/cloud-api/types';
import type { GitService, RefreshScope, RepoId } from '@githappens/git';

import type { TeammateOverlap, TeamStatus, TeamViewResult } from '../../../shared/ipc/conflicts-contract';
import type { CloudHttp } from '../cloud-http';
import { computeFootprint, type OwnFootprintFile } from './footprint';
import { repoIdentity } from './repo-identity';
import { findOverlaps, hashFiles, shapeFootprint, type FootprintPolicies, type HashedFile } from './shaping';

/** Uploads are debounced after changes (spec 14 §6.5). */
export const UPLOAD_DEBOUNCE_MS = 2 * 60_000;
/** Teammates' footprints are polled while a repo is open. */
export const POLL_INTERVAL_MS = 5 * 60_000;
const ORG_TTL_MS = 10 * 60_000;
/** Most recently committed local branches considered per upload. */
const MAX_BRANCHES = 30;
export const FOOTPRINT_STATE_FILE = 'githappens-footprints.json';

export interface TeamTarget {
  ref: string;
  sha: string | null;
}

export interface TeamServiceDeps {
  repos: { get(repoId: RepoId): GitService; list(): GitService[] };
  cloud: CloudHttp;
  footprintsEnabled(): boolean;
  /** Target of a branch (shared with the conflict check's resolver). */
  targetFor(repoId: RepoId, branch: string): Promise<TeamTarget | null>;
  /** Teammates' footprints changed for this repo → recompute overlaps in the report. */
  onOverlapsChanged(repoId: RepoId): void;
  ignoreSpaceChange?: boolean;
  uploadDebounceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

interface RepoState {
  identity?: RepoIdentity | null;
  repoIdentityId?: string | null;
  theirs: Footprint[];
  lastPollAt?: number;
  uploadTimer?: ReturnType<typeof setTimeout>;
  own?: { key: string; files: OwnFootprintFile[] };
}

interface PersistedOrg {
  repoIdentityId?: string;
  /** branchHash → signature of the last uploaded body. */
  branches: Record<string, string>;
}

const sig = (v: unknown): string => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const enc = encodeURIComponent;

/**
 * Team footprints (spec 14 §6.5, opt-in): uploads privacy-shaped footprints of this machine's unmerged
 * branches, polls teammates' footprints and computes overlaps locally. Makes no network call unless the
 * cloud is configured, the user is signed in with an active org and `team.footprints` is on.
 */
export class TeamService {
  private readonly state = new Map<RepoId, RepoState>();
  private org: { id: string; at: number; detail: OrgDetail } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wasActive = false;
  private lastUploadAt?: number;
  private lastError?: string;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly d: TeamServiceDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ---- lifecycle ----

  start(): void {
    this.unsubscribe = this.d.cloud.onSessionChange(() => {
      this.org = null;
      for (const s of this.state.values()) {
        s.theirs = [];
        s.repoIdentityId = undefined;
        s.lastPollAt = undefined;
      }
      for (const id of this.state.keys()) this.d.onOverlapsChanged(id);
    });
    this.pollTimer = setInterval(() => void this.tick(), this.d.pollIntervalMs ?? POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribe?.();
    for (const s of this.state.values()) if (s.uploadTimer) clearTimeout(s.uploadTimer);
    this.state.clear();
  }

  /** Configured + signed in + active org + `team.footprints`. */
  isActive(): boolean {
    return !!(
      this.d.footprintsEnabled() &&
      this.d.cloud.serverUrl() &&
      this.d.cloud.me() &&
      this.d.cloud.activeOrgId()
    );
  }

  /** Periodic: poll open repos; withdraw uploaded footprints once after the user turned sharing off. */
  async tick(): Promise<void> {
    const active = this.isActive();
    if (!active) {
      if (this.wasActive && this.d.cloud.me() && this.d.cloud.activeOrgId()) await this.withdrawAll();
      this.wasActive = false;
      return;
    }
    this.wasActive = true;
    for (const svc of this.d.repos.list()) await this.poll(svc.repo.id).catch(() => undefined);
  }

  status(): TeamStatus {
    const configured = !!this.d.cloud.serverUrl();
    const me = this.d.cloud.me();
    const orgId = this.d.cloud.activeOrgId();
    const org = this.org && this.org.id === orgId ? this.org.detail : null;
    const lastPoll = Math.max(0, ...[...this.state.values()].map((s) => s.lastPollAt ?? 0));
    return {
      configured,
      signedIn: !!me,
      orgId,
      ...(org ? { orgName: org.name } : orgId ? { orgName: me?.orgs.find((o) => o.id === orgId)?.name } : {}),
      footprintsEnabled: this.d.footprintsEnabled(),
      active: this.isActive(),
      ...(org
        ? {
            policies: {
              footprintSharePaths: org.policies.footprintSharePaths,
              footprintShareBranchNames: org.policies.footprintShareBranchNames,
            },
          }
        : {}),
      ...(this.lastUploadAt ? { lastUploadAt: new Date(this.lastUploadAt).toISOString() } : {}),
      ...(lastPoll ? { lastPollAt: new Date(lastPoll).toISOString() } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  // ---- repo events ----

  /** Refs / worktree changed: forget the cached own footprint and schedule a (debounced) upload. */
  onRepoChanged(repoId: RepoId, scopes: RefreshScope[]): void {
    if (!scopes.some((s) => s === 'refs' || s === 'status' || s === 'remotes' || s === 'repoState')) return;
    const st = this.repoState(repoId);
    st.own = undefined;
    if (scopes.includes('remotes')) {
      st.identity = undefined;
      st.repoIdentityId = undefined;
    }
    if (!this.isActive()) return;
    this.wasActive = true;
    if (st.uploadTimer) clearTimeout(st.uploadTimer);
    st.uploadTimer = setTimeout(() => {
      st.uploadTimer = undefined;
      void this.upload(repoId).catch((e) => this.fail('upload', e));
    }, this.d.uploadDebounceMs ?? UPLOAD_DEBOUNCE_MS);
    st.uploadTimer.unref?.();
  }

  forget(repoId: RepoId): void {
    const st = this.state.get(repoId);
    if (st?.uploadTimer) clearTimeout(st.uploadTimer);
    this.state.delete(repoId);
  }

  private repoState(repoId: RepoId): RepoState {
    let st = this.state.get(repoId);
    if (!st) {
      st = { theirs: [] };
      this.state.set(repoId, st);
    }
    return st;
  }

  private fail(what: string, e: unknown): void {
    this.lastError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    this.d.log?.(`[team] ${what} failed`, e);
  }

  // ---- org / identity ----

  private async orgDetail(): Promise<OrgDetail> {
    const orgId = this.d.cloud.activeOrgId();
    if (!orgId) throw new Error('No active organization');
    if (this.org && this.org.id === orgId && this.now() - this.org.at < ORG_TTL_MS) return this.org.detail;
    const r = await this.d.cloud.request<OrgDetail>('GET', `/v1/orgs/${enc(orgId)}`);
    this.org = { id: orgId, at: this.now(), detail: r.data };
    return r.data;
  }

  private async identity(repoId: RepoId): Promise<RepoIdentity | null> {
    const st = this.repoState(repoId);
    if (st.identity === undefined) st.identity = await repoIdentity(this.d.repos.get(repoId));
    return st.identity;
  }

  private async repoIdentityId(repoId: RepoId, orgId: string, repo: RepoIdentity): Promise<string | null> {
    const st = this.repoState(repoId);
    if (st.repoIdentityId) return st.repoIdentityId;
    const persisted = this.readState(repoId).orgs[orgId]?.repoIdentityId;
    if (persisted) return (st.repoIdentityId = persisted);
    try {
      const r = await this.d.cloud.request<{ id: string }>(
        'GET',
        `/v1/orgs/${enc(orgId)}/repo-identities?key=${enc(repoIdentityKey(repo))}`,
      );
      st.repoIdentityId = r.data.id;
      return r.data.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'not_found' || (e as { status?: number }).status === 404)
        return null;
      throw e;
    }
  }

  // ---- persisted upload state (`<commonDir>/githappens-footprints.json`) ----

  private stateFile(repoId: RepoId): string {
    return path.join(this.d.repos.get(repoId).repo.commonDir, FOOTPRINT_STATE_FILE);
  }

  private readState(repoId: RepoId): { orgs: Record<string, PersistedOrg> } {
    try {
      const doc = JSON.parse(fs.readFileSync(this.stateFile(repoId), 'utf8')) as {
        orgs?: Record<string, PersistedOrg>;
      };
      return { orgs: doc.orgs && typeof doc.orgs === 'object' ? doc.orgs : {} };
    } catch {
      return { orgs: {} };
    }
  }

  private writeState(repoId: RepoId, doc: { orgs: Record<string, PersistedOrg> }): void {
    const file = this.stateFile(repoId);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, ...doc }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  // ---- footprints ----

  /** Local branches with work ahead of their target (most recent first), plus the current one if dirty. */
  private async branchFootprints(
    repoId: RepoId,
  ): Promise<Array<{ branch: string; baseRef: string; headSha: string; files: OwnFootprintFile[] }>> {
    const svc = this.d.repos.get(repoId);
    if (svc.repo.isBare) return [];
    const info = await svc.refreshRepoInfo();
    const current = info.head.kind === 'branch' ? info.head.name : null;
    const r = await svc.runRead(
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%00%(objectname)', 'refs/heads'],
      { priority: 'background' },
    );
    const branches = String(r.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split('\0') as [string, string])
      .slice(0, MAX_BRANCHES);
    const out: Array<{ branch: string; baseRef: string; headSha: string; files: OwnFootprintFile[] }> = [];
    for (const [branch, sha] of branches) {
      const target = await this.d.targetFor(repoId, branch).catch(() => null);
      if (!target?.sha) continue;
      const isCurrent = branch === current;
      const ahead = await svc.runRead(['rev-list', '--count', `${target.sha}..${sha}`], {
        priority: 'background',
      });
      if (Number(String(ahead.stdout).trim()) === 0 && !isCurrent) continue;
      const files = await this.ownFiles(svc, target.sha, sha, isCurrent);
      if (!files.length) continue;
      out.push({ branch, baseRef: target.ref, headSha: sha, files });
    }
    return out;
  }

  private async ownFiles(
    svc: GitService,
    targetSha: string,
    headSha: string,
    withWip: boolean,
  ): Promise<OwnFootprintFile[]> {
    const mb = await svc.runRead(['merge-base', targetSha, headSha], { expectedExitCodes: [0, 1] });
    const base = String(mb.stdout).trim();
    if (mb.exitCode !== 0 || !base) return [];
    const opts = { ignoreSpaceChange: this.d.ignoreSpaceChange ?? true };
    return (await computeFootprint(svc, base, withWip ? null : headSha, opts)).files;
  }

  /** Upload changed footprints and delete ones for branches that were merged / deleted. */
  async upload(repoId: RepoId): Promise<void> {
    if (!this.isActive()) return;
    const orgId = this.d.cloud.activeOrgId()!;
    const repo = await this.identity(repoId);
    if (!repo) return;
    const org = await this.orgDetail();
    const policies: FootprintPolicies = org.policies;
    const doc = this.readState(repoId);
    const prev: PersistedOrg = doc.orgs[orgId] ?? { branches: {} };
    const next: PersistedOrg = {
      ...(prev.repoIdentityId ? { repoIdentityId: prev.repoIdentityId } : {}),
      branches: {},
    };
    for (const b of await this.branchFootprints(repoId)) {
      const body = await shapeFootprint({ salt: org.footprintSalt, policies, repo, ...b });
      const s = sig(body);
      if (prev.branches[body.branchHash] !== s) {
        const r = await this.d.cloud.request<{ repoIdentityId: string }>(
          'PUT',
          `/v1/orgs/${enc(orgId)}/footprints`,
          {
            body,
          },
        );
        if (r.data?.repoIdentityId) {
          next.repoIdentityId = r.data.repoIdentityId;
          this.repoState(repoId).repoIdentityId = r.data.repoIdentityId;
        }
        this.lastUploadAt = this.now();
      }
      next.branches[body.branchHash] = s;
    }
    const gone = Object.keys(prev.branches).filter((h) => !(h in next.branches));
    const rid = next.repoIdentityId ?? (gone.length ? await this.repoIdentityId(repoId, orgId, repo) : null);
    if (rid) next.repoIdentityId = rid;
    for (const h of gone) {
      if (!rid) break;
      await this.d.cloud
        .request('DELETE', `/v1/orgs/${enc(orgId)}/footprints/${enc(rid)}/${enc(h)}`)
        .catch((e) => this.fail('delete', e));
    }
    doc.orgs[orgId] = next;
    this.writeState(repoId, doc);
    this.lastError = undefined;
  }

  /** Delete every footprint this machine uploaded (sharing turned off). */
  private async withdrawAll(): Promise<void> {
    const orgId = this.d.cloud.activeOrgId();
    if (!orgId) return;
    for (const svc of this.d.repos.list()) {
      const repoId = svc.repo.id;
      const doc = this.readState(repoId);
      const prev = doc.orgs[orgId];
      if (!prev?.repoIdentityId || !Object.keys(prev.branches).length) continue;
      for (const h of Object.keys(prev.branches)) {
        await this.d.cloud
          .request('DELETE', `/v1/orgs/${enc(orgId)}/footprints/${enc(prev.repoIdentityId)}/${enc(h)}`)
          .catch((e) => this.fail('delete', e));
      }
      doc.orgs[orgId] = { repoIdentityId: prev.repoIdentityId, branches: {} };
      this.writeState(repoId, doc);
      const st = this.repoState(repoId);
      st.theirs = [];
      this.d.onOverlapsChanged(repoId);
    }
  }

  /** Fetch teammates' footprints for a repo (`GET …/footprints?repo=`). */
  async poll(repoId: RepoId): Promise<void> {
    if (!this.isActive()) return;
    this.wasActive = true;
    const orgId = this.d.cloud.activeOrgId()!;
    const repo = await this.identity(repoId);
    const st = this.repoState(repoId);
    st.lastPollAt = this.now();
    if (!repo) return;
    try {
      await this.orgDetail();
      const rid = await this.repoIdentityId(repoId, orgId, repo);
      const theirs = rid
        ? (
            await this.d.cloud.request<Footprint[]>(
              'GET',
              `/v1/orgs/${enc(orgId)}/footprints?repo=${enc(rid)}`,
            )
          ).data
        : [];
      const changed = sig(theirs) !== sig(st.theirs);
      st.theirs = Array.isArray(theirs) ? theirs : [];
      if (changed) this.d.onOverlapsChanged(repoId);
      this.lastError = undefined;
    } catch (e) {
      this.fail('poll', e);
    }
  }

  /** Make sure a repo has been polled once since it was opened (then the 5-min timer takes over). */
  ensurePolled(repoId: RepoId): void {
    if (!this.isActive() || this.repoState(repoId).lastPollAt !== undefined) return;
    void this.poll(repoId);
  }

  /**
   * Overlaps between teammates' footprints and the current branch (+ WIP) against `target`. Pure local
   * work once footprints were polled; [] when inactive.
   */
  async overlaps(repoId: RepoId, headSha: string, target: TeamTarget): Promise<TeammateOverlap[]> {
    if (!this.isActive() || !target.sha) return [];
    const st = this.repoState(repoId);
    if (!st.theirs.length) return [];
    const repo = await this.identity(repoId);
    if (!repo) return [];
    const org = await this.orgDetail();
    const key = `${headSha}:${target.sha}`;
    if (st.own?.key !== key) {
      const svc = this.d.repos.get(repoId);
      st.own = { key, files: await this.ownFiles(svc, target.sha, headSha, !!svc.repo.worktreeRoot) };
    }
    const mine: HashedFile[] = await hashFiles(org.footprintSalt, repo, st.own.files);
    return findOverlaps(mine, st.theirs);
  }

  /** `GET /v1/orgs/:org/team`, filtered to one repo's identity when given. */
  async view(repoId?: RepoId): Promise<TeamViewResult> {
    const status = this.status();
    if (!this.isActive()) return { status, repos: [] };
    const orgId = this.d.cloud.activeOrgId()!;
    await this.orgDetail().catch(() => null);
    const r = await this.d.cloud.request<TeamView>('GET', `/v1/orgs/${enc(orgId)}/team`);
    let repos = r.data?.repos ?? [];
    if (repoId) {
      const id = await this.identity(repoId).catch(() => null);
      const key = id ? repoIdentityKey(id) : null;
      const rid = this.state.get(repoId)?.repoIdentityId;
      repos = repos.filter(
        (x) => (rid && x.repoIdentityId === rid) || (key && repoIdentityKey(x.repo) === key),
      );
    }
    const me = this.d.cloud.me();
    return {
      status: this.status(),
      repos,
      ...(me
        ? { me: { id: me.id, name: me.name, ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}) } }
        : {}),
    };
  }
}
