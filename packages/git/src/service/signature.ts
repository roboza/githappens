import type { Sha } from '../types';
import type { GitService } from './git-service';

/**
 * Commit signature verification for "Verified" badges (spec 06 §6.8 `commit:verify`).
 * `%G?`: G good, B bad, U good/unknown validity, X expired sig, Y expired key,
 * R revoked key, E can't check (missing key / no gpg), N no signature.
 */
export type SignatureCode = 'G' | 'B' | 'U' | 'X' | 'Y' | 'R' | 'E' | 'N';

export interface SignatureInfo {
  code: SignatureCode;
  /** Signer name / identity (%GS). */
  signer?: string;
  /** Key id or fingerprint (%GK). */
  key?: string;
  /** 'openpgp' | 'ssh' | 'x509' guessed from the key format. */
  format?: 'openpgp' | 'ssh' | 'x509';
}

const SEP = '\x1f';
const MAX_BATCH = 200;

export function parseSignatureLog(stdout: string): Record<Sha, SignatureInfo> {
  const out: Record<Sha, SignatureInfo> = {};
  for (const rec of stdout.split('\x1e')) {
    const line = rec.replace(/^\s+/, '');
    if (!line) continue;
    const [sha, code, signer, key] = line.split(SEP);
    if (!sha || !code) continue;
    const info: SignatureInfo = { code: (code.trim() || 'N') as SignatureCode };
    if (signer?.trim()) info.signer = signer.trim();
    if (key?.trim()) {
      info.key = key.trim();
      info.format = /^SHA256:/.test(info.key)
        ? 'ssh'
        : /^[0-9A-F]{16,40}$/i.test(info.key)
          ? 'openpgp'
          : 'x509';
    }
    out[sha.trim()] = info;
  }
  return out;
}

export async function verifyCommits(service: GitService, shas: Sha[]): Promise<Record<Sha, SignatureInfo>> {
  const unique = [...new Set(shas.filter((s) => /^[0-9a-f]{7,64}$/i.test(s)))];
  const result: Record<Sha, SignatureInfo> = {};
  for (let i = 0; i < unique.length; i += MAX_BATCH) {
    const batch = unique.slice(i, i + MAX_BATCH);
    const r = await service.runRead(
      ['log', '--no-walk=unsorted', `--format=%x1e%H${SEP}%G?${SEP}%GS${SEP}%GK`, ...batch, '--'],
      { timeoutMs: 60_000 },
    );
    Object.assign(result, parseSignatureLog(String(r.stdout)));
  }
  return result;
}
