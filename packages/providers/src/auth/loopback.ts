import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderError } from '../http';
import { buildAuthorizeUrl } from './info';
import { createPkce, randomToken } from './pkce';
import type { TokenSet } from './token';

export interface LoopbackOAuthOptions {
  authorizeUrl: string;
  clientId: string;
  scopes: string[];
  /** Exchanges the code (directly or via the broker). */
  tokenExchange: (code: string, codeVerifier: string, redirectUri: string) => Promise<TokenSet>;
  /** e.g. `shell.openExternal`. Never an embedded window. */
  openBrowser: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
  /** Default 5 minutes (spec 10 §4.1). */
  timeoutMs?: number;
  /** 0 = ephemeral (default); set when the provider demands an exact registered port. */
  port?: number;
  /** Default '/callback'. */
  callbackPath?: string;
  scopeSeparator?: string;
  extraParams?: Record<string, string>;
  /** Called with the authorize URL before the browser opens (for "Copy link"). */
  onAuthorizeUrl?: (url: string) => void;
  appName?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#1e1f22;color:#e6e6e6}
main{text-align:center;max-width:28rem}h1{font-size:1.25rem}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(html);
}

/**
 * RFC 8252 loopback OAuth: starts an HTTP server on 127.0.0.1 (ephemeral port), opens the
 * system browser on the authorize URL (PKCE S256 + random state), waits for
 * `/callback?code&state`, validates `state`, exchanges the code and shows a
 * "you can close this tab" page. Rejects on provider error, abort or timeout.
 * Requests with a wrong/missing state get a 400 and the flow keeps waiting.
 */
export async function runLoopbackOAuth(o: LoopbackOAuthOptions): Promise<TokenSet> {
  const app = o.appName ?? 'GitHappens';
  const callbackPath = o.callbackPath ?? '/callback';
  const state = randomToken(32);
  const pkce = await createPkce();
  if (o.signal?.aborted) throw cancelled();

  return new Promise<TokenSet>((resolve, reject) => {
    let settled = false;
    let handling = false;
    let redirectUri = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server = createServer((req, res) => void onRequest(req, res));

    const finish = (err: unknown, value?: TokenSet): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = (): void => finish(cancelled());

    async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== callbackPath) {
        send(res, 404, page('Not found', 'This address only handles the sign-in callback.'));
        return;
      }
      if (settled || handling) {
        send(res, 409, page('Already handled', `Sign-in was already processed. Return to ${app}.`));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        send(
          res,
          400,
          page('Invalid sign-in request', `The request did not match the sign-in started from ${app}.`),
        );
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        send(res, 400, page('Sign-in failed', desc));
        finish(
          new ProviderError({
            code: 'auth_required',
            message: error === 'access_denied' ? 'Authorization was denied in the browser.' : desc,
            providerMessage: error,
          }),
        );
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        send(res, 400, page('Invalid sign-in request', 'No authorization code was returned.'));
        return;
      }
      handling = true;
      try {
        const tokens = await o.tokenExchange(code, pkce.verifier, redirectUri);
        send(res, 200, page('Signed in', `You can close this tab and return to ${app}.`));
        finish(null, tokens);
      } catch (e) {
        send(res, 500, page('Sign-in failed', `Could not complete sign-in: ${(e as Error).message}`));
        finish(e);
      }
    }

    server.on('error', (e) =>
      finish(new ProviderError({ code: 'network', message: `Loopback server error: ${e.message}` })),
    );
    o.signal?.addEventListener('abort', onAbort, { once: true });

    server.listen(o.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}${callbackPath}`;
      const authorizeUrl = buildAuthorizeUrl({
        authorizeUrl: o.authorizeUrl,
        clientId: o.clientId,
        redirectUri,
        scopes: o.scopes,
        state,
        codeChallenge: pkce.challenge,
        scopeSeparator: o.scopeSeparator,
        extraParams: o.extraParams,
      });
      timer = setTimeout(
        () =>
          finish(
            new ProviderError({
              code: 'auth_required',
              message: 'Timed out waiting for the browser sign-in.',
            }),
          ),
        o.timeoutMs ?? 5 * 60_000,
      );
      try {
        o.onAuthorizeUrl?.(authorizeUrl);
        void Promise.resolve(o.openBrowser(authorizeUrl)).catch((e: unknown) => finish(e));
      } catch (e) {
        finish(e);
      }
    });
  });
}

function cancelled(): ProviderError {
  return new ProviderError({ code: 'auth_required', message: 'Sign-in was cancelled.' });
}
