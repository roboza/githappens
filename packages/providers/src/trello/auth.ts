import { type AuthInfoFactory, normalizeHost } from '../auth/info';
import type { AuthDescriptor } from '../bitbucket/shared';

/**
 * Trello (spec 10 §6.1, spec 11 §6.4): a Power-Up API key plus a user token generated for that
 * key ("PAT-like" connect — the key goes in the username field, the token in the token field).
 * Requests carry `Authorization: OAuth oauth_consumer_key="{key}", oauth_token="{token}"`, so the
 * secret never ends up in a URL / log line.
 */
export const TRELLO_API_BASE = 'https://api.trello.com/1';

const quoteParam = (v: string): string => v.replace(/["\\]/g, '');

export const TRELLO_AUTH: AuthDescriptor & { tokenPageUrl(apiKey: string, appName?: string): string } = {
  kind: 'trello',
  defaultHost: 'trello.com',
  scopes: [],
  // Keys are created per Power-Up at trello.com/power-ups/admin; the token page needs the key.
  patPageUrl: () => 'https://trello.com/power-ups/admin',
  tokenPageUrl: (apiKey, appName = 'GitHappens') =>
    `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=${encodeURIComponent(appName)}&key=${encodeURIComponent(apiKey)}`,
  usernameForGit: '',
  apiBaseUrl: () => TRELLO_API_BASE,
  authHeader: (token, apiKey) =>
    apiKey
      ? `OAuth oauth_consumer_key="${quoteParam(apiKey)}", oauth_token="${quoteParam(token)}"`
      : `OAuth oauth_token="${quoteParam(token)}"`,
};

export const trelloAuthInfo: AuthInfoFactory = (rawHost) => ({
  kind: 'trello',
  host: normalizeHost(rawHost || 'trello.com'),
  scopes: [],
  patScopes: [],
  patPageUrl: TRELLO_AUTH.patPageUrl('trello.com'),
  usernameForGit: '',
  apiBaseUrl: TRELLO_API_BASE,
  headers: {},
  // The API key travels as the credential's username → TRELLO_AUTH.authHeader(token, key).
  authorization: (token) => TRELLO_AUTH.authHeader(token),
  oauth: 'none',
  refreshable: false,
  scopeSeparator: ',',
});

export const TRELLO_AUTH_INFO: Readonly<Record<string, AuthInfoFactory>> = { trello: trelloAuthInfo };

/** HttpClient `errorMessage` for Trello (plain-text bodies or `{ message }`). */
export function trelloErrorMessage(_status: number, body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim()) return body.trim();
  const m = (body as { message?: unknown } | undefined)?.message;
  return typeof m === 'string' && m ? m : undefined;
}
