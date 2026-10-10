import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedEnv } from '@githappens/fixtures';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildSearchPlan,
  cancelSearch,
  findOnPath,
  GitProcessRunner,
  GitService,
  pathspecFor,
  recordMatches,
  SearchRecordParser,
  searchProgress,
  searchTerms,
  type SearchTerm,
} from '../src';

describe('search plan (spec 12 §11 → git log argv)', () => {
  it('maps the legacy single-kind query to terms', () => {
    expect(searchTerms({ kind: 'file', text: 'a.ts' })).toEqual([{ field: 'path', text: 'a.ts' }]);
    expect(searchTerms({ kind: 'regex', text: '^x' })).toEqual([
      { field: 'content', text: '^x', regex: true },
    ]);
    expect(searchTerms({ kind: 'message', text: '' })).toEqual([]);
    const terms: SearchTerm[] = [{ field: 'author', text: 'bob' }];
    expect(searchTerms({ kind: 'message', text: 'ignored', terms })).toEqual(terms);
  });

  it('ANDs several message terms with --all-match (fixed strings)', () => {
    const p = buildSearchPlan([
      { field: 'message', text: 'fix bug' },
      { field: 'message', text: 'parser' },
    ]);
    expect(p.filter).toEqual([
      '--grep=fix bug',
      '--grep=parser',
      '--all-match',
      '--fixed-strings',
      '--regexp-ignore-case',
    ]);
    expect(p.post).toEqual([]);
    expect(p.literalPathspecs).toBe(true);
  });

  it('switches to -E for /regex/ and escapes literal terms', () => {
    const p = buildSearchPlan(
      [
        { field: 'message', text: '^fix(es)?:', regex: true },
        { field: 'message', text: 'a.b' },
        { field: 'author', text: 'x+y' },
      ],
      true,
    );
    expect(p.filter).toEqual([
      '--grep=^fix(es)?:',
      '--grep=a\\.b',
      '--all-match',
      '--author=x\\+y',
      '--extended-regexp',
    ]);
  });

  it('post-filters several authors, any-terms and sha terms', () => {
    const p = buildSearchPlan([
      { field: 'author', text: 'alice' },
      { field: 'author', text: 'jones' },
      { field: 'any', text: 'parser' },
      { field: 'sha', text: 'abcd' },
    ]);
    expect(p.filter).toEqual(['--regexp-ignore-case']);
    expect(p.post.map((t) => t.field).sort()).toEqual(['any', 'author', 'author', 'sha']);
    expect(p.format).toContain('%B');
  });

  it('pickaxe / diff regex / file pathspec; one each', () => {
    expect(buildSearchPlan([{ field: 'content', text: 'foo' }]).filter).toEqual([
      '-Sfoo',
      '--regexp-ignore-case',
    ]);
    expect(buildSearchPlan([{ field: 'content', text: 'f.o', regex: true }], true).filter).toEqual(['-Gf.o']);
    const f = buildSearchPlan([{ field: 'path', text: 'src/*.ts' }]);
    expect(f.paths).toEqual([':(glob,icase)src/*.ts']);
    expect(f.literalPathspecs).toBe(false);
    expect(pathspecFor('*.md', true)).toEqual([':(glob)**/*.md']);
    expect(pathspecFor('a[1]', true)).toEqual([':(glob)**/a[1]']);
    expect(pathspecFor('readme', false)).toEqual([':(glob,icase)**/*readme*', ':(glob,icase)**/*readme*/**']);
    expect(() =>
      buildSearchPlan([
        { field: 'content', text: 'a' },
        { field: 'content', text: 'b' },
      ]),
    ).toThrow(/one content/);
    expect(() =>
      buildSearchPlan([
        { field: 'path', text: 'a' },
        { field: 'path', text: 'b' },
      ]),
    ).toThrow(/one file:/);
  });

  it('parses records split across chunks and post-filters them', () => {
    const parser = new SearchRecordParser();
    const rec = 'abc123\x1f100\x1fAlice Jones\x1fa@x.com\x1ffix parser\n\nbody\n\x1e\n';
    expect(parser.push(rec.slice(0, 9))).toEqual([]);
    const recs = [...parser.push(rec.slice(9) + 'def\x1f90'), ...parser.end()];
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ sha: 'abc123', time: 100, authorName: 'Alice Jones' });
    expect(recs[1]).toMatchObject({ sha: 'def', time: 90 });
    const r = recs[0]!;
    expect(recordMatches(r, [{ field: 'any', text: 'PARSER' }])).toBe(true);
    expect(recordMatches(r, [{ field: 'any', text: 'PARSER' }], true)).toBe(false);
    expect(
      recordMatches(r, [
        { field: 'author', text: 'alice' },
        { field: 'author', text: 'jones' },
      ]),
    ).toBe(true);
    expect(
      recordMatches(r, [
        { field: 'author', text: 'alice' },
        { field: 'author', text: 'bob' },
      ]),
    ).toBe(false);
    expect(recordMatches(r, [{ field: 'sha', text: 'ABC1' }])).toBe(true);
    expect(recordMatches(r, [{ field: 'any', text: 'body' }])).toBe(true);
  });
});

// Integration: real git in a temp repo.
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

d('GitService.search (real git)', () => {
  let root: string;
  let runner: GitProcessRunner;
  let svc: GitService;
  const sha: Record<string, string> = {};

  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-search-')));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const env = isolatedEnv(root);
    const git = (args: string[], extra: Record<string, string> = {}) =>
      execFileSync(gitPath!, args, { cwd: repo, env: { ...env, ...extra }, windowsHide: true })
        .toString('utf8')
        .trim();
    git(['init', '-q', '-b', 'main']);
    let t = 1_700_000_000;
    const commit = (key: string, name: string, email: string, msg: string, file?: [string, string]) => {
      if (file) {
        fs.mkdirSync(path.dirname(path.join(repo, file[0])), { recursive: true });
        fs.writeFileSync(path.join(repo, file[0]), file[1]);
        git(['add', '-A']);
      }
      const date = `${t++} +0000`;
      git(
        ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', msg],
        {
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      );
      sha[key] = git(['rev-parse', 'HEAD']);
    };
    commit('a', 'Alice Smith', 'alice@x.com', 'fix bug in parser', ['src/parser.ts', 'const needle = 1;\n']);
    commit('b', 'Bob Jones', 'bob@x.com', 'fix typo', ['README.md', 'hello\n']);
    commit('c', 'Alice Jones', 'aj@x.com', 'parser: speed up\n\nfix bug body', ['src/lexer.ts', 'x\n']);
    commit('d', 'Carol', 'carol@x.com', 'feat: add widget', ['docs/guide.md', 'widget\n']);
    runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }),
    });
    svc = await GitService.open(runner, repo);
  });
  afterAll(() => {
    svc?.dispose();
    runner?.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may still hold handles briefly */
    }
  });

  const q = (terms: SearchTerm[], extra: { limit?: number; searchId?: string } = {}) =>
    svc.search({ kind: 'message', text: '', terms, ...extra });

  it('multi-term message AND (--all-match), quoted phrase as one term', async () => {
    expect(
      await q([
        { field: 'message', text: 'fix' },
        { field: 'message', text: 'parser' },
      ]),
    ).toEqual([sha.c, sha.a]);
    expect(await q([{ field: 'message', text: 'fix bug' }])).toEqual([sha.c, sha.a]);
    expect(await q([{ field: 'message', text: 'bug fix' }])).toEqual([]);
  });

  it('/regex/ message search uses -E', async () => {
    expect(await q([{ field: 'message', text: '^(fix|feat)[:]? (typo|add)', regex: true }])).toEqual([
      sha.d,
      sha.b,
    ]);
    await expect(q([{ field: 'message', text: '(unclosed', regex: true }])).rejects.toBeTruthy();
  });

  it('ANDs authors, any-terms, sha prefixes and git-side filters', async () => {
    expect(
      await q([
        { field: 'author', text: 'alice' },
        { field: 'author', text: 'jones' },
      ]),
    ).toEqual([sha.c]);
    expect(
      await q([
        { field: 'any', text: 'jones' },
        { field: 'any', text: 'fix' },
      ]),
    ).toEqual([sha.c, sha.b]);
    expect(
      await q([
        { field: 'any', text: 'parser' },
        { field: 'path', text: 'lexer' },
      ]),
    ).toEqual([sha.c]);
    expect(
      await q([
        { field: 'content', text: 'needle' },
        { field: 'author', text: 'smith' },
      ]),
    ).toEqual([sha.a]);
    expect(await q([{ field: 'sha', text: sha.b!.slice(0, 7) }])).toEqual([sha.b]);
    expect(await q([{ field: 'sha', text: 'main' }])).toEqual([sha.d]);
    expect(
      await q([
        { field: 'sha', text: sha.b!.slice(0, 6) },
        { field: 'message', text: 'typo' },
      ]),
    ).toEqual([sha.b]);
    expect(await q([{ field: 'any', text: 'a' }], { limit: 2 })).toHaveLength(2);
  });

  it('reports progress and keeps the final snapshot', async () => {
    const searchId = 'progress-1';
    const shas = await q([{ field: 'any', text: 'fix' }], { searchId });
    const p = searchProgress(searchId)!;
    expect(p).toMatchObject({ searchId, done: true, cancelled: false, scanned: 4, total: shas.length });
    expect(p.shas).toEqual(shas);
    expect(searchProgress(searchId, 1)!.shas).toEqual(shas.slice(1));
    expect(p.reachedTime).toBe(1_700_000_000);
    expect(searchProgress('unknown')).toBeNull();
    expect(cancelSearch('unknown')).toBe(false);
  });

  it('graph:search:cancel aborts a running search (Cancelled) before git spawns', async () => {
    const searchId = 'cancel-1';
    const p = q([{ field: 'content', text: 'needle' }], { searchId });
    expect(cancelSearch(searchId)).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'Cancelled' });
    expect(searchProgress(searchId)).toMatchObject({ done: true, cancelled: true });
  });

  it('cancel kills the streaming git process and keeps partial results', async () => {
    const searchId = 'cancel-2';
    let seenSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    // A git log that printed one record and then hangs until it is killed.
    const spy = vi.spyOn(svc, 'streamRead').mockImplementation((_args, o) => {
      seenSignal = o?.signal;
      let fail: (e: unknown) => void = () => undefined;
      const done = new Promise<never>((_r, rej) => (fail = rej));
      async function* out(): AsyncGenerator<Buffer> {
        yield Buffer.from(`${sha.a}\x1f1700000000\x1e\n`);
        await new Promise<void>((resolve) => seenSignal!.addEventListener('abort', () => resolve()));
        const e = Object.assign(new Error('Cancelled'), { code: 'Cancelled' });
        fail(e);
        throw e;
      }
      done.catch(() => undefined);
      return { stdout: out(), done, cancel } as unknown as ReturnType<GitService['streamRead']>;
    });
    try {
      const p = q([{ field: 'content', text: 'needle' }], { searchId });
      await vi.waitFor(() => expect(searchProgress(searchId)?.total).toBe(1));
      expect(searchProgress(searchId)).toMatchObject({ done: false, shas: [sha.a] });
      cancelSearch(searchId);
      await expect(p).rejects.toThrow('Cancelled');
      expect(seenSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalled();
      expect(searchProgress(searchId)).toMatchObject({ done: true, shas: [sha.a] });
    } finally {
      spy.mockRestore();
    }
  });

  it('cancelling a real pickaxe search leaves no git process running', async () => {
    const searchId = 'cancel-3';
    const base = runner.activeCount; // long-lived cat-file helpers of earlier tests
    const p = q([{ field: 'content', text: 'nothing-matches-this' }], { searchId });
    await vi
      .waitFor(() => expect(runner.activeCount).toBeGreaterThan(base), { timeout: 5000, interval: 1 })
      .catch(
        () => undefined, // tiny repo: git may already have finished
      );
    cancelSearch(searchId);
    await p.catch(() => undefined);
    await vi.waitFor(() => expect(runner.activeCount).toBe(base));
  });
});
