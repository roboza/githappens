import path from 'node:path';

/**
 * Environment & argument policy applied to every git invocation (spec 02 §6.1).
 */

export interface BundledGitLayout {
  /** Root of the portable git distribution (dugite-style). */
  dir: string;
  platform: NodeJS.Platform;
  arch: string;
}

/** Path to the git executable inside a bundled distribution. */
export function bundledGitExecutable(layout: BundledGitLayout): string {
  return layout.platform === 'win32'
    ? path.join(layout.dir, 'cmd', 'git.exe')
    : path.join(layout.dir, 'bin', 'git');
}

/** Env vars a bundled (portable) git needs to find its own pieces. Mirrors dugite's setup. */
export function bundledGitEnv(layout: BundledGitLayout, base: NodeJS.ProcessEnv): Record<string, string> {
  const { dir, platform, arch } = layout;
  const env: Record<string, string> = {};
  if (platform === 'win32') {
    const mingw = arch === 'arm64' ? 'clangarm64' : arch === 'ia32' ? 'mingw32' : 'mingw64';
    env.GIT_EXEC_PATH = path.join(dir, mingw, 'libexec', 'git-core');
    const pathKey = findPathKey(base);
    env[pathKey] = [path.join(dir, mingw, 'bin'), path.join(dir, 'usr', 'bin'), base[pathKey] ?? '']
      .filter(Boolean)
      .join(path.win32.delimiter);
  } else {
    env.GIT_EXEC_PATH = path.join(dir, 'libexec', 'git-core');
    if (!base.GIT_CONFIG_SYSTEM) env.GIT_CONFIG_SYSTEM = path.join(dir, 'etc', 'gitconfig');
    env.GIT_TEMPLATE_DIR = path.join(dir, 'share', 'git-core', 'templates');
    if (platform === 'linux') {
      env.PREFIX = dir;
      if (!base.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = path.join(dir, 'ssl', 'cacert.pem');
    }
  }
  return env;
}

/** Windows env keys are case-insensitive; `Path` is common. */
export function findPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

export interface InvocationEnvOptions {
  platform: NodeJS.Platform;
  readOnly?: boolean;
  /** Absolute path to the askpass shim; enables credential prompts routed to the UI (spec 02 §6.3). */
  askpassPath?: string;
  /** Path to a no-op editor shim; defaults to `true` (run through git's sh). */
  editorPath?: string;
}

/** Per-invocation env overrides (spec 02 §6.1 table). Applied on top of the base env. */
export function invocationEnv(base: NodeJS.ProcessEnv, o: InvocationEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.LC_ALL; // keep the UTF-8 locale for path bytes
  env.LANG = base.LANG || 'en_US.UTF-8';
  env.LC_MESSAGES = 'C'; // English stderr so error rules match
  env.LANGUAGE = 'en';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_EDITOR = o.editorPath ?? 'true';
  env.GIT_MERGE_AUTOEDIT = 'no';
  if (o.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  else delete env.GIT_OPTIONAL_LOCKS;
  if (o.askpassPath) {
    env.GIT_ASKPASS = o.askpassPath;
    env.SSH_ASKPASS = o.askpassPath;
    env.SSH_ASKPASS_REQUIRE = 'force';
    if (o.platform !== 'win32' && !env.DISPLAY) env.DISPLAY = ':0';
  }
  return env;
}

/**
 * App-wide additions to every git invocation (spec 09 §6.6/§6.7/§6.11): SSH command, proxy env, TLS and
 * credential-helper config. Supplied by the desktop app through `GitProcessRunner.setInvocationExtras`.
 */
export interface InvocationExtras {
  /** Env vars to set; `null` removes the variable (case-insensitively, for Windows `Path`-style keys). */
  env?: Record<string, string | null>;
  /**
   * Config applied like `git -c key=value`, but through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
   * (git ≥ 2.31) so it reaches child gits (submodules, LFS) and secrets never appear in argv.
   */
  config?: Array<[key: string, value: string]>;
}

/** Apply `InvocationExtras` on top of an already-built invocation env (returns a new object). */
export function applyInvocationExtras(
  base: NodeJS.ProcessEnv,
  extras: InvocationExtras | null | undefined,
): NodeJS.ProcessEnv {
  if (!extras) return base;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extras.env ?? {})) {
    const upper = key.toUpperCase();
    for (const k of Object.keys(env)) if (k !== key && k.toUpperCase() === upper) delete env[k];
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const config = extras.config ?? [];
  if (config.length) {
    const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
    let n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    for (const [key, value] of config) {
      env[`GIT_CONFIG_KEY_${n}`] = key;
      env[`GIT_CONFIG_VALUE_${n}`] = value;
      n++;
    }
    env.GIT_CONFIG_COUNT = String(n);
  }
  return env;
}

/** Global `-c` args that neutralize user config which changes output shape. */
export function globalArgs(o: { platform: NodeJS.Platform; bundled: boolean }): string[] {
  const args = [
    '--no-pager',
    '-c',
    'color.ui=false',
    '-c',
    'core.quotepath=false',
    '-c',
    'log.showSignature=false',
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    '-c',
    'core.pager=cat',
  ];
  // Windows paths > 260 chars (spec 15 §10).
  if (o.platform === 'win32' && o.bundled) args.push('-c', 'core.longpaths=true');
  return args;
}
