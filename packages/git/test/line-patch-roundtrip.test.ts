import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedEnv } from '@githappens/fixtures';
import { expect, it } from 'vitest';

import { STAGING_DIFF_OPTIONS } from '../src/ops/diff-hash';
import { buildLinePatch, selectHunk, selectLines, type PatchMode } from '../src/ops/executors/patch';
import type { LineRef } from '../src/ops/types';
import type { FileDiff } from '../src/types';
import { applyPatch, expectedResult, mulberry32 } from './line-patch-helpers';
import { describeGit, gitPath, useHarness } from './ops-harness';

/**
 * Property round-trip (spec 06 §6.5): ~1000 random file diffs in ONE repo. Random line selections are
 * staged with a single `git apply --cached`, the index is read back and compared with an in-memory model;
 * then random selections of the staged diff are unstaged (`--cached -R`) and checked the same way.
 * Seed: GH_LINEPATCH_SEED (printed with every failure).
 */
const SEED = Number(process.env.GH_LINEPATCH_SEED ?? 0x5eed_2026);
const TRACKED = 1030;
const UNTRACKED = 40;

describeGit('buildLinePatch round-trip with git apply', () => {
  const h = useHarness('linepatch-rt');

  it('stages then unstages random line selections of 1000+ diffs', async () => {
    const rnd = mulberry32(SEED);
    const int = (n: number): number => Math.floor(rnd() * n);
    const chance = (p: number): boolean => rnd() < p;

    const dir = h.fixture('empty').path;
    const svc = await h.open(dir);
    const env = isolatedEnv(h.root);
    const git = (input: string | null, ...args: string[]): Buffer =>
      execFileSync(gitPath!, args, {
        cwd: dir,
        env,
        input: input ?? undefined,
        stdio: 'pipe',
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
    git(null, 'config', 'core.autocrlf', 'false');
    git(null, 'config', 'core.safecrlf', 'false');

    // ---- random contents: per-file tokens (no cross-file similarity → no rename pairing) ----
    const gen = (id: number, crlf: boolean, n: number, finalEol: boolean): string[] => {
      const lines = Array.from({ length: n }, () => `f${id}:${int(8)}${crlf && chance(0.7) ? '\r' : ''}\n`);
      if (lines.length && !finalEol) lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\r?\n$/, '');
      return lines;
    };
    const edit = (id: number, crlf: boolean, old: string[]): string => {
      const out: string[] = [];
      const fresh = (): string => `f${id}:${8 + int(6)}${crlf && chance(0.7) ? '\r' : ''}\n`;
      if (chance(0.1)) out.push(fresh());
      for (const l of old) {
        const r = rnd();
        if (r < 0.62) out.push(l.endsWith('\n') ? l : `${l}\n`);
        else if (r < 0.75) continue;
        else if (r < 0.88) out.push(fresh());
        else out.push(l.endsWith('\n') ? l : `${l}\n`, fresh());
      }
      const finalEol = old.length && !old[old.length - 1]!.endsWith('\n') ? chance(0.5) : chance(0.85);
      if (out.length && !finalEol) out[out.length - 1] = out[out.length - 1]!.replace(/\r?\n$/, '');
      return out.join('');
    };

    interface F {
      path: string;
      head: string | null;
      work: string | null;
      /** Expected index after the stage phase. */
      staged?: string | null;
      unstaged?: string | null;
    }
    const files: F[] = [];
    const nameOf = (i: number): string =>
      i % 97 === 0
        ? `d${i % 7}/sp ${i} ü.txt`
        : i % 101 === 0
          ? `d${i % 7}/日本 ${i}.md`
          : `d${i % 7}/f${i}.txt`;
    for (let i = 0; i < TRACKED; i++) {
      const crlf = chance(0.15);
      const head = chance(0.05) ? '' : gen(i, crlf, 1 + int(24), chance(0.8)).join('');
      let work: string | null = head !== '' && chance(0.05) ? null : edit(i, crlf, rawSplit(head));
      if (work === head) work = `f${i}:top\n${head}`;
      files.push({ path: nameOf(i), head, work });
    }
    for (let i = TRACKED; i < TRACKED + UNTRACKED; i++) {
      files.push({
        path: `new/n${i}.txt`,
        head: null,
        work: gen(i, chance(0.2), 1 + int(15), chance(0.8)).join(''),
      });
    }
    const abs = (p: string): string => path.join(dir, p);
    for (const f of files) if (f.head !== null) h.write(abs(f.path), f.head);
    git(null, 'add', '-A');
    git(null, 'commit', '-q', '-m', 'base');
    for (const f of files) {
      if (f.work === null) fs.rmSync(abs(f.path));
      else h.write(abs(f.path), f.work);
    }

    // ---- random selection, constrained only where the EOF-pair rule cannot represent it ----
    const stats = { diffs: 0, patches: 0, constrained: 0, unstagePatches: 0, unstageConstrained: 0 };
    const select = (file: FileDiff, before: string | null, after: string | null, mode: PatchMode) => {
      const refs: LineRef[] = [];
      const style = rnd();
      const p = 0.15 + rnd() * 0.7;
      file.hunks.forEach((hk, hunkIndex) => {
        const pick = style < 0.15 ? true : style < 0.3 ? hunkIndex === 0 : null;
        hk.lines.forEach((l, lineIndex) => {
          if (l.type !== 'add' && l.type !== 'del') return;
          if (pick ?? chance(p)) refs.push({ hunkIndex, lineIndex });
        });
      });
      let sel = selectLines(file, refs)!;
      let model = expectedResult(before, after, file, sel, mode);
      let constrained = false;
      if (!model.valid) {
        // a selected change would follow a no-EOL line (see the BUG cases in line-patch.test.ts):
        // take the whole hunk that carries the "\ No newline" marker instead
        constrained = true;
        file.hunks.forEach((hk, hi) => {
          if (hk.lines.some((l) => l.type === 'nonewline')) for (const k of selectHunk(file, hi)) sel.add(k);
        });
        sel = new Set(sel);
        model = expectedResult(before, after, file, sel, mode);
      }
      return { sel, model, constrained };
    };

    const mismatches: string[] = [];
    const note = (msg: string): void => {
      if (mismatches.length < 10) mismatches.push(msg);
    };
    const byPath = new Map(files.map((f) => [f.path, f]));
    const pathOf = (d: FileDiff): string => (d.newPath ?? d.oldPath)!;

    // ================= stage =================
    const workdir = await svc.diff({ kind: 'workdir' }, STAGING_DIFF_OPTIONS);
    const untracked: FileDiff[] = [];
    for (const f of files) {
      if (f.head === null)
        untracked.push(...(await svc.diff({ kind: 'untracked', path: f.path }, STAGING_DIFF_OPTIONS)));
    }
    const stagePatches: string[] = [];
    for (const d of [...workdir, ...untracked]) {
      const f = byPath.get(pathOf(d));
      if (!f) throw new Error(`unexpected diff path ${pathOf(d)}`);
      stats.diffs++;
      const { sel, model, constrained } = select(d, f.head, f.work, 'stage');
      if (constrained) stats.constrained++;
      if (!model.valid) note(`${f.path}: stage selection still invalid after constraining`);
      const lp = buildLinePatch(d, sel, 'stage', { path: f.path });
      if (!lp) {
        f.staged = f.head;
        continue;
      }
      stats.patches++;
      f.staged = model.text;
      if (lp.reverse) note(`${f.path}: stage patch marked reverse`);
      try {
        const mem = applyPatch(f.head, lp.patch, lp.reverse);
        if (mem !== model.text)
          note(`${f.path}: in-memory stage ${JSON.stringify(mem)} != ${JSON.stringify(model.text)}`);
      } catch (e) {
        note(`${f.path}: in-memory stage failed: ${(e as Error).message}\n${lp.patch}`);
      }
      stagePatches.push(lp.patch);
    }
    for (const f of files) if (f.staged === undefined) f.staged = f.head;
    expect(stats.diffs, `seed=${SEED}`).toBeGreaterThanOrEqual(1000);
    git(stagePatches.join(''), 'apply', '--cached', '--whitespace=nowarn', '--recount', '-');
    compareIndex('stage', (f) => f.staged!);
    expect(mismatches, `seed=${SEED} (stage)`).toEqual([]);

    // ================= unstage =================
    const staged = await svc.diff({ kind: 'staged' }, STAGING_DIFF_OPTIONS);
    const reversePatches: string[] = [];
    const forwardPatches: string[] = [];
    for (const d of staged) {
      const f = byPath.get(pathOf(d));
      if (!f || d.status === 'R' || d.status === 'C')
        throw new Error(`unexpected staged diff ${d.status} ${pathOf(d)}`);
      const { sel, model, constrained } = select(d, f.head, f.staged!, 'unstage');
      if (constrained) stats.unstageConstrained++;
      if (!model.valid) note(`${f.path}: unstage selection still invalid after constraining`);
      const lp = buildLinePatch(d, sel, 'unstage', { path: f.path });
      if (!lp) continue;
      stats.unstagePatches++;
      f.unstaged = model.text;
      try {
        const mem = applyPatch(f.staged!, lp.patch, lp.reverse);
        if (mem !== model.text)
          note(`${f.path}: in-memory unstage ${JSON.stringify(mem)} != ${JSON.stringify(model.text)}`);
      } catch (e) {
        note(`${f.path}: in-memory unstage failed: ${(e as Error).message}\n${lp.patch}`);
      }
      (lp.reverse ? reversePatches : forwardPatches).push(lp.patch);
    }
    for (const f of files) if (f.unstaged === undefined) f.unstaged = f.staged!;
    if (reversePatches.length) {
      git(reversePatches.join(''), 'apply', '--cached', '-R', '--whitespace=nowarn', '--recount', '-');
    }
    if (forwardPatches.length)
      git(forwardPatches.join(''), 'apply', '--cached', '--whitespace=nowarn', '--recount', '-');
    compareIndex('unstage', (f) => f.unstaged!);
    expect(mismatches, `seed=${SEED} (unstage)`).toEqual([]);
    // every random selection is representable since the EOF-pair fix (spec 06 §6.5)
    expect(stats.constrained + stats.unstageConstrained, `seed=${SEED}`).toBe(0);
    expect(stats.patches, `seed=${SEED}`).toBeGreaterThan(800);
    expect(stats.unstagePatches, `seed=${SEED}`).toBeGreaterThan(500);
    expect(forwardPatches.length + reversePatches.length).toBe(stats.unstagePatches);

    /** Read every index blob in one `cat-file --batch` and compare with the expected content. */
    function compareIndex(phase: string, want: (f: F) => string | null): void {
      const entries = new Map<string, string>();
      for (const rec of git(null, 'ls-files', '-s', '-z').toString('utf8').split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        entries.set(rec.slice(tab + 1), rec.slice(0, tab).split(' ')[1]!);
      }
      const shas = [...entries.values()];
      const out = git(shas.join('\n') + '\n', 'cat-file', '--batch');
      const blobs = new Map<string, string>();
      let pos = 0;
      for (const sha of shas) {
        const nl = out.indexOf(0x0a, pos);
        const [got, , size] = out.subarray(pos, nl).toString('utf8').split(' ');
        if (got !== sha) throw new Error(`cat-file out of sync at ${sha}`);
        blobs.set(sha, out.subarray(nl + 1, nl + 1 + Number(size)).toString('utf8'));
        pos = nl + 1 + Number(size) + 1;
      }
      for (const f of files) {
        const sha = entries.get(f.path);
        const actual = sha === undefined ? null : blobs.get(sha)!;
        const expected = want(f);
        if (actual !== expected) {
          note(`${phase} ${f.path}: index ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`);
        }
      }
      if (entries.size !== files.filter((f) => want(f) !== null).length)
        note(`${phase}: index entry count mismatch`);
    }

    console.info(`line-patch round-trip seed=${SEED}`, stats);
    // ~1070 files written, staged and diffed: ~30 s alone on Windows, well over 60 s on a busy CI runner.
  }, 300_000);
});

function rawSplit(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
