import { WRITABLE_GIT_CONFIG_KEYS, type GitConfigEntry } from '../../shared/settings/git-config';

/** Structural subset of `GitProcessRunner.run` (keeps this module free of the git package). */
export type GitRun = (o: { cwd: string; args: string[]; expectedExitCodes?: number[] }) => Promise<unknown>;

/**
 * Implements the `writeGitConfig` / `setGlobalIdentity` deps of `createPrefsHandlers` on top of
 * the app's git runner: `git config --global|--local <key> <value>` / `--unset`.
 * Exit code 5 (unset of a missing key) is not an error.
 */
export function createGitConfigWriter(run: () => GitRun, homeDir: string) {
  const writeGitConfig = async (
    entries: GitConfigEntry[],
    scope: 'global' | 'local',
    repoPath?: string,
  ): Promise<void> => {
    if (scope === 'local' && !repoPath) throw new Error('A repository is required for local git config.');
    const cwd = scope === 'local' ? repoPath! : homeDir;
    for (const e of entries) {
      if (!WRITABLE_GIT_CONFIG_KEYS.has(e.key)) throw new Error(`Refusing to write git config "${e.key}"`);
      const args =
        e.value === null
          ? ['config', `--${scope}`, '--unset-all', e.key]
          : ['config', `--${scope}`, '--replace-all', e.key, e.value];
      await run()({ cwd, args, expectedExitCodes: e.value === null ? [0, 5] : [0] });
    }
  };
  const setGlobalIdentity = (name: string, email: string): Promise<void> =>
    writeGitConfig(
      [
        { key: 'user.name', value: name },
        { key: 'user.email', value: email },
      ],
      'global',
    );
  /** utf8 runner for the repo-settings `gitconfig:*` channels (`PrefsHandlerDeps.runGit`). */
  const runGit = async (o: { cwd: string; args: string[]; expectedExitCodes?: number[] }) => {
    const r = (await run()({ ...o, encoding: 'utf8' } as Parameters<GitRun>[0])) as {
      exitCode?: number;
      stdout?: unknown;
      stderr?: string;
    };
    return { exitCode: r.exitCode ?? 0, stdout: String(r.stdout ?? ''), stderr: r.stderr };
  };
  return { writeGitConfig, setGlobalIdentity, runGit };
}
