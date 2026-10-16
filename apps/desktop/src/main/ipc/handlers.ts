import fs from 'node:fs';
import path from 'node:path';

import {
  blameFile,
  branchCleanupScan,
  configGet,
  configList,
  configSetGlobal,
  configTarget,
  conflictState,
  isAncestor,
  lfsStatus,
  listConflicts,
  listSubmodules,
  listWorktrees,
  loadConflictFile,
  mergeBase,
  perfAdvice,
  predictConflicts,
  rebaseTodoFor,
  checkoutPreflight,
  GitError,
  GitService,
  headMessage,
  initRepo,
  makeError,
  validateBranchName,
  verifyCommits,
  type ShowFileResult,
} from '@githappens/git';

import type { PrefsIpcContract } from '../../shared/ipc/prefs-contract';
import type { CloneRequest, OpenRepoResult } from '../../shared/ipc/shell-contract';
import type { SecretStore } from '../secrets/secret-store';
import type { PtyService } from '../services/pty-service';
import type { GitEngine } from '../services/git-engine';
import type { RepoManager } from '../services/repo-manager';
import type { RepoRegistry } from '../services/repo-registry';
import type { ShellStateStore } from '../services/shell-state';
import type { SettingsStore } from '../settings/settings-store';
import type { AgentsIpcContract } from '../../shared/ipc/agents-contract';
import type { AiIpcContract } from '../../shared/ipc/ai-contract';
import type { CloudIpcContract } from '../../shared/ipc/cloud-contract';
import type { ConflictsIpcContract } from '../../shared/ipc/conflicts-contract';
import type { BehaviourIpcContract } from '../../shared/ipc/behaviour-contract';
import type { NetworkIpcContract } from '../../shared/ipc/network-contract';
import type { FilesIpcContract } from '../../shared/ipc/files-contract';
import type { CommitIpcContract } from '../../shared/ipc/commit-contract';
import type { RemotesIpcContract } from '../../shared/ipc/remotes-contract';
import type { Repos2IpcContract } from '../../shared/ipc/repos2-contract';
import type { CloudWorkspacesIpcContract } from '../../shared/ipc/cloud-workspaces-contract';
import type { InsightsIpcContract } from '../../shared/ipc/insights-contract';
import type { SuggestIpcContract } from '../../shared/ipc/suggest-contract';
import type { SyncIpcContract } from '../../shared/ipc/sync-contract';
import type { UndoIpcContract } from '../../shared/ipc/undo-contract';
import type { Shell2IpcContract } from '../../shared/ipc/shell2-contract';
import type { GraphIpcContract } from '../../shared/ipc/graph-contract';
import type { ToolsIpcContract } from '../../shared/ipc/tools-contract';
import type { PatchesIpcContract } from '../../shared/ipc/patches-contract';
import type { GitflowIpcContract } from '../../shared/ipc/gitflow-contract';
import type { IntegrationsIpcContract } from '../../shared/ipc/integrations-contract';
import type { LaunchpadIpcContract } from '../../shared/ipc/launchpad-contract';
import type { UpdateIpcContract } from '../../shared/ipc/update-contract';
import type { AboutIpcContract } from '../../shared/ipc/about-contract';
import type { WorkspacesIpcContract } from '../../shared/ipc/workspaces-contract';
import type { IpcHandlers } from './registry';
import { createTerminalHandlers } from './terminal-handlers';

/** OS integrations kept behind an interface so handlers stay testable without Electron. */
export interface ShellAdapter {
  pickFolder(): Promise<string | null>;
  openPath(p: string): void;
  openExternal(url: string): void;
  copyText(text: string): void;
  setTitleBarColors(background: string, foreground: string): void;
}

/** Pending credential prompts answered by the renderer (spec 02 §6.3). */
export interface PromptBroker {
  answer(promptId: string, value: string | null, remember: boolean): void;
}

/** Clone/init run outside any repo queue (spec 03); progress is broadcast by the caller. */
export interface RepoCreator {
  clone: HandlerDepsCloneFn;
  cancel(opId: string): void;
}
type HandlerDepsCloneFn = (req: CloneRequest & { opId: string }) => Promise<{ path: string }>;

export interface HandlerDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  engine: GitEngine;
  repos: RepoManager;
  registry: () => RepoRegistry;
  shellState: () => ShellStateStore;
  shell: ShellAdapter;
  prompts: PromptBroker;
  creator: RepoCreator;
  ptys: PtyService;
  versions: { app: string; electron: string; chrome: string; node: string };
}

/** Validate a folder and describe it for the recent-repos registry (spec 03 `repos:open`). */
async function validateRepo(
  engine: GitEngine,
  p: string,
  /** Shared, never-disposed service provider (RepoManager.borrow: reused by the open that follows). */
  borrow?: (abs: string) => Promise<GitService>,
): Promise<OpenRepoResult> {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs))
    return { ok: false, reason: 'notFound', path: abs, message: 'The folder does not exist.' };
  let service: GitService;
  try {
    service = borrow
      ? await borrow(abs)
      : await GitService.open(engine.runner, abs, { features: engine.info.features });
  } catch (e) {
    if (e instanceof GitError) {
      if (/dubious ownership/i.test(e.serialized.stderr)) {
        return { ok: false, reason: 'unsafeDirectory', path: abs, message: e.serialized.stderr.trim() };
      }
      if (e.code === 'NotARepository') {
        return { ok: false, reason: 'notARepo', path: abs, message: 'This folder is not a Git repository.' };
      }
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: 'permission', path: abs, message: 'Permission denied.' };
    }
    throw e;
  }
  try {
    const info = service.repo;
    const remotes = await service.remotes().catch(() => []);
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const root = info.worktreeRoot ?? info.gitDir;
    return {
      ok: true,
      repo: {
        path: root,
        name: path.basename(root.replace(/[\\/]\.git$/, '')),
        isBare: info.isBare,
        commonDir: info.isLinkedWorktree ? info.commonDir : undefined,
        remoteUrl: remote?.fetchUrl,
        lastBranch: info.head.kind === 'branch' ? info.head.name : undefined,
        favorite: false,
        groupIds: [],
      },
    };
  } finally {
    if (!borrow) service.dispose();
  }
}

const DEFAULT_MAX_FILE = 5 * 1024 * 1024;

/** Read a working-tree file for diffs; refuses paths that escape the worktree. */
export async function readWorktreeFile(
  root: string | null,
  rel: string,
  maxBytes = DEFAULT_MAX_FILE,
): Promise<ShowFileResult> {
  if (!root) throw new Error('Bare repositories have no working tree.');
  const abs = path.resolve(root, rel);
  const relative = path.relative(root, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the working tree.');
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return { content: null, binary: false, size: 0, encoding: 'utf8', missing: true };
  }
  if (st.isSymbolicLink()) {
    // Git stores the link target as the blob content.
    return { content: await fs.promises.readlink(abs), binary: false, size: st.size, encoding: 'utf8' };
  }
  if (!st.isFile()) return { content: null, binary: false, size: 0, encoding: 'utf8', missing: true };
  if (st.size > maxBytes)
    return { content: null, binary: false, size: st.size, encoding: 'utf8', tooLarge: true };
  const buf = await fs.promises.readFile(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  return binary
    ? { content: buf.toString('base64'), binary: true, size: st.size, encoding: 'base64' }
    : { content: buf.toString('utf8'), binary: false, size: st.size, encoding: 'utf8' };
}

/**
 * All channels except the Preferences ones (`createPrefsHandlers`, spec 13) and the
 * integrations ones (`createIntegrationsHandlers`, spec 10) and updates (`createUpdateHandlers`).
 */
export type CoreHandlers = Omit<
  IpcHandlers,
  | keyof PrefsIpcContract
  | keyof IntegrationsIpcContract
  | keyof UpdateIpcContract
  | keyof AboutIpcContract
  | keyof AgentsIpcContract
  | keyof GitflowIpcContract
  | keyof WorkspacesIpcContract
  | keyof LaunchpadIpcContract
  | keyof AiIpcContract
  | keyof CloudIpcContract
  | keyof ConflictsIpcContract
  | keyof PatchesIpcContract
  | keyof NetworkIpcContract
  | keyof BehaviourIpcContract
  | keyof ToolsIpcContract
  | keyof GraphIpcContract
  | keyof FilesIpcContract
  | keyof RemotesIpcContract
  | keyof Shell2IpcContract
  | keyof CommitIpcContract
  | keyof SyncIpcContract
  | keyof UndoIpcContract
  | keyof Repos2IpcContract
  | keyof SuggestIpcContract
  | keyof InsightsIpcContract
  | keyof CloudWorkspacesIpcContract
>;

export function createHandlers(d: HandlerDeps): CoreHandlers {
  const { settings, secrets, engine, repos } = d;
  return {
    // ---- app / settings ----
    'app:getVersionInfo': () => {
      const info = engine.info;
      return { ...d.versions, git: info.version, gitPath: info.path };
    },
    'app:secretStoreStatus': () => ({ available: secrets.available, backend: secrets.backend }),
    'settings:getAll': () => settings.snapshot(),
    'settings:set': ({ key, value }) => settings.set(key, value),
    'settings:reset': ({ key }) => settings.reset(key),

    // ---- shell ----
    'shell:getInitialState': () => ({ tabs: d.shellState().tabs(), layout: d.shellState().layout() }),
    'shell:saveTabs': (s) => d.shellState().saveTabs(s),
    'shell:saveLayout': (l) => d.shellState().saveLayout(l),
    'shell:openPath': ({ path: p }) => d.shell.openPath(p),
    'shell:openExternal': ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      d.shell.openExternal(url);
    },
    'shell:copyText': ({ text }) => d.shell.copyText(text),
    'shell:setTitleBarColors': ({ background, foreground }) =>
      d.shell.setTitleBarColors(background, foreground),

    // ---- repository registry ----
    'repos:list': () => d.registry().list(),
    'repos:open': async ({ path: p }) => {
      const borrow = typeof repos?.borrow === 'function' ? (abs: string) => repos.borrow(abs) : undefined;
      const r = await validateRepo(engine, p, borrow);
      if (r.ok) {
        const { favorite: _f, groupIds: _g, ...rest } = r.repo;
        return { ok: true, repo: d.registry().touch(rest) };
      }
      return r;
    },
    'repos:pickFolder': () => d.shell.pickFolder(),
    'repos:removeRecent': ({ path: p }) => d.registry().remove(p),
    'repos:setFavorite': ({ path: p, favorite }) => d.registry().setFavorite(p, favorite),

    // ---- git engine ----
    'git:engine:info': () => engine.info,
    'git:engine:setExecutable': async ({ kind, path: p }) => {
      if (p !== undefined && !p.trim()) {
        throw new GitError(
          makeError('GitNotFound', { argv: ['--version'] }, 'A path to a git executable is required.'),
        );
      }
      const info = await engine.select(p ?? kind);
      // Persist only what was actually selected (a fallback keeps the old preference).
      if (info.kind === 'bundled' && kind === 'bundled') settings.set('git.executable', 'bundled');
      else if (info.kind === 'system') settings.set('git.executable', p ?? 'system');
      return info;
    },

    // ---- repo lifecycle ----
    'git:repo:open': ({ path: p }) => repos.open(p),
    'git:repo:close': ({ repoId }) => repos.close(repoId),
    'git:repo:info': ({ repoId }) => repos.get(repoId).refreshRepoInfo(),

    // ---- reads ----
    'git:status': ({ repoId, untracked, worktreePath }) =>
      worktreePath ? repos.get(repoId).worktreeStatus(worktreePath) : repos.get(repoId).status({ untracked }),
    'git:log:start': ({ repoId, query, pageSize }) => repos.logStart(repoId, query, pageSize),
    'git:log:next': ({ repoId, cursor, pageSize }) => repos.logNext(repoId, cursor, pageSize),
    'git:log:dispose': ({ repoId, cursor }) => repos.logDispose(repoId, cursor),
    'git:commit:detail': ({ repoId, sha }) => repos.get(repoId).commitDetail(sha),
    'git:refs': ({ repoId }) => repos.get(repoId).refs(),
    'git:revParse': ({ repoId, rev }) => repos.get(repoId).revParse(rev),
    'git:diff': ({ repoId, spec, options }) => repos.get(repoId).diff(spec, options),
    'git:diff:numstat': ({ repoId, spec }) => repos.get(repoId).numstat(spec),
    'git:show:file': ({ repoId, rev, path: p, maxBytes }) => repos.get(repoId).showFile(rev, p, maxBytes),
    'git:worktree:readFile': ({ repoId, path: p, maxBytes }) =>
      readWorktreeFile(repos.get(repoId).repo.worktreeRoot, p, maxBytes),
    'git:stash:list': ({ repoId }) => repos.get(repoId).stashList(),
    'git:remotes': ({ repoId }) => repos.get(repoId).remotes(),
    'graph:search': async ({ repoId, query }) => ({ shas: await repos.get(repoId).search(query) }),
    'git:checkout:preflight': ({ repoId, target }) => checkoutPreflight(repos.get(repoId), target),
    'git:branch:validateName': ({ repoId, name }) => validateBranchName(repos.get(repoId), name),
    'git:branch:cleanupScan': ({ repoId }) => branchCleanupScan(repos.get(repoId)),
    'git:commit:headMessage': ({ repoId }) => headMessage(repos.get(repoId)),
    'git:undo:peek': ({ repoId }) => repos.journal(repoId).peek(),
    'git:conflict:state': ({ repoId }) => conflictState(repos.get(repoId)),
    'git:conflict:loadFile': ({ repoId, path: p }) => loadConflictFile(repos.get(repoId), p),
    'git:conflict:predict': ({ repoId, ours, theirs }) => predictConflicts(repos.get(repoId), ours, theirs),
    'git:rebase:todoFor': ({ repoId, upstream, branch }) =>
      rebaseTodoFor(repos.get(repoId), upstream, branch),
    'git:blame': ({ repoId, path: p, rev, opts }) => blameFile(repos.get(repoId), p, rev, opts ?? {}),
    'git:worktrees': ({ repoId }) => listWorktrees(repos.get(repoId)),
    'git:submodules': ({ repoId }) => listSubmodules(repos.get(repoId)),
    'git:lfs:status': ({ repoId }) => lfsStatus(repos.get(repoId)),
    'git:commit:verify': ({ repoId, shas }) => verifyCommits(repos.get(repoId), shas),
    'git:isAncestor': ({ repoId, ancestor, descendant }) =>
      isAncestor(repos.get(repoId), ancestor, descendant),
    'git:mergeBase': ({ repoId, a, b, mode }) => mergeBase(repos.get(repoId), a, b, mode ?? 'default'),
    'git:conflicts': ({ repoId }) => listConflicts(repos.get(repoId)),
    'git:config:list': ({ repoId, scope, pattern }) =>
      configList(configTarget(engine.runner, repoId ? repos.get(repoId) : null), { scope, pattern }),
    'git:config:get': ({ repoId, key, scope }) =>
      configGet(configTarget(engine.runner, repoId ? repos.get(repoId) : null), key, { scope }),
    'git:perf:advice': ({ repoId }) => {
      let features;
      try {
        features = engine.info.features;
      } catch {
        features = undefined;
      }
      return perfAdvice(repos.get(repoId), { features });
    },
    'git:watch:state': ({ repoId }) => ({ mode: repos.watchMode(repoId) }),

    // ---- writes ----
    'git:config:set': async ({ repoId, key, value, scope }) => {
      // config writes take config.lock: queued per repo; repo-less global writes are serialized app-wide
      if (repoId) await repos.runOp(repoId, { type: 'config.set', key, value, scope });
      else if (scope === 'global') await configSetGlobal(engine.runner, key, value);
      else throw new Error(`The ${scope} config needs an open repository.`);
    },
    'git:op:run': ({ repoId, op }) => repos.runOp(repoId, op),
    'git:op:cancel': ({ repoId, opId }) => repos.cancelOp(repoId, opId),
    'git:lock:remove': async ({ repoId, lockPath }) => {
      // Only *.lock files inside this repo's git dirs may be deleted (spec 02 §6.13).
      const info = repos.get(repoId).repo;
      const abs = path.resolve(lockPath);
      const inside = [info.gitDir, info.commonDir].some((d) => {
        const rel = path.relative(d, abs);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!inside || !abs.endsWith('.lock'))
        throw new Error('Refusing to delete a file that is not a Git lock.');
      await fs.promises.rm(abs, { force: true });
    },
    'git:prompt:answer': ({ promptId, value, remember }) => d.prompts.answer(promptId, value, !!remember),

    // ---- integrated terminal (spec 12) ----
    ...createTerminalHandlers(d.ptys),

    // ---- clone / init (spec 03) ----
    'repos:clone': (req) => d.creator.clone(req),
    'repos:cancel': ({ opId }) => d.creator.cancel(opId),
    'repos:init': (req) => initRepo(engine.runner, req),
  };
}
