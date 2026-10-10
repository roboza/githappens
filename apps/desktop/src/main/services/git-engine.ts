import {
  GitError,
  GitLocator,
  makeError,
  GitProcessRunner,
  resolveShellEnv,
  type CommandLogEntry,
  type GitExecutableInfo,
  type GitExecutablePreference,
  type ResolvedGit,
} from '@githappens/git';

export interface GitEngineOptions {
  bundledGitDir?: string;
  onChanged?: (info: GitExecutableInfo) => void;
  onWarning?: (message: string) => void;
  onCommand?: (entry: CommandLogEntry) => void;
}

/**
 * Owns the active git executable and the app-wide process runner (spec 02 §6.1).
 * Switching executables takes effect for the next command, no restart needed.
 */
export class GitEngine {
  private resolved: ResolvedGit | null = null;
  private lastError: GitError | null = null;
  private locator: GitLocator | null = null;
  readonly runner: GitProcessRunner;

  constructor(private readonly o: GitEngineOptions) {
    this.runner = new GitProcessRunner({
      context: () => {
        if (!this.resolved) throw new Error('Git engine not initialized');
        return this.resolved.context;
      },
      onCommand: o.onCommand,
    });
  }

  /** Resolve the login-shell env once, then pick the executable. */
  async init(preference: GitExecutablePreference): Promise<GitExecutableInfo> {
    const shellEnv = await resolveShellEnv();
    this.locator = new GitLocator({
      bundledGitDir: this.o.bundledGitDir,
      baseEnv: { ...process.env, ...shellEnv },
    });
    return this.select(preference);
  }

  async select(preference: GitExecutablePreference): Promise<GitExecutableInfo> {
    if (!this.locator) throw new Error('Git engine not initialized');
    let resolved: ResolvedGit;
    try {
      resolved = await this.locator.resolve(preference);
    } catch (e) {
      // Keep a previously working executable; otherwise remember why there is none.
      if (!this.resolved && e instanceof GitError) this.lastError = e;
      throw e;
    }
    this.resolved = resolved;
    this.lastError = null;
    for (const w of resolved.warnings) this.o.onWarning?.(w);
    this.o.onChanged?.(resolved.info);
    return resolved.info;
  }

  /** Throws GitNotFound (with the reason) when no usable git was found at startup. */
  get info(): GitExecutableInfo {
    if (this.resolved) return this.resolved.info;
    throw (
      this.lastError ?? new GitError(makeError('GitNotFound', { argv: [] }, 'Git engine is still starting.'))
    );
  }

  dispose(): void {
    this.runner.killAll();
  }
}
