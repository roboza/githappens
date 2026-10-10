import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/** Shared helpers for the opt-in perf (GH_PERF=1) and visual (GH_VISUAL=1) suites. */

export const appDir = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(appDir, '..', '..');
/** Same cache as `pnpm bench` (spec 15 §7 Perf): generated once, reused across runs. */
export const benchCache = path.resolve(
  process.env.GH_BENCH_CACHE ?? path.join(repoRoot, 'test', 'fixtures', '.repos', 'bench'),
);

/** Run the fixtures CLI through tsx directly (argv array, no shell). */
export function makeFixture(name: string, root: string, options: string[] = []): string {
  const req = createRequire(path.join(repoRoot, 'package.json'));
  const tsxCli = req.resolve('tsx/cli');
  execFileSync(
    process.execPath,
    [tsxCli, path.join(repoRoot, 'test', 'fixtures', 'src', 'cli.ts'), name, `--root=${root}`, ...options],
    { cwd: repoRoot, stdio: 'inherit', windowsHide: true },
  );
  return path.join(root, name);
}

/** A heavy fixture from the bench cache, generated on first use. */
export function cachedFixture(name: string): string {
  const dir = path.join(benchCache, name);
  if (!fs.existsSync(path.join(dir, '.git'))) makeFixture(name, benchCache);
  return dir;
}

export interface Session {
  tmp: string;
  app: ElectronApplication;
  page: Page;
  /** Epoch ms when `electron.launch` was called. */
  launchedAt: number;
  /** ms from `electron.launch` to the first graph row in the DOM (includes Electron startup). */
  launchToRowsMs: number;
  /** renderer `performance.now()` (since navigation start) when the first graph row was seen. */
  rendererFirstRowsMs: number;
}

export const GRID = '[role="grid"][aria-label="Commit graph"]';

export async function launchApp(repo: string, o: { env?: Record<string, string> } = {}): Promise<Session> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-perf-')));
  const t0 = Date.now();
  const app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'),
      ELECTRON_RENDERER_URL: '',
      ...o.env,
    },
  });
  const page = await app.firstWindow();
  const handle = await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.querySelector('[role="row"]') ? performance.now() : 0),
    GRID,
    { polling: 'raf', timeout: 60_000 },
  );
  const rendererFirstRowsMs = (await handle.jsonValue()) as number;
  return { tmp, app, page, launchedAt: t0, launchToRowsMs: Date.now() - t0, rendererFirstRowsMs };
}

export async function closeApp(s: Session | undefined): Promise<void> {
  if (!s) return;
  await s.app.close().catch(() => undefined);
  fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

/** Change a setting through the app's own preference channel (same path as the Preferences UI). */
export async function setSetting(page: Page, key: string, value: unknown): Promise<void> {
  await invoke(page, 'settings:set', { key, value });
}

/** `window.api.invoke` from the test, unwrapping the IpcResult envelope. */
export async function invoke<T = unknown>(page: Page, channel: string, req: unknown): Promise<T> {
  const r = (await page.evaluate(
    ([c, q]) =>
      (window as unknown as { api: { invoke(c: string, r: unknown): Promise<unknown> } }).api.invoke(c, q),
    [channel, req] as const,
  )) as { ok: boolean; data?: T; error?: { message?: string } };
  if (!r.ok) throw new Error(`${channel}: ${r.error?.message ?? 'failed'}`);
  return r.data as T;
}

export const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

/** Merge measurements into bench-results/perf-e2e.json (uploaded by the nightly perf workflow). */
export function writeResults(section: string, data: Record<string, unknown>): void {
  const file = path.join(repoRoot, 'bench-results', 'perf-e2e.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first section */
  }
  all[section] = { date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, ...data };
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
}

interface CommandLogEntry {
  argv: string[];
  startedAt: number;
  durationMs: number;
}

/**
 * Git commands the app ran for `repo` (the app's own output log, `git:output:list`), as
 * "+offset ms (duration) argv" lines relative to launch — explains where first-paint time went.
 */
export async function commandTimeline(s: Session, repo: string, untilMs = Infinity): Promise<string[]> {
  const real = fs.realpathSync.native(repo);
  const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
  const repoId = createHash('sha1').update(key).digest('hex');
  // the repo's own log plus app-level commands (version probe, global config …: NO_REPO = '')
  const tag = (scope: string) => (e: CommandLogEntry) => ({ ...e, scope });
  const entries = [
    ...(await invoke<CommandLogEntry[]>(s.page, 'git:output:list', { repoId, limit: 500 })).map(tag('repo')),
    ...(
      await invoke<CommandLogEntry[]>(s.page, 'git:output:list', { repoId: '', limit: 500 }).catch(() => [])
    ).map(tag('app')),
  ];
  return entries
    .map((e) => ({ ...e, at: e.startedAt - s.launchedAt }))
    .filter((e) => e.at <= untilMs)
    .sort((a, b) => a.at - b.at)
    .map(
      (e) =>
        `+${String(e.at).padStart(6)} ms (${String(e.durationMs).padStart(5)} ms) [${e.scope}] git ${e.argv
          .filter((a) => !a.startsWith('--format='))
          .slice(0, 6)
          .join(' ')}`,
    );
}
