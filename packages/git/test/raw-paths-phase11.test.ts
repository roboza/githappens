import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeIgnoreLiteral } from '../src/ops/ignore-pattern';
import {
  opPath,
  rawIgnorePatternFor,
  rawKeyBytes,
  rawPathKey,
  rawPathPattern,
  shownPath,
} from '../src/ops/raw-path';
import { fileHistory } from '../src/service/file-views';
import { argvPathspecs, batchPathspec, rawPathGlob } from '../src/service/pathspec';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

/**
 * Phase 11 (spec 02 §8): names that are not valid UTF-8 are addressed by their raw bytes end to end —
 * pathspec stdin where git supports it, a `:(glob)` pathspec (`?` per invalid byte) for diff / log /
 * clean, and `?` patterns for .gitignore.
 */

const keyOf = (bytes: number[]): string => rawPathKey(Buffer.from(bytes).toString('base64'));
// "dir/laté #1.txt" in Latin-1: 0xe9 is not valid UTF-8 on its own
const LATIN = [...Buffer.from('dir/lat'), 0xe9, ...Buffer.from(' #1.txt')];

describe('raw path helpers (renderer-safe)', () => {
  it('decodes keys, shows U+FFFD and builds byte patterns', () => {
    const key = keyOf(LATIN);
    expect([...rawKeyBytes(key)]).toEqual(LATIN);
    expect(shownPath(key)).toBe('dir/lat� #1.txt');
    expect(shownPath('plain.txt')).toBe('plain.txt');
    expect(rawPathPattern(key, (s) => s)).toBe('dir/lat? #1.txt');
    // a valid multi-byte character next to an invalid byte stays a character
    const mixed = keyOf([...Buffer.from('é'), 0xff, ...Buffer.from('€')]);
    expect(rawPathPattern(mixed, (s) => s)).toBe('é?€');
    // truncated sequences / overlongs are invalid bytes, one `?` each
    expect(rawPathPattern(keyOf([0xe2, 0x82, 0x41]), (s) => s)).toBe('??A');
    expect(rawPathPattern(keyOf([0xc0, 0xaf]), (s) => s)).toBe('??');
    expect(opPath({ path: 'a�', rawPath: 'YYE=' })).toBe(rawPathKey('YYE='));
    expect(opPath({ path: 'a.txt' })).toBe('a.txt');
  });

  it('gitignore patterns keep `?` for invalid bytes and escape the rest', () => {
    const key = keyOf(LATIN);
    expect(rawIgnorePatternFor('file', key)).toBe('/dir/lat? #1.txt');
    expect(rawIgnorePatternFor('file', keyOf([...Buffer.from('x*'), 0xff]))).toBe(
      `/${escapeIgnoreLiteral('x*')}?`,
    );
    expect(rawIgnorePatternFor('file', keyOf([0xff, ...Buffer.from(' ')]))).toBe('/?\\ ');
    expect(rawIgnorePatternFor('folder', key)).toBe('/dir/');
    expect(rawIgnorePatternFor('extension', key)).toBe('*.txt');
    expect(rawIgnorePatternFor('folder', keyOf([0xff, ...Buffer.from('.md')]))).toBeNull();
  });

  it('argv pathspecs: :(glob) for raw keys, :(literal) for the others; batchPathspec no longer throws', () => {
    const key = keyOf([...Buffer.from('a*['), 0xff, ...Buffer.from('.txt')]);
    expect(rawPathGlob(key)).toBe(':(glob)a\\*\\[?.txt');
    expect(argvPathspecs(['x.txt'])).toEqual({ paths: ['x.txt'], env: { GIT_LITERAL_PATHSPECS: '1' } });
    expect(argvPathspecs([key, 'b*.txt'])).toEqual({
      paths: [':(glob)a\\*\\[?.txt', ':(literal)b*.txt'],
      env: { GIT_LITERAL_PATHSPECS: '0' },
    });
    expect(batchPathspec(['clean', '-f'], [key])).toEqual([
      { args: ['clean', '-f', '--', ':(glob)a\\*\\[?.txt'], env: { GIT_LITERAL_PATHSPECS: '0' } },
    ]);
  });
});

/** Can this file system hold a name that is not valid UTF-8? (Linux yes; Windows / APFS no.) */
function canCreateRawName(dir: string): boolean {
  if (process.platform === 'win32') return false;
  const p = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x70, 0xff])]);
  try {
    fs.writeFileSync(p, '');
    fs.rmSync(p);
    return true;
  } catch {
    return false;
  }
}

describeGit('non-UTF-8 names with real git (Linux; skipped where the file system refuses them)', () => {
  const h = useHarness('rawnames');

  it('stage, unstage, diff, history, discard and ignore by raw bytes', async (ctx) => {
    const r = await tinyRepo(h);
    if (!canCreateRawName(r.dir)) return ctx.skip();
    const svc = r.svc;
    const abs = (bytes: number[]): Buffer => Buffer.concat([Buffer.from(`${r.dir}/`), Buffer.from(bytes)]);
    fs.mkdirSync(path.join(r.dir, 'dir'));
    const tracked = [...Buffer.from('dir/lat'), 0xe9, ...Buffer.from('.txt')];
    const twin = [...Buffer.from('dir/lat'), 0xe8, ...Buffer.from('.txt')]; // same shown name
    fs.writeFileSync(abs(tracked), 'one\n');
    let st = await svc.status();
    const entry = st.entries.find((e) => e.rawPath)!;
    const key = opPath(entry);
    expect(key).toBe(keyOf(tracked));

    // stage / unstage / stage + commit
    await h.run(svc, { type: 'wip.stage', paths: [key] });
    expect((await svc.status()).entries.find((e) => e.rawPath)).toMatchObject({ index: 'A' });
    await h.run(svc, { type: 'wip.unstage', paths: [key] });
    expect((await svc.status()).entries.find((e) => e.rawPath)).toMatchObject({ kind: 'untracked' });

    // diff of the untracked file (stdin) names it by its shown path
    const untrackedDiff = await svc.diff({ kind: 'untracked', path: key });
    expect(untrackedDiff).toHaveLength(1);
    expect(untrackedDiff[0]!.newPath).toBe(shownPath(key));
    expect(untrackedDiff[0]!.hunks[0]!.lines.map((l) => l.content)).toEqual(['one']);

    await h.run(svc, { type: 'wip.stage', paths: [key] });
    r.g('commit', '-q', '-m', 'add raw');
    fs.writeFileSync(abs(tracked), 'two\n');
    fs.writeFileSync(abs(twin), 'twin\n'); // untracked, differs only in the invalid byte

    // workdir diff through a :(glob) pathspec
    const wd = await svc.diff({ kind: 'workdir', paths: [key] });
    expect(wd.map((f) => f.newPath)).toEqual([shownPath(key)]);
    expect(wd[0]!.hunks[0]!.lines.filter((l) => l.type === 'add').map((l) => l.content)).toEqual(['two']);

    // file history by raw key (no --follow with pathspec magic)
    const hist = await fileHistory(svc, { path: key });
    expect(hist.entries.map((e) => e.subject)).toEqual(['add raw']);
    expect(hist.entries[0]!.path).toBe(shownPath(key));

    // discard the tracked change by key: the twin (untracked, same shown name) stays
    await h.run(svc, { type: 'wip.discard', paths: [key], includeUntracked: false });
    expect(fs.readFileSync(abs(tracked), 'utf8')).toBe('one\n');
    expect(fs.existsSync(abs(twin))).toBe(true);

    // ignore the twin by a `?` pattern
    st = await svc.status();
    const twinEntry = st.entries.find((e) => e.kind === 'untracked' && e.rawPath)!;
    const pattern = rawIgnorePatternFor('file', opPath(twinEntry))!;
    await h.run(svc, { type: 'wip.ignore', pattern });
    expect((await svc.status()).entries.some((e) => e.kind === 'untracked' && e.rawPath)).toBe(false);

    // discard an untracked raw file by key (git clean through a :(glob) pathspec)
    fs.rmSync(path.join(r.dir, '.gitignore'));
    await h.run(svc, { type: 'wip.discard', paths: [opPath(twinEntry)], includeUntracked: true });
    expect(fs.existsSync(abs(twin))).toBe(false);
    expect(fs.existsSync(abs(tracked))).toBe(true);
  });
});
