import { webcrypto } from 'node:crypto';

/** RFC 4648 §5 base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Cryptographically random base64url string from `bytes` random bytes (32 → 43 chars). */
export function randomToken(bytes = 32): string {
  return base64url(webcrypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 code challenge: BASE64URL(SHA256(ascii(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** New PKCE pair (verifier is 43 chars, within RFC 7636's 43–128). */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier), method: 'S256' };
}
