/**
 * Patterns for credentials that must never land in plain JSON (spec 13 §5.1 "Secrets", §9 "No secret
 * ever written to plain JSON"). Used by settings export (values matching are omitted) and by the
 * userData secret scan test helper (`test/settings-secret-scan.ts`, e2e Phase 10).
 */

export interface SecretPattern {
  id: string;
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'gitlab-token', re: /\bgl(?:pat|oas|dt|rt|ptt|ft|imt|agent|cbt)-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'bitbucket-app-password', re: /\bATBB[A-Za-z0-9_-]{24,}\b/ },
  { id: 'atlassian-api-token', re: /\bATATT3[A-Za-z0-9_=-]{20,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'linear-key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  // scheme://user:password@host — credentials embedded in a URL (proxy, remote, …)
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+:[^/\s@"']+@[^\s"']+/i },
];

export interface SecretMatch {
  id: string;
  /** Matched text with the middle masked (safe to print in test output). */
  excerpt: string;
  index: number;
}

export const maskSecret = (s: string): string =>
  s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;

/** All pattern matches in `text`, plus literal occurrences of `known` secrets. */
export function findSecrets(text: string, known: readonly string[] = []): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    for (const m of text.matchAll(re)) {
      out.push({ id: p.id, excerpt: maskSecret(m[0]), index: m.index ?? 0 });
    }
  }
  for (const k of known) {
    if (k.length < 6) continue;
    for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) {
      out.push({ id: 'known-secret', excerpt: maskSecret(k), index: i });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export const looksSecret = (value: unknown): boolean =>
  findSecrets(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).length > 0;
