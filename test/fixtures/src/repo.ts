import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 2024-01-01T00:00:00Z; every commit advances the clock by one hour. */
export const EPOCH = 1_704_067_200;

export const AUTHORS = {
  alice: { name: 'Alice Example', email: 'alice@example.com' },
  bob: { name: 'Bob Example', email: 'bob@example.com' },
  carol: { name: 'Carol Example', email: 'carol@example.com' },
} as const;
export type AuthorKey = keyof typeof AUTHORS;

export const gitBinary = (): string => process.env.GITHAPPENS_FIXTURE_GIT ?? 'git';

/** Shared clock so SHAs are deterministic across runs and machines. */
export class Clock {
  private t: number;
  constructor(start = EPOCH) {
    this.t = start;
  }
  tick(): string {
    this.t += 3600;
    return `${this.t} +0000`;
  }
  get now(): number {
    return this.t;
  }
}

/**
 * Isolated env: no system/global config, fixed identity and dates, no signing,
 * no autocrlf — so output is identical on every OS (spec 02 §6.16).
 */
export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const globalConfig = path.join(root, '.gitconfig-empty');
  if (!fs.existsSync(globalConfig)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(globalConfig, '');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    LC_MESSAGES: 'C',
    LANGUAGE: 'en',
  };
  delete env.LC_ALL;
  return env;
}

export class Repo {
  constructor(
    readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly clock: Clock,
  ) {}

  static init(
    dir: string,
    env: NodeJS.ProcessEnv,
    clock: Clock,
    opts: { bare?: boolean; branch?: string } = {},
  ): Repo {
    fs.mkdirSync(dir, { recursive: true });
    const r = new Repo(dir, env, clock);
    r.git('init', '-q', `--initial-branch=${opts.branch ?? 'main'}`, ...(opts.bare ? ['--bare'] : []));
    r.configure();
    return r;
  }

  /** Repo-local config pinned for determinism. */
  configure(): void {
    this.git('config', 'commit.gpgsign', 'false');
    this.git('config', 'tag.gpgsign', 'false');
    this.git('config', 'core.autocrlf', 'false');
    this.git('config', 'protocol.file.allow', 'always');
    this.git('config', 'user.name', AUTHORS.alice.name);
    this.git('config', 'user.email', AUTHORS.alice.email);
  }

  git(...args: string[]): string {
    return this.gitWith({}, ...args);
  }

  gitWith(
    o: { env?: NodeJS.ProcessEnv; input?: string | Buffer; allowFail?: boolean },
    ...args: string[]
  ): string {
    const options: ExecFileSyncOptions = {
      cwd: this.dir,
      env: { ...this.env, ...o.env },
      input: o.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    };
    try {
      return execFileSync(gitBinary(), args, options).toString('utf8');
    } catch (e) {
      if (o.allowFail) return String((e as { stdout?: Buffer }).stdout ?? '');
      const err = e as { stderr?: Buffer; message: string };
      throw new Error(
        `git ${args.join(' ')} failed in ${this.dir}: ${err.stderr?.toString() || err.message}`,
        {
          cause: e,
        },
      );
    }
  }

  write(rel: string, content: string | Buffer): this {
    const p = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return this;
  }

  remove(rel: string): this {
    fs.rmSync(path.join(this.dir, rel), { force: true, recursive: true });
    return this;
  }

  private identityEnv(author: AuthorKey): NodeJS.ProcessEnv {
    const date = this.clock.tick();
    const a = AUTHORS[author];
    return {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: a.name,
      GIT_COMMITTER_EMAIL: a.email,
      GIT_COMMITTER_DATE: date,
    };
  }

  /** Write files (optional), stage everything and commit. Returns the new SHA. */
  commit(message: string, files: Record<string, string | Buffer> = {}, author: AuthorKey = 'alice'): string {
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
    this.git('add', '-A');
    this.gitWith({ env: this.identityEnv(author) }, 'commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  /** Run a command that creates a commit (merge, cherry-pick…) with a deterministic identity/date. */
  gitAs(author: AuthorKey, ...args: string[]): string {
    return this.gitWith({ env: this.identityEnv(author) }, ...args);
  }

  /** Like gitAs, but tolerates a non-zero exit (e.g. a merge that stops on conflicts). */
  gitAsAllowFail(author: AuthorKey, ...args: string[]): string {
    return this.gitWith({ env: this.identityEnv(author), allowFail: true }, ...args);
  }

  head(): string {
    return this.git('rev-parse', 'HEAD').trim();
  }

  checkout(ref: string, create = false): this {
    this.git('checkout', '-q', ...(create ? ['-b'] : []), ref);
    return this;
  }
}
