import path from 'node:path';

import {
  cloneRepo,
  GitError,
  initRepo,
  makeError,
  publishToRemote,
  sparseState,
  stripUrlCredentials,
  type GitProcessRunner,
  type GitService,
} from '@githappens/git';
import type { HostingProvider } from '@githappens/providers/types';

import type { CloneResult2, InitResult2, Repos2IpcContract } from '../../shared/ipc/repos2-contract';
import type { CliInstaller } from '../cli/install';
import { repoDetails } from '../repos/details';
import { addSafeDirectory, assertSafeDirectoryValue } from '../repos/safe-directory';
import type { TemplateStore } from '../repos/templates';
import { inspectTarget, validateRepoPath } from '../repos/validate';
import type { RepoRegistry } from '../services/repo-registry';
import { pathKey } from '../services/repo-registry';
import type { HandlerContext } from './registry';

export type Repos2Handlers = {
  [C in keyof Repos2IpcContract]: (
    req: Repos2IpcContract[C]['req'],
    ctx: HandlerContext,
  ) => Repos2IpcContract[C]['res'] | Promise<Repos2IpcContract[C]['res']>;
};

type Features = NonNullable<Parameters<typeof GitService.open>[2]>['features'];

export interface Repos2Deps {
  runner(): GitProcessRunner;
  features?(): Features;
  registry(): RepoRegistry;
  repos: {
    list(): { repo: { id: string; worktreeRoot: string | null; gitDir: string } }[];
    close(id: string): Promise<void>;
    get(id: string): GitService;
    /** Validation service reused by the open that follows (RepoManager.borrow). */
    borrow?(path: string): Promise<GitService>;
  };
  templates: TemplateStore;
  integrations: { provider(integrationKey: string): HostingProvider };
  credentials: {
    envFor(opId: string, background: boolean): Record<string, string>;
    finish(opId: string, errorCode?: string): void;
    wasCancelled(opId: string): boolean;
  };
  /** Broadcast `repos:cloneProgress`. */
  progress(e: {
    opId: string;
    phase: string;
    percent: number | null;
    overall: number | null;
    text: string;
  }): void;
  cli: CliInstaller;
  /** Windows `core.longpaths` per clone (spec 03 §8), when a preference enables it. */
  longPaths?(): boolean;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.includes('\0')) throw new Error(`Invalid ${what}`);
  return v;
};

export function createRepos2Handlers(d: Repos2Deps): Repos2Handlers {
  const inflight = new Map<string, AbortController>();

  /** Run a network step with askpass credentials, translating a cancelled prompt like the core clone. */
  async function withCredentials<T>(
    opId: string,
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(d.credentials.envFor(opId, false));
    } catch (e) {
      const code = e instanceof GitError ? e.code : undefined;
      d.credentials.finish(opId, code);
      if (code === 'AuthenticationFailed' && d.credentials.wasCancelled(opId)) {
        throw new GitError(makeError('AuthCancelled', { argv: [] }, 'Authentication was cancelled.'));
      }
      throw e;
    } finally {
      d.credentials.finish(opId);
    }
  }

  const begin = (opId: unknown): { opId: string; controller: AbortController } => {
    const id =
      typeof opId === 'string' && opId ? opId : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    inflight.set(id, controller);
    return { opId: id, controller };
  };

  return {
    'repos:state': () => d.registry().state(),
    'repos:validate': ({ path: p }) =>
      validateRepoPath(
        d.runner(),
        str(p, 'path'),
        d.features?.(),
        d.repos.borrow ? (abs) => d.repos.borrow!(abs) : undefined,
      ),
    'repos:close': async ({ path: p }) => {
      const key = pathKey(str(p, 'path'));
      const svc = d.repos
        .list()
        .find((s) => [s.repo.worktreeRoot, s.repo.gitDir].some((x) => x && pathKey(x) === key));
      if (svc) await d.repos.close(svc.repo.id);
    },
    'repos:reorderFavorites': ({ paths }) => {
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw new Error('Invalid paths');
      d.registry().reorderFavorites(paths);
    },
    'repos:groups:save': ({ groups }) => d.registry().saveGroups(groups),
    'repos:groups:assign': ({ path: p, groupId, member }) =>
      d.registry().assignGroup(str(p, 'path'), str(groupId, 'group'), !!member),
    'repos:columns:save': ({ columnWidths }) => d.registry().setColumnWidths(columnWidths ?? {}),
    'repos:details': ({ path: p }) => repoDetails(d.runner(), str(p, 'path')),
    'repos:safeDirectory:add': async ({ path: p }) => {
      const value = str(p, 'path');
      assertSafeDirectoryValue(value);
      await addSafeDirectory(d.runner(), value);
    },
    'repos:inspectTarget': ({ parentDir, folderName }) => inspectTarget(parentDir, folderName),

    'repos:clone2': async (req) => {
      const url = str(req?.url, 'URL').trim();
      const { opId, controller } = begin(req.opId);
      const { url: clean, hadCredentials } = stripUrlCredentials(url);
      try {
        const r = await withCredentials(opId, (env) =>
          cloneRepo(
            d.runner(),
            {
              url,
              parentDir: str(req.parentDir, 'folder'),
              folderName: str(req.folderName, 'folder name'),
              bare: !!req.bare,
              depth: req.shallow?.depth,
              shallowSince: req.shallow?.sinceDate || undefined,
              branch: req.shallow?.branch || undefined,
              singleBranch: req.shallow?.singleBranch,
              customFlags: req.shallow?.customFlags,
              sparse: req.sparse?.paths?.length ? req.sparse : undefined,
              blobless: !!req.blobless,
              recurseSubmodules: !!req.recurseSubmodules,
              lfsPull: req.lfsPull !== false,
              longPaths: process.platform === 'win32' && !!d.longPaths?.(),
            },
            {
              opId,
              signal: controller.signal,
              env,
              progress: (p) =>
                d.progress({ opId, phase: p.phase, percent: p.percent, overall: p.overall, text: p.text }),
            },
          ),
        );
        const out: CloneResult2 = { ...r };
        if (hadCredentials) {
          // Never persist a token in .git/config / recents (spec 03 §8).
          await d.runner().run({ cwd: r.path, args: ['remote', 'set-url', 'origin', clean] });
          out.strippedCredentials = true;
        }
        return out;
      } finally {
        inflight.delete(opId);
      }
    },
    'repos:cancel2': ({ opId }) => inflight.get(opId)?.abort(),

    'repos:init2': async (req) => {
      const parentDir = str(req?.parentDir, 'folder');
      const name = str(req.name, 'name').trim();
      const names = Array.isArray(req.gitignoreTemplates) ? req.gitignoreTemplates : [];
      const gitignore = names.length ? d.templates.gitignore(names) : undefined;
      const license = req.license?.spdxId ? d.templates.renderLicense(req.license) : undefined;
      if (req.remote && (req.bare || !req.initialCommit))
        throw new Error(
          'Creating the repository on a provider needs a non-bare repo with an initial commit.',
        );
      // Check the provider before touching disk.
      const provider = req.remote ? d.integrations.provider(str(req.remote.integrationKey, 'account')) : null;
      if (provider && !provider.createRepo)
        throw new Error('This provider does not support creating repositories.');

      const local = await initRepo(d.runner(), {
        parentDir,
        name,
        defaultBranch: str(req.defaultBranch, 'branch').trim(),
        gitignore: req.bare ? undefined : gitignore,
        license: req.bare ? undefined : license,
        readme: !req.bare && !!req.createReadme,
        initialCommit: !req.bare && !!req.initialCommit,
        bare: !!req.bare,
      });
      const out: InitResult2 = { path: local.path };
      if (!provider || !req.remote) return out;

      const created = await provider.createRepo!({
        owner: req.remote.owner || undefined,
        name: req.remote.name?.trim() || name,
        private: req.remote.visibility !== 'public',
        description: req.remote.description?.trim() || undefined,
      });
      const cloneUrl = req.remote.protocol === 'ssh' ? created.sshUrl : created.httpsUrl;
      out.remote = { fullName: created.fullName, webUrl: created.webUrl, cloneUrl };
      const { opId, controller } = begin(req.opId);
      try {
        await withCredentials(opId, (env) =>
          publishToRemote(
            d.runner(),
            local.path,
            { url: cloneUrl, branch: req.defaultBranch.trim() },
            {
              opId,
              env,
              signal: controller.signal,
              progress: (p) =>
                d.progress({ opId, phase: p.phase, percent: p.percent, overall: p.overall, text: p.text }),
            },
          ),
        );
      } catch (e) {
        out.pushError = e instanceof Error ? e.message : String(e);
      } finally {
        inflight.delete(opId);
      }
      return out;
    },

    'templates:gitignore:list': () => d.templates.gitignoreNames(),
    'templates:gitignore:get': ({ names }) => d.templates.gitignore(names),
    'templates:license:list': () => d.templates.licenses(),
    'templates:license:render': (choice) => d.templates.renderLicense(choice),

    'providers:repos:create': async ({ integrationKey, owner, name, description, visibility }) => {
      const provider = d.integrations.provider(str(integrationKey, 'account'));
      if (!provider.createRepo) throw new Error('This provider does not support creating repositories.');
      const n = str(name, 'name').trim();
      if (!/^[\w.-]{1,100}$/.test(n))
        throw new Error('Repository names may contain letters, digits, ".", "-" and "_".');
      return provider.createRepo({
        owner: owner || undefined,
        name: n,
        private: visibility !== 'public',
        description: description?.trim() || undefined,
      });
    },

    'sparse:state': ({ repoId }) => sparseState(d.repos.get(repoId)),

    'cli:status': () => d.cli.status(),
    'cli:install': () => d.cli.install(),
  };
}

/** Absolute launcher-relative helper for wiring: dev builds pass the app dir to electron. */
export const devAppArgs = (isPackaged: boolean, appPath: string): string[] =>
  isPackaged ? [] : [path.resolve(appPath)];
