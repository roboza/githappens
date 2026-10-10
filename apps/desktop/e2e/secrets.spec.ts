import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { scanUserDataForSecrets } from '../test/settings-secret-scan';
import { devLogin, startCloudServer, type CloudServer } from './cloud-server';

/**
 * Phase 10 security verification (spec 00 §2, spec 13 §9, spec 15 §9): every credential the user can
 * enter offline goes to the SecretStore only — never to plain files under userData, never back to the
 * renderer. One app session enters a unique random marker through each path, against local fakes:
 *
 *   1. AI provider API key        Preferences → AI, OpenAI-compatible server on 127.0.0.1 (Test connection)
 *   2. Integration PAT            Preferences → Integrations → GitHub Enterprise, host `ghe.e2e.test`;
 *                                 the main-process `fetch` is re-pointed from https://ghe.e2e.test to a
 *                                 local HTTP fake (the providers only speak https)
 *   3. GitHappens Cloud sign-in   the real services/cloud backend (dev IdP); access/refresh tokens are
 *                                 captured from the token response in main and become markers
 *   4. Git HTTP login "Remember"  askpass prompt for a smart-HTTP remote (`git http-backend` behind Basic
 *                                 auth); a second fetch proves it was saved and served from the store
 *   5. Proxy login                Preferences → Network, manual proxy + Proxy login form
 *
 * While running: markers never appear in the DOM, input values, web storage, IndexedDB names, the React
 * tree (incl. TanStack Query cache / zustand selections), IPC events sent to the renderer, or the results
 * of the read-only status/list invoke channels. After quitting: a byte scan of the whole userData folder
 * (every file, Chromium caches and LevelDB included) and of the repo's .git folder finds no marker in
 * raw, base64, base64url, URL-encoded, UTF-16LE or Basic-auth form.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const shots = path.join(appDir, 'test-results');
const GHE_HOST = 'ghe.e2e.test';
const GIT_USER = 'e2e-user';
const PROXY_USER = 'e2e-proxy-user';

const hex = (n: number): string => randomBytes(n).toString('hex');
const alnum = (n: number): string => {
  let s = '';
  while (s.length < n)
    s += randomBytes(n)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '');
  return s.slice(0, n);
};

const AI_KEY = `sk-e2e${hex(24)}`;
const GHE_PAT = `ghp_${alnum(36)}`;
const GIT_PASSWORD = `klgit-${hex(16)}`;
const PROXY_PASSWORD = `klproxy-${hex(16)}`;
/** Cloud tokens are minted by the server; filled in from the captured token responses. */
const cloudTokens: string[] = [];
const markers = (): string[] => [AI_KEY, GHE_PAT, GIT_PASSWORD, PROXY_PASSWORD, ...cloudTokens];

let tmp: string;
let userData: string;
let clone: string;
let app: ElectronApplication;
let page: Page;
let cloud: CloudServer;
const servers: http.Server[] = [];
const aiAuth: string[] = [];
const gheAuth: string[] = [];
const gitAuth: string[] = [];

const quiet = { stdio: 'ignore' } as const;
const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function listen(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}

/** OpenAI-compatible chat completions (SSE) that answers "OK". */
const aiServer = (): Promise<number> =>
  listen((req, res) => {
    req.resume();
    req.on('end', () => {
      aiAuth.push(String(req.headers.authorization ?? ''));
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });

/** GitHub Enterprise REST v3: `/api/v3/user` for token validation, 404 for everything else. */
const gheServer = (): Promise<number> =>
  listen((req, res) => {
    req.resume();
    gheAuth.push(String(req.headers.authorization ?? ''));
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${GHE_PAT}`) return json(401, { message: 'Bad credentials' });
    if (req.url === '/api/v3/user') {
      return json(
        200,
        { id: 4242, login: 'e2e-octo', name: 'E2E Octo', avatar_url: '' },
        { 'x-oauth-scopes': 'repo, read:org, read:user, user:email, workflow, write:public_key' },
      );
    }
    json(404, { message: 'Not Found' });
  });

/** Smart-HTTP git remote: `git http-backend` as CGI behind HTTP Basic auth. */
const gitServer = (projectRoot: string): Promise<number> =>
  listen((req, res) => {
    const expected = `Basic ${Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString('base64')}`;
    gitAuth.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== expected) {
      req.resume();
      res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"' }).end();
      return;
    }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(u.pathname),
      QUERY_STRING: u.search.replace(/^\?/, ''),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      REMOTE_USER: GIT_USER,
      REMOTE_ADDR: '127.0.0.1',
      GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
    };
    const cgi = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on('data', (c: Buffer) => out.push(c));
    cgi.on('close', () => {
      const all = Buffer.concat(out);
      let sep = all.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sep < 0) {
        sep = all.indexOf('\n\n');
        sepLen = 2;
      }
      if (sep < 0) {
        res.writeHead(500).end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of all.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers).end(all.subarray(sep + sepLen));
    });
  });

const prefsDialog = (): ReturnType<Page['getByRole']> => page.getByRole('dialog', { name: 'Preferences' });

async function openPrefs(section: string): Promise<ReturnType<Page['getByRole']>> {
  const prefs = prefsDialog();
  if (!(await prefs.isVisible())) await page.getByRole('button', { name: 'Preferences' }).click();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: section, exact: true })
    .click();
  return prefs;
}

async function closePrefs(): Promise<void> {
  const prefs = prefsDialog();
  if (await prefs.isVisible()) await prefs.getByRole('button', { name: 'Close preferences' }).click();
  await expect(prefs).toBeHidden();
}

/** `window.api.invoke` from the page, unwrapped like the renderer's own `invoke` (throws on `ok: false`). */
async function invoke(channel: string, req: unknown = {}): Promise<unknown> {
  const r = (await page.evaluate(
    ([c, q]) =>
      (window as unknown as { api: { invoke(c: string, r: unknown): Promise<unknown> } }).api.invoke(c, q),
    [channel, req] as const,
  )) as { ok: boolean; data?: unknown; error?: { message?: string } };
  if (!r.ok) throw new Error(`${channel}: ${r.error?.message ?? 'failed'}`);
  return r.data;
}

/** Every encoding a marker could plausibly be persisted in. */
function needles(): Array<{ label: string; bytes: Buffer }> {
  const out: Array<{ label: string; bytes: Buffer }> = [];
  const add = (label: string, s: string, enc: BufferEncoding = 'utf8'): void => {
    if (s.length >= 6) out.push({ label, bytes: Buffer.from(s, enc) });
  };
  const named: Array<[string, string]> = [
    ['ai-key', AI_KEY],
    ['ghe-pat', GHE_PAT],
    ['git-password', GIT_PASSWORD],
    ['proxy-password', PROXY_PASSWORD],
    ...cloudTokens.map((t, i) => [`cloud-token-${i}`, t] as [string, string]),
  ];
  for (const [name, m] of named) {
    add(`${name} raw`, m);
    add(`${name} utf16le`, m, 'utf16le');
    add(`${name} base64`, Buffer.from(m).toString('base64').replace(/=+$/, ''));
    add(`${name} base64url`, Buffer.from(m).toString('base64url'));
    if (encodeURIComponent(m) !== m) add(`${name} urlencoded`, encodeURIComponent(m));
  }
  add('git basic-auth', Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString('base64').replace(/=+$/, ''));
  add(
    'proxy basic-auth',
    Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64').replace(/=+$/, ''),
  );
  add('proxy url-credentials', `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASSWORD)}@`);
  return out;
}

/** Byte-level scan of every file under `dir` (no skipped folders, binaries included). */
function scanBytes(dir: string): string[] {
  const hits: string[] = [];
  const list = needles();
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let buf: Buffer;
        try {
          buf = fs.readFileSync(p);
        } catch {
          continue; // locked by another process; reported below via the file count only
        }
        for (const n of list) if (buf.includes(n.bytes)) hits.push(`${path.relative(dir, p)}: ${n.label}`);
      }
    }
  };
  walk(dir);
  return hits;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n++;
  return n;
}

// -----------------------------------------------------------------------------------------------------

let aiPort = 0;
let ghePort = 0;
let gitPort = 0;

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sec-')));
  userData = path.join(tmp, 'userData');

  // a bare remote served over smart HTTP, and a clone whose origin points at it
  const srv = path.join(tmp, 'srv');
  const bare = path.join(srv, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], quiet);
  const seedDir = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', pathToFileURL(bare).href, seedDir], quiet);
  const seed = gitIn(seedDir);
  seed('config', 'user.name', 'E2E');
  seed('config', 'user.email', 'e2e@example.com');
  seed('config', 'commit.gpgsign', 'false');
  seed('checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# Secrets e2e\n');
  seed('add', '-A');
  seed('commit', '-q', '-m', 'Initial commit');
  seed('push', '-q', 'origin', 'main');
  clone = path.join(tmp, 'clone');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', pathToFileURL(bare).href, clone], quiet);
  // the remote moves on, so the first fetch has something to bring in
  fs.writeFileSync(path.join(seedDir, 'more.txt'), 'more\n');
  seed('add', '-A');
  seed('commit', '-q', '-m', 'Remote moves on');
  seed('push', '-q', 'origin', 'main');

  [aiPort, ghePort, gitPort] = await Promise.all([aiServer(), gheServer(), gitServer(srv)]);
  gitIn(clone)('remote', 'set-url', 'origin', `http://127.0.0.1:${gitPort}/remote.git`);
  cloud = await startCloudServer(path.join(tmp, 'cloud-data'));

  // No system / user git config: no Git Credential Manager popping up, only GitHappens' askpass chain.
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(
    globalConfig,
    '[user]\n\tname = E2E\n\temail = e2e@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', clone],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: userData,
      ELECTRON_RENDERER_URL: '',
      GH_OAUTH_GITHUB_CLIENT_ID: '',
      GH_OAUTH_BROKER_URL: '',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GCM_INTERACTIVE: 'never',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 30_000 });

  // Main-process hooks: re-point https://ghe.e2e.test at the local fake, capture cloud token responses,
  // record every IPC event sent to renderers, and stub the system browser.
  await app.evaluate(
    ({ BrowserWindow, shell }, o) => {
      const g = globalThis as unknown as { __klSent: string[]; __klTokens: string[]; __klOpened: string[] };
      g.__klSent = [];
      g.__klTokens = [];
      g.__klOpened = [];
      const orig = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(o.from)) {
          url = o.to + url.slice(o.from.length);
          input = typeof input === 'string' || input instanceof URL ? url : new Request(url, input);
        }
        const res = await orig(input, init);
        if (url.includes('/oauth/token')) g.__klTokens.push(await res.clone().text());
        return res;
      }) as typeof fetch;
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      const proto = Object.getPrototypeOf(wc) as { send(this: unknown, ch: string, ...a: unknown[]): void };
      const send = proto.send;
      proto.send = function (this: unknown, ch: string, ...args: unknown[]) {
        try {
          const s = JSON.stringify(args);
          if (s.length < 2_000_000) g.__klSent.push(`${ch} ${s}`);
        } catch {
          /* not serializable */
        }
        return send.call(this, ch, ...args);
      };
      shell.openExternal = (async (url: string) => {
        g.__klOpened.push(url);
      }) as typeof shell.openExternal;
    },
    { from: `https://${GHE_HOST}/`, to: `http://127.0.0.1:${ghePort}/` },
  );
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await cloud?.stop();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('secrets entered through every path stay in the SecretStore', async () => {
  test.setTimeout(120_000);

  // ---- 1. AI provider API key --------------------------------------------------------------------
  let prefs = await openPrefs('AI');
  await prefs.getByRole('checkbox', { name: 'Enable AI features' }).check();
  await prefs.getByRole('combobox', { name: 'Provider' }).selectOption('openai-compatible');
  const model = prefs.getByRole('combobox', { name: 'Model' });
  await model.fill('test-model');
  await model.blur();
  const endpoint = prefs.getByRole('textbox', { name: /^Endpoint URL/ });
  await endpoint.fill(`http://127.0.0.1:${aiPort}/v1`);
  await endpoint.blur();
  await prefs.getByLabel(/API key$/).fill(AI_KEY);
  await prefs.getByRole('button', { name: 'Save key' }).click();
  await expect(prefs.getByText('stored encrypted on this computer')).toBeVisible();
  await expect(prefs.getByLabel(/API key$/)).toHaveValue('');
  await prefs.getByRole('button', { name: 'Test connection' }).click();
  await expect(prefs.getByText(/Connected \(\d+ ms\)/)).toBeVisible({ timeout: 15_000 });
  expect(aiAuth).toContain(`Bearer ${AI_KEY}`);

  // ---- 2. Integration personal access token (GitHub Enterprise on a custom host) -----------------
  prefs = await openPrefs('Integrations');
  await prefs
    .getByRole('list', { name: 'Integrations' })
    .getByRole('button', { name: /GitHub Enterprise/ })
    .click();
  await prefs.getByRole('textbox', { name: 'Server URL' }).fill(`https://${GHE_HOST}`);
  await prefs.locator('input[type="password"]').fill(GHE_PAT);
  await prefs.getByRole('button', { name: 'Connect with token' }).click();
  await expect(prefs.getByText(new RegExp(`${GHE_HOST} · Personal access token`))).toBeVisible({
    timeout: 15_000,
  });
  expect(gheAuth).toContain(`Bearer ${GHE_PAT}`);

  // ---- 3. GitHappens Cloud sign-in (dev IdP) -----------------------------------------------------
  prefs = await openPrefs('Account');
  const account = prefs.getByTestId('account-panel');
  await account.getByRole('textbox', { name: 'Cloud server address' }).fill(cloud.url);
  await account.getByRole('button', { name: 'Validate' }).click();
  await expect(account.getByRole('status').filter({ hasText: 'Developer login' })).toBeVisible();
  await account.getByRole('button', { name: 'Save', exact: true }).click();
  await account.getByRole('button', { name: 'Continue with Developer login' }).click();
  let authorize = '';
  await expect
    .poll(async () => {
      const opened = await app.evaluate(() => (globalThis as unknown as { __klOpened: string[] }).__klOpened);
      authorize = opened.find((u) => u.includes('/oauth/authorize')) ?? '';
      return authorize;
    })
    .toContain('/oauth/authorize?');
  const callback = await devLogin(authorize, 'sec@example.com', 'Sec Tester');
  expect((await fetch(callback)).ok).toBe(true);
  await expect(page.getByRole('button', { name: 'Account: Sec Tester' })).toBeVisible({ timeout: 15_000 });
  const tokenBodies = await app.evaluate(
    () => (globalThis as unknown as { __klTokens: string[] }).__klTokens,
  );
  for (const body of tokenBodies) {
    const t = JSON.parse(body) as { access_token?: string; refresh_token?: string };
    for (const v of [t.access_token, t.refresh_token]) if (v && !cloudTokens.includes(v)) cloudTokens.push(v);
  }
  expect(cloudTokens.length).toBeGreaterThan(0);
  await closePrefs();

  // ---- 4. Git HTTP(S) login typed into the askpass prompt with "Remember" -------------------------
  await invoke('settings:set', { key: 'git.useCredentialHelpers', value: false });
  const fetchAll = async (): Promise<void> => {
    await page.getByRole('grid', { name: 'Commit graph' }).click();
    await page.keyboard.press('Control+p');
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await page.keyboard.type('fetch all');
    await page.keyboard.press('Enter');
  };
  await fetchAll();
  const userPrompt = page.getByRole('dialog', { name: 'Username required' });
  await expect(userPrompt).toBeVisible({ timeout: 20_000 });
  await userPrompt.getByRole('textbox').fill(GIT_USER);
  await userPrompt.getByRole('textbox').press('Enter');
  const pwPrompt = page.getByRole('dialog', { name: 'Password required' });
  await expect(pwPrompt).toBeVisible({ timeout: 20_000 });
  await expect(pwPrompt.getByRole('checkbox')).toBeChecked(); // "Remember" is the default
  await pwPrompt.locator('input[type="password"]').fill(GIT_PASSWORD);
  await pwPrompt.locator('input[type="password"]').press('Enter');
  await expect
    .poll(() => gitIn(clone)('rev-parse', 'origin/main'), { timeout: 20_000 })
    .toBe(gitIn(path.join(tmp, 'seed'))('rev-parse', 'HEAD'));
  // the saved login answers the next fetch without a prompt
  await expect
    .poll(async () => JSON.stringify(await invoke('cred:list')), { timeout: 10_000 })
    .toContain('127.0.0.1');
  const authsBefore = gitAuth.length;
  await fetchAll();
  await expect
    .poll(() => gitAuth.slice(authsBefore).some((a) => a.startsWith('Basic ')), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(page.getByRole('dialog', { name: /required$/ })).toHaveCount(0);

  // ---- 5. Proxy login --------------------------------------------------------------------------
  // A proxy URL with embedded credentials is rejected by the settings schema (never stored in JSON).
  await expect(
    invoke('settings:set', {
      key: 'network.proxyUrl',
      value: `http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:9`,
    }),
  ).rejects.toThrow(/Invalid value/);
  await invoke('settings:set', { key: 'network.proxyUrl', value: 'http://127.0.0.1:9' });
  await invoke('settings:set', { key: 'network.proxyMode', value: 'manual' });
  prefs = await openPrefs('Network');
  const login = prefs.getByRole('region', { name: 'Proxy login' });
  await login.getByRole('textbox', { name: 'User name' }).fill(PROXY_USER);
  await login.getByLabel('Password').fill(PROXY_PASSWORD);
  await login.getByRole('button', { name: 'Save login' }).click();
  await expect(login.getByText(`Saved login ${PROXY_USER} for 127.0.0.1:9`)).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'secrets-proxy-login.png') });
  // back to a direct connection so nothing else is routed to the dead proxy
  await invoke('settings:set', { key: 'network.proxyMode', value: 'none' });
  await closePrefs();

  // ---- Renderer can't obtain any secret -----------------------------------------------------------
  const all = markers();
  expect(all.length).toBeGreaterThanOrEqual(5);
  const rendererHits = await page.evaluate(async (ms) => {
    const hits: string[] = [];
    const check = (where: string, s: string): void => {
      for (const m of ms) if (s.includes(m)) hits.push(`${where}: ${m.slice(0, 6)}…`);
    };
    check('DOM', document.documentElement.outerHTML);
    for (const el of document.querySelectorAll('input, textarea'))
      check('input value', (el as HTMLInputElement).value);
    const dump = (st: Storage): string =>
      JSON.stringify(Array.from({ length: st.length }, (_, i) => [st.key(i), st.getItem(st.key(i)!)]));
    check('localStorage', dump(localStorage));
    check('sessionStorage', dump(sessionStorage));
    check('cookie', document.cookie);
    check('IndexedDB', JSON.stringify(await indexedDB.databases()));
    check('window.name', window.name);
    // React tree: every string reachable from the fiber root (props, hook state, TanStack Query cache,
    // zustand selections). DOM nodes are covered by the outerHTML/input checks above.
    const root = document.getElementById('root') as unknown as Record<string, unknown> | null;
    const key = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer$')) : undefined;
    const seen = new WeakSet<object>();
    let budget = 3_000_000;
    let strings = 0;
    const stack: unknown[] = key ? [root![key]] : [];
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (typeof v === 'string') {
        strings++;
        check('React state', v);
        continue;
      }
      if (!v || typeof v !== 'object' || seen.has(v) || v instanceof Node) continue;
      seen.add(v);
      try {
        if (v instanceof Map) for (const [k, x] of v) stack.push(k, x);
        else if (v instanceof Set) for (const x of v) stack.push(x);
        else for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
      } catch {
        /* exotic object */
      }
    }
    return { hits, strings, walked: !!key };
  }, all);
  expect(rendererHits.walked).toBe(true);
  expect(rendererHits.strings).toBeGreaterThan(1000);
  expect(rendererHits.hits).toEqual([]);

  // read-only status / list channels the renderer may call
  const channels = [
    'app:secretStoreStatus',
    'settings:getAll',
    'settings:readJson',
    'settings:status',
    'auth:list',
    'auth:oauthAvailability',
    'ai:status',
    'ai:key:status',
    'cloud:state',
    'cloud:session',
    'sync:status',
    'team:status',
    'cred:list',
    'net:status',
    'profiles:list',
    'repos:list',
    'workspace:list',
  ];
  for (const ch of channels) {
    const res = JSON.stringify(await invoke(ch).catch((e: unknown) => `error: ${String(e)}`));
    for (const m of all) expect(res, `${ch} leaks a secret`).not.toContain(m);
  }
  const keyStatus = JSON.stringify(await invoke('ai:key:status', { provider: 'openai-compatible' }));
  expect(keyStatus).toContain('"hasKey":true');
  expect(keyStatus).not.toContain(AI_KEY);

  // every IPC event pushed to the renderer during the session
  const sent = await app.evaluate(() => (globalThis as unknown as { __klSent: string[] }).__klSent);
  expect(sent.length).toBeGreaterThan(0);
  const leakedEvents = sent.filter((s) => all.some((m) => s.includes(m))).map((s) => s.split(' ')[0]);
  expect(leakedEvents).toEqual([]);

  // ---- Quit, then scan everything on disk ----------------------------------------------------------
  await app.close();
  expect(countFiles(userData)).toBeGreaterThan(20);
  expect(fs.statSync(path.join(userData, 'secrets.bin')).size).toBeGreaterThan(0);
  expect(scanBytes(userData)).toEqual([]);
  // canary: the scanner does find a marker hidden in a binary file in an encoded form
  const canary = path.join(tmp, 'canary');
  fs.mkdirSync(path.join(canary, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(
    path.join(canary, 'Local Storage', 'leveldb', '000003.log'),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(GHE_PAT, 'utf16le'), Buffer.from([0])]),
  );
  expect(scanBytes(canary)).toEqual([path.join('Local Storage', 'leveldb', '000003.log: ghe-pat utf16le')]);
  expect(scanBytes(path.join(clone, '.git'))).toEqual([]);
  // known-credential patterns too (JWTs, ghp_, sk-…, scheme://user:pass@host) in our own files
  expect(scanUserDataForSecrets(userData, { known: all })).toEqual([]);
});
