import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Me, SyncItem } from '@githappens/cloud-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SyncDataCategory } from '../src/shared/ipc/cloud-contract';
import { CloudError } from '../src/main/cloud/cloud-http';
import type { SyncSource } from '../src/main/cloud/sync/adapters';
import { merge3, sameItems, type SyncItems } from '../src/main/cloud/sync/merge';
import { SyncEngine, type SyncHttp } from '../src/main/cloud/sync/sync-engine';
import type { SecretStore } from '../src/main/secrets/secret-store';

const e = (v: unknown, at: number) => ({ v, at });
const del = (at: number) => ({ del: true as const, at });

describe('merge3', () => {
  it('takes one-sided changes and keeps unchanged keys', () => {
    const base: SyncItems = { a: e(1, 1), b: e(1, 1), c: e(1, 1) };
    const local: SyncItems = { a: e(2, 5), b: e(1, 1), c: e(1, 1), d: e('new', 6) };
    const remote: SyncItems = { a: e(1, 1), b: e(3, 7), c: del(8) };
    const { merged, conflicts } = merge3(base, local, remote, 'lww');
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: e(2, 5), b: e(3, 7), c: del(8), d: e('new', 6) });
  });

  it('per-key last writer wins for concurrent edits (ties → remote)', () => {
    const base: SyncItems = { a: e(1, 1), b: e(1, 1) };
    const local: SyncItems = { a: e('L', 10), b: e('L', 3) };
    const remote: SyncItems = { a: e('R', 9), b: e('R', 4) };
    expect(merge3(base, local, remote, 'lww').merged).toEqual({ a: e('L', 10), b: e('R', 4) });
    // First join: everything stamped 0 → synced value wins.
    expect(merge3({}, { a: e('L', 0) }, { a: e('R', 0) }, 'lww').merged).toEqual({ a: e('R', 0) });
    // Deletion vs edit uses the stamps too.
    expect(merge3(base, { a: del(20), b: e(1, 1) }, { a: e('R', 9), b: e(1, 1) }, 'lww').merged.a).toEqual(
      del(20),
    );
  });

  it('strict categories report conflicts unless a side is preferred', () => {
    const base: SyncItems = { t: e('x', 1), u: e('x', 1) };
    const local: SyncItems = { t: e('L', 5), u: e('x', 1) };
    const remote: SyncItems = { t: e('R', 6), u: e('y', 2) };
    const r = merge3(base, local, remote, 'strict');
    expect(r.conflicts).toEqual(['t']);
    expect(r.merged.u).toEqual(e('y', 2));
    expect(merge3(base, local, remote, 'strict', 'local')).toEqual({
      merged: { t: e('L', 5), u: e('y', 2) },
      conflicts: [],
    });
    expect(merge3(base, local, remote, 'strict', 'remote').merged.t).toEqual(e('R', 6));
  });

  it('treats tombstones and missing keys alike', () => {
    expect(sameItems({ a: del(3) }, {})).toBe(true);
    expect(sameItems({ a: e(1, 3) }, { a: e(1, 9) })).toBe(true);
    expect(sameItems({ a: e(1, 3) }, { a: e(2, 3) })).toBe(false);
  });
});

// ---- engine against an in-memory sync server -------------------------------------------------------

class FakeSyncServer {
  items = new Map<string, SyncItem>();
  puts: string[] = [];
  /** Hook run before a PUT is applied (simulate a concurrent writer). */
  beforePut: ((category: string) => void) | null = null;

  async handle(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const m = /^\/v1\/sync(?:\/([a-z_][a-z0-9-]*))?$/.exec(url);
    if (!m) throw new CloudError('not_found', url, 404);
    const cat = m[1];
    if (!cat && method === 'GET') {
      return [...this.items.values()].map(({ ciphertext: _c, nonce: _n, ...info }) => info);
    }
    if (!cat && method === 'DELETE') {
      this.items.clear();
      return undefined;
    }
    if (cat && method === 'GET') {
      const it = this.items.get(cat);
      if (!it) throw new CloudError('not_found', 'none', 404);
      return it;
    }
    if (cat && method === 'PUT') {
      this.beforePut?.(cat);
      const cur = this.items.get(cat)?.version ?? 0;
      if (Number(opts.headers?.['If-Match']) !== cur) {
        throw new CloudError('precondition_failed', 'stale', 412, {
          error: 'precondition_failed',
          message: 'stale',
          currentVersion: cur,
        });
      }
      const body = opts.body as { ciphertext: string; nonce: string; deviceId: string };
      const next: SyncItem = {
        category: cat,
        version: cur + 1,
        updatedAt: new Date().toISOString(),
        size: body.ciphertext.length,
        deviceId: body.deviceId,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
      };
      this.items.set(cat, next);
      this.puts.push(cat);
      return { version: next.version };
    }
    throw new CloudError('validation', 'unsupported', 400);
  }
}

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    available: true,
    backend: 'memory',
    get: (a) => map.get(a) ?? null,
    set: (a, s) => void map.set(a, s),
    delete: (a) => map.delete(a),
    deleteByPrefix: () => 0,
    listAccounts: () => [...map.keys()],
  };
}

type MemSource = SyncSource & { data: Record<string, unknown>; set(k: string, v: unknown): void };

function memSource(
  category: SyncDataCategory,
  strategy: 'lww' | 'strict',
  data: Record<string, unknown>,
): MemSource {
  const listeners = new Set<() => void>();
  const src: MemSource = {
    category,
    strategy,
    schema: 1,
    data: { ...data },
    read: async () => structuredClone(src.data),
    write: async (d) => {
      src.data = structuredClone(d);
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(k, v) {
      if (v === undefined) delete src.data[k];
      else src.data[k] = v;
      for (const l of listeners) l();
    },
  };
  return src;
}

const ME: Me = { id: 'user-1', name: 'Ada', email: 'a@x.y', orgs: [] };
const FAST = { alg: 'scrypt', N: 1024, r: 8, p: 1 } as const;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sync-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function machine(
  server: FakeSyncServer,
  name: string,
  prefs: Record<string, unknown>,
  themes: Record<string, unknown> = {},
) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  let clock = 1000;
  const settings: Record<string, unknown> = { 'sync.enabled': true };
  const http: SyncHttp = {
    serverUrl: () => 'https://cloud.test',
    me: () => ME,
    onSessionChange: () => () => undefined,
    sessionSecretAccount: (s) => `p/cloud/https://cloud.test|user-1|${s}`,
    request: async <T>(
      method: string,
      url: string,
      opts?: { body?: unknown; headers?: Record<string, string> },
    ) => ({
      status: 200,
      data: (await server.handle(method, url, opts)) as T,
      headers: new Headers(),
    }),
  };
  const preferences = memSource('preferences', 'lww', prefs);
  const themeSrc = memSource('themes', 'strict', themes);
  const statuses: unknown[] = [];
  const engine = new SyncEngine({
    http,
    secrets: memorySecrets(),
    sources: [preferences, themeSrc],
    settings: { get: (k) => settings[k], set: (k, v) => void (settings[k] = v) },
    profileDir: () => dir,
    onStatus: (s) => statuses.push(s),
    now: () => clock,
    kdf: FAST,
    pushDebounceMs: 1,
  });
  return {
    engine,
    preferences,
    themes: themeSrc,
    settings,
    tick: (ms: number) => (clock += ms),
    statuses,
  };
}

const settle = async (m: { engine: SyncEngine }): Promise<void> => {
  await new Promise((r) => setTimeout(r, 15));
  await m.engine.idle();
};

describe('SyncEngine', () => {
  it('sets up keys, uploads only ciphertext and lets a second machine unlock and merge', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', { 'ui.zoom': 1.25, 'editor.tabSize': 2 });
    a.engine.start();
    await a.engine.idle();
    expect(a.engine.status()).toMatchObject({ keyState: 'missing', state: 'locked' });

    const { recoveryKey } = await a.engine.setupPassphrase('correct horse battery');
    expect(recoveryKey).toBeTruthy();
    await a.engine.idle();
    expect(a.engine.status()).toMatchObject({ keyState: 'unlocked', state: 'idle', hasRecoveryKey: true });
    expect(server.items.has('_keys')).toBe(true);
    expect(server.items.has('preferences')).toBe(true);
    for (const item of server.items.values()) {
      expect(Buffer.from(item.ciphertext, 'base64url').toString('latin1')).not.toContain('ui.zoom');
    }

    const b = machine(server, 'b', { 'ui.zoom': 1, 'diff.contextLines': 5 });
    b.engine.start();
    await b.engine.idle();
    expect(b.engine.status()).toMatchObject({ keyState: 'locked', state: 'locked' });

    // A wrong passphrase never touches data.
    const before = JSON.stringify([...server.items]);
    await expect(b.engine.unlock({ passphrase: 'wrong passphrase' })).rejects.toThrow(/not correct/);
    expect(JSON.stringify([...server.items])).toBe(before);
    expect(b.preferences.data).toEqual({ 'ui.zoom': 1, 'diff.contextLines': 5 });

    const st = await b.engine.unlock({ passphrase: 'correct horse battery' });
    expect(st).toMatchObject({ keyState: 'unlocked', state: 'idle' });
    // First join: synced value wins for shared keys; local-only keys are kept and uploaded.
    expect(b.preferences.data).toEqual({ 'ui.zoom': 1.25, 'editor.tabSize': 2, 'diff.contextLines': 5 });
    await a.engine.syncNow();
    expect(a.preferences.data).toEqual(b.preferences.data);
  });

  it('resolves a 412 on push with per-key last-writer-wins', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', { k1: 'a0' });
    a.engine.start();
    await a.engine.setupPassphrase('correct horse battery');
    await a.engine.idle();
    const b = machine(server, 'b', {});
    b.engine.start();
    await b.engine.unlock({ passphrase: 'correct horse battery' });

    a.tick(10);
    a.preferences.set('k1', 'from-a');
    a.preferences.set('k2', 'a-only');
    await settle(a);
    const version = server.items.get('preferences')!.version;

    b.tick(50); // B edits later → wins k1
    b.preferences.set('k1', 'from-b');
    await settle(b);
    expect(server.items.get('preferences')!.version).toBe(version + 1);
    expect(b.preferences.data).toEqual({ k1: 'from-b', k2: 'a-only' });
    await a.engine.syncNow();
    expect(a.preferences.data).toEqual({ k1: 'from-b', k2: 'a-only' });
  });

  it('retries when another writer lands between merge and PUT', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', { k: 1 });
    a.engine.start();
    await a.engine.setupPassphrase('correct horse battery');
    await a.engine.idle();
    const b = machine(server, 'b', {});
    b.engine.start();
    await b.engine.unlock({ passphrase: 'correct horse battery' });
    let once = true;
    server.beforePut = (cat) => {
      if (cat !== 'preferences' || !once) return;
      once = false;
      const cur = server.items.get('preferences')!;
      server.items.set('preferences', { ...cur, version: cur.version + 1 }); // concurrent writer
    };
    b.tick(5);
    b.preferences.set('x', 'y');
    await settle(b);
    expect(b.engine.status().state).toBe('idle');
    expect(b.engine.status().error).toBeUndefined();
  });

  it('reports strict conflicts and resolves them with keep local / keep remote', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', {}, { 'my.jsonc': 'A' });
    a.engine.start();
    await a.engine.setupPassphrase('correct horse battery');
    await a.engine.idle();
    const b = machine(server, 'b', {}, { 'my.jsonc': 'B' });
    b.engine.start();
    await b.engine.unlock({ passphrase: 'correct horse battery' });
    expect(b.engine.status().conflicts).toEqual([{ category: 'themes', keys: ['my.jsonc'] }]);
    expect(b.themes.data).toEqual({ 'my.jsonc': 'B' }); // untouched until the user decides

    await b.engine.resolveConflict('themes', 'local');
    expect(b.engine.status().conflicts).toEqual([]);
    await a.engine.syncNow();
    expect(a.themes.data).toEqual({ 'my.jsonc': 'B' });
  });

  it('unlocks with the recovery key and locks other machines after a reset', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', { k: 1 });
    a.engine.start();
    const { recoveryKey } = await a.engine.setupPassphrase('correct horse battery');
    await a.engine.idle();
    const b = machine(server, 'b', {});
    b.engine.start();
    await b.engine.unlock({ recoveryKey: recoveryKey! });
    expect(b.preferences.data).toEqual({ k: 1 });
    expect(await b.engine.exportRecoveryKey()).toEqual({ recoveryKey });

    // Lost passphrase on B: reset re-uploads B's data under a new key.
    const reset = await b.engine.reset('a brand new passphrase');
    expect(reset.recoveryKey).not.toBe(recoveryKey);
    await b.engine.idle();
    expect(server.items.has('preferences')).toBe(true);

    await a.engine.syncNow();
    expect(a.engine.status()).toMatchObject({ keyState: 'locked', state: 'locked' });
    expect(a.preferences.data).toEqual({ k: 1 }); // nothing wiped
    await a.engine.unlock({ passphrase: 'a brand new passphrase' });
    expect(a.engine.status().keyState).toBe('unlocked');
  });

  it('does nothing while sync is disabled', async () => {
    const server = new FakeSyncServer();
    const a = machine(server, 'a', { k: 1 });
    a.settings['sync.enabled'] = false;
    a.engine.start();
    await a.engine.idle();
    expect(a.engine.status().state).toBe('off');
    expect(server.items.size).toBe(0);
  });
});
