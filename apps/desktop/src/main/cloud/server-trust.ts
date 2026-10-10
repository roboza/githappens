import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

import type { CertificateInfo } from '../../shared/ipc/cloud-contract';

/**
 * Self-signed / private-CA cloud servers (spec 14 §8 "certificate trust prompt"): the user explicitly
 * trusts ONE certificate (SHA-256 fingerprint of the leaf) for ONE server origin. The pin is consulted
 * by the network layer's verify proc only for that host and only when Chromium rejected the chain; a
 * changed certificate is rejected again until the user re-confirms. Pins live in
 * `<userData>/cloud/server-trust.json` (app-wide, like `cloud.serverUrl`).
 */

interface Pin {
  fingerprint256: string;
  subject: string;
  issuer: string;
  validTo: string;
  addedAt: string;
}

interface PinFile {
  version: 1;
  pins: Record<string, Pin>;
}

/** Minimal shape of Electron's verify request (see network/certs.ts). */
export interface TrustRequest {
  hostname?: string;
  certificate: { data: string };
  errorCode: number;
}

export type ProbeFn = (origin: URL) => Promise<CertificateInfo>;

/** `AA:BB:…` uppercase SHA-256 of DER bytes. */
export function fingerprintOfDer(der: Buffer): string {
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?!$)/g, '$1:');
}

export function fingerprintOfPem(pem: string): string | undefined {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) return undefined;
  return fingerprintOfDer(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'));
}

export function originOf(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Certificates only apply to https:// servers.');
  return new URL(u.origin);
}

/** TLS handshake WITHOUT verification, only to show the user what the server presents. */
export const probeTls: ProbeFn = (origin) =>
  new Promise((resolve, reject) => {
    const port = Number(origin.port || 443);
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const socket = tls.connect({
      host,
      port,
      servername: /^[\d.:]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: 10_000,
    });
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(false);
      const authorized = socket.authorized;
      const error = socket.authorizationError ? String(socket.authorizationError) : undefined;
      socket.end();
      if (!peer?.raw) return reject(new Error('The server did not present a certificate.'));
      let selfSigned = false;
      try {
        const x = new X509Certificate(peer.raw);
        selfSigned = x.checkIssued(x);
      } catch {
        /* informational */
      }
      resolve({
        origin: origin.origin,
        fingerprint256: fingerprintOfDer(peer.raw),
        subject: peer.subject?.CN ? String(peer.subject.CN) : JSON.stringify(peer.subject ?? {}),
        issuer: peer.issuer?.CN ? String(peer.issuer.CN) : JSON.stringify(peer.issuer ?? {}),
        validFrom: new Date(peer.valid_from).toISOString(),
        validTo: new Date(peer.valid_to).toISOString(),
        selfSigned,
        trustedBySystem: authorized,
        ...(error ? { error } : {}),
        pinned: false,
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('The server did not answer the TLS handshake.'));
    });
    socket.once('error', reject);
  });

export class ServerTrust {
  private cache: PinFile | null = null;
  constructor(
    private readonly file: () => string,
    private readonly probe: ProbeFn = probeTls,
  ) {}

  private read(): PinFile {
    if (this.cache) return this.cache;
    try {
      const f = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as PinFile;
      this.cache = f.version === 1 && f.pins && typeof f.pins === 'object' ? f : { version: 1, pins: {} };
    } catch {
      this.cache = { version: 1, pins: {} };
    }
    return this.cache;
  }

  private write(f: PinFile): void {
    this.cache = f;
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(f, null, 2), 'utf8');
  }

  list(): Array<{ origin: string } & Pin> {
    return Object.entries(this.read().pins).map(([origin, p]) => ({ origin, ...p }));
  }

  /** What the server presents now, plus whether it matches an existing pin. */
  async inspect(url: string): Promise<CertificateInfo> {
    const origin = originOf(url);
    const info = await this.probe(origin);
    const pin = this.read().pins[origin.origin];
    return { ...info, pinned: !!pin && pin.fingerprint256 === info.fingerprint256 };
  }

  /**
   * Explicit consent: pin `fingerprint256` for the server, but only if it is what the server presents
   * right now (the user confirmed the certificate they were shown).
   */
  async trust(url: string, fingerprint256: string): Promise<CertificateInfo> {
    const origin = originOf(url);
    const info = await this.probe(origin);
    if (info.fingerprint256 !== fingerprint256.toUpperCase())
      throw new Error('The server now presents a different certificate. Review it again before trusting it.');
    const f = this.read();
    this.write({
      version: 1,
      pins: {
        ...f.pins,
        [origin.origin]: {
          fingerprint256: info.fingerprint256,
          subject: info.subject,
          issuer: info.issuer,
          validTo: info.validTo,
          addedAt: new Date().toISOString(),
        },
      },
    });
    return { ...info, pinned: true };
  }

  untrust(url: string): void {
    const origin = originOf(url).origin;
    const f = this.read();
    if (!f.pins[origin]) return;
    const pins = { ...f.pins };
    delete pins[origin];
    this.write({ version: 1, pins });
  }

  /** Verify-proc trust source: the leaf matches the pin for this host. */
  verify(req: TrustRequest): boolean {
    if (req.errorCode === 0 || !req.hostname) return false;
    const pins = this.read().pins;
    const host = req.hostname.toLowerCase();
    const fp = fingerprintOfPem(req.certificate.data);
    if (!fp) return false;
    return Object.entries(pins).some(([origin, pin]) => {
      try {
        return (
          new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '') === host.replace(/^\[|\]$/g, '') &&
          pin.fingerprint256 === fp
        );
      } catch {
        return false;
      }
    });
  }
}
