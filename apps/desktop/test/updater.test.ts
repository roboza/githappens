import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUpdateHandlers } from '../src/main/ipc/update-handlers';
import {
  extractChangelogSection,
  UpdaterService,
  type AutoUpdaterLike,
  type TimerApi,
  type UpdaterServiceOptions,
} from '../src/main/services/updater';
import type { UpdateChannel, UpdateStatus } from '../src/shared/ipc/update-contract';
import { parseMarkdown } from '../src/renderer/src/views/update/markdown-parse';

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  private _channel: string | null = null;
  allowPrerelease = false;
  allowDowngrade = false;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkImpl: () => Promise<unknown> = async () => null;
  checkForUpdates = vi.fn(() => this.checkImpl());
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
  get channel(): string | null {
    return this._channel;
  }
  set channel(v: string | null) {
    this._channel = v;
    this.allowDowngrade = true; // mirrors electron-updater
  }
}

const manualTimers = (): TimerApi & { run(): void } => {
  const fns: (() => void)[] = [];
  return {
    setTimeout: (fn) => fns.push(fn),
    setInterval: () => 0,
    clear: () => undefined,
    run: () => fns.splice(0).forEach((f) => f()),
  };
};

function make(over: Partial<UpdaterServiceOptions> = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  let channel: UpdateChannel = 'stable';
  let autoDownload = true;
  const timers = manualTimers();
  const svc = new UpdaterService({
    updater,
    currentVersion: '0.1.0',
    isPackaged: true,
    platform: 'win32',
    env: {},
    getChannel: () => channel,
    getAutoDownload: () => autoDownload,
    onStatus: (s) => statuses.push(s),
    timers,
    log: () => undefined,
    ...over,
  });
  return {
    svc,
    updater,
    statuses,
    timers,
    setChannel: (c: UpdateChannel) => (channel = c),
    setAutoDownload: (v: boolean) => (autoDownload = v),
  };
}

describe('UpdaterService', () => {
  it('is a no-op when unpackaged', async () => {
    const { svc, updater, timers } = make({ isPackaged: false });
    svc.start();
    timers.run();
    const st = await svc.check();
    expect(st.state).toBe('disabled');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await svc.installAndRestart();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.listenerCount('update-available')).toBe(0);
  });

  it('maps stable / preview channels onto the updater', async () => {
    const t = make();
    await t.svc.check();
    expect(t.updater.channel).toBe('latest');
    expect(t.updater.allowPrerelease).toBe(false);
    expect(t.updater.allowDowngrade).toBe(false);

    t.setChannel('preview');
    t.svc.refreshSettings();
    expect(t.updater.channel).toBe('preview');
    expect(t.updater.allowPrerelease).toBe(true);
    expect(t.updater.allowDowngrade).toBe(false);
    expect(t.svc.current.channel).toBe('preview');
    // A channel switch triggers a fresh check.
    await vi.waitFor(() => expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it('applies the autoDownload setting', async () => {
    const t = make();
    t.setAutoDownload(false);
    await t.svc.check();
    expect(t.updater.autoDownload).toBe(false);
  });

  it('maps updater events to statuses (auto-download)', async () => {
    const t = make();
    t.updater.checkImpl = async () => {
      t.updater.emit('checking-for-update');
      t.updater.emit('update-available', { version: '0.2.0' });
    };
    const st = await t.svc.check();
    expect(st).toMatchObject({ state: 'downloading', version: '0.2.0', progress: 0 });
    t.updater.emit('download-progress', { percent: 42, bytesPerSecond: 1000 });
    expect(t.svc.current).toMatchObject({ state: 'downloading', progress: 0.42 });
    t.updater.emit('update-downloaded', { version: '0.2.0' });
    expect(t.svc.current).toMatchObject({ state: 'ready', version: '0.2.0' });
    expect(t.statuses.map((s) => s.state)).toEqual([
      'checking',
      'checking',
      'downloading',
      'downloading',
      'ready',
    ]);

    await t.svc.installAndRestart();
    t.timers.run();
    expect(t.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('offers a manual download when autoDownload is off', async () => {
    const t = make();
    t.setAutoDownload(false);
    t.updater.checkImpl = async () => void t.updater.emit('update-available', { version: '0.2.0' });
    expect((await t.svc.check()).state).toBe('available');
    await t.svc.installAndRestart();
    expect(t.updater.downloadUpdate).toHaveBeenCalled();
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports not-available and settles "checking" when nothing is emitted', async () => {
    const t = make();
    t.updater.checkImpl = async () => void t.updater.emit('update-not-available', { version: '0.1.0' });
    expect((await t.svc.check()).state).toBe('not-available');
    t.updater.checkImpl = async () => null;
    expect((await t.svc.check()).state).toBe('idle');
  });

  it('turns failures into an error status without throwing', async () => {
    const t = make();
    t.updater.checkImpl = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED\n<xml>lots of body</xml>');
    };
    const st = await t.svc.check();
    expect(st).toMatchObject({ state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    t.updater.emit('error', new Error('boom'));
    expect(t.svc.current.error).toBe('boom');
    // Next check recovers.
    t.updater.checkImpl = async () => void t.updater.emit('update-not-available', {});
    expect((await t.svc.check()).state).toBe('not-available');
  });

  it('uses manual mode with a download link on Linux deb/rpm (no APPIMAGE)', async () => {
    const t = make({ platform: 'linux', env: {} });
    expect(t.svc.current.state).toBe('manual');
    expect(t.svc.current.downloadUrl).toBe('https://github.com/roboza/githappens/releases/latest');
    t.updater.checkImpl = async () => void t.updater.emit('update-available', { version: '0.2.0' });
    const st = await t.svc.check();
    expect(t.updater.autoDownload).toBe(false);
    expect(st).toMatchObject({ state: 'manual', version: '0.2.0' });
    expect(st.downloadUrl).toBe('https://github.com/roboza/githappens/releases/latest');
    t.updater.emit('error', new Error('x'));
    expect(t.svc.current.state).toBe('manual');
    await t.svc.installAndRestart();
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('updates in place for Linux AppImage', () => {
    const t = make({ platform: 'linux', env: { APPIMAGE: '/opt/GitHappens.AppImage' } });
    expect(t.svc.current.state).toBe('idle');
  });

  it('schedules a startup check', async () => {
    const t = make();
    t.svc.start();
    t.timers.run();
    await vi.waitFor(() => expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1));
  });

  it('exposes handlers', async () => {
    const t = make();
    const h = createUpdateHandlers(t.svc);
    expect((await h['update:status']({}, { senderId: 1 })).state).toBe('idle');
    expect((await h['update:check']({}, { senderId: 1 })).state).toBe('idle');
  });
});

describe('whatsNew', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the section once after an upgrade, never on a fresh install', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-upd-'));
    const changelogPath = path.join(dir, 'CHANGELOG.md');
    const stateFile = path.join(dir, 'update-state.json');
    fs.writeFileSync(
      changelogPath,
      '# Changelog\n\n## [0.2.0] - 2026-11-01\n\n- New\n\n## [0.1.0]\n\n- Old\n',
    );
    const at = (v: string) => make({ currentVersion: v, changelogPath, stateFile }).svc;
    expect(at('0.1.0').whatsNew()).toBeNull(); // fresh install
    expect(at('0.1.0').whatsNew()).toBeNull();
    expect(at('0.2.0').whatsNew()).toEqual({ version: '0.2.0', markdown: '- New' });
    expect(at('0.2.0').whatsNew()).toBeNull();
    expect(at('0.2.0').whatsNew(true)).toEqual({ version: '0.2.0', markdown: '- New' });
  });
});

describe('extractChangelogSection', () => {
  const md = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.2.0-preview.20261009] - 2026-10-09',
    '### Added',
    '- preview thing',
    '',
    '## v0.1.0 — 2026-10-01',
    '',
    '### Added',
    '- **Graph** with `lanes`',
    '',
    '## [0.0.1]',
    '- first',
  ].join('\r\n');

  it('extracts a section up to the next h2', () => {
    expect(extractChangelogSection(md, '0.1.0')).toBe('### Added\n- **Graph** with `lanes`');
    expect(extractChangelogSection(md, '0.2.0-preview.20261009')).toBe('### Added\n- preview thing');
    expect(extractChangelogSection(md, '0.0.1')).toBe('- first');
  });

  it('does not match prefixes or missing versions', () => {
    expect(extractChangelogSection(md, '0.1')).toBeNull();
    expect(extractChangelogSection(md, '0.2.0')).toBeNull();
    expect(extractChangelogSection(md, '9.9.9')).toBeNull();
    expect(extractChangelogSection(md, 'Unreleased')).toBeNull(); // empty body
  });

  it('works on the bundled CHANGELOG.md', () => {
    const real = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    // Not package.json's version: release CI rewrites it (e.g. a nightly preview) before tests run,
    // and preview builds have no changelog section. Check the newest released section instead.
    const newest = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/m.exec(real)?.[1];
    expect(newest).toBeDefined();
    expect(extractChangelogSection(real, newest!)).toMatch(/\S/);
  });
});

describe('parseMarkdown (What’s new renderer)', () => {
  it('parses headings, lists, code and links', () => {
    const blocks = parseMarkdown(
      '### Added\n- **Bold** and `code` [docs](https://x.dev)\n  continued\n* two\n\n```\nnpm i\n```\n\nPara [bad](javascript:alert(1))',
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'code', 'paragraph']);
    const list = blocks[1];
    expect(list?.type === 'list' && list.items.length).toBe(2);
    if (list?.type === 'list') {
      const first = list.items[0] ?? [];
      expect(first).toContainEqual({ type: 'strong', text: 'Bold' });
      expect(first).toContainEqual({ type: 'code', text: 'code' });
      expect(first).toContainEqual({ type: 'link', text: 'docs', href: 'https://x.dev' });
    }
    const code = blocks[2];
    expect(code?.type === 'code' && code.text).toBe('npm i');
    const para = blocks[3];
    // Non-http(s) links degrade to plain text.
    expect(para?.type === 'paragraph' && para.inline.some((n) => n.type === 'link')).toBe(false);
  });
});
