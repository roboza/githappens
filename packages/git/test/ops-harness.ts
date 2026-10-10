import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedEnv, makeFixture, type FixtureName, type FixtureResult } from '@githappens/fixtures';
import { afterAll, beforeAll, describe, vi } from 'vitest';

import { GitError } from '../src/errors/classify';
import { findOnPath } from '../src/locator/shell-env';
import { createOpRegistry } from '../src/ops/executors';
import { OperationQueue, type QueueHooks } from '../src/ops/queue';
import type { GitOperation, OpResult } from '../src/ops/types';
import { GitProcessRunner } from '../src/process/runner';
import { GitService } from '../src/service/git-service';
import { atLeast, parseGitVersion } from '../src/locator/version';
import type { SerializedGitError, VersionTuple } from '../src/types';

// fixture generation spawns many git processes: slow on Windows under parallel test load
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Shared setup for executor integration tests: fixtures in os.tmpdir(), git on PATH, ops via the queue. */
export const gitPath = findOnPath('git');
export const describeGit = gitPath ? describe : describe.skip;

/** Version of the git on PATH (CI also runs this suite against the minimum supported system git, 2.36). */
export const gitVersion: VersionTuple = gitPath
  ? (parseGitVersion(execFileSync(gitPath, ['--version'], { encoding: 'utf8' }))?.tuple ?? [0, 0, 0])
  : [0, 0, 0];
/** True when the git on PATH is at least `min` — gate tests of features newer than 2.36. */
export const gitAtLeast = (...min: [number, number, number?]): boolean =>
  atLeast(gitVersion, [min[0], min[1], min[2] ?? 0]);

export interface Harness {
  root: string;
  runner: GitProcessRunner;
  fixture(name: FixtureName, options?: Record<string, string | number | boolean>): FixtureResult;
  open(p: string): Promise<GitService>;
  /** Run one op through a fresh OperationQueue + createOpRegistry. */
  run(svc: GitService, op: GitOperation, hooks?: QueueHooks): Promise<OpResult>;
  /** Run an op that must fail; returns the serialized error. */
  fail(svc: GitService, op: GitOperation, hooks?: QueueHooks): Promise<SerializedGitError>;
  git(cwd: string, ...args: string[]): string;
  gitBuf(cwd: string, ...args: string[]): Buffer;
  read(p: string): string;
  write(p: string, content: string | Buffer): void;
}

export function useHarness(prefix: string): Harness {
  const services: GitService[] = [];
  const registry = createOpRegistry();
  let seq = 0;
  const h: Harness = {
    root: '',
    runner: null as unknown as GitProcessRunner,
    fixture(name: FixtureName, options?: Record<string, string | number | boolean>): FixtureResult {
      return makeFixture(name, { root: path.join(h.root, String(++seq)), force: true, options });
    },
    async open(p: string) {
      const s = await GitService.open(h.runner, p);
      services.push(s);
      return s;
    },
    run(svc: GitService, op: GitOperation, hooks?: QueueHooks) {
      return new OperationQueue(svc, registry, hooks).enqueue(op).done;
    },
    async fail(svc: GitService, op: GitOperation, hooks?: QueueHooks) {
      try {
        await h.run(svc, op, hooks);
      } catch (e) {
        if (e instanceof GitError) return e.serialized;
        throw e;
      }
      throw new Error(`expected ${op.type} to fail`);
    },
    gitBuf(cwd: string, ...args: string[]) {
      return execFileSync(gitPath!, args, {
        cwd,
        env: isolatedEnv(h.root),
        windowsHide: true,
        stdio: 'pipe',
      });
    },
    git(cwd: string, ...args: string[]) {
      return h.gitBuf(cwd, ...args).toString('utf8');
    },
    read(p: string) {
      return fs.readFileSync(p, 'utf8');
    },
    write(p: string, content: string | Buffer) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
  };

  beforeAll(() => {
    h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `kl-${prefix}-`)));
    h.runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: isolatedEnv(h.root), bundled: false }),
    });
  });
  afterAll(() => {
    for (const s of services) s.dispose();
    h.runner?.killAll();
    try {
      fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may still hold handles briefly */
    }
  });
  return h;
}

/** A small throwaway repo (from the `empty` fixture) with helpers to build history by hand (Phase 3 tests). */
export interface TinyRepo {
  dir: string;
  svc: GitService;
  g(...args: string[]): string;
  /** Write (string) / delete (null) files, stage everything and commit; returns the new sha. */
  commit(message: string, files: Record<string, string | Buffer | null>): string;
  rev(rev: string): string;
  file(rel: string): string | null;
}

export async function tinyRepo(
  h: Harness,
  initial: Record<string, string> = { 'README.md': 'base\n' },
): Promise<TinyRepo> {
  const dir = h.fixture('empty').path;
  const g = (...args: string[]): string => h.git(dir, ...args);
  const r: TinyRepo = {
    dir,
    svc: null as unknown as GitService,
    g,
    commit(message, files) {
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        if (content === null) fs.rmSync(p, { force: true });
        else h.write(p, content);
      }
      g('add', '-A');
      g('commit', '-q', '--allow-empty', '-m', message);
      return r.rev('HEAD');
    },
    rev: (rev) => g('rev-parse', rev).trim(),
    file(rel) {
      try {
        return fs.readFileSync(path.join(dir, rel), 'utf8');
      } catch {
        return null;
      }
    },
  };
  r.commit('Base', initial);
  r.svc = await h.open(dir);
  return r;
}
