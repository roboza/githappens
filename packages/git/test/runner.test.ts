import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOnPath, GitError, GitProcessRunner, type CommandLogEntry, type ProgressEvent } from '../src';

// Integration tests against the git on PATH (CI installs one; bundled git is covered by e2e).
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

d('GitProcessRunner (real git)', () => {
  let dir: string;
  const log: CommandLogEntry[] = [];
  const runner = new GitProcessRunner({
    context: () => ({ gitPath: gitPath!, baseEnv: process.env, bundled: false }),
    onCommand: (e) => log.push(e),
    killGraceMs: 500,
  });
  const cfg = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runner-'));
    await runner.run({ cwd: dir, args: ['init', '-q', '-b', 'main'] });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs git --version', async () => {
    const r = await runner.run({ cwd: dir, args: ['--version'], readOnly: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^git version \d+\.\d+/);
  });

  it('passes stdin and returns buffers on request', async () => {
    const r = await runner.run({
      cwd: dir,
      args: ['hash-object', '--stdin'],
      stdin: 'hello\n',
      encoding: 'buffer',
    });
    expect(Buffer.isBuffer(r.stdout)).toBe(true);
    expect(r.stdout.toString().trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('throws a classified GitError and logs the command', async () => {
    const err = await runner
      .run({ cwd: dir, args: [...cfg, 'commit', '-m', 'nothing'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('NothingToCommit');
    const last = log[log.length - 1]!;
    expect(last.argv).toContain('commit');
    expect(last.exitCode).not.toBe(0);
  });

  it('accepts expected non-zero exit codes', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await runner.run({ cwd: dir, args: ['add', '--', 'a.txt'] });
    const r = await runner.run({
      cwd: dir,
      args: ['diff', '--cached', '--quiet'],
      expectedExitCodes: [0, 1],
    });
    expect(r.exitCode).toBe(1);
  });

  it('handles unicode and space-containing paths after --', async () => {
    const name = 'ünï cødé file.txt';
    fs.writeFileSync(path.join(dir, name), 'x\n');
    await runner.run({ cwd: dir, args: ['add', '--', name] });
    const r = await runner.run({ cwd: dir, args: ['diff', '--cached', '--name-only', '-z'], readOnly: true });
    expect(r.stdout.split('\0')).toContain(name);
  });

  it('cancels a blocked process via AbortSignal', async () => {
    const ac = new AbortController();
    // `cat-file --batch` waits on stdin forever until killed.
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const p = runner.run({ cwd: dir, args: ['cat-file', '--batch'], stdin, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const err = await p.catch((e: unknown) => e);
    expect((err as GitError).code).toBe('Cancelled');
    expect(runner.activeCount).toBe(0);
  });

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runner.run({ cwd: dir, args: ['status'], signal: ac.signal })).rejects.toMatchObject({
      code: 'Cancelled',
    });
  });

  it('enforces maxBuffer', async () => {
    const err = await runner
      .run({ cwd: dir, args: ['help', '-a'], readOnly: true, maxBuffer: 16 })
      .catch((e: unknown) => e);
    expect((err as GitError).code).toBe('OutputTooLarge');
  });

  it('times out', async () => {
    const { PassThrough } = await import('node:stream');
    const err = await runner
      .run({ cwd: dir, args: ['cat-file', '--batch'], stdin: new PassThrough(), timeoutMs: 200 })
      .catch((e: unknown) => e);
    expect((err as GitError).code).toBe('Timeout');
  });

  it('streams stdout', async () => {
    await runner.run({ cwd: dir, args: [...cfg, 'commit', '-q', '-m', 'first'] });
    const s = runner.stream({ cwd: dir, args: ['log', '--format=%s'], readOnly: true });
    let text = '';
    for await (const chunk of s.stdout) text += chunk.toString();
    await s.done;
    expect(text.trim()).toBe('first');
  });

  it('reports progress from stderr', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-clone-'));
    const events: ProgressEvent[] = [];
    await runner.run({
      cwd: target,
      args: ['clone', '--progress', pathToFileURL(dir).href, 'c'],
      progress: (e) => events.push(e),
      progressKind: 'clone',
    });
    fs.rmSync(target, { recursive: true, force: true });
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(last.overall ?? 0).toBeGreaterThan(0);
  });

  it('caps concurrency', async () => {
    const limited = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: process.env, bundled: false }),
      maxConcurrent: 1,
    });
    let maxSeen = 0;
    const timer = setInterval(() => (maxSeen = Math.max(maxSeen, limited.activeCount)), 1);
    await Promise.all(
      Array.from({ length: 4 }, () => limited.run({ cwd: dir, args: ['--version'], readOnly: true })),
    );
    clearInterval(timer);
    expect(maxSeen).toBeLessThanOrEqual(1);
  });

  it('reports GitNotFound for a missing executable', async () => {
    const broken = new GitProcessRunner({
      context: () => ({ gitPath: path.join(dir, 'no-such-git'), baseEnv: process.env, bundled: false }),
    });
    await expect(broken.run({ cwd: dir, args: ['--version'] })).rejects.toMatchObject({
      code: 'GitNotFound',
    });
  });

  it('applies invocation extras (config via GIT_CONFIG_COUNT) to every command', async () => {
    const r2 = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: process.env, bundled: false }),
    });
    r2.setInvocationExtras(() => ({ config: [['githappens.probe', 'from-extras']] }));
    const r = await r2.run({ cwd: dir, args: ['config', '--get', 'githappens.probe'], readOnly: true });
    expect(r.stdout.trim()).toBe('from-extras');
    r2.setInvocationExtras(() => {
      throw new Error('broken provider');
    });
    const r3 = await r2.run({
      cwd: dir,
      args: ['config', '--get', 'githappens.probe'],
      readOnly: true,
      expectedExitCodes: [1],
    });
    expect(r3.exitCode).toBe(1);
  });
});
