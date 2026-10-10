import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  avatarKey,
  avatarUrl,
  AvatarService,
  githubNoreplyAvatar,
  gravatarUrl,
  parseAvatarUrl,
  type FetchLike,
} from '../src/main/avatars/avatar-service';
import {
  AVATAR_SCHEME_PRIVILEGES,
  handleAvatarProtocol,
  registerAvatarScheme,
} from '../src/main/avatars/protocol';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function mockFetch(routes: Record<string, { status: number; type?: string; body?: Buffer | string }>) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1] ?? { status: 404 };
    const body = typeof hit.body === 'string' ? Buffer.from(hit.body) : (hit.body ?? Buffer.alloc(0));
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (hit.type ?? null) : null) },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer,
    };
  };
  return { fn, calls };
}

describe('avatar URL mapping', () => {
  it('maps emails / https URLs to stable hashes and round-trips protocol URLs', () => {
    const k = avatarKey({ email: ' Ann@Example.com ' })!;
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(avatarKey({ email: 'ann@example.com' })).toBe(k);
    expect(avatarKey({ url: 'https://avatars.githubusercontent.com/u/1' })).not.toBe(k);
    expect(avatarKey({ url: 'http://insecure.example/x.png' })).toBeNull();
    expect(avatarKey({ email: 'not-an-email' })).toBeNull();
    const url = avatarUrl(k, 16);
    expect(url).toBe(`githappens-avatar://avatar/${k}?s=16`);
    expect(parseAvatarUrl(url)).toEqual({ key: k, size: 16 });
    expect(parseAvatarUrl('githappens-avatar://avatar/../../etc/passwd')).toBeNull();
    expect(parseAvatarUrl('https://avatar/abc')).toBeNull();
    expect(parseAvatarUrl(`githappens-avatar://avatar/${k}?s=99999`)?.size).toBe(256);
  });

  it('maps GitHub noreply emails and builds sha256 Gravatar URLs', () => {
    expect(githubNoreplyAvatar('12345+octo@users.noreply.github.com', 32)).toBe(
      'https://avatars.githubusercontent.com/u/12345?s=32&v=4',
    );
    expect(githubNoreplyAvatar('octo@users.noreply.github.com', 32)).toBe(
      'https://github.com/octo.png?size=32',
    );
    expect(githubNoreplyAvatar('octo@example.com', 32)).toBeNull();
    expect(gravatarUrl('Ann@Example.com', 64)).toMatch(
      /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/,
    );
  });

  it('declares a standard secure scheme and wires protocol.handle', async () => {
    const registered: unknown[] = [];
    registerAvatarScheme({ registerSchemesAsPrivileged: (s) => registered.push(...s) });
    expect(registered).toEqual([AVATAR_SCHEME_PRIVILEGES]);
    expect(AVATAR_SCHEME_PRIVILEGES.privileges.standard).toBe(true);
    let handler: ((r: Request) => Response | Promise<Response>) | null = null;
    const svc = { handle: async () => new Response('x') } as unknown as AvatarService;
    handleAvatarProtocol(
      { handle: (scheme, h) => ((handler = h), expect(scheme).toBe('githappens-avatar')) },
      svc,
    );
    expect(await (await handler!(new Request('https://x'))).text()).toBe('x');
  });
});

describe('AvatarService cache', () => {
  let dir: string;
  let now = Date.now();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-avatar-'));
    now = Date.now();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (
    fetch: FetchLike,
    useGravatar = true,
    extra: Partial<ConstructorParameters<typeof AvatarService>[0]> = {},
  ) => new AvatarService({ dir, fetch, useGravatar: () => useGravatar, now: () => now, ...extra });

  it('fetches Gravatar once, serves from disk afterwards, and respects the TTL', async () => {
    const { fn, calls } = mockFetch({
      'https://www.gravatar.com/': { status: 200, type: 'image/png', body: PNG },
    });
    const svc = make(fn);
    const [url] = svc.resolve({ items: [{ email: 'ann@example.com' }], size: 16 });
    expect(url).toMatch(/^githappens-avatar:\/\/avatar\/[0-9a-f]{32}\?s=16$/);
    const res = await svc.handle({ url: url! });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('s=32'); // 2× for HiDPI

    // second request: disk cache, no network (also from a fresh service = after restart)
    await svc.handle({ url: url! });
    const svc2 = make(fn);
    expect((await svc2.handle({ url: url! })).status).toBe(200);
    expect(calls).toHaveLength(1);

    // past the TTL: revalidate; on failure the stale file is still served
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.img'))!;
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(dir, file), old, old);
    const { fn: failing, calls: c2 } = mockFetch({});
    const svc3 = make(failing);
    svc3.resolve({ items: [{ email: 'ann@example.com' }], size: 16 });
    expect((await svc3.handle({ url: url! })).status).toBe(200);
    expect(c2).toHaveLength(1);
    svc.dispose();
    svc2.dispose();
    svc3.dispose();
  });

  it('negatively caches 404s for a day, then retries', async () => {
    const { fn, calls } = mockFetch({});
    const svc = make(fn);
    const [url] = svc.resolve({ items: [{ email: 'nobody@example.com' }] });
    expect((await svc.handle({ url: url! })).status).toBe(404);
    expect(calls).toHaveLength(1);
    // known miss: resolve answers null (initials) and the protocol does not refetch
    expect(svc.resolve({ items: [{ email: 'nobody@example.com' }] })).toEqual([null]);
    expect((await svc.handle({ url: url! })).status).toBe(404);
    expect(calls).toHaveLength(1);
    now += 25 * 3600 * 1000;
    expect(svc.resolve({ items: [{ email: 'nobody@example.com' }] })[0]).toBe(url);
    await svc.handle({ url: url! });
    expect(calls).toHaveLength(2);
    svc.dispose();
  });

  it('makes zero network requests when Gravatar is off and no provider applies', async () => {
    const { fn, calls } = mockFetch({ 'https://': { status: 200, type: 'image/png', body: PNG } });
    const svc = make(fn, false);
    expect(svc.resolve({ items: [{ email: 'ann@example.com' }, {}] })).toEqual([null, null]);
    expect(calls).toHaveLength(0);
    // a GitHub noreply address still maps to the GitHub avatar (provider source, not Gravatar)
    const [gh] = svc.resolve({ items: [{ email: '7+octo@users.noreply.github.com' }] });
    expect((await svc.handle({ url: gh! })).status).toBe(200);
    expect(calls).toEqual(['https://avatars.githubusercontent.com/u/7?s=64&v=4']);
    svc.dispose();
  });

  it('asks connected GitLab hosts by email and proxies provider URLs; rejects non-images and big files', async () => {
    const { fn, calls } = mockFetch({
      'https://gitlab.acme.dev/api/v4/avatar': {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ avatar_url: 'https://gitlab.acme.dev/uploads/a.png' }),
      },
      'https://gitlab.acme.dev/uploads/': { status: 200, type: 'image/png', body: PNG },
      'https://cdn.example/html': { status: 200, type: 'text/html', body: '<script>' },
      'https://cdn.example/big': { status: 200, type: 'image/png', body: Buffer.alloc(2048) },
    });
    const svc = make(fn, false, {
      providerHosts: () => [{ kind: 'gitlab', host: 'gitlab.acme.dev' }],
      maxBytes: 1024,
    });
    const [a, b, c] = svc.resolve({
      items: [
        { email: 'dev@acme.dev' },
        { url: 'https://cdn.example/html' },
        { url: 'https://cdn.example/big' },
      ],
    });
    expect((await svc.handle({ url: a! })).status).toBe(200);
    expect(calls.slice(0, 2)).toEqual([
      'https://gitlab.acme.dev/api/v4/avatar?email=dev%40acme.dev&size=64',
      'https://gitlab.acme.dev/uploads/a.png',
    ]);
    expect((await svc.handle({ url: b! })).status).toBe(404);
    expect((await svc.handle({ url: c! })).status).toBe(404);
    expect((await svc.handle({ url: 'githappens-avatar://avatar/zz' })).status).toBe(400);
    svc.dispose();
  });

  it('dedupes concurrent loads and caps concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fn: FetchLike = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) as ArrayBuffer,
      };
    };
    const svc = make(fn, true, { maxConcurrent: 3 });
    const urls = svc.resolve({ items: Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.io` })) });
    const results = await Promise.all([...urls, urls[0]].map((u) => svc.handle({ url: u! })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    svc.dispose();
  });
});
