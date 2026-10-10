import { HttpClient, ProviderError } from '../http';
import { githubAuthInfo } from './info';
import { parseTokenResponse, type TokenSet } from './token';

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** seconds */
  expiresIn: number;
}

export interface GitHubDeviceFlowOptions {
  /** 'github.com' or a GHE host. */
  host: string;
  clientId: string;
  scopes: string[];
  /** Show the user code and open `verificationUri`. */
  onUserCode: (info: DeviceCodeInfo) => void | Promise<void>;
  signal?: AbortSignal;
  /** Defaults to a fresh client against https://{host}. */
  http?: HttpClient;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const cancelled = (): ProviderError =>
  new ProviderError({ code: 'auth_required', message: 'Sign-in was cancelled.' });

/**
 * GitHub OAuth device flow (no client secret): requests a device code, hands the user code to
 * the UI, then polls the token endpoint honoring `interval`, `authorization_pending` and
 * `slow_down` (+5s, or the server-provided interval) until success, denial or expiry.
 */
export async function runGitHubDeviceFlow(o: GitHubDeviceFlowOptions): Promise<TokenSet> {
  const info = githubAuthInfo(o.host);
  const web = `https://${info.host}`;
  const http = o.http ?? new HttpClient({ baseUrl: web, retries: 0, timeoutMs: 30_000 });
  const sleep = o.sleep ?? abortableSleep;
  const headers = { Accept: 'application/json' };

  const dc = await http.post<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
    error?: string;
    error_description?: string;
  }>(info.deviceCodeUrl!, new URLSearchParams({ client_id: o.clientId, scope: o.scopes.join(' ') }), {
    headers,
    signal: o.signal,
  });
  if (!dc?.device_code) {
    throw new ProviderError({
      code: dc?.error === 'device_flow_disabled' ? 'unsupported' : 'auth_required',
      message: dc?.error_description ?? 'Device flow could not be started.',
      providerMessage: dc?.error,
    });
  }
  await o.onUserCode({
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    verificationUriComplete: dc.verification_uri_complete,
    expiresIn: dc.expires_in,
  });

  let intervalMs = Math.max(1, dc.interval ?? 5) * 1000;
  const deadline = Date.now() + dc.expires_in * 1000;
  for (;;) {
    if (o.signal?.aborted) throw cancelled();
    await sleep(intervalMs, o.signal);
    if (Date.now() > deadline)
      throw new ProviderError({ code: 'auth_required', message: 'The device code expired.' });
    const r = await http.post<Record<string, unknown>>(
      info.tokenUrl!,
      new URLSearchParams({
        client_id: o.clientId,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      { headers, signal: o.signal },
    );
    const error = typeof r?.error === 'string' ? r.error : undefined;
    if (!error) return parseTokenResponse(r);
    switch (error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs = typeof r.interval === 'number' ? r.interval * 1000 : intervalMs + 5000;
        continue;
      case 'expired_token':
        throw new ProviderError({
          code: 'auth_required',
          message: 'The device code expired.',
          providerMessage: error,
        });
      case 'access_denied':
        throw new ProviderError({
          code: 'auth_required',
          message: 'Authorization was denied.',
          providerMessage: error,
        });
      default:
        throw new ProviderError({
          code: 'auth_required',
          message: typeof r.error_description === 'string' ? r.error_description : error,
          providerMessage: error,
        });
    }
  }
}
