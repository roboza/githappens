import type {
  RepoSettingsEventContract,
  RepoSettingsIpcContract,
} from '../../shared/ipc/repo-settings-contract';
import { assertRepo, createRepoGitConfig, type RepoGitRun } from '../repo-settings/repo-git-config';
import { RepoSettingsStore } from '../repo-settings/repo-settings-store';
import type { HandlerContext } from './registry';

/**
 * Repo-specific settings IPC (spec 13 §5.4 `repoSettings:*`, `gitconfig:*`). Spread into the prefs
 * handlers by `createPrefsHandlers`, so `main/index.ts` needs no extra wiring.
 */
export interface RepoSettingsHandlerDeps {
  /** Active profile folder (`profiles/<id>`), re-read per call. */
  profileDir(): string;
  run: RepoGitRun;
  broadcast<E extends keyof RepoSettingsEventContract>(event: E, payload: RepoSettingsEventContract[E]): void;
}

export type RepoSettingsHandlers = {
  [K in keyof RepoSettingsIpcContract]: (
    req: RepoSettingsIpcContract[K]['req'],
    ctx: HandlerContext,
  ) => RepoSettingsIpcContract[K]['res'] | Promise<RepoSettingsIpcContract[K]['res']>;
};

export function createRepoSettingsHandlers(d: RepoSettingsHandlerDeps): RepoSettingsHandlers {
  const store = new RepoSettingsStore(d.profileDir);
  const cfg = createRepoGitConfig(d.run);
  return {
    'repoSettings:get': async ({ repoPath }) => store.get(await assertRepo(d.run, repoPath)),
    'repoSettings:set': async ({ repoPath, patch }) => {
      const settings = store.set(await assertRepo(d.run, repoPath), patch);
      d.broadcast('repoSettings:changed', { repoPath, settings });
      return settings;
    },
    'gitconfig:get': ({ repoPath, key }) => cfg.get(repoPath, key),
    'gitconfig:list': ({ repoPath }) => cfg.list(repoPath),
    'gitconfig:set': ({ repoPath, key, value }) => cfg.set(repoPath, key, value),
    'gitconfig:unset': ({ repoPath, key }) => cfg.unset(repoPath, key),
  };
}
