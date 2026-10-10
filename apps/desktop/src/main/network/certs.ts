import fs from 'node:fs';

/**
 * TLS options (spec 09 §6.11 "Certificates", spec 13 Network).
 *
 * Git: Windows "Use OS certificate store" → `http.sslBackend=schannel`; custom CA → `http.sslCAInfo=<path>`.
 * schannel ignores `sslCAInfo` unless `http.schannelUseSSLCAInfo` is set, and that would replace the Windows
 * store — so with both on we keep the OS store and report that the bundle is not used by git.
 *
 * Electron (provider APIs, AI, cloud, updater): Chromium already trusts the OS store. A custom bundle is
 * honoured through `session.setCertificateVerifyProc`: a chain Chromium rejected is accepted when one of its
 * certificates is in the bundle.
 */

export interface TlsPrefs {
  useOsCertStore: boolean;
  caBundlePath: string;
}

export interface GitTlsConfig {
  config: Array<[string, string]>;
  warnings: string[];
}

export function gitTlsConfig(
  prefs: TlsPrefs,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = fs.existsSync,
): GitTlsConfig {
  const config: Array<[string, string]> = [];
  const warnings: string[] = [];
  const schannel = platform === 'win32' && prefs.useOsCertStore;
  if (schannel) config.push(['http.sslBackend', 'schannel']);
  const ca = prefs.caBundlePath.trim();
  if (ca) {
    if (!exists(ca)) warnings.push(`The CA bundle ${ca} does not exist.`);
    else if (schannel) {
      warnings.push(
        'Git uses the Windows certificate store, so the custom CA bundle is not used for git. Import the CA into Windows, or turn the OS store off.',
      );
    } else config.push(['http.sslCAInfo', ca]);
  }
  return { config, warnings };
}

/** Base64 DER bodies of every certificate in a PEM bundle (whitespace removed). */
export function pemBodies(pem: string): string[] {
  const out: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(pem); m; m = re.exec(pem)) {
    const body = m[1]!.replace(/\s+/g, '');
    if (body) out.push(body);
  }
  return out;
}

/** Minimal shape of Electron's `Certificate` used here. */
export interface CertificateLike {
  data: string;
  issuerCert?: CertificateLike | null;
}

export interface VerifyRequestLike {
  /** Electron passes the host name being verified (used by per-host pins, e.g. the cloud server). */
  hostname?: string;
  certificate: CertificateLike;
  errorCode: number;
}

/**
 * Extra trust decision plugged into the verify proc by other features (spec 14 self-signed cloud server
 * pins): true = trust this chain although Chromium rejected it. Never consulted for chains Chromium
 * accepted.
 */
export type TrustSource = (req: VerifyRequestLike) => boolean;

/**
 * `session.setCertificateVerifyProc` callback: 0 = trust, -3 = use Chromium's own verdict. Only chains that
 * Chromium rejected and that contain a certificate from the bundle are overridden.
 */
export function createCertificateVerifyProc(
  bundle: () => ReadonlySet<string>,
): (req: VerifyRequestLike, callback: (code: number) => void) => void {
  return (req, callback) => {
    if (req.errorCode === 0) return callback(-3);
    const trusted = bundle();
    if (!trusted.size) return callback(-3);
    let cert: CertificateLike | null | undefined = req.certificate;
    for (let depth = 0; cert && depth < 10; depth++) {
      const body = pemBodies(cert.data)[0];
      if (body && trusted.has(body)) return callback(0);
      if (cert.issuerCert === cert) break;
      cert = cert.issuerCert;
    }
    callback(-3);
  };
}
