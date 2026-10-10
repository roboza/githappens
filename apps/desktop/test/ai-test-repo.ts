import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, GitProcessRunner, GitService } from '@githappens/git';
import { afterAll, beforeAll } from 'vitest';

/** Temp git repos for the AI tests (real git on PATH, isolated from the user's config). */
export const gitPath = findOnPath('git');

export interface TestRepo {
  dir: string;
  svc: GitService;
  git(...args: string[]): string;
  write(rel: string, text: string): void;
}

export function useTestRepos(prefix: string): { make(files?: Record<string, string>): Promise<TestRepo> } {
  let root = '';
  let env: NodeJS.ProcessEnv = {};
  let runner: GitProcessRunner;
  const services: GitService[] = [];
  let n = 0;
  beforeAll(() => {
    if (!gitPath) return;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `kl-${prefix}-`)));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    };
    runner = new GitProcessRunner({ context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }) });
  });
  afterAll(() => {
    for (const s of services) s.dispose();
    runner?.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may hold handles briefly */
    }
  });
  return {
    async make(files = { 'README.md': 'hello\n' }) {
      const dir = path.join(root, `r${++n}`);
      fs.mkdirSync(dir, { recursive: true });
      const git = (...args: string[]): string =>
        execFileSync(gitPath!, args, { cwd: dir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const write = (rel: string, text: string): void => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      };
      git('init', '-q', '-b', 'main');
      git('config', 'core.autocrlf', 'false');
      for (const [k, v] of Object.entries(files)) write(k, v);
      git('add', '-A');
      git('commit', '-q', '-m', 'Initial commit');
      const svc = await GitService.open(runner, dir);
      services.push(svc);
      return { dir, svc, git, write };
    },
  };
}
