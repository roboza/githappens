import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EtagStore, HttpClient, ProviderError, RequestGate } from '../src/http';

/** Spec 10 §6.4: budget policy (concurrency cap, serialized mutations, background pause) + ETag LRU. */

const API = 'https://api.example.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RequestGate', () => {
  it('caps concurrency (FIFO) and releases slots', async () => {
    const gate = new RequestGate({ maxConcurrent: 2 });
    const r1 = await gate.acquire({ mutation: false, background: false });
    const r2 = await gate.acquire({ mutation: false, background: false });
    expect(gate.inFlight).toBe(2);
    const order: number[] = [];
    const p3 = gate.acquire({ mutation: false, background: false }).then((r) => (order.push(3), r));
    const p4 = gate.acquire({ mutation: false, background: false }).then((r) => (order.push(4), r));
    await tick();
    expect(order).toEqual([]);
    r1();
    r1(); // idempotent
    await tick();
    expect(order).toEqual([3]);
    r2();
    await tick();
    expect(order).toEqual([3, 4]);
    (await p3)();
    (await p4)();
    expect(gate.inFlight).toBe(0);
  });

  it('serializes mutations but lets reads pass a waiting mutation', async () => {
    const gate = new RequestGate();
    const m1 = await gate.acquire({ mutation: true, background: false });
    const events: string[] = [];
    const m2 = gate.acquire({ mutation: true, background: false }).then((r) => (events.push('m2'), r));
    const read = gate.acquire({ mutation: false, background: false }).then((r) => (events.push('read'), r));
    await tick();
    expect(events).toEqual(['read']);
    m1();
    await tick();
    expect(events).toEqual(['read', 'm2']);
    (await m2)();
    (await read)();
  });

  it('pauses background requests below 10% until the reset, user requests still go', async () => {
    let now = 1_000;
    const gate = new RequestGate({ now: () => now });
    expect(gate.paused()).toBe(false);
    gate.observe({ remaining: 50, limit: 1000, resetAt: 5_000 });
    expect(gate.budget).toEqual({ remaining: 50, limit: 1000, resetAt: 5_000 });
    expect(gate.paused()).toBe(true);
    const err = await gate.acquire({ mutation: false, background: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).serialized).toMatchObject({ code: 'rate_limited', retryAt: 5_000 });
    (await gate.acquire({ mutation: false, background: false }))();
    now = 5_001;
    expect(gate.paused()).toBe(false);
    (await gate.acquire({ mutation: false, background: true }))();
    gate.observe({ remaining: 200, limit: 1000, resetAt: 99_999 });
    expect(gate.paused()).toBe(false);
  });

  it('is fed by HttpClient rate-limit headers and enforces the cap on real requests', async () => {
    let inflight = 0;
    let peak = 0;
    server.use(
      http.get(`${API}/items/:n`, async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await delay(20);
        inflight--;
        return HttpResponse.json(
          { ok: true },
          {
            headers: {
              'x-ratelimit-remaining': '5',
              'x-ratelimit-limit': '100',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
            },
          },
        );
      }),
    );
    const gate = new RequestGate({ maxConcurrent: 4 });
    const seen: number[] = [];
    const user = new HttpClient({ baseUrl: API, gate, onRateLimit: (r) => seen.push(r.remaining) });
    await Promise.all(Array.from({ length: 10 }, (_, i) => user.get(`items/${i}`)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(seen).toHaveLength(10);
    expect(gate.budget?.remaining).toBe(5);
    expect(gate.paused()).toBe(true);
    const poller = new HttpClient({ baseUrl: API, gate, background: true });
    await expect(poller.get('items/1')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(user.get('items/1')).resolves.toEqual({ ok: true });
  });

  it('serializes HttpClient mutations per gate and records 429 as an exhausted budget', async () => {
    let inflight = 0;
    let peak = 0;
    server.use(
      http.post(`${API}/m`, async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await delay(10);
        inflight--;
        return HttpResponse.json({ ok: true });
      }),
      http.get(`${API}/limited`, () =>
        HttpResponse.json({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } }),
      ),
    );
    const gate = new RequestGate();
    const c = new HttpClient({ baseUrl: API, gate, retries: 0 });
    await Promise.all([c.post('m', {}), c.post('m', {}), c.post('m', {})]);
    expect(peak).toBe(1);
    await expect(c.get('limited')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(gate.budget?.remaining).toBe(0);
    expect(gate.paused()).toBe(true);
    expect(gate.inFlight).toBe(0);
  });

  it('releases the slot on network errors and retries', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/flaky`, () => {
        calls++;
        return calls === 1 ? HttpResponse.error() : HttpResponse.json({ ok: 1 });
      }),
    );
    const gate = new RequestGate({ maxConcurrent: 1 });
    const c = new HttpClient({ baseUrl: API, gate, retries: 1 });
    await expect(c.get('flaky')).resolves.toEqual({ ok: 1 });
    expect(gate.inFlight).toBe(0);
  });
});

describe('EtagStore', () => {
  it('evicts the least-recently-used entry', () => {
    const s = new EtagStore(2);
    s.set('a', { etag: '1', data: 'A' });
    s.set('b', { etag: '2', data: 'B' });
    expect(s.get('a')?.data).toBe('A'); // a is now most recent
    s.set('c', { etag: '3', data: 'C' });
    expect(s.size).toBe(2);
    expect(s.get('b')).toBeUndefined();
    expect(s.get('a')?.etag).toBe('1');
    expect(s.get('c')?.etag).toBe('3');
    s.set('a', { etag: '4', data: 'A2' });
    expect(s.size).toBe(2);
    expect(new EtagStore().capacity).toBe(2000);
  });

  it('makes HttpClient GETs conditional and serves cached data on 304', async () => {
    const ifNoneMatch: Array<string | null> = [];
    let version = 1;
    server.use(
      http.get(`${API}/repo`, ({ request }) => {
        const inm = request.headers.get('if-none-match');
        ifNoneMatch.push(inm);
        if (inm === `"v${version}"`) return new HttpResponse(null, { status: 304 });
        return HttpResponse.json({ v: version }, { headers: { etag: `"v${version}"` } });
      }),
    );
    const store = new EtagStore();
    const c = new HttpClient({ baseUrl: API, etagStore: store });
    expect(await c.get('repo', { query: { a: 1 } })).toEqual({ v: 1 });
    const r2 = await c.request<{ v: number }>('repo', { query: { a: 1 } });
    expect(r2).toMatchObject({ status: 304, data: { v: 1 }, notModified: false, etag: '"v1"' });
    version = 2;
    expect(await c.get('repo', { query: { a: 1 } })).toEqual({ v: 2 });
    expect(ifNoneMatch).toEqual([null, '"v1"', '"v1"']);
    expect(store.size).toBe(1);

    // Explicit etag keeps the old contract (notModified, no data, store bypassed).
    const r3 = await c.request('repo', { query: { a: 1 }, etag: '"v2"' });
    expect(r3).toMatchObject({ status: 304, notModified: true, data: undefined, etag: '"v2"' });
  });
});
