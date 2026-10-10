import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CloudWorkspace, Me } from '@githappens/cloud-api';
import { afterAll, describe, expect, it } from 'vitest';

import { CloudError, type CloudHttp } from '../src/main/cloud/cloud-http';
import { createPatchKeyStore } from '../src/main/cloud/patches';
import { fingerprintOfDer, fingerprintOfPem, ServerTrust } from '../src/main/cloud/server-trust';
import {
  CloudWorkspaceService,
  LaunchpadStateSync,
  mergeLaunchpadItems,
  parseDoc,
  sanitizeRemoteUrl,
  workspaceToDoc,
  type CloudWorkspaceHost,
} from '../src/main/cloud/workspaces';
import { createCloudHandlers } from '../src/main/ipc/cloud-handlers';
import { createCloudWorkspacesHandlers } from '../src/main/ipc/cloud-workspaces-handlers';
import { NetworkService } from '../src/main/network/network-service';
import type { SecretStore } from '../src/main/secrets/secret-store';
import { CLOUD_INVOKE_CHANNELS } from '../src/shared/ipc/cloud-contract';
import { CLOUD_WORKSPACES_INVOKE_CHANNELS } from '../src/shared/ipc/cloud-workspaces-contract';
import type {
  CreateWorkspaceInput,
  NewWorkspaceRepo,
  Workspace,
} from '../src/shared/ipc/workspaces-contract';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cloud-extras-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (): string => {
  const d = path.join(tmp, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const SERVER = 'https://cloud.test';
const ME: Me = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  orgs: [{ id: 'o1', name: 'Org', slug: 'org', role: 'admin' }],
};

/** /v1/workspaces + /v1/launchpad/state + /v1/orgs/:id in memory. */
class FakeCloud implements CloudHttp {
  me_: Me | null = ME;
  readonly ws = new Map<string, CloudWorkspace>();
  launchpad = { version: 0, doc: {} as Record<string, unknown> };
  readonly sent: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> =
    [];
  private seq = 0;
  serverUrl(): string | null {
    return SERVER;
  }
  me(): Me | null {
    return this.me_;
  }
  activeOrgId(): string | null {
    return 'o1';
  }
  onSessionChange(): () => void {
    return () => undefined;
  }
  async upload(): Promise<void> {}
  async download(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async request<T>(
    method: string,
    p: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    this.sent.push({ method, path: p, body: opts.body, headers: opts.headers });
    const ok = (data: unknown) => ({ status: 200, data: structuredClone(data) as T, headers: new Headers() });
    const body = (opts.body ?? {}) as { doc?: Record<string, unknown>; orgId?: string; shares?: never[] };
    const ifMatch = opts.headers?.['if-match'];
    if (p === '/v1/workspaces' && method === 'GET') return ok([...this.ws.values()]);
    if (p === '/v1/workspaces' && method === 'POST') {
      const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
      const w: CloudWorkspace = {
        id,
        ownerUserId: this.me_!.id,
        ...(body.orgId ? { orgId: body.orgId } : {}),
        version: 1,
        doc: body.doc!,
        shares: [],
        updatedAt: new Date().toISOString(),
      };
      this.ws.set(id, w);
      return ok(w);
    }
    const m = /^\/v1\/workspaces\/([0-9a-f-]+)(\/shares)?$/.exec(p);
    if (m) {
      const w = this.ws.get(m[1]!);
      if (!w) throw new CloudError('not_found', 'nope', 404);
      if (method === 'GET') return ok(w);
      if (method === 'DELETE') {
        this.ws.delete(w.id);
        return ok(null);
      }
      if (ifMatch && Number(ifMatch) !== w.version)
        throw new CloudError('precondition_failed', 'version', 412);
      if (m[2]) w.shares = body.shares!;
      else w.doc = body.doc!;
      w.version++;
      return ok(w);
    }
    if (p === '/v1/launchpad/state') {
      if (method === 'GET') return ok(this.launchpad);
      if (Number(ifMatch) !== this.launchpad.version) throw new CloudError('precondition_failed', 'v', 412);
      this.launchpad = { version: this.launchpad.version + 1, doc: body.doc! };
      return ok({ version: this.launchpad.version });
    }
    if (p === '/v1/orgs/o1')
      return ok({
        id: 'o1',
        teams: [{ id: 't1', orgId: 'o1', name: 'Core', memberIds: ['u1', 'u2'] }],
        members: [
          { user: { id: 'u1', name: 'Ada' }, role: 'admin', joinedAt: '' },
          { user: { id: 'u2', name: 'Bob', email: 'bob@example.com' }, role: 'member', joinedAt: '' },
        ],
      });
    throw new CloudError('not_found', `no route ${method} ${p}`, 404);
  }
}

class FakeHost implements CloudWorkspaceHost {
  items: Workspace[] = [];
  bulk: unknown[] = [];
  list(): Workspace[] {
    return this.items;
  }
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const w: Workspace = {
      id: `local-${this.items.length + 1}`,
      kind: input.kind,
      name: input.name,
      order: this.items.length,
      hidden: false,
      repos: (input.repos ?? []).map((r, i) => this.repo(r, i)),
      createdAt: '',
      updatedAt: '',
      ...(input.defaultCloneRoot ? { defaultCloneRoot: input.defaultCloneRoot } : {}),
    };
    this.items.push(w);
    return w;
  }
  private repo(r: NewWorkspaceRepo, i: number) {
    return { id: `r${i}`, name: r.name ?? 'x', addedAt: '', ...r };
  }
  async addRepos(id: string): Promise<Workspace> {
    return this.items.find((w) => w.id === id)!;
  }
  startBulk(req: unknown): { bulkId: string } {
    this.bulk.push(req);
    return { bulkId: 'b1' };
  }
  onDidChange(): () => void {
    return () => undefined;
  }
}

describe('cloud workspace documents', () => {
  it('strip paths and credentials', () => {
    expect(sanitizeRemoteUrl('https://bob:ghp_secret@github.com/acme/app.git?x=1')).toBe(
      'https://github.com/acme/app.git',
    );
    expect(sanitizeRemoteUrl('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git');
    expect(sanitizeRemoteUrl('C:\\repos\\app')).toBeUndefined();
    expect(sanitizeRemoteUrl('file:///srv/app.git')).toBeUndefined();
    const ws: Workspace = {
      id: 'w',
      kind: 'local',
      name: 'Team',
      order: 0,
      hidden: false,
      createdAt: '',
      updatedAt: '',
      defaultCloneRoot: 'C:\\code',
      repos: [
        {
          id: 'a',
          name: 'app',
          addedAt: '',
          localPath: 'C:\\code\\app',
          remoteUrl: 'https://tok@github.com/acme/app.git',
          provider: {
            integrationKey: 'github:github.com:42',
            owner: 'acme',
            name: 'app',
            cloneUrlHttps: '',
            cloneUrlSsh: '',
            webUrl: 'https://github.com/acme/app',
          },
        },
      ],
    };
    const doc = workspaceToDoc(ws);
    expect(JSON.stringify(doc)).not.toMatch(/code|tok@|42/);
    expect(doc.repos[0]).toEqual({
      name: 'app',
      remoteUrl: 'https://github.com/acme/app.git',
      provider: {
        kind: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'app',
        webUrl: 'https://github.com/acme/app',
      },
    });
    expect(
      parseDoc({ name: 'x', repos: [{ name: 'r', remoteUrl: 'https://u:p@h/x.git' }, { bad: 1 }] }),
    ).toEqual({
      format: 'githappens-workspace/1',
      name: 'x',
      repos: [{ name: 'r', remoteUrl: 'https://h/x.git' }],
    });
  });
});

describe('CloudWorkspaceService', () => {
  it('publishes, shares, opens on another computer and clones missing repos', async () => {
    const cloud = new FakeCloud();
    const host = new FakeHost();
    const profile = dir();
    const local = await host.create({
      kind: 'local',
      name: 'Team',
      repos: [
        { name: 'app', localPath: path.join(profile, 'app'), remoteUrl: 'https://github.com/acme/app.git' },
        { name: 'lib', localPath: path.join(profile, 'lib'), remoteUrl: 'https://github.com/acme/lib.git' },
      ],
    });
    const svc = new CloudWorkspaceService({
      cloud,
      workspaces: host,
      integrations: () => [{ key: 'github:github.com:1', kind: 'github', host: 'github.com' }],
      profileDir: () => profile,
    });
    const pub = await svc.publish(local.id);
    expect(pub).toMatchObject({
      name: 'Team',
      mine: true,
      canWrite: true,
      orgId: 'o1',
      localWorkspaceId: local.id,
    });
    expect(JSON.stringify(cloud.sent.at(-1)!.body)).not.toContain(profile.replace(/\\/g, '\\\\'));
    expect((await svc.status(local.id)).localChanged).toBe(false);
    local.name = 'Team 2';
    expect((await svc.status(local.id)).localChanged).toBe(true);
    const again = await svc.publish(local.id);
    expect(again.version).toBe(2);
    expect(cloud.sent.at(-1)!.headers).toEqual({ 'if-match': '1' });

    const targets = await svc.shareTargets();
    expect(targets.teams).toEqual([{ id: 't1', orgId: 'o1', name: 'Core', memberCount: 2 }]);
    expect(targets.members.map((m) => m.id)).toEqual(['u2']);
    const shared = await svc.share(pub.id, [{ principalType: 'team', principalId: 't1' }]);
    expect(shared.shares).toHaveLength(1);
    // the link follows the shares write, so the next publish does not conflict
    expect((await svc.publish(local.id)).version).toBe(4);

    // a concurrent edit elsewhere → 412 surfaces as a conflict
    cloud.ws.get(pub.id)!.version = 99;
    await expect(svc.publish(local.id)).rejects.toMatchObject({ code: 'precondition_failed' });

    // another computer: same account, nothing cloned except `lib`
    const host2 = new FakeHost();
    const profile2 = dir();
    const libClone = path.join(profile2, 'lib');
    fs.mkdirSync(libClone);
    const svc2 = new CloudWorkspaceService({
      cloud,
      workspaces: host2,
      integrations: () => [{ key: 'github:github.com:9', kind: 'github', host: 'github.com' }],
      knownRepos: async () => [{ path: libClone, remotes: ['git@github.com:acme/lib.git'] }],
      profileDir: () => profile2,
    });
    const listed = await svc2.list();
    expect(listed.items.map((i) => i.localWorkspaceId)).toEqual([undefined]);
    const opened = await svc2.open(pub.id, path.join(profile2, 'clones'));
    expect(opened.workspace.kind).toBe('cloud');
    expect(opened.workspace.repos.find((r) => r.name === 'lib')!.localPath).toBe(libClone);
    expect(opened.missing).toHaveLength(1);
    const cloned = svc2.cloneMissing(opened.workspace.id);
    expect(cloned).toEqual({ bulkId: 'b1', count: 1 });
    expect(host2.bulk[0]).toMatchObject({
      op: 'clone',
      options: { cloneRoot: path.join(profile2, 'clones') },
    });
    expect((await svc2.list()).items[0]!.localWorkspaceId).toBe(opened.workspace.id);

    svc2.unlink(opened.workspace.id);
    expect((await svc2.status(opened.workspace.id)).linked).toBeNull();
    await svc.delete(pub.id);
    expect(cloud.ws.size).toBe(0);
  });

  it('handlers cover the contract', () => {
    expect(Object.keys(createCloudWorkspacesHandlers({} as never)).sort()).toEqual(
      [...CLOUD_WORKSPACES_INVOKE_CHANNELS].sort(),
    );
    expect(Object.keys(createCloudHandlers({} as never)).sort()).toEqual([...CLOUD_INVOKE_CHANNELS].sort());
  });
});

describe('Launchpad server state (opt-in)', () => {
  it('3-way merges per key; local wins concurrent edits', () => {
    expect(
      mergeLaunchpadItems(
        { a: 1, b: 1, c: 1 },
        { a: 2, b: 1, d: 1 }, // changed a, deleted c, added d
        { a: 1, b: 3, c: 1, e: 1 }, // changed b, added e
      ),
    ).toEqual({ a: 2, b: 3, d: 1, e: 1 });
    expect(mergeLaunchpadItems({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 });
  });

  it('syncs only when enabled and E2E sync does not already cover it', async () => {
    const cloud = new FakeCloud();
    cloud.launchpad = {
      version: 3,
      doc: { format: 'githappens-launchpad/1', items: { 'v:remote': { id: 'remote', name: 'Remote view' } } },
    };
    let state = {
      itemStates: { x: { uid: 'x', pinnedAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z' } },
      savedViews: [] as Array<{ id: string; name: string }>,
    };
    const launchpad = {
      userState: () => state as never,
      applyUserState: (itemStates: never, savedViews: never) => {
        state = { itemStates, savedViews };
      },
      onUserStateChange: () => () => undefined,
    };
    let enabled = false;
    let covers = false;
    const sync = new LaunchpadStateSync({
      cloud,
      launchpad,
      enabled: () => enabled,
      e2eCovers: () => covers,
      profileDir: dir,
    });
    expect((await sync.syncNow()).lastSyncAt).toBeUndefined();
    enabled = true;
    covers = true;
    expect(await sync.syncNow()).toMatchObject({ enabled: true, coveredByE2eSync: true });
    expect(cloud.sent.filter((s) => s.path === '/v1/launchpad/state')).toHaveLength(0);
    covers = false;
    const st = await sync.syncNow();
    expect(st.error).toBeUndefined();
    expect(st.version).toBe(4);
    expect(Object.keys(cloud.launchpad.doc.items as object).sort()).toEqual(['s:x', 'v:remote']);
    expect(state.savedViews.map((v) => v.id)).toEqual(['remote']);
    expect(JSON.stringify(cloud.launchpad.doc)).not.toContain('lastSeenAt');
  });
});

describe('self-signed server trust', () => {
  const der = Buffer.from('not really a certificate, just DER-ish bytes');
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
  const fp = fingerprintOfDer(der);
  const info = {
    origin: 'https://cloud.local:8443',
    fingerprint256: fp,
    subject: 'cloud.local',
    issuer: 'cloud.local',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
    selfSigned: true,
    trustedBySystem: false,
    error: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    pinned: false,
  };

  it('pins only with explicit consent to the presented certificate, per host', async () => {
    expect(fingerprintOfPem(pem)).toBe(fp);
    let presented = info;
    const trust = new ServerTrust(
      () => path.join(dir(), 'trust.json'),
      async () => presented,
    );
    expect((await trust.inspect('https://cloud.local:8443/x')).pinned).toBe(false);
    await expect(trust.trust('https://cloud.local:8443', 'AA:BB')).rejects.toThrow(/different certificate/);
    await expect(trust.trust('http://cloud.local', fp)).rejects.toThrow(/https/);
    expect((await trust.trust('https://cloud.local:8443', fp.toLowerCase())).pinned).toBe(true);
    const req = { hostname: 'cloud.local', certificate: { data: pem }, errorCode: -202 };
    expect(trust.verify(req)).toBe(true);
    expect(trust.verify({ ...req, hostname: 'evil.example' })).toBe(false);
    const otherPem = `-----BEGIN CERTIFICATE-----
${Buffer.from('another cert').toString('base64')}
-----END CERTIFICATE-----`;
    expect(trust.verify({ ...req, certificate: { data: otherPem } })).toBe(false);
    expect(trust.verify({ ...req, errorCode: 0 })).toBe(false); // Chromium already trusts it: no opinion
    presented = { ...info, fingerprint256: 'FF:FF' };
    expect((await trust.inspect('https://cloud.local:8443')).pinned).toBe(false); // certificate changed
    expect(trust.list()).toHaveLength(1);
    trust.untrust('https://cloud.local:8443/');
    expect(trust.verify(req)).toBe(false);
  });

  it('extends the network verify proc instead of replacing it', async () => {
    const procs: Array<((r: never, cb: (c: number) => void) => void) | null> = [];
    const net = new NetworkService({
      prefs: () =>
        ({
          mode: 'none',
          url: '',
          noProxy: '',
          useOsCertStore: false,
          caBundlePath: '',
          useCredentialHelpers: true,
        }) as never,
      profileId: () => 'p',
      secrets: {} as never,
      setCertificateVerifyProc: (p) => void procs.push(p as never),
    });
    await net.apply();
    expect(procs.at(-1)).toBeNull(); // no bundle, no sources → Chromium default
    const remove = net.addTrustSource((r) => r.hostname === 'cloud.local');
    const proc = procs.at(-1)!;
    const verdict = (hostname: string, errorCode: number): number => {
      let code = NaN;
      proc({ hostname, errorCode, certificate: { data: pem } } as never, (c) => (code = c));
      return code;
    };
    expect(verdict('cloud.local', -202)).toBe(0);
    expect(verdict('other.host', -202)).toBe(-3);
    expect(verdict('cloud.local', 0)).toBe(-3);
    remove();
    expect(procs.at(-1)).toBeNull();
  });
});

describe('persistent e2e keys of own patches', () => {
  it('stores keys per profile and server in the SecretStore', () => {
    const map = new Map<string, string>();
    const secrets = {
      available: true,
      backend: 'test',
      get: (a: string) => map.get(a) ?? null,
      set: (a: string, v: string) => void map.set(a, v),
      delete: (a: string) => map.delete(a),
      deleteByPrefix: () => 0,
      listAccounts: () => [...map.keys()],
    } as SecretStore;
    let server: string | null = SERVER;
    const ks = createPatchKeyStore({ secrets, profileId: () => 'default', serverUrl: () => server });
    ks.set('Patch0001abcdefghijklm', 'key-1');
    expect(ks.get('Patch0001abcdefghijklm')).toBe('key-1');
    expect([...map.keys()][0]).toMatch(/^default\/cloud\/patch-key\/[0-9a-f]{16}\/Patch0001abcdefghijklm$/);
    server = 'https://other.test';
    expect(ks.get('Patch0001abcdefghijklm')).toBeNull();
    server = SERVER;
    ks.delete('Patch0001abcdefghijklm');
    expect(map.size).toBe(0);
    ks.set('../evil', 'x');
    expect(map.size).toBe(0);
  });
});
