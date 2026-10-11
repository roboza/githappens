import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { binaryArch, checkPackage } from '../../../.github/scripts/check-package-arch.mjs';
import { mergeDir, mergeManifests } from '../../../.github/scripts/merge-update-manifests.mjs';
import { RELEASES_REPO, RELEASES_URL } from '../src/main/services/updater';

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

const { GitHubProvider } = updaterRequire('./providers/GitHubProvider') as {
  GitHubProvider: new (
    options: object,
    updater: object,
    runtimeOptions: object,
  ) => {
    resolveFiles(info: object): { url: URL; info: { url: string } }[];
    getBlockMapFiles(baseUrl: URL, oldVersion: string, newVersion: string): URL[];
  };
};
/** electron-updater's GitHubProvider for the repo in electron-builder.yml `publish`. */
const githubProvider = () =>
  new GitHubProvider({ provider: 'github', ...RELEASES_REPO }, { channel: 'latest' }, { platform: 'win32' });

const merge = mergeManifests as (texts: string[]) => { text: string; files: number };
const mergeAll = mergeDir as (inDir: string, outDir: string) => string[];

/** What electron-builder writes for one arch (CRLF on Windows runners). */
const winManifest = (arch: 'x64' | 'arm64', eol = '\n'): string =>
  [
    'version: 0.2.0',
    'files:',
    `  - url: GitHappens-Setup-${arch}.exe`,
    `    sha512: sha-${arch}==`,
    `    size: ${arch === 'x64' ? 100 : 90}`,
    `path: GitHappens-Setup-${arch}.exe`,
    `sha512: sha-${arch}==`,
    "releaseDate: '2026-10-10T03:00:00.000Z'",
    '',
  ].join(eol);
const macManifest = (arch: 'x64' | 'arm64'): string =>
  [
    'version: 0.2.0',
    'files:',
    `  - url: GitHappens-mac-${arch}.zip`,
    `    sha512: zip-${arch}==`,
    '    size: 10',
    `  - url: GitHappens-mac-${arch}.dmg`,
    `    sha512: dmg-${arch}==`,
    '    size: 11',
    `path: GitHappens-mac-${arch}.zip`,
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
    expect(info.path).toBe('GitHappens-Setup-x64.exe'); // legacy field stays x64
    expect(info.files.map((f) => f.url)).toEqual(['GitHappens-Setup-x64.exe', 'GitHappens-Setup-arm64.exe']);
    // The github provider resolves the version-less names inside the release's tag.
    const gh = githubProvider();
    const resolved = gh.resolveFiles({ ...info, tag: 'v0.2.0' });
    for (const arch of ['x64', 'arm64']) {
      const picked = withArch(arch, () => provider.findFile(resolved, 'exe'));
      expect(picked?.url.href).toBe(
        `https://github.com/roboza/githappens/releases/download/v0.2.0/GitHappens-Setup-${arch}.exe`,
      );
    }
  });

  it("differential updates find the previous release's blockmap by its tag", () => {
    const gh = githubProvider();
    const [file] = gh.resolveFiles({ ...(yaml.load(winManifest('x64')) as object), tag: 'v0.2.0' });
    const [oldMap, newMap] = gh.getBlockMapFiles(file!.url, '0.1.0', '0.2.0');
    expect(newMap!.href).toBe(
      'https://github.com/roboza/githappens/releases/download/v0.2.0/GitHappens-Setup-x64.exe.blockmap',
    );
    expect(oldMap!.href).toBe(
      'https://github.com/roboza/githappens/releases/download/v0.1.0/GitHappens-Setup-x64.exe.blockmap',
    );
  });

  it('merges both macOS builds and deduplicates re-uploaded entries', () => {
    const { text, files } = merge([macManifest('x64'), macManifest('arm64'), macManifest('x64')]);
    expect(files).toBe(4);
    const info = yaml.load(text) as { files: { url: string; sha512: string; size: number }[] };
    expect(info.files).toContainEqual({
      url: 'GitHappens-mac-arm64.zip',
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
      winManifest('x64').replace(/Setup-x64\.exe/g, 'linux-x86_64.AppImage'),
    );
    put(
      'manifest-linux-arm64',
      'latest-linux-arm64.yml',
      winManifest('arm64').replace(/Setup-arm64\.exe/g, 'linux-arm64.AppImage'),
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

describe('GitHub Releases feed (electron-builder.yml publish + release.yml)', () => {
  const builderText = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  const cfg = yaml.load(builderText) as Record<string, unknown> & {
    publish: Record<string, unknown>;
    artifactName: string;
    nsis: { artifactName: string };
    dmg: { artifactName: string };
  };

  it('publishes to GitHub Releases of roboza/githappens as a draft that CI publishes', () => {
    expect(cfg.publish).toEqual({
      provider: 'github',
      owner: 'roboza',
      repo: 'githappens',
      releaseType: 'draft',
    });
    // The app's own references (deb/rpm download link) point at the same repository.
    expect(RELEASES_REPO).toEqual({ owner: cfg.publish.owner, repo: cfg.publish.repo });
    expect(RELEASES_URL).toBe('https://github.com/roboza/githappens/releases/latest');
    // No channel in the file: local builds write latest*.yml, CI passes the channel per version.
    expect(cfg.publish.channel).toBeUndefined();
  });

  it('asset names carry no version, so /releases/latest/download/<name> always works', () => {
    const patterns = [cfg.artifactName, cfg.nsis.artifactName, cfg.dmg.artifactName];
    for (const p of patterns) expect(p).not.toContain('${version}');
    // electron-builder's per-format arch spelling (x86_64/amd64/aarch64) is kept as is.
    const expand = (pattern: string, os: string, arch: string, ext: string): string =>
      pattern
        .replace('${productName}', 'GitHappens')
        .replace('${os}', os)
        .replace('${arch}', arch)
        .replace('${ext}', ext);
    const names = [
      ...['x64', 'arm64'].flatMap((a) => [
        expand(cfg.nsis.artifactName, 'win', a, 'exe'),
        expand(cfg.artifactName, 'win', a, 'zip'),
        expand(cfg.dmg.artifactName, 'mac', a, 'dmg'),
        expand(cfg.artifactName, 'mac', a, 'zip'),
        expand(cfg.artifactName, 'linux', a, 'tar.gz'),
      ]),
      ...[
        ['x86_64', 'AppImage'],
        ['arm64', 'AppImage'],
        ['amd64', 'deb'],
        ['arm64', 'deb'],
        ['x86_64', 'rpm'],
        ['aarch64', 'rpm'],
      ].map(([a, ext]) => expand(cfg.artifactName, 'linux', a!, ext!)),
    ];
    expect(names.sort()).toEqual(
      [
        'GitHappens-Setup-x64.exe',
        'GitHappens-Setup-arm64.exe',
        'GitHappens-win-x64.zip',
        'GitHappens-win-arm64.zip',
        'GitHappens-mac-x64.dmg',
        'GitHappens-mac-arm64.dmg',
        'GitHappens-mac-x64.zip',
        'GitHappens-mac-arm64.zip',
        'GitHappens-linux-x64.tar.gz',
        'GitHappens-linux-arm64.tar.gz',
        'GitHappens-linux-x86_64.AppImage',
        'GitHappens-linux-arm64.AppImage',
        'GitHappens-linux-amd64.deb',
        'GitHappens-linux-arm64.deb',
        'GitHappens-linux-x86_64.rpm',
        'GitHappens-linux-aarch64.rpm',
      ].sort(),
    );
    // GitHub keeps these names unchanged (electron-builder only rewrites names GitHub would mangle).
    for (const n of names) expect(n).toMatch(/^[\w.-]+$/);
  });

  it('the website download buttons use /releases/latest/download/<fixed name>', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'website', 'index.html'), 'utf8');
    const links = [...html.matchAll(/href="(https:\/\/github\.com\/roboza\/githappens\/releases\/[^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((u) => u.includes('/download/'));
    expect(links.sort()).toEqual(
      [
        'GitHappens-Setup-x64.exe',
        'GitHappens-mac-arm64.dmg',
        'GitHappens-mac-x64.dmg',
        'GitHappens-linux-x86_64.AppImage',
        'GitHappens-linux-amd64.deb',
        'GitHappens-linux-x86_64.rpm',
        'GitHappens-linux-x64.tar.gz',
      ]
        .map((n) => `https://github.com/roboza/githappens/releases/latest/download/${n}`)
        .sort(),
    );
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

  it('release.yml packages with --publish never and the computed channel', () => {
    const rel = workflow('release.yml');
    const v = rel.jobs.prepare!.steps!.find((s) => s.name === 'Resolve version')!;
    expect(v.run).toContain('echo "channel=$channel"');
    expect(rel.jobs.prepare!.outputs?.channel).toBe('${{ steps.v.outputs.channel }}');
    const pkg = rel.jobs.build!.steps!.find((s) => s.name === 'Package and sign') as Step & {
      env: Record<string, string>;
    };
    expect(pkg.env.CHANNEL).toBe('${{ needs.prepare.outputs.channel }}');
    expect(pkg.run).toContain('--publish never');
    // The github provider ignores detectUpdateChannel: preview builds need the explicit channel.
    expect(pkg.run).toContain('"-c.publish.channel=$CHANNEL"');
    expect(pkg.run).not.toContain('publish.url');
  });

  it('release.yml: draft → per-arch assets → merged manifests → prerelease (preview) or latest (stable)', () => {
    const rel = workflow('release.yml') as Workflow & { permissions?: Record<string, string> };
    expect(rel.permissions).toEqual({ contents: 'write' });
    expect(Object.keys(rel.jobs).sort()).toEqual(['build', 'prepare', 'publish']);
    const create = rel.jobs.prepare!.steps!.find((s) => (s.run ?? '').includes('gh release create'))!;
    expect(create.run).toContain('--draft');
    expect(create.run).toContain('--prerelease');
    const upload = rel.jobs.build!.steps!.find((s) => s.name === 'Upload to the draft release')!;
    expect(upload.run).toContain('*.blockmap');
    expect(upload.run).not.toContain('*.yml');
    const steps = rel.jobs.publish!.steps!;
    const names = steps.map((s) => s.name ?? s.uses ?? '');
    const merged = names.indexOf('Upload merged manifests');
    const published = names.indexOf('Publish release');
    expect(merged).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(merged); // clients never see a release without its manifests
    const run = steps[published]!.run!;
    expect(run).toContain('--draft=false');
    expect(run).toContain('flags+=(--prerelease)');
    expect(run).toContain('flags+=(--latest)');
  });
});
