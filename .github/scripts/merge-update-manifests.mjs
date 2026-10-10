#!/usr/bin/env node
// Merge per-arch electron-builder update manifests (spec 15 §6.5, release.yml "publish" job).
//
// Each build job uploads its *.yml (latest.yml, latest-mac.yml, latest-linux.yml, latest-linux-arm64.yml,
// preview*.yml …) as an artifact `manifest-<id>/`. Windows x64 + arm64 both write `latest.yml` and the two
// macOS builds both write `latest-mac.yml`, so files with the same name are merged: the `files:` lists are
// concatenated (deduplicated by url) and the header (version, legacy `path`/`sha512`, releaseDate) comes
// from the x64 manifest. electron-updater then picks the file whose url contains `process.arch`.
//
// Usage: node .github/scripts/merge-update-manifests.mjs <manifests-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {string} text */
function split(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const i = lines.indexOf('files:');
  if (i < 0) throw new Error('manifest without files:');
  let j = i + 1;
  while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('- '))) j++;
  return { head: lines.slice(0, i + 1), files: lines.slice(i + 1, j), tail: lines.slice(j) };
}

/**
 * Merge manifests that share a file name.
 * @param {string[]} texts
 * @returns {{ text: string, files: number }}
 */
export function mergeManifests(texts) {
  // x64 first so the legacy single-file `path:`/`sha512:` header stays the x64 artifact.
  const sorted = [...texts].sort((a, b) => Number(/arm64/.test(a)) - Number(/arm64/.test(b)));
  const parts = sorted.map(split);
  const first = parts[0];
  if (!first) throw new Error('nothing to merge');
  const versions = new Set(parts.map((p) => p.head.find((l) => l.startsWith('version:'))));
  if (versions.size > 1) throw new Error(`manifests disagree on the version: ${[...versions].join(', ')}`);
  const seen = new Set();
  const files = [];
  for (const part of parts) {
    let entry = [];
    const flush = () => {
      const url = (entry[0] || '').replace(/^\s*-\s*url:\s*/, '');
      if (entry.length && !seen.has(url)) {
        seen.add(url);
        files.push(...entry);
      }
      entry = [];
    };
    for (const l of part.files) {
      if (/^\s*- /.test(l)) flush();
      entry.push(l);
    }
    flush();
  }
  return { text: [...first.head, ...files, ...first.tail].join('\n'), files: seen.size };
}

/**
 * manifests/<artifact>/<name>.yml → out/<name>.yml
 * @param {string} inDir
 * @param {string} outDir
 */
export function mergeDir(inDir, outDir) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const dir of fs.readdirSync(inDir)) {
    const sub = path.join(inDir, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.yml') || f === 'builder-debug.yml') continue;
      const list = groups.get(f) ?? [];
      list.push(fs.readFileSync(path.join(sub, f), 'utf8'));
      groups.set(f, list);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (const [name, texts] of groups) {
    const { text, files } = mergeManifests(texts);
    fs.writeFileSync(path.join(outDir, name), text);
    summary.push(`${name}: merged ${texts.length} manifest(s), ${files} file(s)`);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [inDir, outDir] = process.argv.slice(2);
  if (!inDir || !outDir) {
    console.error('usage: merge-update-manifests.mjs <manifests-dir> <out-dir>');
    process.exit(2);
  }
  for (const line of mergeDir(inDir, outDir)) console.log(line);
}
