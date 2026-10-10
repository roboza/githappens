import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execTool, type ExecResult } from './ssh-tools';

/** SSH key generation and inspection (spec 09 §6.7 "Generate key", spec 13 SSH, spec 10 §6.5). */

export type SshKeyType = 'ed25519' | 'rsa-4096';

export interface PublicKeyInfo {
  publicKey: string;
  /** `SHA256:<base64>` like `ssh-keygen -l`. */
  fingerprint: string;
  /** Key algorithm from the public key line, e.g. `ssh-ed25519`. */
  algorithm: string;
  comment: string;
}

export interface GeneratedKey extends PublicKeyInfo {
  privateKeyPath: string;
  publicKeyPath: string;
}

const KEY_LINE =
  /^((?:sk-)?(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521))(?:@openssh\.com)?)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

/** Parse one OpenSSH public key line and compute its SHA256 fingerprint. Throws on invalid input. */
export function parsePublicKey(text: string): PublicKeyInfo {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  const m = line ? KEY_LINE.exec(line) : null;
  if (!m) throw new Error('Not an OpenSSH public key.');
  const blob = Buffer.from(m[2]!, 'base64');
  if (!blob.length) throw new Error('Not an OpenSSH public key.');
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { publicKey: line!, fingerprint, algorithm: m[1]!, comment: m[3]?.trim() ?? '' };
}

export async function readPublicKey(publicKeyPath: string): Promise<PublicKeyInfo> {
  const text = await fs.promises.readFile(publicKeyPath, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new Error(
      e.code === 'ENOENT' ? `Public key not found: ${publicKeyPath}` : `Could not read ${publicKeyPath}`,
    );
  });
  return parsePublicKey(text);
}

/** `~/.ssh/githappens_ed25519` (never an existing file: `_2`, `_3`… are appended — spec 10 §6.5). */
export function defaultKeyPath(type: SshKeyType, home = os.homedir(), exists = fs.existsSync): string {
  return uniqueKeyPath(
    path.join(home, '.ssh', `githappens_${type === 'rsa-4096' ? 'rsa' : 'ed25519'}`),
    exists,
  );
}

export function uniqueKeyPath(p: string, exists: (p: string) => boolean = fs.existsSync): string {
  const taken = (c: string): boolean => exists(c) || exists(`${c}.pub`);
  if (!taken(p)) return p;
  for (let i = 2; i < 1000; i++) if (!taken(`${p}_${i}`)) return `${p}_${i}`;
  throw new Error('Could not find a free key file name.');
}

export function expandHome(p: string, home = os.homedir()): string {
  const t = p.trim();
  return t === '~' || t.startsWith('~/') || t.startsWith('~\\') ? path.join(home, t.slice(1)) : t;
}

/** argv for `ssh-keygen` (exported for tests). The passphrase is an argv value: no shell is involved. */
export function keygenArgs(o: {
  type: SshKeyType;
  comment: string;
  path: string;
  passphrase: string;
}): string[] {
  const typeArgs = o.type === 'rsa-4096' ? ['-t', 'rsa', '-b', '4096'] : ['-t', 'ed25519'];
  return ['-q', ...typeArgs, '-C', o.comment, '-f', o.path, '-N', o.passphrase];
}

export interface GenerateOptions {
  keygen: string;
  type: SshKeyType;
  comment: string;
  /** Empty or omitted = no passphrase. */
  passphrase?: string;
  path: string;
  platform?: NodeJS.Platform;
  /** Test seam. */
  exec?: (file: string, args: string[]) => Promise<ExecResult>;
}

export async function generateSshKey(o: GenerateOptions): Promise<GeneratedKey> {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? ((f: string, a: string[]) => execTool(f, a, { timeoutMs: 60_000 }));
  if (o.type !== 'ed25519' && o.type !== 'rsa-4096') throw new Error('Unsupported key type.');
  const comment = o.comment.trim();
  if (/[\0\r\n]/.test(comment) || comment.length > 256) throw new Error('Invalid key comment.');
  const passphrase = o.passphrase ?? '';
  if (/[\0\r\n]/.test(passphrase)) throw new Error('The passphrase must not contain line breaks.');
  if (passphrase && passphrase.length < 5)
    throw new Error('Use a passphrase of at least 5 characters, or none.');
  const keyPath = path.resolve(expandHome(o.path));
  if (path.basename(keyPath).startsWith('-')) throw new Error('Invalid key file name.');
  if (fs.existsSync(keyPath) || fs.existsSync(`${keyPath}.pub`)) {
    throw new Error(`A key already exists at ${keyPath}. Choose another file name.`);
  }
  await fs.promises.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  const r = await exec(o.keygen, keygenArgs({ type: o.type, comment, path: keyPath, passphrase }));
  if (r.exitCode !== 0 || !fs.existsSync(`${keyPath}.pub`)) {
    const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(' ');
    throw new Error(`ssh-keygen failed${detail ? `: ${detail}` : ''}`);
  }
  await restrictKeyPermissions(keyPath, platform, exec);
  const info = await readPublicKey(`${keyPath}.pub`);
  return { ...info, privateKeyPath: keyPath, publicKeyPath: `${keyPath}.pub` };
}

/**
 * POSIX: 600 private / 644 public. Windows: drop inherited ACEs and grant only the current user
 * (`icacls <key> /inheritance:r /grant:r <user>:F`), which Windows OpenSSH requires. Best effort.
 */
export async function restrictKeyPermissions(
  keyPath: string,
  platform: NodeJS.Platform = process.platform,
  exec: (file: string, args: string[]) => Promise<ExecResult> = (f, a) => execTool(f, a),
): Promise<void> {
  if (platform !== 'win32') {
    await fs.promises.chmod(keyPath, 0o600).catch(() => undefined);
    await fs.promises.chmod(`${keyPath}.pub`, 0o644).catch(() => undefined);
    return;
  }
  const user = process.env.USERNAME || os.userInfo().username;
  if (!user) return;
  const icacls = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  await exec(icacls, [keyPath, '/inheritance:r', '/grant:r', `${user}:F`]).catch(() => undefined);
}
