import { hmacBase64Url, repoIdentityKey, type Footprint, type OrgDetail } from '@githappens/cloud-api';
import { describe, expect, it, vi } from 'vitest';

import type { CloudHttp } from '../src/main/cloud/cloud-http';
import {
  computeFootprint,
  hunkBaseRange,
  parseUnifiedZero,
  unquoteGitPath,
} from '../src/main/cloud/team/footprint';
import { identityFromUrl } from '../src/main/cloud/team/repo-identity';
import { findOverlaps, footprintHash, rangesOverlap, shapeFootprint } from '../src/main/cloud/team/shaping';
import { TeamService } from '../src/main/cloud/team/team-service';
import { gitPath, useTestRepos } from './ai-test-repo';

const SALT = 'c2FsdC1zYWx0LXNhbHQtc2FsdC1zYWx0LXNhbHQtMzI'; // base64url
const REPO = { provider: 'github', host: 'github.com', owner: 'Acme', name: 'Widget' };

describe('unified=0 range parsing', () => {
  it('maps hunk headers to base ranges', () => {
    expect(hunkBaseRange('@@ -10,3 +10,4 @@ fn')).toEqual([10, 12]);
    expect(hunkBaseRange('@@ -7 +7 @@')).toEqual([7, 7]);
    expect(hunkBaseRange('@@ -4,0 +5,2 @@')).toEqual([4, 4]);
    expect(hunkBaseRange('not a hunk')).toBeNull();
  });

  it('parses files, merges ranges, handles added/deleted/binary/quoted paths', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,2 @@',
      '-x',
      '-y',
      '+x',
      '+y',
      '@@ -5 +5 @@',
      '--- not a header',
      '+z',
      '@@ -40,0 +41,1 @@',
      '+new',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      'diff --git a/new file.txt b/new file.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new file.txt',
      '@@ -0,0 +1,2 @@',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/ws.txt b/ws.txt',
      'index 3..4 100644',
      'diff --git "a/t\\303\\251st\\tx" "b/t\\303\\251st\\tx"',
      '--- "a/t\\303\\251st\\tx"',
      '+++ "b/t\\303\\251st\\tx"',
      '@@ -2 +2 @@',
      '',
    ].join('\n');
    expect(parseUnifiedZero(diff)).toEqual([
      {
        path: 'src/a.ts',
        ranges: [
          [3, 5],
          [40, 40],
        ],
      },
      { path: 'gone.txt', ranges: [[1, 4]] },
      { path: 'new file.txt', ranges: [[0, 0]] },
      { path: 'img.png', ranges: [] },
      { path: 'tést\tx', ranges: [[2, 2]] },
    ]);
    expect(unquoteGitPath('plain')).toBe('plain');
  });
});

describe('privacy shaping', () => {
  const files = [{ path: 'src/auth.ts', ranges: [[40, 58]] as [number, number][] }];

  it('hashes match the shared hmacBase64Url and plaintext is omitted by default', async () => {
    const put = await shapeFootprint({
      salt: SALT,
      policies: { footprintSharePaths: false, footprintShareBranchNames: false },
      repo: REPO,
      branch: 'ana/refactor-auth',
      baseRef: 'origin/main',
      headSha: 'abc',
      files,
    });
    const key = repoIdentityKey(REPO);
    expect(put.branchHash).toBe(await hmacBase64Url(SALT, `${key}:ana/refactor-auth`));
    expect(put.files[0]!.pathHash).toBe(await hmacBase64Url(SALT, `${key}:src/auth.ts`));
    expect(put.branchLabel).toBeUndefined();
    expect(put.files[0]!.path).toBeUndefined();
    expect(JSON.stringify(put)).not.toContain('auth.ts');
    expect(JSON.stringify(put)).not.toContain('refactor');
  });

  it('includes plaintext only when the org policy allows', async () => {
    const put = await shapeFootprint({
      salt: SALT,
      policies: { footprintSharePaths: true, footprintShareBranchNames: true },
      repo: REPO,
      branch: 'b',
      baseRef: 'origin/main',
      headSha: 'abc',
      files,
    });
    expect(put.branchLabel).toBe('b');
    expect(put.files[0]!.path).toBe('src/auth.ts');
    const pathsOnly = await shapeFootprint({
      salt: SALT,
      policies: { footprintSharePaths: true, footprintShareBranchNames: false },
      repo: REPO,
      branch: 'b',
      baseRef: 'origin/main',
      headSha: 'abc',
      files,
    });
    expect(pathsOnly.branchLabel).toBeUndefined();
    expect(pathsOnly.files[0]!.path).toBe('src/auth.ts');
  });

  it('caps uploads at 500 files', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ path: `f${i}`, ranges: [] }));
    const put = await shapeFootprint({
      salt: SALT,
      policies: { footprintSharePaths: false, footprintShareBranchNames: false },
      repo: REPO,
      branch: 'b',
      baseRef: 'origin/main',
      headSha: 'abc',
      files: many,
    });
    expect(put.files).toHaveLength(500);
  });
});

describe('overlap detection', () => {
  it('ranges overlap within ±3 lines; empty ranges overlap anything', () => {
    expect(rangesOverlap([[10, 12]], [[15, 20]])).toBe(true);
    expect(rangesOverlap([[10, 12]], [[16, 20]])).toBe(false);
    expect(rangesOverlap([[20, 30]], [[5, 17]])).toBe(true);
    expect(rangesOverlap([[20, 30]], [[5, 16]])).toBe(false);
    expect(rangesOverlap([], [[1, 1]])).toBe(true);
    expect(rangesOverlap([[100, 100]], [])).toBe(true);
  });

  it('matches by pathHash and resolves names from own files', async () => {
    const pathHash = await footprintHash(SALT, REPO, 'src/auth.ts');
    const other = await footprintHash(SALT, REPO, 'src/other.ts');
    const theirs: Footprint[] = [
      {
        user: { id: 'u2', name: 'Ana' },
        repoIdentityId: 'rid',
        branchHash: 'bh',
        branchLabel: 'ana/refactor-auth',
        baseRef: 'origin/main',
        headSha: 'x',
        updatedAt: '2026-10-01T00:00:00Z',
        files: [
          { pathHash, ranges: [[50, 60]] },
          { pathHash: other, ranges: [[1, 2]] },
        ],
      },
    ];
    const mine = [{ path: 'src/auth.ts', pathHash, ranges: [[40, 48]] as [number, number][] }];
    expect(findOverlaps(mine, theirs)).toEqual([
      {
        user: { id: 'u2', name: 'Ana' },
        branchLabel: 'ana/refactor-auth',
        branchHash: 'bh',
        path: 'src/auth.ts',
        pathHash,
        myRanges: [[40, 48]],
        theirRanges: [[50, 60]],
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ]);
    expect(findOverlaps([{ ...mine[0]!, ranges: [[1, 10]] }], theirs)).toEqual([]);
  });

  it('derives provider-independent repo identities from remote URLs', () => {
    expect(identityFromUrl('git@github.com:Acme/Widget.git')).toEqual(REPO);
    expect(identityFromUrl('https://github.com/Acme/Widget')).toEqual(REPO);
    const az1 = identityFromUrl('https://org@dev.azure.com/org/proj/_git/repo');
    const az2 = identityFromUrl('git@ssh.dev.azure.com:v3/org/proj/repo');
    expect(az1).toEqual(az2);
    expect(identityFromUrl('ssh://git@git.example.com:2222/team/sub/app.git')).toEqual({
      provider: 'git',
      host: 'git.example.com',
      owner: 'team/sub',
      name: 'app',
    });
  });
});

// ---- TeamService with a fake CloudHttp ----

function fakeCloud(opts: { configured?: boolean; signedIn?: boolean; org?: string | null } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const theirs: Footprint[] = [];
  const org: OrgDetail = {
    id: 'org1',
    name: 'Acme',
    slug: 'acme',
    policies: {
      patchMaxExpiryDays: null,
      allowPublicLinks: true,
      footprintSharePaths: false,
      footprintShareBranchNames: false,
    },
    footprintSalt: SALT,
    members: [],
    teams: [],
    myRole: 'member',
  };
  const cloud: CloudHttp = {
    serverUrl: () => (opts.configured === false ? null : 'https://cloud.test'),
    me: () =>
      opts.signedIn === false
        ? null
        : {
            id: 'me',
            name: 'Me',
            email: 'me@x.test',
            orgs: [{ id: 'org1', name: 'Acme', slug: 'acme', role: 'member' }],
          },
    activeOrgId: () => (opts.org === undefined ? 'org1' : opts.org),
    request: (async (method: string, p: string, o?: { body?: unknown }) => {
      calls.push({ method, path: p, ...(o?.body ? { body: o.body } : {}) });
      if (method === 'GET' && p === '/v1/orgs/org1')
        return { status: 200, data: org, headers: new Headers() };
      if (method === 'PUT') return { status: 200, data: { repoIdentityId: 'rid1' }, headers: new Headers() };
      if (method === 'GET' && p.startsWith('/v1/orgs/org1/footprints?repo=rid1'))
        return { status: 200, data: theirs, headers: new Headers() };
      if (method === 'GET' && p === '/v1/orgs/org1/team')
        return {
          status: 200,
          data: {
            repos: [
              { repoIdentityId: 'rid1', repo: REPO, members: [] },
              { repoIdentityId: 'rid2', repo: { ...REPO, name: 'other' }, members: [] },
            ],
          },
          headers: new Headers(),
        };
      return { status: 204, data: undefined, headers: new Headers() };
    }) as CloudHttp['request'],
    upload: async () => undefined,
    download: async () => new Uint8Array(),
    onSessionChange: () => () => undefined,
  };
  return { cloud, calls, theirs, org };
}

const d = gitPath ? describe : describe.skip;

d('TeamService', () => {
  const repos = useTestRepos('team');

  async function repoWithBranch() {
    const r = await repos.make({
      'src/auth.ts': Array.from({ length: 80 }, (_, i) => `l${i + 1}`).join('\n') + '\n',
    });
    r.git('remote', 'add', 'origin', 'git@github.com:Acme/Widget.git');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('checkout', '-q', '-b', 'feature/secret-name');
    r.write('src/auth.ts', r.git('show', 'HEAD:src/auth.ts').replace('l45\n', 'l45 changed\n'));
    r.git('commit', '-q', '-am', 'edit');
    await r.svc.refreshRepoInfo();
    return r;
  }

  function team(r: Awaited<ReturnType<typeof repoWithBranch>>, cloud: CloudHttp, enabled = true) {
    const onOverlapsChanged = vi.fn();
    const sha = () => r.git('rev-parse', 'refs/remotes/origin/main').trim();
    const svc = new TeamService({
      repos: { get: () => r.svc, list: () => [r.svc] },
      cloud,
      footprintsEnabled: () => enabled,
      targetFor: async (_id, branch) => (branch === 'main' ? null : { ref: 'origin/main', sha: sha() }),
      onOverlapsChanged,
      uploadDebounceMs: 10,
    });
    return { svc, onOverlapsChanged };
  }

  it('makes zero network calls when footprints are disabled or the cloud is off', async () => {
    const r = await repoWithBranch();
    for (const [c, enabled] of [
      [fakeCloud(), false],
      [fakeCloud({ configured: false }), true],
      [fakeCloud({ signedIn: false }), true],
      [fakeCloud({ org: null }), true],
    ] as const) {
      const { svc } = team(r, c.cloud, enabled);
      svc.onRepoChanged(r.svc.repo.id, ['refs', 'status']);
      await svc.upload(r.svc.repo.id);
      await svc.poll(r.svc.repo.id);
      await svc.tick();
      svc.ensurePolled(r.svc.repo.id);
      expect(await svc.overlaps(r.svc.repo.id, 'x', { ref: 'origin/main', sha: 'y' })).toEqual([]);
      expect((await svc.view(r.svc.repo.id)).repos).toEqual([]);
      await new Promise((res) => setTimeout(res, 30));
      expect(c.calls).toEqual([]);
      expect(svc.status().active).toBe(false);
      svc.dispose();
    }
  });

  it('uploads hashed footprints, skips unchanged bodies and deletes vanished branches', async () => {
    const r = await repoWithBranch();
    const c = fakeCloud();
    const { svc } = team(r, c.cloud);
    await svc.upload(r.svc.repo.id);
    const puts = c.calls.filter((x) => x.method === 'PUT');
    expect(puts).toHaveLength(1);
    const body = puts[0]!.body as {
      branchHash: string;
      branchLabel?: string;
      files: unknown[];
      repo: unknown;
    };
    expect(body.branchLabel).toBeUndefined();
    expect(body.files).toEqual([
      { pathHash: await hmacBase64Url(SALT, `${repoIdentityKey(REPO)}:src/auth.ts`), ranges: [[45, 45]] },
    ]);
    expect(body.repo).toMatchObject(REPO);
    expect(JSON.stringify(c.calls)).not.toContain('secret-name');
    expect(JSON.stringify(c.calls)).not.toContain('auth.ts');

    c.calls.length = 0;
    await svc.upload(r.svc.repo.id);
    expect(c.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);

    // Branch merged into the target → its footprint is deleted.
    r.git('update-ref', 'refs/remotes/origin/main', 'feature/secret-name');
    r.git('checkout', '-q', 'main');
    await svc.upload(r.svc.repo.id);
    expect(c.calls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual([
      `/v1/orgs/org1/footprints/rid1/${encodeURIComponent(body.branchHash)}`,
    ]);
    svc.dispose();
  });

  it('debounces uploads after repo changes', async () => {
    const r = await repoWithBranch();
    const c = fakeCloud();
    const { svc } = team(r, c.cloud);
    svc.onRepoChanged(r.svc.repo.id, ['refs']);
    svc.onRepoChanged(r.svc.repo.id, ['status']);
    await vi.waitFor(() => expect(c.calls.some((x) => x.method === 'PUT')).toBe(true), {
      timeout: 20_000,
    });
    expect(c.calls.filter((x) => x.method === 'PUT')).toHaveLength(1);
    svc.dispose();
  });

  it('polls teammates and reports overlapping ranges for the current branch', async () => {
    const r = await repoWithBranch();
    const c = fakeCloud();
    const { svc, onOverlapsChanged } = team(r, c.cloud);
    await svc.upload(r.svc.repo.id); // learns repoIdentityId
    c.theirs.push({
      user: { id: 'u2', name: 'Ana' },
      repoIdentityId: 'rid1',
      branchHash: 'their-branch',
      baseRef: 'origin/main',
      headSha: 'x',
      updatedAt: '2026-10-01T00:00:00Z',
      files: [{ pathHash: await footprintHash(SALT, REPO, 'src/auth.ts'), ranges: [[47, 50]] }],
    });
    await svc.poll(r.svc.repo.id);
    expect(c.calls.some((x) => x.path === '/v1/orgs/org1/footprints?repo=rid1')).toBe(true);
    expect(onOverlapsChanged).toHaveBeenCalledWith(r.svc.repo.id);
    const head = r.git('rev-parse', 'HEAD').trim();
    const target = { ref: 'origin/main', sha: r.git('rev-parse', 'refs/remotes/origin/main').trim() };
    const overlaps = await svc.overlaps(r.svc.repo.id, head, target);
    expect(overlaps).toMatchObject([
      { path: 'src/auth.ts', myRanges: [[45, 45]], theirRanges: [[47, 50]], user: { name: 'Ana' } },
    ]);

    const view = await svc.view(r.svc.repo.id);
    expect(view.repos.map((x) => x.repoIdentityId)).toEqual(['rid1']);
    expect(view.status).toMatchObject({ active: true, orgName: 'Acme' });
    svc.dispose();
  });

  it('computes WIP footprints including untracked files', async () => {
    const r = await repoWithBranch();
    r.write('notes.md', 'x\n');
    const fp = await computeFootprint(r.svc, r.git('rev-parse', 'refs/remotes/origin/main').trim(), null);
    expect(fp.files).toEqual([
      { path: 'notes.md', ranges: [] },
      { path: 'src/auth.ts', ranges: [[45, 45]] },
    ]);
  });
});
