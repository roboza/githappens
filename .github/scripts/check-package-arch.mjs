#!/usr/bin/env node
// Asserts that a packaged app carries binaries for its target arch (release.yml, spec 15 §6.3/§6.4):
// the bundled git executable and every native module (*.node) under app.asar.unpacked must be built for
// <arch>. Catches an x64 node-pty/@parcel/watcher prebuild or dugite git leaking into an arm64 package.
//
// Usage: node .github/scripts/check-package-arch.mjs <resources-dir> <x64|arm64>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Architecture of a PE / ELF / Mach-O binary from its header, or null if unrecognised.
 * Universal (fat) Mach-O files report every slice, joined with '+'.
 * @param {Buffer} b
 * @returns {string | null}
 */
export function binaryArch(b) {
  if (b.length >= 64 && b[0] === 0x4d && b[1] === 0x5a) {
    const pe = b.readUInt32LE(0x3c);
    if (pe + 6 > b.length || b.readUInt32LE(pe) !== 0x00004550) return null;
    const machine = b.readUInt16LE(pe + 4);
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }[machine] ?? `pe:${machine.toString(16)}`;
  }
  if (b.length >= 20 && b.readUInt32BE(0) === 0x7f454c46) {
    const machine = b[5] === 2 ? b.readUInt16BE(18) : b.readUInt16LE(18);
    return (
      { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' }[machine] ?? `elf:${machine.toString(16)}`
    );
  }
  const cpu = (/** @type {number} */ t) =>
    ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[t] ?? `macho:${t.toString(16)}`;
  if (b.length >= 8 && b.readUInt32LE(0) === 0xfeedfacf) return cpu(b.readUInt32LE(4));
  if (b.length >= 8 && b.readUInt32BE(0) === 0xcafebabe) {
    const n = b.readUInt32BE(4);
    const arches = [];
    for (let i = 0; i < n && 8 + i * 20 + 4 <= b.length; i++) arches.push(cpu(b.readUInt32BE(8 + i * 20)));
    return arches.join('+');
  }
  return null;
}

/** @param {string} file */
function headerOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {string} dir @returns {string[]} */
function nativeModules(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...nativeModules(p));
    else if (e.name.endsWith('.node')) out.push(p);
  }
  return out;
}

/**
 * @param {string} resources  packaged `resources` dir (Contents/Resources on macOS)
 * @param {string} arch       expected arch (x64 | arm64)
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkPackage(resources, arch) {
  const lines = [];
  let ok = true;
  const check = (/** @type {string} */ file, /** @type {boolean} */ required) => {
    if (!fs.existsSync(file)) {
      if (required) {
        ok = false;
        lines.push(`MISSING ${file}`);
      }
      return;
    }
    const got = binaryArch(headerOf(file));
    const good = got !== null && got.split('+').includes(arch);
    if (!good) ok = false;
    lines.push(`${good ? 'ok' : 'WRONG'} ${got ?? 'unknown'} ${path.relative(resources, file)}`);
  };
  const win = path.join(resources, 'git', 'cmd', 'git.exe');
  check(fs.existsSync(win) ? win : path.join(resources, 'git', 'bin', 'git'), true);
  const modules = nativeModules(path.join(resources, 'app.asar.unpacked', 'node_modules'));
  if (modules.length === 0) {
    ok = false;
    lines.push('MISSING native modules under app.asar.unpacked/node_modules');
  }
  for (const m of modules) check(m, true);
  // node-pty and @parcel/watcher must both have a prebuild for this arch.
  for (const pkg of ['node-pty', 'watcher']) {
    if (!modules.some((m) => m.includes(pkg) && m.includes(arch))) {
      ok = false;
      lines.push(`MISSING ${pkg} prebuild for ${arch}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [resources, arch] = process.argv.slice(2);
  if (!resources || !arch) {
    console.error('usage: check-package-arch.mjs <resources-dir> <x64|arm64>');
    process.exit(2);
  }
  const { ok, lines } = checkPackage(resources, arch);
  for (const l of lines) console.log(l);
  if (!ok) {
    console.error(`::error::packaged binaries do not all match ${arch}`);
    process.exit(1);
  }
}
