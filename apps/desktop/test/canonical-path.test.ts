import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalKey, canonicalPath, type RealpathFn } from '../src/main/services/canonical-path';
import { parseOpenPathArgs } from '../src/main/services/cli-args';
import { pathKey as registryKey } from '../src/main/services/repo-registry';
import { scanForRepos } from '../src/main/workspaces/directory-scan';
import { pathKey as workspaceKey } from '../src/main/workspaces/util';
import { WorkspaceStore } from '../src/main/workspaces/workspace-store';

/** A fake filesystem where `SHORT~1` is an 8.3 alias of `short-and-long`. */
const sep = path.sep;
const root = path.resolve('/fake');
const LONG = path.join(root, 'short-and-long');
const SHORT = path.join(root, 'SHORT~1');
const fakeRealpath: RealpathFn = (p) => {
  const abs = path.resolve(p);
  if (abs === root || abs === path.parse(abs).root) return abs;
  if (abs === LONG || abs === SHORT) return LONG;
  if (abs.startsWith(LONG + sep)) return abs;
  if (abs.startsWith(SHORT + sep)) return LONG + abs.slice(SHORT.length);
  throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' });
};

describe('canonicalPath (injected realpath)', () => {
  it('expands an 8.3 alias and keeps a missing tail', () => {
    expect(canonicalPath(SHORT, fakeRealpath)).toBe(LONG);
    expect(canonicalPath(path.join(SHORT, 'alpha'), fakeRealpath)).toBe(path.join(LONG, 'alpha'));
    // `missing` does not exist: realpath fails, its existing ancestor is canonicalized instead.
    const throwsBelow: RealpathFn = (p) => {
      if (path.basename(p) === 'missing') throw new Error('ENOENT');
      return fakeRealpath(p);
    };
    expect(canonicalPath(path.join(SHORT, 'missing'), throwsBelow)).toBe(path.join(LONG, 'missing'));
  });

  it('strips trailing separators but keeps roots', () => {
    expect(canonicalPath(SHORT + sep, fakeRealpath)).toBe(LONG);
    const fsRoot = path.parse(root).root;
    expect(canonicalPath(fsRoot, (p) => p)).toBe(fsRoot);
  });

  it('keys compare equal for both spellings (case-folded on win32/darwin only)', () => {
    expect(canonicalKey(SHORT, 'win32', fakeRealpath)).toBe(canonicalKey(LONG, 'win32', fakeRealpath));
    expect(canonicalKey(LONG, 'win32', fakeRealpath)).toBe(LONG.toLowerCase());
    expect(canonicalKey(LONG, 'linux', fakeRealpath)).toBe(LONG);
    expect(registryKey(path.join(SHORT, 'alpha'), 'win32', fakeRealpath)).toBe(
      registryKey(path.join(LONG, 'ALPHA'), 'win32', fakeRealpath),
    );
  });

  it('parseOpenPathArgs canonicalizes and dedupes CLI paths', () => {
    expect(
      parseOpenPathArgs(['githappens', '-p', SHORT, `--path=${LONG}`], true, root, fakeRealpath),
    ).toEqual([LONG]);
  });
});

/** Windows 8.3 short name of `p` (via cmd's `%~sI`), or null when short names are disabled. */
function shortNameOf(p: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

describe('Windows 8.3 short paths (real filesystem)', () => {
  let tmp = '';
  let long = '';
  let short: string | null = null;

  beforeAll(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-canonical-')));
    long = path.join(tmp, 'a-long-folder-name-for-8dot3');
    fs.mkdirSync(path.join(long, 'alpha', '.git'), { recursive: true });
    fs.mkdirSync(path.join(long, 'beta', '.git'), { recursive: true });
    short = shortNameOf(long);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.runIf(process.platform === 'win32')(
    'short and long spellings resolve to one canonical path',
    async (ctx) => {
      if (!short) ctx.skip(); // 8.3 names disabled on this volume
      const s = short!;
      // The JS realpath keeps the short form; the native one (used by the app) expands it.
      expect(canonicalPath(s)).toBe(long);
      expect(canonicalPath(path.join(s, 'alpha'))).toBe(path.join(long, 'alpha'));
      expect(registryKey(path.join(s, 'alpha'))).toBe(registryKey(path.join(long, 'alpha')));
      expect(workspaceKey(path.join(s, 'alpha'))).toBe(workspaceKey(path.join(long, 'alpha')));
      expect(parseOpenPathArgs(['githappens', '-p', path.join(s, 'alpha')], true, tmp)).toEqual([
        path.join(long, 'alpha'),
      ]);

      // A scan of the short spelling reports the long paths (what the registry / recents hold).
      const scan = await scanForRepos({ root: s, depth: 1 });
      expect(scan.paths.sort()).toEqual([path.join(long, 'alpha'), path.join(long, 'beta')]);

      // Workspace repos added under both spellings are one repo.
      const profile = path.join(tmp, 'profile');
      const store = new WorkspaceStore({
        profileDir: () => profile,
        onChange: () => {},
        onCorrupt: () => {},
      });
      const ws = store.create({
        kind: 'local',
        name: 'Short names',
        repos: [{ localPath: path.join(s, 'alpha') }, { localPath: path.join(long, 'alpha') }],
      });
      expect(ws.repos.map((r) => r.localPath)).toEqual([path.join(long, 'alpha')]);
    },
  );
});
