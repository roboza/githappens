import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createPatch,
  DAY,
  makeOrg,
  signIn,
  startCloud,
  type Session,
  type TestCloud,
} from './helpers.ts';

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startCloud();
});
afterEach(async () => {
  await cloud.close();
});

const HEAD = 'b'.repeat(40);
const PR = { provider: 'github', host: 'github.com', owner: 'Acme', repo: 'App', prNumber: 42 };

async function suggestionPatch(s: Session, extra: Record<string, unknown> = {}, e2e = true) {
  return createPatch(cloud, s, { kind: 'suggestion', ...extra }, e2e);
}

async function suggest(s: Session, patchId: string, extra: Record<string, unknown> = {}) {
  return call(cloud, 'POST', '/v1/suggestions', {
    token: s.access,
    body: { ...PR, patchId, prHeadSha: HEAD, title: 'Rename helper', ...extra },
  });
}

describe('code suggestions', () => {
  it('create → list by PR (case-insensitive) → get → mark applied', async () => {
    const reviewer = await signIn(cloud, 'rev@example.com', 'Rita');
    const author = await signIn(cloud, 'auth@example.com', 'Arno');
    const { meta } = await suggestionPatch(reviewer);
    const created = await suggest(reviewer, meta.id, {
      coAuthor: { name: 'Rita R', email: 'rita@example.com' },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      patchId: meta.id,
      author: { id: reviewer.userId, name: 'Rita' },
      ...PR,
      prHeadSha: HEAD,
      title: 'Rename helper',
      status: 'open',
      coAuthor: { name: 'Rita R', email: 'rita@example.com' },
      webUrl: `${cloud.url}/p/${meta.id}`,
      deepLink: `githappens://suggestion/${created.json.id}`,
    });
    expect(created.json.author.email).toBeUndefined();

    const list = await call(cloud, 'GET', '/v1/suggestions?provider=github&owner=acme&repo=app&pr=42', {
      token: author.access,
    });
    expect(list.status).toBe(200);
    expect(list.json.map((x: { id: string }) => x.id)).toEqual([created.json.id]);
    // anonymous callers see link suggestions too; other PRs / hosts filter out
    expect(
      (await call(cloud, 'GET', '/v1/suggestions?provider=github&owner=acme&repo=app')).json,
    ).toHaveLength(1);
    expect(
      (await call(cloud, 'GET', '/v1/suggestions?provider=github&owner=acme&repo=app&pr=7')).json,
    ).toHaveLength(0);
    expect(
      (await call(cloud, 'GET', '/v1/suggestions?provider=github&host=ghe.example.com&owner=acme&repo=app'))
        .json,
    ).toHaveLength(0);

    const one = await call(cloud, 'GET', `/v1/suggestions/${created.json.id}`);
    expect(one.status).toBe(200);

    // the PR author (not the suggester) marks it applied; commentId stays author-only
    const applied = await call(cloud, 'PATCH', `/v1/suggestions/${created.json.id}`, {
      token: author.access,
      body: { status: 'applied' },
    });
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ status: 'applied', statusBy: { id: author.userId } });
    expect(
      (
        await call(cloud, 'PATCH', `/v1/suggestions/${created.json.id}`, {
          token: author.access,
          body: { commentId: 'IC_123' },
        })
      ).status,
    ).toBe(403);
    const withComment = await call(cloud, 'PATCH', `/v1/suggestions/${created.json.id}`, {
      token: reviewer.access,
      body: { commentId: 'IC_123', status: 'open' },
    });
    expect(withComment.json).toMatchObject({ commentId: 'IC_123', status: 'open' });
    expect(withComment.json.statusBy).toBeUndefined();
    // anonymous status changes are refused
    expect(
      (await call(cloud, 'PATCH', `/v1/suggestions/${created.json.id}`, { body: { status: 'dismissed' } }))
        .status,
    ).toBe(401);
  });

  it('validates the backing patch', async () => {
    const a = await signIn(cloud, 'a@example.com');
    const b = await signIn(cloud, 'b@example.com');
    const wip = await createPatch(cloud, a); // kind 'wip'
    expect((await suggest(a, wip.meta.id)).status).toBe(422);
    const mine = await suggestionPatch(a);
    expect((await suggest(b, mine.meta.id)).status).toBe(404); // someone else's patch
    expect((await suggest(a, mine.meta.id)).status).toBe(201);
    expect((await suggest(a, mine.meta.id)).status).toBe(409); // one suggestion per patch
    expect((await suggest(a, mine.meta.id, { prHeadSha: 'nope' })).status).toBe(422);
    expect((await suggest(a, mine.meta.id, { prNumber: 0 })).status).toBe(422);
    expect((await suggest(a, mine.meta.id, { owner: '../x' })).status).toBe(422);
    const missing = await call(cloud, 'GET', '/v1/suggestions?provider=github&owner=acme');
    expect(missing.status).toBe(422);
    expect((await call(cloud, 'GET', '/v1/suggestions/not-a-uuid')).status).toBe(404);
  });

  it('read access follows the patch visibility and expiry', async () => {
    const owner = await signIn(cloud, 'owner@example.com');
    const member = await signIn(cloud, 'member@example.com');
    const outsider = await signIn(cloud, 'out@example.com');
    const org = await makeOrg(cloud, owner, [{ s: member }]);
    const orgPatch = await suggestionPatch(owner, { visibility: 'org', orgId: org.id }, false);
    const s1 = await suggest(owner, orgPatch.meta.id);
    expect(s1.status).toBe(201);
    const collab = await suggestionPatch(
      owner,
      { visibility: 'collaborators', orgId: org.id, collaborators: [member.userId] },
      false,
    );
    expect((await suggest(owner, collab.meta.id)).status).toBe(201);

    const q = '/v1/suggestions?provider=github&owner=acme&repo=app&pr=42';
    expect((await call(cloud, 'GET', q, { token: member.access })).json).toHaveLength(2);
    expect((await call(cloud, 'GET', q, { token: outsider.access })).json).toHaveLength(0);
    expect((await call(cloud, 'GET', q)).json).toHaveLength(0);
    expect(
      (await call(cloud, 'GET', `/v1/suggestions/${s1.json.id}`, { token: outsider.access })).status,
    ).toBe(404);
    expect(
      (
        await call(cloud, 'PATCH', `/v1/suggestions/${s1.json.id}`, {
          token: outsider.access,
          body: { status: 'dismissed' },
        })
      ).status,
    ).toBe(404);

    // deleting the patch hides the suggestion; the purge job removes the row with the patch
    expect(
      (await call(cloud, 'DELETE', `/v1/patches/${orgPatch.meta.id}`, { token: owner.access })).status,
    ).toBe(204);
    expect((await call(cloud, 'GET', q, { token: member.access })).json).toHaveLength(1);
    await cloud.app.runJobs();
    expect(await cloud.store.getSuggestion(s1.json.id)).toBeUndefined();

    // expired patches hide their suggestion as well
    const short = await suggestionPatch(owner, { expiresAt: new Date(cloud.clock.now + DAY).toISOString() });
    expect((await suggest(owner, short.meta.id)).status).toBe(201);
    expect((await call(cloud, 'GET', q)).json).toHaveLength(1);
    cloud.clock.now += 2 * DAY;
    expect((await call(cloud, 'GET', q)).json).toHaveLength(0);
  });

  it('are removed with their author', async () => {
    const a = await signIn(cloud, 'gone@example.com');
    const p = await suggestionPatch(a);
    const s = await suggest(a, p.meta.id);
    await cloud.store.purgeUser(a.userId);
    expect(await cloud.store.getSuggestion(s.json.id)).toBeUndefined();
  });
});
