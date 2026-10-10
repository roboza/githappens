import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowedSignersLine,
  gitSupportsSshSigning,
  parsePublicKey,
  resolveSshPublicKey,
  upsertAllowedSigners,
  writeAllowedSigners,
} from '../src/main/gpg/allowed-signers';
import {
  detectGpg,
  GpgService,
  gpgCandidates,
  parseGpgColons,
  parseGpgVersion,
  spawnGpg,
  validateGenerateRequest,
  type GpgRun,
} from '../src/main/gpg/gpg';
import { createPrefsHandlers } from '../src/main/ipc/prefs-handlers';
import { SettingsStore } from '../src/main/settings/settings-store';
import { ThemeService } from '../src/main/settings/theme-service';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gpg-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const COLONS = [
  'sec:u:255:22:3AA5C34371567BD2:1700000000:1763072000::u:::scESC:::+:::23::0:',
  'fpr:::::::::0123456789ABCDEF0123456789AB3AA5C34371567BD2:',
  'grp:::::::::AAAA:',
  'uid:u::::1700000000::HASH::Ada Lovelace <ada@example.com>::::::::::0:',
  'uid:r::::1700000000::HASH2::Old Name \\x3a revoked <old@example.com>::::::::::0:',
  'ssb:u:255:18:1111222233334444:1700000000:::::e:::+:::cv25519::',
  'fpr:::::::::FFFF1111222233334444:',
  'sec:e:4096:1:AAAABBBBCCCCDDDD:1500000000:1600000000::u:::cC:::+:::::0:',
  'fpr:::::::::9999888877776666AAAABBBBCCCCDDDD:',
  'uid:e::::1500000000::H3::Expired \\x3a Key <exp@example.com>::::::::::0:',
  'ssb:e:4096:1:5555666677778888:1500000000:1600000000:::::s:::+::::',
].join('\n');

describe('gpg colon parsing', () => {
  it('parses secret keys, fingerprints, uids, expiry and capabilities', () => {
    const keys = parseGpgColons(COLONS, 1_710_000_000_000);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      keyId: '3AA5C34371567BD2',
      fingerprint: '0123456789ABCDEF0123456789AB3AA5C34371567BD2',
      uids: ['Ada Lovelace <ada@example.com>'],
      created: 1_700_000_000_000,
      expires: 1_763_072_000_000,
      expired: false,
      revoked: false,
      canSign: true,
    });
    expect(keys[1]).toMatchObject({
      keyId: 'AAAABBBBCCCCDDDD',
      expired: true,
      canSign: false, // primary is certify-only and the signing subkey expired
      uids: ['Expired : Key <exp@example.com>'],
    });
  });

  it('reads versions and lists OS candidates', () => {
    expect(parseGpgVersion('gpg (GnuPG) 2.4.5\nlibgcrypt 1.10.3\n')).toBe('2.4.5');
    expect(parseGpgVersion('gpg (GnuPG/MacGPG2) 2.2.41\n')).toBe('2.2.41');
    expect(parseGpgVersion('nonsense')).toBeNull();
    const win = gpgCandidates({ PATH: 'C:\\bin;C:\\bin', ProgramFiles: 'C:\\PF' }, 'win32');
    expect(win[0]).toMatch(/gpg\.exe$/);
    expect(win).toContain('C:\\PF\\GnuPG\\bin\\gpg.exe');
    expect(win.filter((p) => p.toLowerCase() === path.join('C:\\bin', 'gpg.exe').toLowerCase())).toHaveLength(
      1,
    );
    expect(gpgCandidates({ PATH: '' }, 'darwin')).toContain('/opt/homebrew/bin/gpg');
  });

  it('detect prefers the configured program and skips ones that do not run', async () => {
    const run: GpgRun = vi.fn(async (p: string) =>
      p.includes('broken')
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: `gpg (GnuPG) ${p.includes('two') ? '2.2.1' : '2.4.0'}\n`, stderr: '' },
    );
    const r = await detectGpg('/opt/broken/gpg', {
      run,
      exists: (p) => p.startsWith('/opt/'),
      extraCandidates: ['/opt/one/gpg', '/opt/two/gpg'],
      env: { PATH: '' },
      platform: 'linux',
    });
    expect(r.program).toBe('/opt/one/gpg');
    expect(r.version).toBe('2.4.0');
    expect(r.candidates.map((c) => c.path)).toEqual(['/opt/one/gpg', '/opt/two/gpg']);
  });

  it('generateKey passes the passphrase on stdin (never argv) and returns the new key', async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const run: GpgRun = async (_p, args, o) => {
      calls.push({ args, stdin: o?.stdin });
      if (args.includes('--quick-gen-key')) {
        return {
          code: 0,
          stdout: '[GNUPG:] KEY_CREATED P 0123456789ABCDEF0123456789AB3AA5C34371567BD2\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: COLONS, stderr: '' };
    };
    const svc = new GpgService(() => '/usr/bin/gpg', { run });
    const key = await svc.generateKey({ name: 'Ada', email: 'ada@example.com', passphrase: 's3cret-pass' });
    expect(key.keyId).toBe('3AA5C34371567BD2');
    const gen = calls.find((c) => c.args.includes('--quick-gen-key'))!;
    expect(gen.args).toEqual(
      expect.arrayContaining([
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        'Ada <ada@example.com>',
      ]),
    );
    expect(gen.args.join(' ')).not.toContain('s3cret-pass');
    expect(gen.stdin).toBe('s3cret-pass\n');
  });

  it('validates generate requests and key ids', async () => {
    expect(() => validateGenerateRequest({ name: 'A <b>', email: 'a@b.c' })).toThrow(/name/);
    expect(() => validateGenerateRequest({ name: 'A', email: 'nope' })).toThrow(/email/);
    expect(() => validateGenerateRequest({ name: 'A', email: 'a@b.c', expire: '1 year' })).toThrow(/expiry/);
    expect(validateGenerateRequest({ name: ' A ', email: 'a@b.c' })).toMatchObject({
      algo: 'ed25519',
      expire: '2y',
    });
    const svc = new GpgService(() => 'gpg', { run: async () => ({ code: 0, stdout: '', stderr: '' }) });
    await expect(svc.exportPublic('--armor; rm')).rejects.toThrow(/Invalid key id/);
  });
});

describe('allowed_signers helper', () => {
  const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkey ada@laptop';

  it('builds and de-duplicates entries', () => {
    const key = parsePublicKey(PUB)!;
    expect(key).toMatchObject({ type: 'ssh-ed25519', comment: 'ada@laptop' });
    expect(parsePublicKey(`key::${PUB}`)?.base64).toBe(key.base64);
    const line = allowedSignersLine('ada@example.com', key);
    expect(line).toBe(`ada@example.com namespaces="git" ssh-ed25519 ${key.base64}`);
    const a = upsertAllowedSigners('# signers\nbob@x.io ssh-rsa AAAA', line);
    expect(a.added).toBe(true);
    expect(a.content.endsWith(`${line}\n`)).toBe(true);
    expect(upsertAllowedSigners(a.content, line).added).toBe(false);
    expect(() => allowedSignersLine('a b@c', key)).toThrow(/valid email/);
  });

  it('resolves keys from .pub paths / private key paths and writes ~/.ssh/allowed_signers', () => {
    const ssh = path.join(dir, '.ssh');
    fs.mkdirSync(ssh);
    fs.writeFileSync(path.join(ssh, 'id_ed25519.pub'), `${PUB}\n`);
    expect(resolveSshPublicKey('~/.ssh/id_ed25519', dir).type).toBe('ssh-ed25519');
    expect(resolveSshPublicKey(path.join(ssh, 'id_ed25519.pub'), dir).type).toBe('ssh-ed25519');
    expect(() => resolveSshPublicKey('~/.ssh/missing', dir)).toThrow(/No SSH public key/);
    const file = path.join(ssh, 'allowed_signers');
    const r1 = writeAllowedSigners({ file, email: 'ada@example.com', key: parsePublicKey(PUB)! });
    const r2 = writeAllowedSigners({ file, email: 'ada@example.com', key: parsePublicKey(PUB)! });
    expect([r1.added, r2.added]).toEqual([true, false]);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('signing:allowedSigners uses the profile email + signing key and records the file', async () => {
    const settings = new SettingsStore({
      dir,
      defaultIdentity: () => ({ name: 'Ada', email: 'ada@example.com' }),
    });
    settings.load();
    fs.mkdirSync(path.join(dir, 'home', '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', '.ssh', 'id.pub'), PUB);
    settings.set('signing.signingKey', '~/.ssh/id.pub');
    const h = createPrefsHandlers({
      settings,
      userDataDir: dir,
      secrets: { deleteByPrefix: vi.fn(() => 0) },
      broadcast: vi.fn(),
      setGlobalIdentity: vi.fn(),
      writeGitConfig: vi.fn(),
      openPath: vi.fn(),
      pickPath: vi.fn(async () => null),
      themes: new ThemeService({ dir: path.join(dir, 'themes') }),
      homeDir: path.join(dir, 'home'),
    });
    const r = await h['signing:allowedSigners']({}, { senderId: 1 });
    expect(r.file).toBe(path.join(dir, 'home', '.ssh', 'allowed_signers'));
    expect(r.line.startsWith('ada@example.com namespaces="git" ssh-ed25519 ')).toBe(true);
    expect(settings.get('signing.allowedSignersFile')).toBe(r.file);
  });

  it('gates SSH signing on git >= 2.34', () => {
    expect(gitSupportsSshSigning('git version 2.34.0')).toBe(true);
    expect(gitSupportsSshSigning('git version 2.45.1.windows.1')).toBe(true);
    expect(gitSupportsSshSigning('git version 2.33.8')).toBe(false);
    expect(gitSupportsSshSigning('git version 3.0.0')).toBe(true);
  });
});

// Real GnuPG round trip (generate → list → export) in a throwaway GNUPGHOME; skipped when gpg is absent.
const realGpg = await (async () => {
  try {
    const r = await detectGpg(undefined);
    return r.program && /^2\./.test(r.version ?? '') ? r.program : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!realGpg)('real gpg', () => {
  it('generates, lists and exports a key in an isolated GNUPGHOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gnupg-'));
    // Git for Windows' MSYS gpg only understands POSIX-style GNUPGHOME paths (/c/Users/…).
    const msys = process.platform === 'win32' && /[\\/]usr[\\/]bin[\\/]gpg/i.test(realGpg!);
    const gnupgHome = msys
      ? home.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
      : home;
    const env = { ...process.env, GNUPGHOME: gnupgHome };
    const run = spawnGpg(env);
    try {
      const svc = new GpgService(() => realGpg!, { run, env });
      const key = await svc.generateKey({ name: 'GitHappens Test', email: 'test@example.com', expire: '1d' });
      expect(key.uids[0]).toBe('GitHappens Test <test@example.com>');
      expect(key.canSign).toBe(true);
      expect((await svc.listKeys()).map((k) => k.keyId)).toContain(key.keyId);
      expect(await svc.exportPublic(key.keyId)).toMatch(/BEGIN PGP PUBLIC KEY BLOCK/);
    } finally {
      // the agent started for this GNUPGHOME may still hold its sockets: best-effort cleanup
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* temp dir is left for the OS */
      }
    }
  }, 120_000);
});
