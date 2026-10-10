import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildSshInvocation,
  listAgentPipes,
  shQuote,
  sshPath,
  type SshHostInfo,
  type SshPrefs,
} from '../src/main/ssh/ssh-command';
import { generateSshKey, keygenArgs, parsePublicKey, uniqueKeyPath } from '../src/main/ssh/ssh-keys';
import { SshService } from '../src/main/ssh/ssh-service';
import { parseSshTarget, parseSshTestOutput, sshTestArgs } from '../src/main/ssh/ssh-test';
import { locateSshTool } from '../src/main/ssh/ssh-tools';

const prefs = (p: Partial<SshPrefs> = {}): SshPrefs => ({
  useLocalAgent: false,
  privateKeyPath: '',
  useSshConfig: true,
  windowsAgent: 'openssh',
  ...p,
});

const linux: SshHostInfo = {
  platform: 'linux',
  homedir: '/home/me',
  windowsSsh: null,
  agentPipes: null,
  env: { HOME: '/home/me', SSH_AUTH_SOCK: '/tmp/agent.sock' },
};

const win: SshHostInfo = {
  platform: 'win32',
  homedir: 'C:\\Users\\Me',
  windowsSsh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  agentPipes: { openssh: true, pageant: 'pageant.me.abc123' },
  env: { USERPROFILE: 'C:\\Users\\Me' },
};

describe('GIT_SSH_COMMAND builder (spec 09 §6.7)', () => {
  it('quotes for the POSIX sh git uses', () => {
    expect(shQuote('ssh')).toBe('ssh');
    expect(shQuote('/home/me/.ssh/id')).toBe('/home/me/.ssh/id');
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(shQuote('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`);
    expect(shQuote('')).toBe("''");
  });

  it('leaves ssh alone by default (no key, agent off, config on)', () => {
    const inv = buildSshInvocation(prefs(), linux);
    expect(inv.env).toEqual({});
    expect(inv.mode).toBe('default');
  });

  it('uses the key file with IdentitiesOnly on POSIX', () => {
    const inv = buildSshInvocation(prefs({ privateKeyPath: '~/.ssh/my key' }), linux);
    expect(inv.env.GIT_SSH_COMMAND).toBe(`ssh -i '/home/me/.ssh/my key' -o IdentitiesOnly=yes`);
    expect(inv.argv).toEqual({ exe: null, args: ['-i', '/home/me/.ssh/my key', '-o', 'IdentitiesOnly=yes'] });
    expect(inv.mode).toBe('key');
  });

  it('writes Windows key paths with forward slashes and sets HOME for MSYS ssh', () => {
    const inv = buildSshInvocation(prefs({ privateKeyPath: 'C:\\Users\\Me\\.ssh\\id_ed25519' }), win);
    expect(inv.env.GIT_SSH_COMMAND).toBe('ssh -i C:/Users/Me/.ssh/id_ed25519 -o IdentitiesOnly=yes');
    expect(inv.env.HOME).toBe('C:\\Users\\Me');
  });

  it('adds -F none when ~/.ssh/config is not honoured', () => {
    expect(buildSshInvocation(prefs({ useSshConfig: false }), linux).env.GIT_SSH_COMMAND).toBe('ssh -F none');
    expect(
      buildSshInvocation(prefs({ useSshConfig: false, privateKeyPath: '/k' }), linux).env.GIT_SSH_COMMAND,
    ).toBe('ssh -F none -i /k -o IdentitiesOnly=yes');
  });

  it('ignores option-like key paths', () => {
    const inv = buildSshInvocation(prefs({ privateKeyPath: '-oProxyCommand=evil' }), linux);
    expect(inv.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(inv.warnings.join()).toMatch(/invalid/);
  });

  it('agent on POSIX: no GIT_SSH_COMMAND, key path ignored, warns without SSH_AUTH_SOCK', () => {
    const inv = buildSshInvocation(prefs({ useLocalAgent: true, privateKeyPath: '/k' }), linux);
    expect(inv.env).toEqual({});
    expect(inv.mode).toBe('agent');
    const noSock = buildSshInvocation(prefs({ useLocalAgent: true }), { ...linux, env: {} });
    expect(noSock.warnings.join()).toMatch(/SSH_AUTH_SOCK/);
  });

  it('agent on Windows (OpenSSH): Windows ssh.exe, SSH_AUTH_SOCK removed', () => {
    const inv = buildSshInvocation(prefs({ useLocalAgent: true }), win);
    expect(inv.env.GIT_SSH_COMMAND).toBe('C:/Windows/System32/OpenSSH/ssh.exe');
    expect(inv.env.SSH_AUTH_SOCK).toBeNull();
    expect(inv.client).toBe('windows-openssh');
    const stopped = buildSshInvocation(prefs({ useLocalAgent: true }), {
      ...win,
      agentPipes: { openssh: false, pageant: null },
    });
    expect(stopped.warnings.join()).toMatch(/Authentication Agent service/);
  });

  it('agent on Windows (Pageant): IdentityAgent points at the pageant pipe', () => {
    const inv = buildSshInvocation(
      prefs({ useLocalAgent: true, windowsAgent: 'pageant', useSshConfig: false }),
      win,
    );
    expect(inv.env.GIT_SSH_COMMAND).toBe(
      'C:/Windows/System32/OpenSSH/ssh.exe -F none -o IdentityAgent=//./pipe/pageant.me.abc123',
    );
    expect(inv.argv.exe).toBe(win.windowsSsh);
    const missing = buildSshInvocation(prefs({ useLocalAgent: true, windowsAgent: 'pageant' }), {
      ...win,
      agentPipes: { openssh: false, pageant: null },
    });
    expect(missing.warnings.join()).toMatch(/Pageant is not running/);
  });

  it('falls back to git ssh with a warning when Windows OpenSSH is missing', () => {
    const inv = buildSshInvocation(prefs({ useLocalAgent: true }), { ...win, windowsSsh: null });
    expect(inv.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(inv.warnings.join()).toMatch(/OpenSSH Client/);
  });

  it('expands ~ in paths', () => {
    expect(sshPath('~/.ssh/id', linux)).toBe('/home/me/.ssh/id');
    expect(sshPath('~\\.ssh\\id', win)).toBe('C:/Users/Me/.ssh/id');
  });

  it('finds agent pipes by name', () => {
    const pipes = listAgentPipes('win32', () => ['foo', 'openssh-ssh-agent', 'pageant.x.1']);
    expect(pipes).toEqual({ openssh: true, pageant: 'pageant.x.1' });
    expect(listAgentPipes('linux', () => [])).toBeNull();
    expect(
      listAgentPipes('win32', () => {
        throw new Error('no');
      }),
    ).toBeNull();
  });
});

describe('ssh -T output parsing', () => {
  it('recognises provider greetings', () => {
    const gh = parseSshTestOutput(
      "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.",
      1,
    );
    expect(gh).toMatchObject({ ok: true, kind: 'success', user: 'octocat' });
    expect(parseSshTestOutput('Welcome to GitLab, @jane!', 0)).toMatchObject({ ok: true, user: 'jane' });
    expect(
      parseSshTestOutput('authenticated via ssh key.\n\nYou can use git to connect to Bitbucket.', 0).ok,
    ).toBe(true);
    expect(parseSshTestOutput('remote: Shell access is not supported.', 1).ok).toBe(true);
  });

  it('classifies failures', () => {
    expect(parseSshTestOutput('git@github.com: Permission denied (publickey).', 255).kind).toBe('auth');
    expect(parseSshTestOutput('Host key verification failed.', 255).kind).toBe('hostkey');
    expect(
      parseSshTestOutput(
        '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.',
        255,
      ).kind,
    ).toBe('hostkeyChanged');
    expect(
      parseSshTestOutput('ssh: Could not resolve hostname nope: Name or service not known', 255).kind,
    ).toBe('network');
    expect(parseSshTestOutput('WARNING: UNPROTECTED PRIVATE KEY FILE!', 255).kind).toBe('permissions');
    expect(parseSshTestOutput('Load key "/k": invalid format', 255).kind).toBe('keyFormat');
    expect(parseSshTestOutput('', 255, { timedOut: true }).kind).toBe('timeout');
    expect(parseSshTestOutput('something odd', 3)).toMatchObject({
      ok: false,
      kind: 'unknown',
      message: 'something odd',
    });
  });

  it('parses and validates targets', () => {
    expect(parseSshTarget('github.com')).toEqual({ user: 'git', host: 'github.com', port: undefined });
    expect(parseSshTarget('ssh://me@host.example:2222/x')).toEqual({
      user: 'me',
      host: 'host.example',
      port: 2222,
    });
    expect(() => parseSshTarget('-oProxyCommand=x')).toThrow();
    expect(() => parseSshTarget('a b')).toThrow();
    expect(sshTestArgs({ user: 'git', host: 'h', port: 22 })).toEqual([
      '-T',
      '-o',
      'ConnectTimeout=15',
      '-p',
      '22',
      '--',
      'git@h',
    ]);
  });
});

describe('SshService.testConnection', () => {
  it('runs ssh with the key args, askpass env and no GIT_SSH_COMMAND', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const released: string[] = [];
    const svc = new SshService({
      prefs: () => ({ ...prefs({ privateKeyPath: '/k/id' }), publicKeyPath: '' }),
      setKeyPaths: () => undefined,
      defaultComment: () => 'me@example.com',
      probe: () => linux,
      locate: (n) => (n === 'ssh' ? '/usr/bin/ssh' : null),
      askpass: {
        env: (opId) => ({ GITHAPPENS_ASKPASS_TOKEN: opId }),
        release: (opId) => released.push(opId),
      },
      exec: async (file, args, env) => {
        calls.push({ file, args, env });
        return {
          exitCode: 1,
          stdout: '',
          stderr: "Hi me! You've successfully authenticated, but…",
          timedOut: false,
        };
      },
    });
    const r = await svc.testConnection('github.com');
    expect(r).toMatchObject({ ok: true, user: 'me' });
    expect(calls[0]!.file).toBe('/usr/bin/ssh');
    expect(calls[0]!.args).toEqual([
      '-i',
      '/k/id',
      '-o',
      'IdentitiesOnly=yes',
      ...sshTestArgs({ user: 'git', host: 'github.com' }),
    ]);
    expect(calls[0]!.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(calls[0]!.env.GITHAPPENS_ASKPASS_TOKEN).toMatch(/^ssh-test-/);
    expect(released).toEqual([calls[0]!.env.GITHAPPENS_ASKPASS_TOKEN]);
  });
});

describe('SSH keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ssh-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('parses public keys and computes the SHA256 fingerprint', () => {
    // Fingerprint verified with `ssh-keygen -lf`.
    const k = parsePublicKey(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@example.com\n',
    );
    expect(k.algorithm).toBe('ssh-ed25519');
    expect(k.comment).toBe('me@example.com');
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(() => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow();
  });

  it('never picks an existing file name', () => {
    const taken = new Set(['/s/k', '/s/k_2.pub']);
    expect(uniqueKeyPath('/s/k', (p) => taken.has(p))).toBe('/s/k_3');
    expect(uniqueKeyPath('/s/new', () => false)).toBe('/s/new');
  });

  it('builds ssh-keygen argv without a shell', () => {
    expect(keygenArgs({ type: 'ed25519', comment: 'a b', path: '/p/k', passphrase: '' })).toEqual([
      '-q',
      '-t',
      'ed25519',
      '-C',
      'a b',
      '-f',
      '/p/k',
      '-N',
      '',
    ]);
    expect(keygenArgs({ type: 'rsa-4096', comment: 'c', path: '/p/k', passphrase: 'pw pw' })).toContain(
      '4096',
    );
  });

  const keygen = locateSshTool('ssh-keygen');
  (keygen ? it : it.skip)('generates a key with the real ssh-keygen (paths with spaces)', async () => {
    const keyPath = path.join(tmp, 'dir with space', 'id_test');
    const key = await generateSshKey({
      keygen: keygen!,
      type: 'ed25519',
      comment: 'me@example.com',
      path: keyPath,
    });
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(key.publicKeyPath).toBe(`${keyPath}.pub`);
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ me@example.com$/);
    expect(key.fingerprint).toMatch(/^SHA256:/);
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    await expect(
      generateSshKey({ keygen: keygen!, type: 'ed25519', comment: 'x', path: keyPath }),
    ).rejects.toThrow(/already exists/);
    const withPass = await generateSshKey({
      keygen: keygen!,
      type: 'ed25519',
      comment: 'pw',
      passphrase: 'correct horse',
      path: path.join(tmp, 'id_pw'),
    });
    expect(fs.readFileSync(withPass.privateKeyPath, 'utf8')).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
  });

  it('rejects bad input before running ssh-keygen', async () => {
    const exec = async () => {
      throw new Error('must not run');
    };
    await expect(
      generateSshKey({ keygen: 'x', type: 'ed25519', comment: 'a\nb', path: path.join(tmp, 'n1'), exec }),
    ).rejects.toThrow(/comment/);
    await expect(
      generateSshKey({
        keygen: 'x',
        type: 'ed25519',
        comment: 'a',
        passphrase: 'abc',
        path: path.join(tmp, 'n2'),
        exec,
      }),
    ).rejects.toThrow(/passphrase/);
  });
});
