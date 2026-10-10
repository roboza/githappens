import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isEncryptedBlob,
  sha256Hex,
  type Me,
  type OrgDetail,
  type PatchCreate,
  type PatchMeta,
  type RepoIdentity,
} from '@githappens/cloud-api';
import { createOpRegistry, OperationQueue, type GitService, type RepoId } from '@githappens/git';
import { afterAll, describe, expect, it } from 'vitest';

import { CloudError, type CloudHttp } from '../src/main/cloud/cloud-http';
import { PatchService, summarizePatch } from '../src/main/cloud/patches';
import { toPatchError } from '../src/main/ipc/patches-handlers';
import type { OpenedPatch, PatchOpenRes } from '../src/shared/ipc/patches-contract';
import { gitPath, useTestRepos, type TestRepo } from './ai-test-repo';

const SERVER = 'https://cloud.test';
const ME: Me = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  orgs: [{ id: 'o1', name: 'Org', slug: 'org', role: 'owner' }],
};

/** In-memory GitHappens Cloud (spec 14 §5.3 patch routes) behind the CloudHttp interface. */
class FakeCloud implements CloudHttp {
  me_: Me | null = ME;
  server: string | null = SERVER;
  maxBytes = 25 * 1024 * 1024;
  readonly metas = new Map<string, PatchMeta & { complete: boolean }>();
  readonly blobs = new Map<string, Uint8Array>();
  /** Everything sent to the server (request bodies + URLs), to check the key never leaves. */
  readonly sent: string[] = [];
  private seq = 0;

  serverUrl(): string | null {
    return this.server;
  }
  me(): Me | null {
    return this.me_;
  }
  activeOrgId(): string | null {
    return this.me_ ? 'o1' : null;
  }
  onSessionChange(): () => void {
    return () => undefined;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    p: string,
    opts: { body?: unknown; auth?: boolean | 'optional' } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    this.sent.push(`${method} ${p} ${JSON.stringify(opts.body ?? null)}`);
    const ok = (data: unknown, status = 200) => ({ status, data: data as T, headers: new Headers() });
    const authed = opts.auth === false ? false : !!this.me_;
    if (opts.auth !== false && opts.auth !== 'optional' && !this.me_)
      throw new CloudError('unauthorized', 'no');
    if (p === '/.well-known/githappens-cloud')
      return ok({
        name: 'test',
        version: '1',
        idps: ['dev'],
        limits: { patchMaxBytes: this.maxBytes, patchMaxExpiryDays: null },
      });
    if (method === 'POST' && p === '/v1/patches') {
      const b = opts.body as PatchCreate;
      const id = `Patch${String(++this.seq).padStart(4, '0')}abcdefghijklm`;
      this.metas.set(id, {
        id,
        title: b.title,
        ...(b.description ? { description: b.description } : {}),
        kind: b.kind,
        author: { id: this.me_!.id, name: this.me_!.name },
        ...(b.orgId ? { orgId: b.orgId } : {}),
        ...(b.repo ? { repo: b.repo } : {}),
        baseSha: b.baseSha,
        ...(b.files ? { files: b.files } : {}),
        e2e: b.e2e,
        size: b.size,
        sha256: b.sha256,
        visibility: b.visibility,
        createdAt: new Date(Date.now() + this.seq).toISOString(),
        ...(b.expiresAt ? { expiresAt: b.expiresAt } : {}),
        webUrl: `${SERVER}/p/${id}`,
        complete: false,
      });
      return ok({ id, uploadUrl: `${SERVER}/upload/${id}`, webUrl: `${SERVER}/p/${id}` });
    }
    const m = /^\/v1\/patches\/([A-Za-z0-9]+)(\/complete)?$/.exec(p);
    if (m) {
      const meta = this.metas.get(m[1]!);
      if (!meta) throw new CloudError('not_found', 'not found', 404);
      if (m[2]) {
        const blob = this.blobs.get(meta.id)!;
        if (blob.length !== meta.size || (await sha256Hex(blob)) !== meta.sha256)
          throw new CloudError('validation', 'bad blob', 422);
        meta.complete = true;
        return ok(this.pub(meta));
      }
      if (method === 'GET') {
        if (meta.visibility !== 'link' && !authed) throw new CloudError('unauthorized', 'sign in', 401);
        return ok({ ...this.pub(meta), downloadUrl: `${SERVER}/blob/${meta.id}` });
      }
      if (method === 'DELETE') {
        this.metas.delete(meta.id);
        return ok(null, 204);
      }
      if (method === 'PATCH') {
        Object.assign(meta, opts.body);
        return ok(this.pub(meta));
      }
    }
    if (method === 'GET' && p.startsWith('/v1/patches?')) {
      const q = new URLSearchParams(p.split('?')[1]);
      const items = [...this.metas.values()]
        .filter((x) => x.complete && (q.get('scope') === 'mine') === (x.author.id === this.me_?.id))
        .map((x) => this.pub(x));
      return ok({ items });
    }
    if (method === 'GET' && p === '/v1/orgs/o1') {
      const org: Partial<OrgDetail> = {
        id: 'o1',
        members: [
          { user: { id: 'u1', name: 'Ada' }, role: 'owner', joinedAt: '' },
          { user: { id: 'u2', name: 'Bob' }, role: 'member', joinedAt: '' },
        ],
      };
      return ok(org);
    }
    throw new CloudError('not_found', `no route ${method} ${p}`, 404);
  }

  private pub(m: PatchMeta & { complete: boolean }): PatchMeta {
    const { complete: _c, ...meta } = m;
    void _c;
    return meta;
  }

  async upload(url: string, bytes: Uint8Array): Promise<void> {
    this.sent.push(`PUT ${url} <${bytes.length} bytes>`);
    this.blobs.set(url.split('/').pop()!, bytes);
  }

  async download(url: string): Promise<Uint8Array> {
    const blob = /\/blob\/([A-Za-z0-9]+)$/.exec(url);
    if (blob) {
      const b = this.blobs.get(blob[1]!);
      if (!b) throw new CloudError('gone', 'gone', 410);
      return b;
    }
    // anonymous metadata from "another server" (same in-memory store)
    const meta = /^https:\/\/other\.test\/v1\/patches\/([A-Za-z0-9]+)$/.exec(url);
    if (meta) {
      const r = await this.request<unknown>('GET', `/v1/patches/${meta[1]}`, { auth: false });
      return new TextEncoder().encode(JSON.stringify(r.data));
    }
    throw new CloudError('network', `unreachable ${url}`);
  }
}

const describeGit = gitPath ? describe : describe.skip;

describeGit('Cloud Patches: PatchService (spec 14 §6.3)', () => {
  const repos = useTestRepos('cloudpatch');
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-patch-cache-'));
  afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  let n = 0;

  function makeService(
    cloud: FakeCloud,
    open: TestRepo[],
    identities: Record<RepoId, RepoIdentity | undefined> = {},
  ): PatchService {
    const byId = new Map<RepoId, GitService>(open.map((r) => [r.svc.repo.id, r.svc]));
    const registry = createOpRegistry();
    const cache = path.join(cacheRoot, `c${++n}`);
    return new PatchService({
      cloud,
      repos: {
        get: (id) => {
          const s = byId.get(id);
          if (!s) throw new Error('not open');
          return s;
        },
        list: () => [...byId.values()],
        runOp: (id, op) => new OperationQueue(byId.get(id)!, registry).enqueue(op).done,
      },
      resolveRepoIdentity: async (id) => identities[id],
      appVersion: '0.0.0-test',
      cacheDir: () => cache,
    });
  }

  /** Staged entries (blob ids, modes, stages): must be identical before and after building a patch. */
  function indexState(r: TestRepo): string {
    const leftovers = fs
      .readdirSync(path.join(r.dir, '.git'), { recursive: true })
      .filter((f) => String(f).includes('patch-index-'));
    expect(leftovers).toEqual([]);
    return r.git('ls-files', '--stage', '-z');
  }

  async function opened(svc: PatchService, url: string, allowOtherServer = false): Promise<OpenedPatch> {
    const r: PatchOpenRes = await svc.open(url, allowOtherServer);
    if (r.status !== 'opened') throw new Error(`unexpected ${r.status}`);
    return r.opened;
  }

  async function dirtyRepo(): Promise<TestRepo> {
    const r = await repos.make({ 'a.txt': 'one\ntwo\n', 'b.txt': 'bee\n' });
    r.write('a.txt', 'one\nTWO\n'); // staged below
    r.git('add', 'a.txt');
    r.write('b.txt', 'BEE\n'); // unstaged
    r.write('new/untracked.txt', 'fresh\n'); // untracked
    fs.writeFileSync(path.join(r.dir, 'img.bin'), Buffer.from([0, 1, 2, 255, 0, 9]));
    return r;
  }

  it('shares staged-only WIP as a plain patch without touching the index', async () => {
    const r = await dirtyRepo();
    const cloud = new FakeCloud();
    const svc = makeService(cloud, [r]);
    const before = indexState(r);
    const res = await svc.create({
      repoId: r.svc.repo.id,
      source: { kind: 'wip', stagedOnly: true },
      title: 'Staged',
      visibility: 'link',
      e2e: false,
    });
    expect(indexState(r)).toBe(before);
    expect(res.shareUrl).toBe(`${SERVER}/p/${res.patch.id}`);
    expect(res.deepLink).toBe(`githappens://patch/${res.patch.id}`);
    const body = JSON.parse(
      cloud.sent
        .find((s) => s.startsWith('POST /v1/patches '))!
        .split(' ')
        .slice(2)
        .join(' '),
    ) as PatchCreate;
    expect(body).toMatchObject({
      title: 'Staged',
      e2e: false,
      kind: 'wip',
      baseSha: r.git('rev-parse', 'HEAD').trim(),
    });
    expect(body.files?.map((f) => f.path)).toEqual(['a.txt']);
    expect(isEncryptedBlob(cloud.blobs.get(res.patch.id)!)).toBe(false);

    // another machine: anonymous open of a link patch
    const o = await opened(makeService(cloudAnon(cloud), []), res.shareUrl);
    expect(o.bundle.patch).toContain('+TWO');
    expect(o.bundle.patch).not.toContain('BEE');
    expect(o.diff.map((f) => f.newPath)).toEqual(['a.txt']);
  });

  it('shares all WIP incl. untracked + binary end-to-end encrypted; the key never reaches the server', async () => {
    const r = await dirtyRepo();
    const cloud = new FakeCloud();
    const svc = makeService(cloud, [r]);
    const before = indexState(r);
    const res = await svc.create({
      repoId: r.svc.repo.id,
      source: { kind: 'wip', stagedOnly: false },
      title: 'Everything',
      description: 'secret notes',
      visibility: 'link',
    });
    expect(indexState(r)).toBe(before);
    const key = /#k=(.+)$/.exec(res.shareUrl)![1]!;
    expect(key.length).toBeGreaterThan(20);
    expect(res.deepLink).toBe(`githappens://patch/${res.patch.id}#k=${key}`);
    expect(cloud.sent.join('\n')).not.toContain(key);
    expect(cloud.sent.join('\n')).not.toContain('secret notes');
    const body = JSON.parse(
      cloud.sent
        .find((s) => s.startsWith('POST /v1/patches '))!
        .split(' ')
        .slice(2)
        .join(' '),
    ) as PatchCreate;
    expect(body).toMatchObject({ title: 'Encrypted patch', e2e: true });
    expect(body.files).toBeUndefined();
    expect(isEncryptedBlob(cloud.blobs.get(res.patch.id)!)).toBe(true);
    expect(res.patch.localTitle).toBe('Everything');

    const anon = makeService(cloudAnon(cloud), []);
    await expect(anon.open(`${SERVER}/p/${res.patch.id}`)).rejects.toMatchObject({ code: 'needs-key' });
    expect(
      (toPatchError(await anon.open(`${SERVER}/p/${res.patch.id}`).catch((e: unknown) => e)) as Error)
        .message,
    ).toMatch(/encrypted/);
    const o = await opened(anon, res.shareUrl);
    expect(o.bundle.title).toBe('Everything');
    expect(o.bundle.description).toBe('secret notes');
    expect(o.bundle.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'b.txt',
      'img.bin',
      'new/untracked.txt',
    ]);
    expect(o.bundle.files.find((f) => f.path === 'img.bin')).toMatchObject({ status: 'A', binary: true });
    expect(o.bundle.patch).toContain('GIT binary patch');
  });

  it('shares a commit (format-patch) and a stash incl. untracked files', async () => {
    const r = await repos.make({ 'a.txt': 'one\n' });
    r.write('a.txt', 'one\ntwo\n');
    r.git('commit', '-qam', 'Add two');
    const sha = r.git('rev-parse', 'HEAD').trim();
    const cloud = new FakeCloud();
    const svc = makeService(cloud, [r]);
    const c = await svc.create({
      repoId: r.svc.repo.id,
      source: { kind: 'commit', sha },
      title: 'Add two',
      visibility: 'org',
      e2e: false,
    });
    expect(c.patch).toMatchObject({
      kind: 'commit',
      baseSha: r.git('rev-parse', 'HEAD^').trim(),
      orgId: 'o1',
    });
    const oc = await opened(makeService(cloud, []), c.shareUrl);
    expect(oc.bundle.patch).toMatch(/^Subject: \[PATCH\] Add two$/m);
    expect(oc.bundle.files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }]);

    r.write('a.txt', 'stashed\n');
    r.write('u.txt', 'untracked\n');
    r.git('stash', 'push', '-u', '-m', 'my stash');
    const stash = r.git('rev-parse', 'stash@{0}').trim();
    const draft = await svc.preview(r.svc.repo.id, { kind: 'stash', ref: stash });
    expect(draft).toMatchObject({ kind: 'stash', title: 'my stash', baseSha: sha });
    expect(draft.files.map((f) => f.path).sort()).toEqual(['a.txt', 'u.txt']);
  });

  it('verifies the blob checksum and refuses patches over the server limit', async () => {
    const r = await dirtyRepo();
    const cloud = new FakeCloud();
    const svc = makeService(cloud, [r]);
    const res = await svc.create({
      repoId: r.svc.repo.id,
      source: { kind: 'wip', stagedOnly: true },
      title: 'x',
      visibility: 'link',
      e2e: false,
    });
    const blob = cloud.blobs.get(res.patch.id)!;
    cloud.blobs.set(
      res.patch.id,
      Uint8Array.from(blob, (b, i) => (i === blob.length - 1 ? b ^ 1 : b)),
    );
    await expect(makeService(cloud, []).open(res.shareUrl)).rejects.toThrow(/checksum/);

    cloud.maxBytes = 10;
    await expect(
      makeService(cloud, [r]).create({
        repoId: r.svc.repo.id,
        source: { kind: 'wip', stagedOnly: true },
        title: 'x',
        visibility: 'link',
      }),
    ).rejects.toThrow(/too large/);
  });

  it('flags links to another server, opens them anonymously when allowed', async () => {
    const r = await dirtyRepo();
    const cloud = new FakeCloud();
    const res = await makeService(cloud, [r]).create({
      repoId: r.svc.repo.id,
      source: { kind: 'wip', stagedOnly: true },
      title: 'x',
      visibility: 'link',
    });
    const otherUrl = res.shareUrl.replace(SERVER, 'https://other.test');
    const svc = makeService(cloud, []);
    expect(await svc.open(otherUrl)).toEqual({
      status: 'server-mismatch',
      linkServer: 'https://other.test',
      configuredServer: SERVER,
    });
    const o = await opened(svc, otherUrl, true);
    expect(o.bundle.title).toBe('x');
    await expect(svc.open('https://example.com/not-a-patch')).rejects.toThrow(/not a Cloud Patch link/);
  });

  it('matches local repos by remote identity or root commit and applies to a new branch', async () => {
    const a = await repos.make({ 'f.txt': 'base\n' });
    const base = a.git('rev-parse', 'HEAD').trim();
    a.write('f.txt', 'base\nshared change\n');
    const b = await repos.make({ 'other.txt': 'x\n' }); // becomes a clone of a
    b.git('remote', 'add', 'origin', a.dir);
    b.git('fetch', '-q', 'origin');
    b.git('reset', '-q', '--hard', 'origin/main');
    const unrelated = await repos.make({ 'z.txt': 'z\n' });
    const idA: RepoIdentity = { provider: 'github', host: 'github.com', owner: 'acme', name: 'app' };
    const cloud = new FakeCloud();
    const res = await makeService(cloud, [a], { [a.svc.repo.id]: idA }).create({
      repoId: a.svc.repo.id,
      source: { kind: 'wip', stagedOnly: false },
      title: 'Shared change',
      visibility: 'link',
    });
    expect(res.patch.repo).toMatchObject({ ...idA, initialCommitSha: base });

    // recipient: b is a fork (different remote identity, same root commit); unrelated doesn't match
    const recipient = makeService(cloud, [b, unrelated], {
      [b.svc.repo.id]: { provider: 'github', host: 'github.com', owner: 'me', name: 'app-fork' },
    });
    const o = await opened(recipient, res.shareUrl);
    expect(o.localMatch.candidates).toEqual([
      expect.objectContaining({ repoId: b.svc.repo.id, match: 'root-commit', baseAvailable: true }),
    ]);
    expect(o.localMatch.repoId).toBe(b.svc.repo.id);
    const check = await recipient.checkRepo(res.patch.id, unrelated.svc.repo.id);
    expect(check).toMatchObject({ match: 'chosen', baseAvailable: false });

    const applied = await recipient.apply({
      patchId: res.patch.id,
      repoId: b.svc.repo.id,
      target: { kind: 'new-branch', name: 'cloud/shared' },
      commit: true,
    });
    expect(applied).toMatchObject({ applied: true, conflicts: [], branch: 'cloud/shared' });
    expect(b.git('log', '-1', '--format=%s').trim()).toBe('Shared change');
    expect(b.git('rev-parse', 'HEAD^').trim()).toBe(base);
    expect(fs.readFileSync(path.join(b.dir, 'f.txt'), 'utf8')).toBe('base\nshared change\n');
  });

  it('lists created patches (offline from the local cache) and deletes them', async () => {
    const r = await dirtyRepo();
    const cloud = new FakeCloud();
    const svc = makeService(cloud, [r]);
    const res = await svc.create({
      repoId: r.svc.repo.id,
      source: { kind: 'wip', stagedOnly: true },
      title: 'Mine',
      visibility: 'link',
    });
    const mine = await svc.list({ scope: 'mine' });
    expect(mine.items.map((p) => [p.id, p.mine, p.hasKey, p.localTitle])).toEqual([
      [res.patch.id, true, true, 'Mine'],
    ]);
    expect((await svc.list({ scope: 'shared' })).items).toEqual([]);
    const realRequest = cloud.request.bind(cloud);
    cloud.request = (async () => {
      throw new CloudError('network', 'offline');
    }) as typeof cloud.request;
    const offline = await svc.list({ scope: 'mine' });
    expect(offline.offline).toBe(true);
    expect(offline.items.map((p) => p.id)).toEqual([res.patch.id]);
    // the cache holds metadata only, never the key
    const cacheText = fs.readdirSync(cacheRoot).map((d) => {
      const f = path.join(cacheRoot, d, 'cloud-patches.json');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    });
    expect(cacheText.join('')).not.toContain(/#k=(.+)$/.exec(res.shareUrl)![1]!);
    cloud.request = realRequest;
    expect((await svc.collaboratorCandidates()).members).toEqual([{ id: 'u2', name: 'Bob' }]);
    await svc.delete(res.patch.id);
    expect((await svc.list({ scope: 'mine' })).items).toEqual([]);
  });

  it('summarizes renames, deletions and format-patch signatures', () => {
    const text = [
      'From 123 Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH] x',
      '',
      '---',
      'diff --git a/old.txt b/new.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to new.txt',
      'index 1..2 100644',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-- gone',
      '+-- added',
      'diff --git a/d.txt b/d.txt',
      'deleted file mode 100644',
      '--- a/d.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '-- ',
      '2.47.0',
      '',
    ].join('\n');
    expect(summarizePatch(text).files).toEqual([
      { path: 'new.txt', status: 'R', additions: 1, deletions: 1 },
      { path: 'd.txt', status: 'D', additions: 0, deletions: 1 },
    ]);
  });
});

/** Same server state, but a signed-out client (recipient without an account). */
function cloudAnon(cloud: FakeCloud): FakeCloud {
  const anon = Object.create(cloud) as FakeCloud;
  anon.me_ = null;
  return anon;
}
