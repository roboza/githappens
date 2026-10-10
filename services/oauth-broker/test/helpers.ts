import { type AddressInfo } from 'node:net';
import { type Server } from 'node:http';
import { type BrokerConfig, makeConfig } from '../src/config.ts';
import { type LogEntry } from '../src/logger.ts';
import { createBroker, type FetchLike } from '../src/server.ts';

export const SECRETS = {
  github: 'gh-secret-0123456789abcdef',
  ghe: 'ghe-secret-0123456789abcdef',
  gitlab: 'gl-secret-0123456789abcdef',
  gitlabSm: 'glsm-secret-0123456789abcdef',
  bitbucket: 'bb-secret-0123456789abcdef',
  atlassian: 'atl-secret-0123456789abcdef',
  azure: 'az-secret-0123456789abcdef',
};

export const CODE = 'auth-code-SENSITIVE-7f3a9c';
export const VERIFIER = 'verifier-SENSITIVE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const REFRESH = 'refresh-token-SENSITIVE-55aa';
export const ACCESS = 'access-token-SENSITIVE-99ff';
export const REDIRECT = 'http://127.0.0.1:49152/callback';

export function fullConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return makeConfig({
    port: 0,
    host: '127.0.0.1',
    providers: {
      github: { clientId: 'gh-client', clientSecret: SECRETS.github },
      gitlab: { clientId: 'gl-client', clientSecret: SECRETS.gitlab },
      bitbucket: { clientId: 'bb-client', clientSecret: SECRETS.bitbucket },
      atlassian: { clientId: 'atl-client', clientSecret: SECRETS.atlassian },
      'azure-devops': { clientId: 'az-client', clientSecret: SECRETS.azure },
    },
    gheHosts: { 'ghe.example.com': { clientId: 'ghe-client', clientSecret: SECRETS.ghe } },
    gitlabHosts: { 'gitlab.example.com': { clientId: 'glsm-client', clientSecret: SECRETS.gitlabSm } },
    upstreamTimeoutMs: 500,
    ...overrides,
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Responder = (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const tokenOk: Responder = () =>
  jsonResponse({
    access_token: ACCESS,
    token_type: 'Bearer',
    refresh_token: REFRESH,
    expires_in: 7200,
    scope: 'api read_user',
  });

export interface TestBroker {
  url: string;
  server: Server;
  calls: RecordedCall[];
  logs: LogEntry[];
  setResponder(r: Responder): void;
  clock: { now: number };
  close(): Promise<void>;
}

export async function startBroker(config: BrokerConfig = fullConfig()): Promise<TestBroker> {
  const calls: RecordedCall[] = [];
  const logs: LogEntry[] = [];
  const clock = { now: 1_000_000 };
  let responder: Responder = tokenOk;
  const fetchMock: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return responder(call, init.signal ?? undefined);
  };
  const server = createBroker(config, {
    fetch: fetchMock,
    logSink: (e) => logs.push(e),
    now: () => clock.now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    calls,
    logs,
    clock,
    setResponder: (r) => {
      responder = r;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}
