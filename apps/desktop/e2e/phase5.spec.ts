import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 5 end-to-end, fully offline: workspaces (scan + overview + bulk fetch over a file:// remote),
 * the pinned Launchpad tab (no integrations → connect state; WIPs from workspace repos), Git Flow
 * (init → start feature → finish), AI commit messages against an in-test OpenAI-compatible server on
 * 127.0.0.1, and the Agent Sessions view with a `node` "agent" started in a pty.
 *
 * Layout under a temp dir:
 *   origin.git        bare remote (file://)
 *   ws/alpha          clone of origin.git — opened at launch; Git Flow / AI / agents run here
 *   ws/beta           local-only repo with uncommitted changes (dirty count, Launchpad WIP)
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const shots = path.join(appDir, 'test-results');

let tmp: string;
let wsDir: string;
let alpha: string;
let beta: string;
let app: ElectronApplication;
let page: Page;

const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const identity = (git: (...a: string[]) => string): void => {
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
};

const toast = (text: string | RegExp) => page.getByRole('region', { name: 'Notifications' }).getByText(text);

// ---- tiny OpenAI-compatible server (POST /v1/chat/completions, SSE) --------------------------------

interface Seen {
  url: string;
  authorization?: string;
  body: { model?: string; stream?: boolean; response_format?: { type?: string } };
}
const seen: Seen[] = [];
let server: http.Server;
let port = 0;
const AI_MESSAGE = { summary: 'Add greeting', description: 'Adds a greeting file for the e2e test.' };

function startAiServer(): Promise<void> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let body: Seen['body'] = {};
      try {
        body = JSON.parse(raw) as Seen['body'];
      } catch {
        /* keep empty */
      }
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      const content = JSON.stringify(AI_MESSAGE);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (o: unknown): void => void res.write(`data: ${JSON.stringify(o)}\n\n`);
      // two deltas to exercise streaming/partial parsing
      const mid = Math.floor(content.length / 2);
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: content.slice(0, mid) } }] });
      chunk({ choices: [{ index: 0, delta: { content: content.slice(mid) }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

// -----------------------------------------------------------------------------------------------------

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-p5-')));
  wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(wsDir);
  const origin = path.join(tmp, 'origin.git');
  alpha = path.join(wsDir, 'alpha');
  beta = path.join(wsDir, 'beta');

  // origin with one commit on main, pushed from a throwaway seed clone
  const quiet = { stdio: 'ignore' } as const;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], quiet);
  const seedDir = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '-q', pathToFileURL(origin).href, seedDir], quiet);
  const seed = gitIn(seedDir);
  identity(seed);
  seed('checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# Alpha\n');
  seed('add', '-A');
  seed('commit', '-q', '-m', 'Initial commit');
  seed('push', '-q', 'origin', 'main');

  // alpha: a clone (origin = file:// remote)
  execFileSync('git', ['clone', '-q', pathToFileURL(origin).href, alpha], quiet);
  identity(gitIn(alpha));

  // the remote moves on after the clone, so a fetch has something to bring in
  fs.writeFileSync(path.join(seedDir, 'remote.txt'), 'from the remote\n');
  seed('add', '-A');
  seed('commit', '-q', '-m', 'Remote moves on');
  seed('push', '-q', 'origin', 'main');

  // beta: local only, with uncommitted changes (1 modified + 1 untracked)
  fs.mkdirSync(beta);
  const b = gitIn(beta);
  b('init', '-q', '-b', 'main');
  identity(b);
  fs.writeFileSync(path.join(beta, 'notes.txt'), 'one\n');
  b('add', '-A');
  b('commit', '-q', '-m', 'Beta initial');
  fs.writeFileSync(path.join(beta, 'notes.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(beta, 'scratch.txt'), 'scratch\n');

  await startAiServer();

  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', alpha],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'),
      ELECTRON_RENDERER_URL: '',
      GH_OAUTH_GITHUB_CLIENT_ID: '',
      GH_OAUTH_BROKER_URL: '',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

// ---- 1. Workspaces -----------------------------------------------------------------------------------

test('workspaces: scan a folder into a local workspace, see status, bulk fetch', async () => {
  // the native folder picker is replaced in the main process: it "picks" the ws folder
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [dir],
    })) as typeof dialog.showOpenDialog;
  }, wsDir);

  await page.getByRole('button', { name: 'New tab' }).click();
  await page
    .getByRole('complementary', { name: 'Repository management' })
    .getByRole('button', { name: 'New workspace' })
    .click();
  await page
    .getByRole('dialog', { name: 'New workspace' })
    .getByRole('button', { name: /Local workspace/ })
    .click();

  const dialog = page.getByRole('dialog', { name: 'New local workspace' });
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('E2E Workspace');
  await dialog.getByRole('button', { name: /Scan folder/ }).click();
  const picks = dialog.getByRole('list', { name: 'Repositories to add' });
  await expect(picks.getByRole('checkbox', { name: /alpha/ })).toBeChecked();
  await expect(picks.getByRole('checkbox', { name: /beta/ })).toBeChecked();
  await expect(dialog.getByText('Repositories (2 selected)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dialog).toBeHidden();

  // overview: both repos, current branch, dirty count for beta
  await expect(page.getByRole('heading', { name: 'E2E Workspace' })).toBeVisible();
  const alphaRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: 'Select alpha' }) });
  const betaRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select beta' }) });
  await expect(alphaRow.getByRole('cell').nth(2)).toHaveText('main', { timeout: 15_000 });
  await expect(betaRow.getByRole('cell').nth(2)).toHaveText('main');
  await expect(betaRow.getByRole('cell').nth(4)).toHaveText('2');
  await expect(alphaRow.getByRole('cell').nth(4)).toHaveText('0');
  await expect(page.getByText('1 with changes')).toBeVisible();
  await expect(alphaRow.getByRole('cell').nth(7)).toHaveText('never');

  // bulk fetch over the file:// remote
  const git = gitIn(alpha);
  const before = git('rev-parse', 'origin/main');
  await alphaRow.getByRole('checkbox', { name: 'Select alpha' }).check();
  await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Fetch' }).click();
  await expect(alphaRow.getByText('Fetched')).toBeVisible({ timeout: 20_000 });
  await expect(toast('Fetch finished')).toBeVisible();
  expect(git('rev-parse', 'origin/main')).not.toBe(before);
  expect(git('log', '-1', '--format=%s', 'origin/main')).toBe('Remote moves on');
  await expect(alphaRow.getByRole('cell').nth(7)).not.toHaveText('never', { timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'phase5-workspace.png') });

  // Sorting: WIP starts biggest first; Repository cycles asc → desc → workspace order
  const firstRow = page.getByRole('checkbox', { name: /^Select (alpha|beta)$/ }).first();
  const heading = (name: string) => page.getByRole('columnheader').getByRole('button', { name, exact: true });
  await heading('WIP').click();
  await expect(firstRow).toHaveAccessibleName('Select beta');
  await heading('Repository').click();
  await expect(firstRow).toHaveAccessibleName('Select alpha');
  await heading('Repository').click();
  await expect(firstRow).toHaveAccessibleName('Select beta');
  await heading('Repository').click();
  await expect(page.getByRole('columnheader', { name: 'Repository' })).toHaveAttribute('aria-sort', 'none');

  // Push: alpha is behind its upstream after the fetch, so there is nothing to push
  const bulk = page.getByRole('toolbar', { name: 'Bulk actions' });
  await bulk.getByRole('button', { name: 'Push' }).click();
  await page.getByRole('menuitem', { name: 'Push', exact: true }).click();
  await expect(toast('Nothing to push')).toBeVisible();
  await alphaRow.getByRole('checkbox', { name: 'Select alpha' }).uncheck();

  // Hide beta, show hidden rows, unhide it again
  await betaRow.getByRole('checkbox', { name: 'Select beta' }).check();
  await bulk.getByRole('button', { name: 'Hide' }).click();
  await expect(betaRow).toHaveCount(0);
  await expect(page.getByText('1 with changes')).toBeHidden();
  const showHidden = page.getByRole('checkbox', { name: 'Show hidden (1)' });
  await showHidden.check();
  await expect(betaRow.getByRole('checkbox', { name: 'Select beta' })).toBeDisabled();
  await betaRow.getByRole('button', { name: 'Unhide' }).click();
  await expect(showHidden).toHaveCount(0);
  await expect(betaRow.getByRole('checkbox', { name: 'Select beta' })).toBeEnabled();
  await expect(page.getByText('1 with changes')).toBeVisible({ timeout: 15_000 });

  // Branches tab: "main" is shared by both repos
  await page.getByRole('tab', { name: 'Branches' }).click();
  await expect(page.getByRole('cell', { name: 'main', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Repositories' }).click();
});

// ---- 2. Launchpad ------------------------------------------------------------------------------------

test('launchpad: pinned tab, connect-a-provider state, WIPs lists the dirty repo', async () => {
  const lpTab = page.getByRole('tab', { name: 'Launchpad', exact: true });
  await expect(lpTab).toBeVisible();
  // pinned: no close button
  await expect(page.getByRole('button', { name: 'Close Launchpad' })).toHaveCount(0);
  await lpTab.click();

  const lp = page.getByRole('region', { name: 'Launchpad' });
  await expect(lp).toBeVisible();
  await expect(
    lp.getByRole('heading', { name: 'Connect a provider to see pull requests and issues' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(lp.getByRole('button', { name: 'Connect an account' })).toBeVisible();

  await lp.getByRole('tablist', { name: 'Launchpad views' }).getByRole('tab', { name: /^WIPs/ }).click();
  const betaWip = lp.getByText('beta', { exact: true });
  await expect(betaWip).toBeVisible({ timeout: 20_000 });
  await expect(lp.getByRole('heading', { name: /Connect a provider/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, 'phase5-launchpad.png') });
});

// ---- 3. Git Flow -------------------------------------------------------------------------------------

test('git flow: init, start feature, commit, finish', async () => {
  const git = gitIn(alpha);
  // back to the alpha repo tab
  await page.getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name: /alpha/ }).click();
  const nav = page.getByRole('navigation', { name: 'Repository references' });
  const flow = nav.getByRole('tree', { name: 'Gitflow' });
  await flow.scrollIntoViewIfNeeded();

  await flow.getByRole('button', { name: 'Initialize Git Flow' }).click();
  const init = page.getByRole('dialog', { name: 'Initialize Git Flow' });
  await expect(init.getByLabel('Production branch')).toHaveValue('main');
  await expect(init.getByLabel('Development branch')).toHaveValue('develop');
  await init.getByRole('button', { name: 'Initialize' }).click();
  await expect(init).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => git('branch', '--list', 'develop')).toContain('develop');
  await expect(flow.getByText('No flow branches')).toBeVisible();

  // start feature/e2e
  await nav.getByRole('button', { name: 'Start a Git Flow branch' }).click();
  await page.getByRole('menuitem', { name: 'Start Feature' }).click();
  const name = flow.getByRole('textbox', { name: 'New feature name' });
  await name.fill('e2e');
  await name.press('Enter');
  await expect.poll(() => git('rev-parse', '--abbrev-ref', 'HEAD'), { timeout: 15_000 }).toBe('feature/e2e');
  const row = flow.getByRole('treeitem', { name: /e2e/ });
  await expect(row).toBeVisible();

  // a commit from the command line
  fs.writeFileSync(path.join(alpha, 'feature.txt'), 'feature work\n');
  git('add', 'feature.txt');
  git('commit', '-q', '-m', 'Feature e2e work');
  const sha = git('rev-parse', 'HEAD');
  await expect(page.getByRole('grid', { name: 'Commit graph' }).getByText('Feature e2e work')).toBeVisible({
    timeout: 15_000,
  });

  // finish from the UI
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Finish Feature e2e/ }).click();
  const finish = page.getByRole('dialog', { name: 'Finish Feature e2e' });
  await expect(finish.getByRole('checkbox', { name: /Delete feature\/e2e after finishing/ })).toBeChecked();
  await page.screenshot({ path: path.join(shots, 'phase5-gitflow.png') });
  await finish.getByRole('button', { name: 'Finish Feature' }).click();
  await expect(finish).toBeHidden({ timeout: 15_000 });

  await expect.poll(() => git('branch', '--list', 'feature/e2e'), { timeout: 15_000 }).toBe('');
  expect(git('branch', '--contains', sha, '--format=%(refname:short)').split('\n')).toContain('develop');
  expect(git('status', '--porcelain')).toBe('');
  await expect(flow.getByRole('treeitem', { name: /e2e/ })).toHaveCount(0);
});

// ---- 4. AI -------------------------------------------------------------------------------------------

test('ai: commit message from an OpenAI-compatible server on localhost', async () => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: 'AI' })
    .click();

  await prefs.getByRole('checkbox', { name: 'Enable AI features' }).check();
  await prefs.getByRole('combobox', { name: 'Provider' }).selectOption('openai-compatible');
  const model = prefs.getByRole('combobox', { name: 'Model' });
  await model.fill('test-model');
  await model.blur();
  const endpoint = prefs.getByRole('textbox', { name: /^Endpoint URL/ });
  await endpoint.fill(`http://127.0.0.1:${port}/v1`);
  await endpoint.blur();
  await prefs.getByLabel(/API key$/).fill('test-key');
  await prefs.getByRole('button', { name: 'Save key' }).click();
  await expect(prefs.getByText('stored encrypted on this computer')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase5-ai-prefs.png') });
  await prefs.getByRole('button', { name: 'Close preferences' }).click();
  await expect(prefs).toBeHidden();

  // stage a change
  const git = gitIn(alpha);
  fs.writeFileSync(path.join(alpha, 'greeting.txt'), 'hello\n');
  git('add', 'greeting.txt');
  await page.getByRole('grid', { name: 'Commit graph' }).getByText('// WIP').click({ timeout: 15_000 });
  await expect(page.getByRole('listbox', { name: 'Staged files' }).getByText('greeting.txt')).toBeVisible({
    timeout: 15_000,
  });

  const sparkle = page.getByRole('button', { name: 'Generate commit message with AI', exact: true });
  await expect(sparkle).toBeEnabled();
  await sparkle.click();
  const consent = page.getByRole('dialog', { name: 'Allow AI features' });
  await expect(consent).toBeVisible();
  await expect(consent.getByText(`http://127.0.0.1:${port}/v1`)).toBeVisible();
  await expect(consent.getByText('a server on this computer')).toBeVisible();
  await consent.getByRole('button', { name: 'Allow' }).click();

  await expect(page.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Add greeting', {
    timeout: 20_000,
  });
  await page.screenshot({ path: path.join(shots, 'phase5-ai.png') });

  expect(seen.length).toBeGreaterThan(0);
  const last = seen[seen.length - 1]!;
  expect(last.url).toBe('/v1/chat/completions');
  expect(last.authorization).toBe('Bearer test-key');
  expect(last.body.model).toBe('test-model');
  expect(last.body.stream).toBe(true);

  // the renderer never holds the key
  const leaked = await page.evaluate(
    () =>
      document.documentElement.outerHTML.includes('test-key') ||
      JSON.stringify(localStorage).includes('test-key'),
  );
  expect(leaked).toBe(false);

  // leave the repo clean for the next test
  git('reset', '-q', '--hard');
  fs.rmSync(path.join(alpha, 'greeting.txt'), { force: true });
});

// ---- 5. Agent sessions -------------------------------------------------------------------------------

test('agents: worktree group, start a node "agent" session and stop it', async () => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  const sections = prefs.getByRole('navigation', { name: 'Preference sections' });
  await sections.getByRole('button', { name: 'UI Customization' }).click();
  await prefs.getByRole('switch', { name: /Show Agents view/ }).check();

  await sections.getByRole('button', { name: 'External Tools' }).click();
  const cmd = prefs.getByLabel(/^Agent command/);
  await cmd.fill('node');
  await cmd.press('Enter');
  const args = prefs.getByLabel(/^Agent arguments/);
  await args.fill('-e\nsetInterval(()=>{},1000)');
  await args.blur();
  await expect(prefs.getByRole('button', { name: 'Reset Agent arguments to default' })).toBeVisible();
  await expect(prefs.getByRole('button', { name: 'Reset Agent command to default' })).toBeVisible();
  await prefs.getByRole('button', { name: 'Close preferences' }).click();

  const nav = page.getByRole('navigation', { name: 'Repository references' });
  await nav.getByRole('group', { name: 'Left panel mode' }).getByRole('button', { name: 'Agents' }).click();
  const panel = nav.locator('[aria-label="Agent sessions"]');
  await expect(panel).toBeVisible();
  const group = panel.getByRole('treeitem').filter({ hasText: 'alpha' });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await expect(group.getByText('No agent sessions')).toBeVisible();

  await group.getByRole('button', { name: 'New agent session' }).click();
  const card = group.getByRole('group', { name: /^node — alpha/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/^(running|idle|waiting for input)$/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'phase5-agents.png') });

  await card.getByRole('button', { name: 'Stop' }).click();
  // Ctrl+C ends node; if it did not, the app asks before killing it.
  const kill = page.getByRole('dialog').getByRole('button', { name: 'Kill' });
  await expect(async () => {
    if (await kill.isVisible()) await kill.click();
    await expect(card.getByText('exited', { exact: false })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(group.getByText('No agent sessions')).toBeVisible({ timeout: 15_000 });
});
