#!/usr/bin/env node
// Upload a release to Cloudflare R2 (release.yml "Upload to R2" job; layout in docs/releases.md).
//
//   releases/<versioned artifacts + .blockmap>   public, max-age=31536000, immutable
//   latest/ | preview/<fixed-name copies>        public, max-age=300
//   latest/ | preview/version.json               no-cache, max-age=0
//   releases/<channel manifests *.yml>           no-cache, max-age=0   ← always LAST
//
// Order matters: a client that reads a channel manifest must find every file it points at, so the
// versioned artifacts go up first, then the fixed-name copies + version.json, and the manifests last.
// Every manifest is checked against the artifacts before anything is uploaded.
//
// Usage:
//   node .github/scripts/upload-r2.mjs --version <v> --channel latest|preview \
//     --dist <dir with installers> --manifests <dir with merged *.yml> [--dry-run] [--date <iso>]
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (credentials are handed to the
// AWS CLI through its environment, never on the command line); GITHAPPENS_DOWNLOADS_URL optionally
// overrides the public base URL (default: `publish.url` in apps/desktop/electron-builder.yml minus
// `/releases`). Without the R2 settings the script prints a notice and exits 0 (forks still build).
// --dry-run prints the `aws` commands instead of running them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CACHE_CONTROL = {
  /** Versioned artifacts never change once uploaded. */
  immutable: 'public, max-age=31536000, immutable',
  /** Fixed-name copies in latest/ and preview/ are replaced by every release. */
  fixed: 'public, max-age=300',
  /** Channel manifests and version.json must be re-validated on every request. */
  metadata: 'no-cache, max-age=0',
};

/** Files electron-builder produces that belong in the feed (release/<version>/*). */
const ARTIFACT_EXTS = ['.exe', '.zip', '.dmg', '.AppImage', '.deb', '.rpm', '.tar.gz', '.blockmap'];
/** electron-updater channel files: latest.yml, latest-mac.yml, latest-linux.yml, latest-linux-arm64.yml … */
const MANIFEST_RE = /^(latest|preview)(-mac|-linux(?:-arm64)?)?\.yml$/;

const CONTENT_TYPES = [
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.zip', 'application/zip'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.deb', 'application/vnd.debian.binary-package'],
  ['.rpm', 'application/x-rpm'],
  ['.tar.gz', 'application/gzip'],
];

/** @param {string} name */
export function contentType(name) {
  return CONTENT_TYPES.find(([ext]) => name.endsWith(ext))?.[1] ?? 'application/octet-stream';
}

/** @param {string} name */
export function isArtifact(name) {
  return ARTIFACT_EXTS.some((ext) => name.endsWith(ext));
}

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** @param {string} a */
const normArch = (a) => (a === 'x86_64' || a === 'amd64' || a === 'x64' ? 'x64' : 'arm64');

/**
 * The fixed-name copy of a versioned artifact (the name minus `-<version>`) and its version.json key,
 * or null for files that get no fixed copy (blockmaps, unknown names).
 *   GitHappens-Setup-1.2.3-x64.exe        → GitHappens-Setup-x64.exe          windows-x64-exe
 *   GitHappens-1.2.3-win-arm64.zip        → GitHappens-win-arm64.zip          windows-arm64-zip
 *   GitHappens-1.2.3-mac-arm64.dmg        → GitHappens-mac-arm64.dmg          mac-arm64-dmg
 *   GitHappens-1.2.3-linux-x86_64.AppImage → GitHappens-linux-x86_64.AppImage linux-x64-appimage
 *   GitHappens-1.2.3-linux-amd64.deb      → GitHappens-linux-amd64.deb        linux-x64-deb
 * @param {string} name
 * @param {string} version
 * @returns {{ fixed: string, key: string } | null}
 */
export function fixedCopy(name, version) {
  const v = escapeRegExp(version);
  let m = new RegExp(`^(.+)-Setup-${v}-(x64|arm64)\\.exe$`).exec(name);
  if (m) return { fixed: `${m[1]}-Setup-${m[2]}.exe`, key: `windows-${m[2]}-exe` };
  m = new RegExp(`^(.+)-${v}-win-(x64|arm64)\\.zip$`).exec(name);
  if (m) return { fixed: `${m[1]}-win-${m[2]}.zip`, key: `windows-${m[2]}-zip` };
  m = new RegExp(`^(.+)-${v}-mac-(x64|arm64)\\.(dmg|zip)$`).exec(name);
  if (m) return { fixed: `${m[1]}-mac-${m[2]}.${m[3]}`, key: `mac-${m[2]}-${m[3]}` };
  m = new RegExp(`^(.+)-${v}-linux-(x86_64|amd64|x64|aarch64|arm64)\\.(AppImage|deb|rpm|tar\\.gz)$`).exec(
    name,
  );
  if (m) {
    return { fixed: `${m[1]}-linux-${m[2]}.${m[3]}`, key: `linux-${normArch(m[2])}-${m[3].toLowerCase()}` };
  }
  return null;
}

/**
 * Public base URL of the bucket: GITHAPPENS_DOWNLOADS_URL, else electron-builder.yml `publish.url`
 * without its `/releases` suffix (the one place the default lives).
 * @param {Record<string, string | undefined>} env
 * @param {string} builderConfigText
 */
export function resolveDownloadsUrl(env, builderConfigText) {
  const override = env.GITHAPPENS_DOWNLOADS_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  const lines = builderConfigText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^publish:\s*$/.test(l));
  for (let i = start + 1; start >= 0 && i < lines.length && /^(\s|$)/.test(lines[i] ?? ''); i++) {
    const m = /^\s+url:\s*['"]?([^'"#\s]+)/.exec(lines[i] ?? '');
    if (m?.[1]) return m[1].replace(/\/+$/, '').replace(/\/releases$/, '');
  }
  throw new Error('electron-builder.yml has no publish.url');
}

/**
 * Files a manifest points at (`files[].url` and the legacy `path`).
 * @param {string} text
 */
export function manifestRefs(text) {
  const refs = new Set();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(?:\s*-\s*url|\s+url|path):\s*['"]?([^'"\s]+)/.exec(line);
    if (m?.[1]) refs.add(decodeURIComponent(m[1]));
  }
  return [...refs];
}

/**
 * @typedef {{ phase: 'artifacts' | 'fixed' | 'metadata' | 'manifests', src: string, key: string,
 *   cacheControl: string, contentType: string }} Upload
 * @typedef {{ version: string, channel: string, date: string, files: Record<string, string> }} VersionJson
 */

/**
 * Build the ordered upload list. Pure: takes file names + manifest texts, touches no disk or network.
 * @param {{
 *   version: string, channel: string, downloadsUrl: string, date: string,
 *   artifacts: { name: string, path: string }[],
 *   manifests: { name: string, path: string, text: string }[],
 *   versionJsonPath: string,
 * }} o
 * @returns {{ uploads: Upload[], versionJson: VersionJson, warnings: string[] }}
 */
export function planUpload(o) {
  if (o.channel !== 'latest' && o.channel !== 'preview') {
    throw new Error(`channel must be latest or preview, got ${o.channel}`);
  }
  if (!o.version) throw new Error('version is required');
  const isPrerelease = o.version.includes('-');
  if (isPrerelease !== (o.channel === 'preview')) {
    throw new Error(`version ${o.version} does not belong on the ${o.channel} channel`);
  }
  const artifacts = o.artifacts
    .filter((a) => isArtifact(a.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (artifacts.length === 0) throw new Error('no artifacts to upload');
  if (o.manifests.length === 0) throw new Error('no update manifests to upload');
  const names = new Set(artifacts.map((a) => a.name));
  for (const m of o.manifests) {
    const nm = MANIFEST_RE.exec(m.name);
    if (!nm) throw new Error(`${m.name} is not an electron-updater channel manifest`);
    if (nm[1] !== o.channel) throw new Error(`${m.name} does not belong on the ${o.channel} channel`);
    const v = /^version:\s*['"]?([^'"\s]+)/m.exec(m.text)?.[1];
    if (v !== o.version) throw new Error(`${m.name} is for version ${v}, expected ${o.version}`);
    const refs = manifestRefs(m.text);
    if (refs.length === 0) throw new Error(`${m.name} lists no files`);
    for (const ref of refs) {
      if (!names.has(ref)) throw new Error(`${m.name} points at ${ref}, which is not among the artifacts`);
    }
  }

  const base = o.downloadsUrl.replace(/\/+$/, '');
  const folder = o.channel; // latest/ or preview/
  /** @type {Upload[]} */
  const uploads = [];
  /** @type {string[]} */
  const warnings = [];
  for (const a of artifacts) {
    uploads.push({
      phase: 'artifacts',
      src: a.path,
      key: `releases/${a.name}`,
      cacheControl: CACHE_CONTROL.immutable,
      contentType: contentType(a.name),
    });
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const a of artifacts) {
    if (a.name.endsWith('.blockmap')) continue;
    const copy = fixedCopy(a.name, o.version);
    if (!copy) {
      warnings.push(`no fixed-name copy for ${a.name}`);
      continue;
    }
    uploads.push({
      phase: 'fixed',
      src: a.path,
      key: `${folder}/${copy.fixed}`,
      cacheControl: CACHE_CONTROL.fixed,
      contentType: contentType(a.name),
    });
    files[copy.key] = `${base}/${folder}/${copy.fixed}`;
  }
  const versionJson = {
    version: o.version,
    channel: o.channel,
    date: o.date,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  uploads.push({
    phase: 'metadata',
    src: o.versionJsonPath,
    key: `${folder}/version.json`,
    cacheControl: CACHE_CONTROL.metadata,
    contentType: contentType('version.json'),
  });
  for (const m of [...o.manifests].sort((a, b) => a.name.localeCompare(b.name))) {
    uploads.push({
      phase: 'manifests',
      src: m.path,
      key: `releases/${m.name}`,
      cacheControl: CACHE_CONTROL.metadata,
      contentType: contentType(m.name),
    });
  }
  return { uploads, versionJson, warnings };
}

/**
 * `aws` argv for one upload (no credentials: those travel in the environment).
 * @param {Upload} u
 * @param {{ bucket: string, endpoint: string }} target
 */
export function awsArgs(u, target) {
  return [
    's3',
    'cp',
    u.src,
    `s3://${target.bucket}/${u.key}`,
    '--endpoint-url',
    target.endpoint,
    '--region',
    'auto',
    '--cache-control',
    u.cacheControl,
    '--content-type',
    u.contentType,
    '--no-progress',
    '--only-show-errors',
  ];
}

/** @param {string[]} argv */
export function formatCommand(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'dry-run') out[k] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[k] = v;
    }
  }
  return out;
}

/** @param {string} dir */
const listFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }));

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {(cmd: string, args: string[], env: Record<string, string | undefined>) => void} run
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
export function main(argv, env, run, log) {
  const args = parseArgs(argv);
  const dryRun = args['dry-run'] === true;
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (k) => !env[k]?.trim(),
  );
  if (missing.length > 0 && !dryRun) {
    log(`::notice title=R2 upload skipped::${missing.join(', ')} not configured — nothing was uploaded.`);
    return 0;
  }
  const version = String(args.version ?? '');
  const channel = String(args.channel ?? '');
  const dist = String(args.dist ?? '');
  const manifestsDir = String(args.manifests ?? '');
  if (!version || !channel || !dist || !manifestsDir) {
    log(
      'usage: upload-r2.mjs --version <v> --channel latest|preview --dist <dir> --manifests <dir> [--dry-run]',
    );
    return 2;
  }
  const builderConfig =
    typeof args['builder-config'] === 'string'
      ? args['builder-config']
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/electron-builder.yml');
  const downloadsUrl = resolveDownloadsUrl(env, fs.readFileSync(builderConfig, 'utf8'));
  const work =
    typeof args['work-dir'] === 'string'
      ? fs.mkdirSync(args['work-dir'], { recursive: true }) && args['work-dir']
      : fs.mkdtempSync(path.join(os.tmpdir(), 'githappens-r2-'));
  const versionJsonPath = path.join(work, 'version.json');
  const manifests = listFiles(manifestsDir)
    .filter((f) => f.name.endsWith('.yml') && f.name !== 'builder-debug.yml')
    .map((f) => ({ ...f, text: fs.readFileSync(f.path, 'utf8') }));
  const { uploads, versionJson, warnings } = planUpload({
    version,
    channel,
    downloadsUrl,
    date: typeof args.date === 'string' ? args.date : new Date().toISOString(),
    artifacts: listFiles(dist),
    manifests,
    versionJsonPath,
  });
  fs.writeFileSync(versionJsonPath, `${JSON.stringify(versionJson, null, 2)}\n`);
  for (const w of warnings) log(`::warning::${w}`);

  const target = {
    bucket: env.R2_BUCKET?.trim() || '<R2_BUCKET>',
    endpoint: `https://${env.R2_ACCOUNT_ID?.trim() || '<R2_ACCOUNT_ID>'}.r2.cloudflarestorage.com`,
  };
  const awsEnv = {
    ...env,
    AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto',
    // R2 does not implement every optional S3 integrity checksum newer AWS CLIs send by default.
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
  log(
    `${dryRun ? '[dry-run] ' : ''}${uploads.length} upload(s) to ${target.bucket}, public at ${downloadsUrl}`,
  );
  let phase = '';
  for (const u of uploads) {
    if (u.phase !== phase) {
      phase = u.phase;
      log(`# ${phase}`);
    }
    const argvAws = awsArgs(u, target);
    if (dryRun) log(formatCommand(['aws', ...argvAws]));
    else {
      log(`upload ${u.key}`);
      run('aws', argvAws, awsEnv);
    }
  }
  log(`# version.json\n${JSON.stringify(versionJson, null, 2)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(
      process.argv.slice(2),
      process.env,
      (cmd, args, env) => execFileSync(cmd, args, { stdio: 'inherit', env }),
      (line) => console.log(line),
    );
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
