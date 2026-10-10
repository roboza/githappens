import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { binaryArch, checkPackage } from '../../../.github/scripts/check-package-arch.mjs';
import { mergeDir, mergeManifests } from '../../../.github/scripts/merge-update-manifests.mjs';
import * as uploadR2 from '../../../.github/scripts/upload-r2.mjs';

/**
 * Release pipeline (spec 15 §6.4–6.6): the per-arch update-manifest merge used by release.yml, and a
 * structural check of the three workflows (parsed with js-yaml — no actionlint binary needed).
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const updaterRequire = createRequire(createRequire(import.meta.url).resolve('electron-updater'));
const yaml = updaterRequire('js-yaml') as { load(text: string): unknown };
const provider = updaterRequire('./providers/Provider') as {
  resolveFiles(info: unknown, baseUrl: URL): { url: URL; info: { url: string } }[];
  findFile(files: { url: URL; info: { url: string } }[], ext: string): { url: URL } | undefined;
};

const merge = mergeManifests as (texts: string[]) => { text: string; files: number };
const mergeAll = mergeDir as (inDir: string, outDir: string) => string[];

/** What electron-builder writes for one arch (CRLF on Windows runners). */
const winManifest = (arch: 'x64' | 'arm64', eol = '\n'): string =>
  [
    'version: 0.2.0',
    'files:',
    `  - url: GitHappens-Setup-0.2.0-${arch}.exe`,
    `    sha512: sha-${arch}==`,
    `    size: ${arch === 'x64' ? 100 : 90}`,
    `path: GitHappens-Setup-0.2.0-${arch}.exe`,
    `sha512: sha-${arch}==`,
    "releaseDate: '2026-10-10T03:00:00.000Z'",
    '',
  ].join(eol);
const macManifest = (arch: 'x64' | 'arm64'): string =>
  [
    'version: 0.2.0',
    'files:',
    `  - url: GitHappens-0.2.0-mac-${arch}.zip`,
    `    sha512: zip-${arch}==`,
    '    size: 10',
    `  - url: GitHappens-0.2.0-mac-${arch}.dmg`,
    `    sha512: dmg-${arch}==`,
    '    size: 11',
    `path: GitHappens-0.2.0-mac-${arch}.zip`,
    `sha512: zip-${arch}==`,
    "releaseDate: '2026-10-10T03:00:00.000Z'",
    '',
  ].join('\n');

function withArch<T>(arch: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'arch', original);
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-manifests-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('update manifest merge (release.yml publish job)', () => {
  it('merges Windows x64 + arm64 latest.yml so each arch downloads its own installer', () => {
    // arm64 job may finish first; CRLF from the Windows runner is normalised.
    const { text, files } = merge([winManifest('arm64', '\r\n'), winManifest('x64', '\r\n')]);
    expect(files).toBe(2);
    const info = yaml.load(text) as { version: string; path: string; files: { url: string }[] };
    expect(info.version).toBe('0.2.0');
    expect(info.path).toBe('GitHappens-Setup-0.2.0-x64.exe'); // legacy field stays x64
    expect(info.files.map((f) => f.url)).toEqual([
      'GitHappens-Setup-0.2.0-x64.exe',
      'GitHappens-Setup-0.2.0-arm64.exe',
    ]);
    const resolved = provider.resolveFiles(info, new URL('https://example.test/download/'));
    for (const arch of ['x64', 'arm64']) {
      const picked = withArch(arch, () => provider.findFile(resolved, 'exe'));
      expect(picked?.url.pathname).toBe(`/download/GitHappens-Setup-0.2.0-${arch}.exe`);
    }
  });

  it('merges both macOS builds and deduplicates re-uploaded entries', () => {
    const { text, files } = merge([macManifest('x64'), macManifest('arm64'), macManifest('x64')]);
    expect(files).toBe(4);
    const info = yaml.load(text) as { files: { url: string; sha512: string; size: number }[] };
    expect(info.files).toContainEqual({
      url: 'GitHappens-0.2.0-mac-arm64.zip',
      sha512: 'zip-arm64==',
      size: 10,
    });
  });

  it('refuses to merge manifests of different versions', () => {
    expect(() => merge([winManifest('x64'), winManifest('arm64').replace('0.2.0', '0.2.1')])).toThrow(
      /disagree on the version/,
    );
  });

  it('merges a downloaded-artifacts tree by file name (linux arm64 has its own manifest)', () => {
    const put = (artifact: string, name: string, text: string): void => {
      fs.mkdirSync(path.join(dir, 'in', artifact), { recursive: true });
      fs.writeFileSync(path.join(dir, 'in', artifact, name), text);
    };
    put('manifest-win-x64', 'latest.yml', winManifest('x64'));
    put('manifest-win-arm64', 'latest.yml', winManifest('arm64'));
    put(
      'manifest-linux-x64',
      'latest-linux.yml',
      winManifest('x64').replace(/Setup-0\.2\.0-x64\.exe/g, '0.2.0-linux-x86_64.AppImage'),
    );
    put(
      'manifest-linux-arm64',
      'latest-linux-arm64.yml',
      winManifest('arm64').replace(/Setup-0\.2\.0-arm64\.exe/g, '0.2.0-linux-arm64.AppImage'),
    );
    put('manifest-linux-arm64', 'builder-debug.yml', 'x: 1\n');
    const summary = mergeAll(path.join(dir, 'in'), path.join(dir, 'out'));
    expect(summary.sort()).toEqual([
      'latest-linux-arm64.yml: merged 1 manifest(s), 1 file(s)',
      'latest-linux.yml: merged 1 manifest(s), 1 file(s)',
      'latest.yml: merged 2 manifest(s), 2 file(s)',
    ]);
    expect(fs.readdirSync(path.join(dir, 'out')).sort()).toEqual([
      'latest-linux-arm64.yml',
      'latest-linux.yml',
      'latest.yml',
    ]);
  });
});

type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
type Job = {
  'runs-on'?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  container?: string;
  strategy?: { matrix?: unknown };
  steps?: Step[];
  outputs?: Record<string, string>;
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const workflow = (name: string): Workflow =>
  yaml.load(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8')) as Workflow;

describe('GitHub workflows (spec 15 §6.6)', () => {
  it('ci.yml: install → typecheck → lint → unit → build → e2e smoke on all three OSes, plus git 2.36', () => {
    const ci = workflow('ci.yml');
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(['pull_request']));
    const check = ci.jobs.check!;
    expect((check.strategy?.matrix as { os: string[] }).os).toEqual([
      'ubuntu-latest',
      'windows-latest',
      'macos-latest',
    ]);
    const names = (check.steps ?? []).map((s) => s.name ?? s.uses ?? '');
    const order = ['Install', 'Typecheck', 'Lint', 'Unit & integration tests', 'Build'];
    const idx = order.map((n) => names.indexOf(n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(names.filter((n) => n.startsWith('E2E smoke')).length).toBe(2);
    expect(names.indexOf('Build')).toBeLessThan(names.findIndex((n) => n.startsWith('E2E smoke')));
    const minGit = ci.jobs['min-git']!;
    expect(minGit.steps?.some((s) => /git-2\.36\.\d+/.test(s.run ?? ''))).toBe(true);
  });

  it('release.yml: arm64 runners are opt-in via vars.GH_ARM_RUNNERS, native per arch', () => {
    const rel = workflow('release.yml');
    const prepare = rel.jobs.prepare!;
    expect(prepare.outputs?.matrix).toBeDefined();
    const matrixStep = prepare.steps!.find((s) => s.name === 'Build matrix')!;
    expect(matrixStep).toBeDefined();
    const env = (matrixStep as { env?: Record<string, string> }).env ?? {};
    expect(env.ARM_RUNNERS).toBe('${{ vars.GH_ARM_RUNNERS }}');
    expect(matrixStep.run).toContain('ubuntu-24.04-arm');
    expect(matrixStep.run).toContain('windows-11-arm');
    const build = rel.jobs.build!;
    expect(build.strategy?.matrix).toBe('${{ fromJSON(needs.prepare.outputs.matrix) }}');
    const stepNames = build.steps!.map((s) => s.name);
    expect(stepNames).toContain('Verify native modules and bundled git match the target arch');
    expect(stepNames).toContain('Smoke-test the packaged app');
    const publish = rel.jobs.publish!;
    expect(
      publish.steps!.some((s) => (s.run ?? '').includes('.github/scripts/merge-update-manifests.mjs')),
    ).toBe(true);
  });

  it('release.yml matrix script produces the expected entries for each GH_ARM_RUNNERS value', async () => {
    const rel = workflow('release.yml');
    const run = rel.jobs.prepare!.steps!.find((s) => s.name === 'Build matrix')!.run!;
    // The step is `node -e '<js>'`-free bash calling node with a heredoc; extract and run the JS.
    const js = /<<'EOF'\n([\s\S]*?)\n\s*EOF/.exec(run)?.[1];
    expect(js, 'matrix step embeds its generator in a heredoc').toBeTruthy();
    const ids = (arm: string): string[] => {
      const out = path.join(dir, `out-${arm || 'none'}`);
      const fn = new Function('process', 'require', js!) as (p: unknown, r: unknown) => void;
      fn({ env: { ARM_RUNNERS: arm, GITHUB_OUTPUT: out } }, createRequire(import.meta.url));
      const line = fs.readFileSync(out, 'utf8').trim();
      const matrix = JSON.parse(line.replace(/^matrix=/, '')) as {
        include: { id: string; runner: string; arch: string }[];
      };
      return matrix.include.map((e) => `${e.id}@${e.runner}`);
    };
    const base = [
      'win-x64@windows-latest',
      'mac-x64@macos-15-intel',
      'mac-arm64@macos-latest',
      'linux-x64@ubuntu-latest',
    ];
    expect(ids('')).toEqual(base);
    expect(ids('false')).toEqual(base);
    expect(ids('true')).toEqual([...base, 'win-arm64@windows-11-arm', 'linux-arm64@ubuntu-24.04-arm']);
    expect(ids('linux')).toEqual([...base, 'linux-arm64@ubuntu-24.04-arm']);
    expect(ids('windows')).toEqual([...base, 'win-arm64@windows-11-arm']);
  });

  it('nightly.yml builds the preview channel through release.yml', () => {
    const nightly = workflow('nightly.yml');
    expect(nightly.jobs.release!.uses).toBe('./.github/workflows/release.yml');
  });
});

describe('check-package-arch (release.yml "Verify native modules …")', () => {
  const pe = (machine: number): Buffer => {
    const b = Buffer.alloc(256);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.writeUInt32LE(0x00004550, 0x80);
    b.writeUInt16LE(machine, 0x84);
    return b;
  };
  const elf = (machine: number): Buffer => {
    const b = Buffer.alloc(64);
    b.writeUInt32BE(0x7f454c46, 0);
    b[5] = 1; // little-endian
    b.writeUInt16LE(machine, 18);
    return b;
  };
  const macho = (cpu: number): Buffer => {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(0xfeedfacf, 0);
    b.writeUInt32LE(cpu, 4);
    return b;
  };
  const arch = binaryArch as (b: Buffer) => string | null;
  const check = checkPackage as (res: string, arch: string) => { ok: boolean; lines: string[] };

  it('reads the arch of PE, ELF and Mach-O headers', () => {
    expect(arch(pe(0x8664))).toBe('x64');
    expect(arch(pe(0xaa64))).toBe('arm64');
    expect(arch(elf(0x3e))).toBe('x64');
    expect(arch(elf(0xb7))).toBe('arm64');
    expect(arch(macho(0x0100000c))).toBe('arm64');
    expect(arch(macho(0x01000007))).toBe('x64');
    expect(arch(Buffer.from('#!/bin/sh\n'))).toBeNull();
  });

  it('fails a package whose native modules or git are for another arch', () => {
    const res = path.join(dir, 'resources');
    const put = (rel: string, b: Buffer): void => {
      fs.mkdirSync(path.dirname(path.join(res, rel)), { recursive: true });
      fs.writeFileSync(path.join(res, rel), b);
    };
    put('git/bin/git', elf(0xb7));
    put(
      'app.asar.unpacked/node_modules/@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node',
      elf(0xb7),
    );
    put('app.asar.unpacked/node_modules/@parcel/watcher-linux-arm64-glibc/watcher.node', elf(0xb7));
    expect(check(res, 'arm64').ok).toBe(true);
    const x64 = check(res, 'x64');
    expect(x64.ok).toBe(false);
    expect(x64.lines).toContain('MISSING node-pty prebuild for x64');
    put('app.asar.unpacked/node_modules/@parcel/watcher-linux-arm64-glibc/watcher.node', elf(0x3e));
    expect(check(res, 'arm64').lines.some((l) => l.startsWith('WRONG x64'))).toBe(true);
  });
});

describe('R2 feed config (electron-builder.yml publish + release.yml)', () => {
  const builderText = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  const resolveUrl = uploadR2.resolveDownloadsUrl as (
    env: Record<string, string | undefined>,
    text: string,
  ) => string;

  it('publishes to the generic provider on the download host, stable channel by default', () => {
    const cfg = yaml.load(builderText) as { publish: Record<string, unknown> };
    expect(cfg.publish).toEqual({
      provider: 'generic',
      url: 'https://downloads.githappens.dev/releases',
      channel: 'latest',
    });
  });

  it('the downloads base URL has one default (electron-builder.yml) and one override (repo variable)', () => {
    expect(resolveUrl({}, builderText)).toBe('https://downloads.githappens.dev');
    expect(resolveUrl({ GITHAPPENS_DOWNLOADS_URL: ' https://dl.example.test/ ' }, builderText)).toBe(
      'https://dl.example.test',
    );
    expect(() => resolveUrl({}, 'appId: x\n')).toThrow(/publish\.url/);
    // No other copy of the host in the workflows or the upload script.
    for (const f of ['release.yml', 'nightly.yml']) {
      const text = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', f), 'utf8');
      expect(text).not.toContain('downloads.githappens.dev');
    }
    const script = fs.readFileSync(path.join(repoRoot, '.github', 'scripts', 'upload-r2.mjs'), 'utf8');
    expect(script).not.toContain('downloads.githappens.dev');
  });

  it('every workflow file parses', () => {
    const wfDir = path.join(repoRoot, '.github', 'workflows');
    const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'nightly.yml', 'perf.yml', 'release.yml']));
    for (const f of files) {
      const wf = yaml.load(fs.readFileSync(path.join(wfDir, f), 'utf8')) as Workflow;
      expect(Object.keys(wf.jobs ?? {}).length, f).toBeGreaterThan(0);
    }
  });

  it('release.yml packages with --publish never, the computed channel and the optional host override', () => {
    const rel = workflow('release.yml');
    const v = rel.jobs.prepare!.steps!.find((s) => s.name === 'Resolve version')!;
    expect(v.run).toContain('echo "channel=$channel"');
    expect(rel.jobs.prepare!.outputs?.channel).toBe('${{ steps.v.outputs.channel }}');
    const pkg = rel.jobs.build!.steps!.find((s) => s.name === 'Package and sign') as Step & {
      env: Record<string, string>;
    };
    expect(pkg.env.CHANNEL).toBe('${{ needs.prepare.outputs.channel }}');
    expect(pkg.env.DOWNLOADS_URL).toBe('${{ vars.GITHAPPENS_DOWNLOADS_URL }}');
    expect(pkg.run).toContain('--publish never');
    expect(pkg.run).toContain('"-c.publish.channel=$CHANNEL"');
    expect(pkg.run).toContain('"-c.publish.url=${DOWNLOADS_URL%/}/releases"');
  });

  it('release.yml uploads to R2 after the manifest merge, skipping cleanly without secrets', () => {
    const rel = workflow('release.yml');
    const publish = rel.jobs.publish!;
    expect(publish.steps!.some((s) => s.with?.name === 'update-manifests')).toBe(true);
    const r2 = rel.jobs.r2! as Job & { env: Record<string, string> };
    expect(r2.needs).toEqual(['prepare', 'publish']);
    expect(r2.env).toMatchObject({
      R2_ACCOUNT_ID: '${{ secrets.R2_ACCOUNT_ID }}',
      R2_ACCESS_KEY_ID: '${{ secrets.R2_ACCESS_KEY_ID }}',
      R2_SECRET_ACCESS_KEY: '${{ secrets.R2_SECRET_ACCESS_KEY }}',
      R2_BUCKET: '${{ vars.R2_BUCKET || secrets.R2_BUCKET }}',
      GITHAPPENS_DOWNLOADS_URL: '${{ vars.GITHAPPENS_DOWNLOADS_URL }}',
    });
    const [check, ...rest] = r2.steps!;
    expect(check!.name).toBe('Check R2 configuration');
    expect(check!.run).toContain('::notice');
    expect(check!.run).toContain('enabled=false');
    // Every later step is gated, so a fork without secrets ends green with the notice.
    for (const s of rest) expect(s.if, s.name ?? s.uses).toBe("steps.cfg.outputs.enabled == 'true'");
    const runs = rest.map((s) => s.run ?? '').filter((r) => r.includes('upload-r2.mjs'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain('--dry-run');
    expect(runs[1]).not.toContain('--dry-run');
    // Credentials never appear on a command line.
    for (const r of runs) expect(r).not.toMatch(/SECRET|ACCESS_KEY/);
  });
});

type Upload = { phase: string; src: string; key: string; cacheControl: string; contentType: string };
type VersionJson = { version: string; channel: string; date: string; files: Record<string, string> };
type PlanInput = {
  version: string;
  channel: string;
  downloadsUrl: string;
  date: string;
  artifacts: { name: string; path: string }[];
  manifests: { name: string; path: string; text: string }[];
  versionJsonPath: string;
};
const plan = uploadR2.planUpload as (o: PlanInput) => {
  uploads: Upload[];
  versionJson: VersionJson;
  warnings: string[];
};
const CACHE = uploadR2.CACHE_CONTROL as Record<'immutable' | 'fixed' | 'metadata', string>;

/** What the default build matrix (no arm64 runners) produces for a version. */
function defaultBuild(v: string): { artifacts: string[]; manifests: Record<string, string[]> } {
  const win = [
    `GitHappens-Setup-${v}-x64.exe`,
    `GitHappens-Setup-${v}-x64.exe.blockmap`,
    `GitHappens-${v}-win-x64.zip`,
  ];
  const mac = ['x64', 'arm64'].flatMap((a) => [
    `GitHappens-${v}-mac-${a}.dmg`,
    `GitHappens-${v}-mac-${a}.dmg.blockmap`,
    `GitHappens-${v}-mac-${a}.zip`,
    `GitHappens-${v}-mac-${a}.zip.blockmap`,
  ]);
  const linux = ['x86_64.AppImage', 'amd64.deb', 'x86_64.rpm', 'x64.tar.gz'].map(
    (s) => `GitHappens-${v}-linux-${s}`,
  );
  return {
    artifacts: [...win, ...mac, ...linux],
    manifests: {
      yml: [`GitHappens-Setup-${v}-x64.exe`],
      'mac.yml': ['x64', 'arm64'].flatMap((a) => [
        `GitHappens-${v}-mac-${a}.zip`,
        `GitHappens-${v}-mac-${a}.dmg`,
      ]),
      'linux.yml': [`GitHappens-${v}-linux-x86_64.AppImage`],
    },
  };
}
const manifestText = (v: string, urls: string[]): string =>
  [
    `version: ${v}`,
    'files:',
    ...urls.flatMap((u) => [`  - url: ${u}`, '    sha512: abc==', '    size: 1']),
    `path: ${urls[0]}`,
    'sha512: abc==',
    "releaseDate: '2026-10-10T03:00:00.000Z'",
    '',
  ].join('\n');
function planFor(v: string, channel: string, over: Partial<PlanInput> = {}): ReturnType<typeof plan> {
  const b = defaultBuild(v);
  return plan({
    version: v,
    channel,
    downloadsUrl: 'https://downloads.githappens.dev',
    date: '2026-10-10T03:00:00.000Z',
    artifacts: b.artifacts.map((name) => ({ name, path: `dist/${name}` })),
    manifests: Object.entries(b.manifests).map(([suffix, urls]) => {
      const name = suffix === 'yml' ? `${channel}.yml` : `${channel}-${suffix}`;
      return { name, path: `manifests/${name}`, text: manifestText(v, urls) };
    }),
    versionJsonPath: 'work/version.json',
    ...over,
  });
}

describe('upload-r2.mjs (R2 layout, order and cache headers)', () => {
  it('uploads artifacts, then fixed-name copies, then version.json, and the channel manifests last', () => {
    const { uploads } = planFor('0.2.0', 'latest');
    const phases = uploads.map((u) => u.phase).filter((p, i, a) => p !== a[i - 1]);
    expect(phases).toEqual(['artifacts', 'fixed', 'metadata', 'manifests']);
    const lastArtifact = uploads.map((u) => u.phase).lastIndexOf('artifacts');
    const firstManifest = uploads.findIndex((u) => u.key.endsWith('.yml'));
    expect(firstManifest).toBeGreaterThan(lastArtifact);
    expect(uploads.slice(firstManifest).map((u) => u.key)).toEqual([
      'releases/latest-linux.yml',
      'releases/latest-mac.yml',
      'releases/latest.yml',
    ]);
  });

  it('sets the cache headers per kind of object', () => {
    const { uploads } = planFor('0.2.0', 'latest');
    for (const u of uploads) {
      const metadata = u.key.endsWith('.yml') || u.key.endsWith('/version.json');
      const expected = metadata
        ? CACHE.metadata
        : u.key.startsWith('releases/')
          ? CACHE.immutable
          : CACHE.fixed;
      expect(u.cacheControl, u.key).toBe(expected);
    }
    expect(CACHE).toEqual({
      immutable: 'public, max-age=31536000, immutable',
      fixed: 'public, max-age=300',
      metadata: 'no-cache, max-age=0',
    });
    expect(uploads.find((u) => u.key === 'releases/latest.yml')!.contentType).toBe(
      'text/yaml; charset=utf-8',
    );
  });

  it('puts every versioned artifact + blockmap in releases/ and fixed-name copies in latest/', () => {
    const { uploads, versionJson, warnings } = planFor('0.2.0', 'latest');
    expect(warnings).toEqual([]);
    const keys = (phase: string): string[] => uploads.filter((u) => u.phase === phase).map((u) => u.key);
    expect(keys('artifacts')).toHaveLength(defaultBuild('0.2.0').artifacts.length);
    expect(keys('artifacts')).toContain('releases/GitHappens-Setup-0.2.0-x64.exe.blockmap');
    expect(keys('fixed').sort()).toEqual([
      'latest/GitHappens-Setup-x64.exe',
      'latest/GitHappens-linux-amd64.deb',
      'latest/GitHappens-linux-x64.tar.gz',
      'latest/GitHappens-linux-x86_64.AppImage',
      'latest/GitHappens-linux-x86_64.rpm',
      'latest/GitHappens-mac-arm64.dmg',
      'latest/GitHappens-mac-arm64.zip',
      'latest/GitHappens-mac-x64.dmg',
      'latest/GitHappens-mac-x64.zip',
      'latest/GitHappens-win-x64.zip',
    ]);
    expect(keys('metadata')).toEqual(['latest/version.json']);
    const base = 'https://downloads.githappens.dev/latest';
    expect(versionJson).toEqual({
      version: '0.2.0',
      channel: 'latest',
      date: '2026-10-10T03:00:00.000Z',
      files: {
        'linux-x64-appimage': `${base}/GitHappens-linux-x86_64.AppImage`,
        'linux-x64-deb': `${base}/GitHappens-linux-amd64.deb`,
        'linux-x64-rpm': `${base}/GitHappens-linux-x86_64.rpm`,
        'linux-x64-tar.gz': `${base}/GitHappens-linux-x64.tar.gz`,
        'mac-arm64-dmg': `${base}/GitHappens-mac-arm64.dmg`,
        'mac-arm64-zip': `${base}/GitHappens-mac-arm64.zip`,
        'mac-x64-dmg': `${base}/GitHappens-mac-x64.dmg`,
        'mac-x64-zip': `${base}/GitHappens-mac-x64.zip`,
        'windows-x64-exe': `${base}/GitHappens-Setup-x64.exe`,
        'windows-x64-zip': `${base}/GitHappens-win-x64.zip`,
      },
    });
  });

  it('maps the arm64 Windows/Linux names electron-builder produces', () => {
    const fixed = uploadR2.fixedCopy as (n: string, v: string) => { fixed: string; key: string } | null;
    const v = '0.2.0';
    const cases: [string, string, string][] = [
      [`GitHappens-Setup-${v}-arm64.exe`, 'GitHappens-Setup-arm64.exe', 'windows-arm64-exe'],
      [`GitHappens-${v}-win-arm64.zip`, 'GitHappens-win-arm64.zip', 'windows-arm64-zip'],
      [`GitHappens-${v}-linux-arm64.AppImage`, 'GitHappens-linux-arm64.AppImage', 'linux-arm64-appimage'],
      [`GitHappens-${v}-linux-arm64.deb`, 'GitHappens-linux-arm64.deb', 'linux-arm64-deb'],
      [`GitHappens-${v}-linux-aarch64.rpm`, 'GitHappens-linux-aarch64.rpm', 'linux-arm64-rpm'],
      [`GitHappens-${v}-linux-arm64.tar.gz`, 'GitHappens-linux-arm64.tar.gz', 'linux-arm64-tar.gz'],
    ];
    for (const [name, f, key] of cases) expect(fixed(name, v)).toEqual({ fixed: f, key });
    expect(fixed(`GitHappens-Setup-${v}-x64.exe.blockmap`, v)).toBeNull();
    expect(fixed('GitHappens-Setup-0.2.1-x64.exe', v)).toBeNull();
  });

  it('nightly builds go to the preview channel and the preview/ folder', () => {
    const v = '0.2.1-preview.20261010';
    const { uploads, versionJson } = planFor(v, 'preview');
    expect(uploads.filter((u) => u.phase === 'fixed').every((u) => u.key.startsWith('preview/'))).toBe(true);
    expect(uploads.some((u) => u.key === 'preview/GitHappens-Setup-x64.exe')).toBe(true);
    expect(uploads.some((u) => u.key === `releases/GitHappens-Setup-${v}-x64.exe`)).toBe(true);
    expect(uploads.filter((u) => u.phase === 'manifests').map((u) => u.key)).toEqual([
      'releases/preview-linux.yml',
      'releases/preview-mac.yml',
      'releases/preview.yml',
    ]);
    expect(versionJson.files['windows-x64-exe']).toBe(
      'https://downloads.githappens.dev/preview/GitHappens-Setup-x64.exe',
    );
  });

  it('refuses inconsistent input before uploading anything', () => {
    const v = '0.2.0';
    const b = defaultBuild(v);
    const winYml = b.manifests.yml!;
    // A manifest that points at a file that was not built.
    expect(() =>
      planFor(v, 'latest', {
        artifacts: b.artifacts.filter((n) => !n.endsWith('.AppImage')).map((name) => ({ name, path: name })),
      }),
    ).toThrow(/latest-linux\.yml points at GitHappens-0\.2\.0-linux-x86_64\.AppImage/);
    // Wrong channel for the version, manifests of the other channel, or of another version.
    expect(() => planFor(v, 'preview')).toThrow(/does not belong on the preview channel/);
    expect(() =>
      planFor(v, 'latest', {
        manifests: [{ name: 'preview.yml', path: 'p', text: manifestText(v, winYml) }],
      }),
    ).toThrow(/preview\.yml does not belong/);
    expect(() =>
      planFor(v, 'latest', {
        manifests: [{ name: 'latest.yml', path: 'p', text: manifestText('0.1.9', winYml) }],
      }),
    ).toThrow(/version 0\.1\.9/);
    expect(() => planFor(v, 'beta')).toThrow(/latest or preview/);
  });

  describe('main()', () => {
    const run = uploadR2.main as (
      argv: string[],
      env: Record<string, string | undefined>,
      exec: (cmd: string, args: string[], env: Record<string, string | undefined>) => void,
      log: (line: string) => void,
    ) => number;
    const secrets = {
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'AKID',
      R2_SECRET_ACCESS_KEY: 'shh-secret',
      R2_BUCKET: 'githappens-downloads',
    };
    const setup = (): string[] => {
      const v = '0.2.0';
      const b = defaultBuild(v);
      const dist = path.join(dir, 'dist');
      const manifests = path.join(dir, 'manifests');
      fs.mkdirSync(dist);
      fs.mkdirSync(manifests);
      // Per-arch *.yml and builder-debug.yml also land in dist/ (dist-* artifacts); they are ignored.
      for (const n of [...b.artifacts, 'builder-debug.yml', 'latest.yml'])
        fs.writeFileSync(path.join(dist, n), 'x');
      for (const [suffix, urls] of Object.entries(b.manifests)) {
        const name = suffix === 'yml' ? 'latest.yml' : `latest-${suffix}`;
        fs.writeFileSync(path.join(manifests, name), manifestText(v, urls));
      }
      const work = ['--work-dir', path.join(dir, 'work')];
      return ['--version', v, '--channel', 'latest', '--dist', dist, '--manifests', manifests, ...work];
    };

    it('skips with a notice (exit 0) when the R2 settings are missing', () => {
      const calls: string[][] = [];
      const lines: string[] = [];
      const code = run(
        setup(),
        { R2_ACCOUNT_ID: 'x' },
        (_c, a) => calls.push(a),
        (l) => lines.push(l),
      );
      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(lines.join('\n')).toMatch(
        /^::notice title=R2 upload skipped::R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/,
      );
    });

    it('--dry-run prints the aws commands in upload order and runs nothing', () => {
      const calls: string[][] = [];
      const lines: string[] = [];
      const code = run(
        [...setup(), '--dry-run'],
        secrets,
        (_c, a) => calls.push(a),
        (l) => lines.push(l),
      );
      expect(code).toBe(0);
      expect(calls).toEqual([]);
      const cmds = lines.filter((l) => l.startsWith('aws s3 cp '));
      // 15 artifacts + 10 fixed copies + version.json + 3 manifests
      expect(cmds).toHaveLength(29);
      expect(cmds[0]).toContain('s3://githappens-downloads/releases/');
      expect(cmds[0]).toContain('--endpoint-url https://acct123.r2.cloudflarestorage.com --region auto');
      expect(cmds[0]).toContain("--cache-control 'public, max-age=31536000, immutable'");
      expect(cmds.at(-1)).toMatch(
        /s3:\/\/githappens-downloads\/releases\/latest\.yml .*--cache-control 'no-cache, max-age=0'/,
      );
      expect(lines.join('\n')).not.toContain('shh-secret');
    });

    it('runs aws with argv arrays, credentials only in the environment', () => {
      const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
      const code = run(
        setup(),
        secrets,
        (cmd, args, env) => calls.push({ cmd, args, env }),
        () => undefined,
      );
      expect(code).toBe(0);
      expect(calls.every((c) => c.cmd === 'aws' && c.args[0] === 's3' && c.args[1] === 'cp')).toBe(true);
      expect(calls.map((c) => c.args[3]).slice(-3)).toEqual([
        's3://githappens-downloads/releases/latest-linux.yml',
        's3://githappens-downloads/releases/latest-mac.yml',
        's3://githappens-downloads/releases/latest.yml',
      ]);
      expect(calls.some((c) => c.args.join(' ').includes('shh-secret'))).toBe(false);
      expect(calls[0]!.env).toMatchObject({
        AWS_ACCESS_KEY_ID: 'AKID',
        AWS_SECRET_ACCESS_KEY: 'shh-secret',
        AWS_DEFAULT_REGION: 'auto',
      });
      // version.json is written before its upload and lists the fixed copies.
      const vj = calls.find((c) => c.args[3]?.endsWith('/latest/version.json'))!;
      const json = JSON.parse(fs.readFileSync(vj.args[2]!, 'utf8')) as VersionJson;
      expect(json.version).toBe('0.2.0');
      expect(json.files['mac-arm64-dmg']).toBe(
        'https://downloads.githappens.dev/latest/GitHappens-mac-arm64.dmg',
      );
    });
  });
});
