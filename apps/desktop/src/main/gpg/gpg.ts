import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  GpgDetectResult,
  GpgGenerateRequest,
  GpgKey,
  GpgProgramInfo,
} from '../../shared/ipc/prefs-contract';

/**
 * GnuPG helpers for Preferences › Commit Signing (spec 13 §4.2, §6 "Signing"). argv only; the
 * passphrase for key generation goes over stdin.
 *
 * Passphrase handling, per OS (researched for GnuPG ≥ 2.1.12, where `allow-loopback-pinentry` is on
 * by default):
 *  - Key generation (here): `--batch --pinentry-mode loopback --passphrase-fd 0` reads the passphrase
 *    from our stdin on Windows (Gpg4win), macOS (GPG Suite / Homebrew) and Linux alike — no TTY, no
 *    pinentry window. An empty line = unprotected key.
 *  - Commit-time signing (git → gpg → gpg-agent): gpg asks the agent, which runs the configured
 *    pinentry. Windows: Gpg4win's pinentry-w32/-qt is a GUI and works from the app. macOS: GPG Suite
 *    ships pinentry-mac; Homebrew users need `pinentry-program /opt/homebrew/bin/pinentry-mac` in
 *    `~/.gnupg/gpg-agent.conf`. Linux: pinentry-gnome3/-qt work when a display is available;
 *    pinentry-curses/-tty cannot prompt without a terminal → git reports "gpg failed to sign the
 *    data" (the composer offers "Commit without signing" and shows these tips). Git's GIT_ASKPASS is
 *    for credentials only — gpg never consults it, so we do not route signing passphrases through it.
 *  - SSH signing (`ssh-keygen -Y sign`): uses ssh-agent; a passphrase-protected key that is not loaded
 *    in the agent cannot prompt without a TTY → add it to the agent first.
 */

export interface GpgRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GpgRun = (
  program: string,
  args: string[],
  o?: { stdin?: string; timeoutMs?: number },
) => Promise<GpgRunResult>;

export interface GpgDeps {
  /** Runs a gpg binary (injectable for tests). */
  run?: GpgRun;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Extra candidate paths (tests). */
  extraCandidates?: string[];
  exists?: (p: string) => boolean;
}

export const spawnGpg =
  (env: NodeJS.ProcessEnv = process.env): GpgRun =>
  (program, args, o = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 30_000);
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.stdin ?? '');
    });

/** `gpg (GnuPG) 2.4.5` / `gpg (GnuPG/MacGPG2) 2.2.41` → `2.4.5`. */
export function parseGpgVersion(stdout: string): string | null {
  const m = /^gpg[^\n]*?\(GnuPG[^)]*\)\s+(\d+\.\d+(?:\.\d+)?)/m.exec(stdout);
  return m ? m[1]! : null;
}

/** Candidate gpg programs for this OS, most likely first (PATH entries come first). */
export function gpgCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const win = platform === 'win32';
  const names = win ? ['gpg.exe', 'gpg2.exe'] : ['gpg', 'gpg2'];
  const pathVar = env.PATH ?? env.Path ?? '';
  const out: string[] = [];
  for (const dir of pathVar.split(win ? ';' : ':').filter(Boolean)) {
    for (const n of names) out.push(path.join(dir, n));
  }
  if (win) {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    out.push(
      path.win32.join(pf86, 'GnuPG', 'bin', 'gpg.exe'),
      path.win32.join(pf, 'GnuPG', 'bin', 'gpg.exe'),
      path.win32.join(pf86, 'Gpg4win', 'bin', 'gpg.exe'),
      ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'GnuPG', 'bin', 'gpg.exe')] : []),
      // Git for Windows bundles GnuPG 2.x
      path.win32.join(pf, 'Git', 'usr', 'bin', 'gpg.exe'),
    );
  } else if (platform === 'darwin') {
    out.push(
      '/opt/homebrew/bin/gpg',
      '/usr/local/bin/gpg',
      '/usr/local/MacGPG2/bin/gpg2',
      '/usr/local/MacGPG2/bin/gpg',
    );
  } else {
    out.push('/usr/bin/gpg', '/usr/bin/gpg2', '/usr/local/bin/gpg');
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = win ? p.toLowerCase() : p;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Run `--version` on the configured program and every candidate that exists. */
export async function detectGpg(configured: string | undefined, d: GpgDeps = {}): Promise<GpgDetectResult> {
  const run = d.run ?? spawnGpg(d.env);
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  const list = [
    ...(configured?.trim() ? [configured.trim()] : []),
    ...(d.extraCandidates ?? []),
    ...gpgCandidates(d.env, d.platform),
  ];
  const candidates: GpgProgramInfo[] = [];
  const seenReal = new Set<string>();
  for (const p of list) {
    if (!exists(p)) continue;
    let real = p;
    try {
      real = fs.realpathSync.native(p);
    } catch {
      /* keep p */
    }
    const key = (d.platform ?? process.platform) === 'win32' ? real.toLowerCase() : real;
    if (seenReal.has(key)) continue;
    seenReal.add(key);
    try {
      const r = await run(p, ['--version'], { timeoutMs: 5000 });
      const version = r.code === 0 ? parseGpgVersion(r.stdout) : null;
      if (version) candidates.push({ path: p, version });
    } catch {
      /* not runnable */
    }
  }
  const best = candidates[0];
  return { program: best?.path, version: best?.version, candidates };
}

/** Un-escape gpg colon-format strings (`\x3a` → `:`). */
const unescapeColon = (s: string): string =>
  s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/** gpg prints epoch seconds, or ISO `20250101T120000` with `--fixed-list-mode` off on old builds. */
function gpgTime(s: string | undefined): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

/**
 * Parse `gpg --list-secret-keys --with-colons` (also works for `--list-keys`): one entry per
 * `sec`/`pub` record with its `fpr` and valid `uid`s; subkey (`ssb`/`sub`) capabilities are folded
 * into `canSign`. https://github.com/gpg/gnupg/blob/master/doc/DETAILS
 */
export function parseGpgColons(stdout: string, now = Date.now()): GpgKey[] {
  const keys: GpgKey[] = [];
  let cur: GpgKey | null = null;
  let lastRecord = '';
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split(':');
    const type = f[0];
    if (type === 'sec' || type === 'pub') {
      const validity = f[1] ?? '';
      const expires = gpgTime(f[6]);
      const caps = f[11] ?? '';
      cur = {
        keyId: (f[4] ?? '').toUpperCase(),
        fingerprint: '',
        uids: [],
        created: gpgTime(f[5]) ?? 0,
        expires,
        expired: validity === 'e' || (expires !== null && expires < now),
        revoked: validity === 'r',
        canSign: /[sS]/.test(caps) && !/[dD]/.test(caps),
      };
      keys.push(cur);
    } else if (type === 'fpr' && cur && (lastRecord === 'sec' || lastRecord === 'pub')) {
      cur.fingerprint = (f[9] ?? '').toUpperCase();
    } else if (type === 'uid' && cur) {
      const validity = f[1] ?? '';
      const uid = unescapeColon(f[9] ?? '');
      if (uid && validity !== 'r') cur.uids.push(uid);
    } else if ((type === 'ssb' || type === 'sub') && cur) {
      const validity = f[1] ?? '';
      if (validity !== 'r' && validity !== 'e' && /s/.test(f[11] ?? '')) cur.canSign = true;
    }
    if (type) lastRecord = type;
  }
  return keys.filter((k) => k.keyId);
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;
const KEY_ID_RE = /^(?:0x)?[0-9A-Fa-f]{8,40}$/;

export function validateGenerateRequest(r: GpgGenerateRequest): Required<
  Omit<GpgGenerateRequest, 'passphrase'>
> & {
  passphrase: string;
} {
  const name = String(r.name ?? '').trim();
  const email = String(r.email ?? '').trim();
  if (!name || name.length > 200 || /[<>\r\n]/.test(name)) throw new Error('Enter a valid name for the key.');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('Enter a valid email for the key.');
  const algo = r.algo ?? 'ed25519';
  if (algo !== 'ed25519' && algo !== 'rsa4096') throw new Error('Unsupported key type.');
  const expire = (r.expire ?? '2y').trim();
  if (!/^(?:0|\d{1,3}[dwmy]?)$/.test(expire)) throw new Error('Invalid expiry (use 0, 1y, 2y, 90d…).');
  const passphrase = r.passphrase ?? '';
  if (/[\r\n\0]/.test(passphrase)) throw new Error('The passphrase cannot contain line breaks.');
  return { name, email, algo, expire, passphrase };
}

export class GpgService {
  private detected: Promise<GpgDetectResult> | null = null;

  constructor(
    private readonly configured: () => string | undefined,
    private readonly d: GpgDeps = {},
  ) {}

  private get run(): GpgRun {
    return this.d.run ?? spawnGpg(this.d.env);
  }

  detect(force = false): Promise<GpgDetectResult> {
    if (force || !this.detected) {
      this.detected = detectGpg(this.configured(), this.d).catch((e: unknown) => {
        this.detected = null;
        throw e;
      });
    }
    return this.detected;
  }

  private async program(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const configured = this.configured()?.trim();
    if (configured) return configured;
    const r = await this.detect();
    if (!r.program) {
      throw new Error(
        'GnuPG was not found. Install Gpg4win (Windows), GPG Suite or `brew install gnupg` (macOS), or gnupg from your package manager (Linux), then set the GPG program.',
      );
    }
    return r.program;
  }

  async listKeys(explicit?: string): Promise<GpgKey[]> {
    const program = await this.program(explicit);
    const r = await this.run(program, [
      '--batch',
      '--with-colons',
      '--fixed-list-mode',
      '--keyid-format=long',
      '--list-secret-keys',
    ]);
    // exit 2 with empty output = no secret keyring yet
    if (r.code !== 0 && r.stdout.trim()) throw new Error(r.stderr.trim() || `gpg exited with ${r.code}`);
    return parseGpgColons(r.stdout);
  }

  async generateKey(req: GpgGenerateRequest): Promise<GpgKey> {
    const v = validateGenerateRequest(req);
    const program = await this.program();
    const r = await this.run(
      program,
      [
        '--batch',
        '--status-fd',
        '1',
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--quick-gen-key',
        `${v.name} <${v.email}>`,
        v.algo,
        'sign',
        v.expire,
      ],
      { stdin: `${v.passphrase}\n`, timeoutMs: 120_000 },
    );
    const fpr = /\[GNUPG:\] KEY_CREATED [BP] ([0-9A-F]{40,64})/.exec(r.stdout)?.[1];
    if (r.code !== 0 || !fpr) {
      throw new Error(
        `gpg could not create the key: ${r.stderr.trim().split('\n').pop() ?? `exit ${r.code}`}`,
      );
    }
    const key = (await this.listKeys(program)).find((k) => k.fingerprint === fpr);
    if (!key) throw new Error('The key was created but could not be listed.');
    return key;
  }

  async exportPublic(keyId: string): Promise<string> {
    if (!KEY_ID_RE.test(keyId)) throw new Error('Invalid key id.');
    const program = await this.program();
    const r = await this.run(program, ['--batch', '--armor', '--export', keyId.replace(/^0x/, '')]);
    const armored = r.stdout.trim();
    if (r.code !== 0 || !armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
      throw new Error(r.stderr.trim() || `No public key found for ${keyId}.`);
    }
    return `${armored}\n`;
  }
}
