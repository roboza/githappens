import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedEnv } from '@githappens/fixtures';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AskpassServer,
  classifyPrompt,
  writeAskpassShims,
  type AskpassRequest,
  type AskpassShims,
} from '../src/askpass';
import { GitError } from '../src/errors/classify';
import { findOnPath } from '../src/locator/shell-env';
import { GitProcessRunner } from '../src/process/runner';

describe('classifyPrompt', () => {
  it('classifies git and ssh prompts with host extraction', () => {
    expect(classifyPrompt("Username for 'https://github.com': ")).toEqual({
      kind: 'username',
      url: 'https://github.com',
      host: 'github.com',
    });
    expect(classifyPrompt("Password for 'https://alice@git.example.com:8443': ")).toEqual({
      kind: 'password',
      url: 'https://alice@git.example.com:8443',
      host: 'git.example.com:8443',
      username: 'alice',
    });
    expect(classifyPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toEqual({
      kind: 'passphrase',
      keyPath: '/home/a/.ssh/id_ed25519',
    });
    expect(
      classifyPrompt(
        "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:x.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      ),
    ).toEqual({ kind: 'hostkey', host: 'github.com' });
    expect(classifyPrompt("git@host.example's password: ")).toEqual({
      kind: 'password',
      username: 'git',
      host: 'host.example',
    });
    expect(classifyPrompt('Something else?')).toEqual({ kind: 'generic' });
  });
});

const gitPath = findOnPath('git');

describe('AskpassServer round trip', () => {
  let dir: string;
  let shims: AskpassShims;
  let server: AskpassServer;
  const onPrompt = vi.fn(async (req: AskpassRequest): Promise<string | null> => {
    if (req.host === 'cancel.example') return null;
    if (req.kind === 'username') return 'alice';
    if (req.kind === 'password') return 's3cr3t "quoted" & 100%';
    return null;
  });
  const logs: string[] = [];

  beforeAll(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-askpass-')));
    shims = await writeAskpassShims(path.join(dir, 'shims'), { nodeExecutable: process.execPath });
    server = new AskpassServer({ shims, onPrompt, log: (m) => logs.push(m) });
    await server.start();
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  // async: the server lives in this process, so a sync spawn would deadlock
  const runMain = (env: Record<string, string>, prompt: string) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const c = spawn(process.execPath, [shims.mainPath, prompt], {
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      let stdout = '';
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', (d: string) => (stdout += d));
      c.on('close', (status) => resolve({ status, stdout }));
    });

  it('writes the shims and exposes the env', () => {
    expect(fs.readFileSync(shims.shPath, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    expect(fs.readFileSync(shims.cmdPath, 'utf8')).toContain('askpass-main.js');
    const env = server.envFor('op-env', { nonInteractive: false });
    expect(env).toMatchObject({
      GIT_ASKPASS: shims.shPath,
      SSH_ASKPASS_REQUIRE: 'force',
      GITHAPPENS_ASKPASS_PIPE: server.pipePath,
    });
    expect(env.GITHAPPENS_ASKPASS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    server.release('op-env');
  });

  it('answers a prompt through the node client', async () => {
    const env = server.envFor('op-1', { nonInteractive: false });
    const r = await runMain(env, "Password for 'https://bob@example.com': ");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('s3cr3t "quoted" & 100%\n');
    expect(onPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ opId: 'op-1', kind: 'password', host: 'example.com', username: 'bob' }),
    );
    // answers are never logged
    expect(logs.join('\n')).not.toContain('s3cr3t');
    server.release('op-1');
  });

  it('cancels for unknown tokens, released ops, user cancel and non-interactive ops', async () => {
    const calls = onPrompt.mock.calls.length;
    const env = server.envFor('op-2', { nonInteractive: false });
    expect(
      (await runMain({ ...env, GITHAPPENS_ASKPASS_TOKEN: 'f'.repeat(64) }, "Username for 'https://x': "))
        .status,
    ).toBe(1);
    expect((await runMain(env, "Username for 'https://cancel.example': ")).status).toBe(1);
    expect(server.wasCancelled('op-2')).toBe(true);
    server.release('op-2');
    expect((await runMain(env, "Username for 'https://x': ")).status).toBe(1);

    const bg = server.envFor('op-bg', { nonInteractive: true });
    expect((await runMain(bg, "Username for 'https://x': ")).status).toBe(1);
    expect(server.wasCancelled('op-bg')).toBe(true);
    server.release('op-bg');
    expect(onPrompt.mock.calls.length).toBe(calls + 1); // only the cancel.example prompt reached the UI
  });

  (gitPath ? it : it.skip)('feeds git credential prompts via GIT_ASKPASS', async () => {
    const runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: isolatedEnv(dir), bundled: false }),
    });
    const input = 'protocol=https\nhost=example.com\n\n';
    const env = server.envFor('op-git', { nonInteractive: false });
    const r = await runner.run({ cwd: dir, args: ['credential', 'fill'], stdin: input, env });
    expect(r.stdout).toContain('username=alice\n');
    expect(r.stdout).toContain('password=s3cr3t "quoted" & 100%\n');
    // second prompt of the same host + user within the op is answered from the per-op cache
    server.release('op-git');

    const bg = server.envFor('op-git-bg', { nonInteractive: true });
    const err = await runner
      .run({ cwd: dir, args: ['credential', 'fill'], stdin: input, env: bg })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('AuthenticationFailed');
    server.release('op-git-bg');
  });

  it('sets ELECTRON_RUN_AS_NODE for Electron executables', async () => {
    const s = await writeAskpassShims(path.join(dir, 'electron'), {
      nodeExecutable: 'C:\\Program Files\\GitHappens\\GitHappens.exe',
      runAsNodeEnv: true,
    });
    expect(fs.readFileSync(s.shPath, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1 exec ');
    expect(fs.readFileSync(s.cmdPath, 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1');
    const srv = new AskpassServer({ shims: s, onPrompt: async () => null });
    expect(srv.envFor('x', { nonInteractive: false }).ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
