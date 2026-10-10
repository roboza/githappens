import fs from 'node:fs';
import path from 'node:path';

/**
 * SSH signing helpers (spec 13 §6 "Signing — SSH"): `allowed_signers` entries in the format
 * `<email> namespaces="git" <keytype> <base64>` so `git log --show-signature` can verify SSH
 * signatures (`gpg.ssh.allowedSignersFile`).
 */

export interface SshPublicKey {
  type: string;
  base64: string;
  comment?: string;
}

const KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-dss)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

export function parsePublicKey(text: string): SshPublicKey | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  const m = line ? KEY_RE.exec(line.replace(/^key::/, '')) : null;
  return m ? { type: m[1]!, base64: m[2]!, comment: m[3]?.trim() || undefined } : null;
}

const PRINCIPAL_RE = /^[^\s@<>,"']+@[^\s@<>,"']+$/;

export function allowedSignersLine(email: string, key: SshPublicKey): string {
  const e = email.trim();
  if (!PRINCIPAL_RE.test(e)) throw new Error('A valid email is required for the allowed signers entry.');
  return `${e} namespaces="git" ${key.type} ${key.base64}`;
}

/** Append `line` unless an entry for the same principal and key already exists. */
export function upsertAllowedSigners(content: string, line: string): { content: string; added: boolean } {
  const [email, , type, b64] = line.split(/\s+/);
  const exists = content.split(/\r?\n/).some((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return false;
    const principals = t.split(/\s+/)[0]!.split(',');
    return principals.includes(email!) && t.includes(`${type} ${b64}`);
  });
  if (exists) return { content, added: false };
  const sep = content && !content.endsWith('\n') ? '\n' : '';
  return { content: `${content}${sep}${line}\n`, added: true };
}

const expandHome = (p: string, home: string): string =>
  p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(1)) : p;

/**
 * Public key from a `user.signingkey`-style value: `key::ssh-… AAAA`, a literal key, a `.pub` path,
 * or a private key path (its `.pub` sibling is read).
 */
export function resolveSshPublicKey(value: string, home: string): SshPublicKey {
  const v = value.trim();
  if (!v) throw new Error('Choose an SSH signing key (a .pub file) first.');
  const literal = parsePublicKey(v);
  if (literal) return literal;
  const p = expandHome(v, home);
  for (const candidate of p.endsWith('.pub') ? [p] : [`${p}.pub`, p]) {
    let text: string;
    try {
      if (fs.statSync(candidate).size > 64 * 1024) continue;
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const k = parsePublicKey(text);
    if (k) return k;
  }
  throw new Error(`No SSH public key found at ${p}.`);
}

/** Create / append `file` (default `~/.ssh/allowed_signers`). */
export function writeAllowedSigners(o: { file: string; email: string; key: SshPublicKey }): {
  file: string;
  line: string;
  added: boolean;
} {
  const line = allowedSignersLine(o.email, o.key);
  let content = '';
  try {
    content = fs.readFileSync(o.file, 'utf8');
  } catch {
    /* new file */
  }
  const r = upsertAllowedSigners(content, line);
  if (r.added) {
    fs.mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(o.file, r.content, { mode: 0o644 });
  }
  return { file: o.file, line, added: r.added };
}

export const defaultAllowedSignersFile = (home: string): string => path.join(home, '.ssh', 'allowed_signers');
export { expandHome };

/** `git version 2.45.1.windows.1` → true when ≥ 2.34 (SSH signing support). */
export function gitSupportsSshSigning(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 2 || (maj === 2 && min >= 34);
}
