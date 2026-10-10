import fs from 'node:fs';
import path from 'node:path';

import type { GitExecutableInfo, RepoId } from '@githappens/git/types';

import type {
  MenuRebuildRequest,
  Shell2IpcContract,
  WindowStateInfo,
} from '../../shared/ipc/shell2-contract';
import type { HandlerContext } from './registry';

export type Shell2Handlers = {
  [C in keyof Shell2IpcContract]: (
    req: Shell2IpcContract[C]['req'],
    ctx: HandlerContext,
  ) => Shell2IpcContract[C]['res'] | Promise<Shell2IpcContract[C]['res']>;
};

/** The BrowserWindow methods used here. */
export interface WindowControls {
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  close(): void;
  isFocused(): boolean;
}

/** The GitService surface used here. */
export interface RepoLike {
  readonly repo: { worktreeRoot: string | null; gitDir: string };
  runRead(
    args: string[],
    o?: { maxBuffer?: number; expectedExitCodes?: number[] },
  ): Promise<{ stdout: string | Buffer; exitCode: number }>;
  runWrite(
    args: string[],
    o?: { priority?: 'background' | 'interactive'; timeoutMs?: number },
  ): Promise<{ stdout: string; exitCode: number }>;
}

export interface Shell2HandlerDeps {
  window(): WindowControls | undefined;
  menu: { rebuild(req: MenuRebuildRequest): void; popup(at: { x?: number; y?: number }): void };
  registry(): { setAlias(path: string, alias: string | null): void };
  finder: { list(repoId: RepoId, refresh?: boolean): Promise<string[]> };
  repos: { get(repoId: RepoId): RepoLike };
  saveDialog(o: { title: string; defaultName: string }): Promise<string | null>;
  reloadEnv(): Promise<GitExecutableInfo>;
  /** Active git version (for `git maintenance`, ≥ 2.29). */
  gitVersion(): readonly [number, number, number] | undefined;
}

/** The empty tree, for diffs in a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function windowState(w: WindowControls | undefined): WindowStateInfo {
  return w
    ? { fullscreen: w.isFullScreen(), maximized: w.isMaximized(), focused: w.isFocused() }
    : { fullscreen: false, maximized: false, focused: false };
}

/**
 * Resolve a repo-relative worktree path, refusing anything outside the worktree or inside `.git`.
 * Exported for tests.
 */
export function resolveWorktreePath(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Invalid path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel))
    throw new Error('The path must be relative to the repository');
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error('The path must stay inside the repository');
  }
  if (inside.split(/[\\/]/)[0]!.toLowerCase() === '.git')
    throw new Error('Refusing to touch the .git folder');
  return abs;
}

const atLeast = (v: readonly number[] | undefined, want: readonly number[]): boolean => {
  if (!v) return false;
  for (let i = 0; i < want.length; i++) {
    const a = v[i] ?? 0;
    if (a !== want[i]) return a > want[i]!;
  }
  return true;
};

/** Window, menu, alias, file-finder and palette helper channels (spec 01 / spec 12). */
export function createShell2Handlers(d: Shell2HandlerDeps): Shell2Handlers {
  const win = (): WindowControls | undefined => d.window();
  const worktreeRoot = (repoId: RepoId): string => {
    const root = d.repos.get(repoId).repo.worktreeRoot;
    if (!root) throw new Error('This repository has no working tree.');
    return root;
  };

  return {
    'window:getState': () => windowState(win()),
    'window:toggleFullscreen': () => {
      const w = win();
      if (!w) return false;
      // setFullScreen is asynchronous on macOS: report the requested state.
      const next = !w.isFullScreen();
      w.setFullScreen(next);
      return next;
    },
    'window:setFullscreen': ({ on }) => {
      const w = win();
      if (!w) return false;
      w.setFullScreen(!!on);
      return !!on;
    },
    'window:minimize': () => win()?.minimize(),
    'window:maximize': () => {
      const w = win();
      if (!w) return false;
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
      return w.isMaximized();
    },
    'window:close': () => win()?.close(),

    'menu:rebuild': (req) => {
      if (!req || typeof req !== 'object') throw new Error('Invalid menu request');
      d.menu.rebuild({
        accelerators: req.accelerators ?? {},
        enabled: req.enabled ?? {},
        recent: Array.isArray(req.recent) ? req.recent : [],
        profiles: Array.isArray(req.profiles) ? req.profiles : [],
      });
    },
    'menu:popup': ({ x, y }) =>
      d.menu.popup({
        x: typeof x === 'number' && Number.isFinite(x) ? x : undefined,
        y: typeof y === 'number' && Number.isFinite(y) ? y : undefined,
      }),

    'repos:setAlias': ({ path: p, alias }) => {
      if (typeof p !== 'string' || !p) throw new Error('Invalid path');
      const a = typeof alias === 'string' ? alias.trim() : '';
      d.registry().setAlias(p, a ? a.slice(0, 200) : null);
    },

    'files:list': ({ repoId, refresh }) => d.finder.list(repoId, !!refresh),
    'files:delete': async ({ repoId, path: rel }) => {
      const abs = resolveWorktreePath(worktreeRoot(repoId), rel);
      const st = await fs.promises.lstat(abs);
      if (st.isDirectory()) throw new Error('Only files can be deleted here.');
      await fs.promises.rm(abs);
    },

    'wip:savePatch': async ({ repoId }) => {
      const svc = d.repos.get(repoId);
      const hasHead =
        (await svc.runRead(['rev-parse', '--verify', '--quiet', 'HEAD'], { expectedExitCodes: [0, 1] }))
          .exitCode === 0;
      const r = await svc.runRead(
        ['diff', '--binary', '--no-color', '--no-ext-diff', hasHead ? 'HEAD' : EMPTY_TREE],
        {
          maxBuffer: 512 * 1024 * 1024,
        },
      );
      const text = String(r.stdout);
      if (!text.trim()) throw new Error('There are no tracked changes to save as a patch.');
      const root = svc.repo.worktreeRoot ?? svc.repo.gitDir;
      const name = path.basename(root).replace(/[^\w.-]+/g, '_') || 'changes';
      const target = await d.saveDialog({ title: 'Save patch', defaultName: `${name}-wip.patch` });
      if (!target) return { saved: false };
      await fs.promises.writeFile(target, text, 'utf8');
      return { saved: true, path: target };
    },

    'repo:maintenance': async ({ repoId }) => {
      const svc = d.repos.get(repoId);
      const steps: string[] = [];
      const run = async (args: string[]): Promise<void> => {
        await svc.runWrite(args, { priority: 'background', timeoutMs: 30 * 60_000 });
        steps.push(`git ${args.join(' ')}`);
      };
      if (atLeast(d.gitVersion(), [2, 29])) await run(['maintenance', 'run', '--task=gc']);
      else await run(['gc', '--auto']);
      const v = d.gitVersion();
      await run([
        'commit-graph',
        'write',
        '--reachable',
        ...(atLeast(v, [2, 27]) ? ['--changed-paths'] : []),
      ]);
      return { steps };
    },

    'shell:reloadEnv': () => d.reloadEnv(),
  };
}
