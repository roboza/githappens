import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sha1Hex, writeFileAtomic } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlameStreams } from '../src/main/files/blame-streams';
import { mimeFor, serveRevision } from '../src/main/files/revision-protocol';
import {
  createWorktreeFile,
  readWorktreeBytes,
  safeWorktreePath,
  writeWorktreeBytes,
} from '../src/main/files/worktree-io';
import { parseRevisionUrl, revisionUrl } from '../src/shared/ipc/files-contract';
import { gitPath, useTestRepos } from './ai-test-repo';

let root = '';
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-file-io-')));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows may hold handles briefly */
  }
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('worktree IO for the in-app editor (spec 07 §6.10)', () => {
  it('saves atomically, detects on-disk changes through expectedHash and preserves bytes', async () => {
    const dir = path.join(root, 'wt1');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\r\ntwo\r\n');
    const r = await readWorktreeBytes(dir, 'a.txt');
    expect(r).toMatchObject({ exists: true, size: 10, hash: sha1Hex(enc('one\r\ntwo\r\n')) });

    const ok = await writeWorktreeBytes(dir, 'a.txt', enc('one\r\nTWO\r\n'), r.hash);
    expect(ok).toMatchObject({ ok: true, hash: sha1Hex(enc('one\r\nTWO\r\n')) });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
    // no temp files left behind
    expect(fs.readdirSync(dir)).toEqual(['a.txt']);

    // someone else changed it: the stale hash conflicts and nothing is written
    fs.writeFileSync(path.join(dir, 'a.txt'), 'external\n');
    const conflict = await writeWorktreeBytes(dir, 'a.txt', enc('mine\n'), r.hash);
    expect(conflict).toEqual({ ok: false, conflict: true, hash: sha1Hex(enc('external\n')) });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('external\n');
    // overwrite (no expectedHash) wins
    expect((await writeWorktreeBytes(dir, 'a.txt', enc('mine\n'))).ok).toBe(true);
    // expectedHash null = "must not exist"
    expect((await writeWorktreeBytes(dir, 'new.txt', enc('n'), null)).ok).toBe(true);
    expect(await writeWorktreeBytes(dir, 'new.txt', enc('n2'), null)).toMatchObject({
      ok: false,
      conflict: true,
    });
  });

  it.skipIf(process.platform === 'win32')('preserves the file mode and writes through symlinks', async () => {
    const dir = path.join(root, 'wt-mode');
    fs.mkdirSync(dir);
    const f = path.join(dir, 'run.sh');
    fs.writeFileSync(f, '#!/bin/sh\n');
    fs.chmodSync(f, 0o755);
    fs.symlinkSync('run.sh', path.join(dir, 'link.sh'));
    await writeWorktreeBytes(dir, 'link.sh', enc('#!/bin/sh\necho hi\n'));
    expect(fs.lstatSync(path.join(dir, 'link.sh')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.statSync(f).mode & 0o777).toBe(0o755);
  });

  it('retries the rename on EPERM/EBUSY and gives up after the retries', async () => {
    const file = path.join(root, 'retry.txt');
    let calls = 0;
    await writeFileAtomic(file, enc('x'), {
      backoffMs: 1,
      rename: async (a, b) => {
        if (++calls < 3) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
        await fs.promises.rename(a, b);
      },
    });
    expect(calls).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    await expect(
      writeFileAtomic(file, enc('y'), {
        retries: 1,
        backoffMs: 1,
        rename: async () => {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        },
      }),
    ).rejects.toThrow('locked');
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    expect(fs.readdirSync(root).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses paths outside the worktree or inside .git; creates new files once', async () => {
    const dir = path.join(root, 'wt2');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    for (const bad of ['../x.txt', 'a/../../x.txt', '.git/config', '.GIT/HEAD', '/etc/passwd', 'C:/x', '']) {
      expect(() => safeWorktreePath(dir, bad), bad).toThrow();
    }
    expect(() => safeWorktreePath(null, 'a.txt')).toThrow(/Bare/);
    await createWorktreeFile(dir, 'deep/new dir/日本.txt');
    expect(fs.readFileSync(path.join(dir, 'deep/new dir/日本.txt'), 'utf8')).toBe('');
    await expect(createWorktreeFile(dir, 'deep/new dir/日本.txt')).rejects.toThrow(/already exists/);
    await expect(createWorktreeFile(dir, 'folder/')).rejects.toThrow(/file name/);
    expect(await readWorktreeBytes(dir, 'missing.txt')).toMatchObject({ exists: false, hash: null });
  });
});

describe('githappens-rev:// URLs', () => {
  it('round-trips repo ids, special revisions and paths with unicode, spaces, tabs and newlines', () => {
    for (const p of ['a.png', 'dir/with space/ü.png', 'new\nline\ttab.png', '%2F weird #?.png']) {
      const url = revisionUrl('C:\\repos\\My Repo', ':worktree', p);
      expect(url.startsWith('githappens-rev://blob/')).toBe(true);
      expect(parseRevisionUrl(url)).toEqual({ repoId: 'C:\\repos\\My Repo', rev: ':worktree', path: p });
    }
    expect(parseRevisionUrl('githappens-rev://blob/only-two/parts')).toBeNull();
    expect(parseRevisionUrl('https://example.com/a/b/c')).toBeNull();
    expect(mimeFor('X.PNG')).toBe('image/png');
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
  });
});

const describeGit = gitPath ? describe : describe.skip;

describeGit('githappens-rev:// protocol and blame streams (real repo)', () => {
  const repos = useTestRepos('githappens-rev');

  it('serves blobs at revisions, the index and the worktree, resolves local LFS objects, guards traversal', async () => {
    const r = await repos.make({ 'img/a.png': 'v1', 'secret.txt': 's' });
    r.write('img/a.png', 'v2-staged');
    r.git('add', 'img/a.png');
    r.write('img/a.png', 'v3-worktree');
    const deps = { service: (id: string) => (id === 'r' ? r.svc : (undefined as never)), maxBytes: 1024 };
    const get = async (rev: string, p: string) => serveRevision(revisionUrl('r', rev, p), deps);

    const head = await get('HEAD', 'img/a.png');
    expect(head.status).toBe(200);
    expect(head.headers['Content-Type']).toBe('image/png');
    expect(head.body!.toString()).toBe('v1');
    expect((await get(':index', 'img/a.png')).body!.toString()).toBe('v2-staged');
    expect((await get(':worktree', 'img/a.png')).body!.toString()).toBe('v3-worktree');
    expect((await get('HEAD', 'nope.png')).status).toBe(404);
    expect((await get(':worktree', '../outside.png')).status).toBe(403);
    expect((await get(':worktree', '.git/config')).status).toBe(403);
    expect((await get('--output=x', 'img/a.png')).status).toBe(400);
    expect(
      (
        await serveRevision(revisionUrl('other', 'HEAD', 'a.png'), {
          service: () => {
            throw new Error('closed');
          },
        })
      ).status,
    ).toBe(404);

    // too large for the cap
    r.write('big.png', 'x'.repeat(2048));
    expect((await get(':worktree', 'big.png')).status).toBe(413);

    // an LFS pointer whose object is local serves the object bytes
    const content = Buffer.from('real image bytes');
    const oid = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    const objDir = path.join(r.dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(objDir, oid), content);
    r.write(
      'lfs.png',
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`,
    );
    expect((await get(':worktree', 'lfs.png')).body!.toString()).toBe('real image bytes');
  });

  it('streams blame chunks and a done event per stream id; cancel stops events', async () => {
    const r = await repos.make({ 'f.txt': 'a\nb\n' });
    r.write('f.txt', 'a\nb\nc\n');
    const events: { event: string; payload: { streamId: string; lines?: unknown[]; error?: string } }[] = [];
    const streams = new BlameStreams((event, payload) => events.push({ event, payload }));
    const id = streams.start(r.svc, 'f.txt', undefined, { ignoreWhitespace: true });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.event === 'blame:done')) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    expect(events.every((e) => e.payload.streamId === id)).toBe(true);
    const lines = events.flatMap((e) => (e.event === 'blame:chunk' ? (e.payload.lines ?? []) : []));
    expect(lines).toHaveLength(3);
    expect(events.at(-1)).toEqual({ event: 'blame:done', payload: { streamId: id } });

    const failing = new BlameStreams((event, payload) => events.push({ event, payload }));
    const bad = failing.start(r.svc, 'missing.txt', 'HEAD');
    await new Promise((res) => setTimeout(res, 1500));
    const done = events.find((e) => e.payload.streamId === bad && e.event === 'blame:done');
    expect(done?.payload.error).toBeTruthy();

    const cancelled = new BlameStreams((event, payload) => events.push({ event, payload }));
    const cid = cancelled.start(r.svc, 'f.txt', undefined);
    cancelled.cancel(cid);
    await new Promise((res) => setTimeout(res, 500));
    expect(events.some((e) => e.payload.streamId === cid)).toBe(false);
    expect(cancelled.size).toBe(0);
  });
});
