import fs from 'node:fs';
import path from 'node:path';

import {
  GitError,
  openExternalMergeToolArgv,
  type GitOperation,
  type GitService,
  type OpResult,
  type RepoId,
} from '@githappens/git';

import type {
  DetectedTools,
  ExternalDiffRequest,
  LaunchResult,
  MergeToolRequest,
  MergeToolResult,
  ToolKind,
  ToolPathRef,
} from '../../shared/ipc/tools-contract';
import {
  expandToolCommand,
  GIT_TOOL_NAMES,
  TOOL_PRESETS,
  type ToolVars,
} from '../../shared/settings/external-tools';
import type { SettingKey, SettingValue } from '../../shared/settings/registry';
import {
  DEFAULT_TERMINAL_ORDER,
  EDITORS,
  lineStyleForExe,
  osKey,
  TERMINALS,
  type LineStyle,
} from './catalog';
import { ToolDetector } from './detect';
import type { ToolEnv } from './env';
import { cleanupDiffTemp, gitDifftoolArgs, materializeDiff, TEMP_DIR_NAME } from './external-diff';
import {
  customTerminalArgv,
  editorArgs,
  resolveExe,
  resolveLaunch,
  terminalArgv,
  toolError,
  toolNotFound,
  windowsStartLaunch,
  type Launch,
} from './launch';
import { spawnAndWait, spawnDetached, type SpawnOptions } from './spawn';

/** What the tools service needs from the RepoManager. */
export interface ToolsRepos {
  get(repoId: RepoId): GitService;
  /** The repo's op queue (journal, refresh, op events) — used for mark resolved / git mergetool. */
  runOp(repoId: RepoId, op: GitOperation, background?: boolean, signal?: AbortSignal): Promise<OpResult>;
}

export interface ToolsServiceDeps {
  env: ToolEnv;
  settings: { get<K extends SettingKey>(key: K): SettingValue<K> };
  repos: ToolsRepos;
  /** Electron `shell` (default program / file manager). */
  shell: { openPath(p: string): Promise<string>; showItemInFolder(p: string): void };
  /** Root for temp files (normally `os.tmpdir()`). */
  tmpRoot: string;
  spawnDetached?: (l: Launch, o: SpawnOptions) => Promise<void>;
  spawnAndWait?: (l: Launch, o: SpawnOptions & { signal?: AbortSignal }) => Promise<number | null>;
  /** How long a fire-and-forget `git difftool` may fail fast before we report success. */
  difftoolGraceMs?: number;
  log?: (msg: string, e?: unknown) => void;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_BLOB = 256 * 1024 * 1024;

/**
 * External tools / "Open in…" (spec 12 §4.10, §6.10; spec 07 §6.9; spec 08 §4.8, §6.8; spec 13 External Tools).
 * Launches are argv arrays, spawned detached (editors, terminals, diff tools) or awaited (merge tool).
 */
export class ToolsService {
  readonly detector: ToolDetector;
  private readonly waits = new Map<string, AbortController>();
  private readonly detached: NonNullable<ToolsServiceDeps['spawnDetached']>;
  private readonly waited: NonNullable<ToolsServiceDeps['spawnAndWait']>;

  constructor(private readonly d: ToolsServiceDeps) {
    this.detector = new ToolDetector(d.env);
    this.detached = d.spawnDetached ?? spawnDetached;
    this.waited = d.spawnAndWait ?? spawnAndWait;
    try {
      cleanupDiffTemp(d.tmpRoot, DAY);
    } catch {
      /* best effort */
    }
  }

  detect(refresh = false): DetectedTools {
    return this.detector.detect(refresh);
  }

  /** Tool path from the cached scan, re-scanning once when it is missing (installed since the last scan). */
  private found(kind: 'editor' | 'terminal' | 'diff', id: string): string | null {
    return this.detector.find(kind, id) ?? (this.detector.detect(true), this.detector.find(kind, id));
  }

  private get platform(): NodeJS.Platform {
    return this.d.env.platform;
  }

  private get P(): typeof path.posix {
    return this.platform === 'win32' ? path.win32 : path.posix;
  }

  // ---- paths ----

  /** Absolute path of a ref; repo-relative paths must stay inside the working tree. */
  resolvePath(ref: ToolPathRef): string {
    if (/[\0\r\n]/.test(ref.path)) throw toolError('Invalid path.');
    if (!ref.repoId) {
      if (!this.P.isAbsolute(ref.path)) throw toolError(`Not an absolute path: "${ref.path}".`);
      return this.P.normalize(ref.path);
    }
    const root = this.root(ref.repoId);
    if (!ref.path || ref.path === '.') return root;
    if (this.P.isAbsolute(ref.path) || /^[a-zA-Z]:/.test(ref.path)) {
      throw toolError(`Expected a repository-relative path: "${ref.path}".`);
    }
    const abs = this.P.resolve(root, ref.path);
    const back = this.P.relative(root, abs);
    if (back.startsWith('..') || this.P.isAbsolute(back))
      throw toolError(`Path is outside the working tree: "${ref.path}".`);
    return abs;
  }

  private root(repoId: RepoId): string {
    const root = this.d.repos.get(repoId).repo.worktreeRoot;
    if (!root) throw toolError('This repository has no working tree.');
    return root;
  }

  // ---- open actions ----

  async openDefault(ref: ToolPathRef): Promise<LaunchResult> {
    const p = this.resolvePath(ref);
    if (!fs.existsSync(p)) throw toolError(`${p} does not exist in the working tree.`);
    const err = await this.d.shell.openPath(p);
    if (err) throw toolError(err);
    return { launched: 'default program' };
  }

  async openFileManager(ref: ToolPathRef): Promise<LaunchResult> {
    const p = this.resolvePath(ref);
    if (!fs.existsSync(p)) {
      // Deleted files: reveal the closest folder that still exists.
      let dir = this.P.dirname(p);
      while (!fs.existsSync(dir) && this.P.dirname(dir) !== dir) dir = this.P.dirname(dir);
      const err = await this.d.shell.openPath(dir);
      if (err) throw toolError(err);
    } else if (fs.statSync(p).isDirectory()) {
      const err = await this.d.shell.openPath(p);
      if (err) throw toolError(err);
    } else {
      this.d.shell.showItemInFolder(p);
    }
    return { launched: 'file manager' };
  }

  /** The configured editor's executable, line style and label (spec 13 `tools.editor` / `tools.editorPath`). */
  private editor(): { exe: string; style: LineStyle; label: string } | null {
    const id = this.d.settings.get('tools.editor');
    const override = this.d.settings.get('tools.editorPath')?.trim();
    if (id === 'none') return null;
    if (id === 'custom') {
      if (!override) throw toolNotFound('editor', 'no editor path is set');
      return { exe: override, style: lineStyleForExe(override), label: this.P.basename(override) };
    }
    const def = EDITORS.find((e) => e.id === id);
    if (!def) throw toolNotFound('editor');
    const exe = override || this.found('editor', id);
    if (!exe) throw toolNotFound('editor', `${def.label} is not installed`);
    return { exe, style: def.line, label: def.label };
  }

  private editorLaunch(exe: string, style: LineStyle, file: string, line?: number): Launch {
    if (this.platform === 'darwin' && /\.app$/i.test(exe))
      return resolveLaunch(['/usr/bin/open', '-a', exe, file], this.d.env, 'editor');
    return resolveLaunch([exe, ...editorArgs(style, file, line)], this.d.env, 'editor');
  }

  async openEditor(ref: ToolPathRef, line?: number): Promise<LaunchResult> {
    const p = this.resolvePath(ref);
    const ed = this.editor();
    if (!ed) return this.openDefault({ path: p }); // spec 07 §4.12: no editor → OS default
    if (!fs.existsSync(p)) throw toolError(`${p} does not exist in the working tree.`);
    const cwd = ref.repoId ? this.root(ref.repoId) : fs.statSync(p).isDirectory() ? p : this.P.dirname(p);
    await this.launchDetached(this.editorLaunch(ed.exe, ed.style, p, line), cwd, 'editor');
    return { launched: ed.label };
  }

  private terminalId(): string {
    const id = this.d.settings.get('tools.terminal');
    if (id !== 'os') return id;
    for (const cand of DEFAULT_TERMINAL_ORDER[osKey(this.platform)])
      if (this.found('terminal', cand)) return cand;
    throw toolNotFound('terminal', 'no terminal was detected');
  }

  async openTerminal(cwdIn: string, repoId?: RepoId): Promise<LaunchResult> {
    const cwd = this.resolvePath({ path: cwdIn, repoId });
    if (!this.d.env.isDir(cwd)) throw toolError(`${cwd} is not a folder.`);
    const id = this.terminalId();
    const win = this.platform === 'win32';
    if (id === 'custom') {
      const t = customTerminalArgv(this.d.settings.get('tools.terminalCommand') ?? '', cwd);
      const exe = resolveExe(t.argv[0], this.d.env, 'terminal');
      const l = win
        ? windowsStartLaunch(exe, t.argv.slice(1), this.d.env)
        : resolveLaunch(t.argv, this.d.env, 'terminal');
      await this.launchDetached(l, cwd, 'terminal');
      return { launched: this.P.basename(exe) };
    }
    const exe = this.found('terminal', id);
    if (!exe)
      throw toolNotFound('terminal', `${TERMINALS.find((t) => t.id === id)?.label ?? id} is not installed`);
    const t = terminalArgv(id, exe, cwd, this.platform);
    const l =
      win && (id === 'powershell' || id === 'cmd')
        ? windowsStartLaunch(exe, t.argv.slice(1), this.d.env)
        : resolveLaunch(t.argv, this.d.env, 'terminal');
    await this.launchDetached(l, t.cwd, 'terminal');
    return { launched: TERMINALS.find((x) => x.id === id)?.label ?? 'terminal' };
  }

  private async launchDetached(l: Launch, cwd: string, kind: ToolKind): Promise<void> {
    try {
      await this.detached(l, { cwd });
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === 'ENOENT') throw toolNotFound(kind, l.file);
      throw e;
    }
  }

  // ---- diff ----

  /** argv for the configured diff tool on two files (preset or `tools.customDiffCmd`). */
  private diffArgv(vars: ToolVars): { argv: string[]; label: string } {
    const id = this.d.settings.get('tools.diffTool');
    if (id === 'none') throw toolNotFound('diff', 'no external diff tool is selected');
    if (id === 'custom') {
      const tpl = this.d.settings.get('tools.customDiffCmd')?.trim();
      if (!tpl) throw toolNotFound('diff', 'the custom diff command is empty');
      return { argv: expandToolCommand(tpl, vars), label: 'custom diff tool' };
    }
    const preset = TOOL_PRESETS[id];
    if (!preset?.diff) throw toolNotFound('diff');
    const exe = this.found('diff', id);
    if (!exe) throw toolNotFound('diff', `${preset.label} is not installed`);
    return { argv: [exe, ...expandToolCommand(preset.diff, vars)], label: preset.label };
  }

  async openDiff(req: ExternalDiffRequest): Promise<LaunchResult & { via: 'tool' | 'git-difftool' }> {
    const svc = this.d.repos.get(req.repoId);
    const root = this.root(req.repoId);
    const id = this.d.settings.get('tools.diffTool');
    if (id === 'git-config') {
      await this.requireGitTool(svc, 'diff');
      await this.runGitDifftool(svc, gitDifftoolArgs(req));
      return { launched: 'git difftool', via: 'git-difftool' };
    }
    // Validate the tool before writing temp files.
    this.diffArgv({ LOCAL: '', REMOTE: '' });
    const sides = await materializeDiff(req, {
      tmpRoot: this.d.tmpRoot,
      worktreeFile: (rel) => this.resolvePath({ repoId: req.repoId, path: rel }),
      readBlob: async (rev, p) => {
        const r = await svc.showFile(rev, p, MAX_BLOB);
        if (r.missing || r.content == null) return null;
        return Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf8');
      },
    });
    const { argv, label } = this.diffArgv({ LOCAL: sides.oldFile, REMOTE: sides.newFile });
    await this.launchDetached(resolveLaunch(argv, this.d.env, 'diff'), root, 'diff');
    return { launched: label, via: 'tool' };
  }

  /** "Git config default" needs `diff.tool` / `merge.tool`, or git falls back to a terminal vimdiff. */
  private async requireGitTool(svc: GitService, kind: 'diff' | 'merge'): Promise<void> {
    const keys =
      kind === 'diff' ? ['diff.tool', 'diff.guitool', 'merge.tool'] : ['merge.tool', 'merge.guitool'];
    for (const k of keys) {
      const r = await svc.runRead(['config', '--get', k], { expectedExitCodes: [0, 1] });
      if (r.exitCode === 0 && String(r.stdout).trim()) return;
    }
    throw toolNotFound(kind, `set ${kind}.tool in your git config`);
  }

  /** Fire-and-forget `git difftool`, reporting failures that happen right away. */
  private async runGitDifftool(svc: GitService, args: string[]): Promise<void> {
    const run = svc.runRead(args, { timeoutMs: 0, unpooled: true, expectedExitCodes: [0] });
    const grace = new Promise<'running'>((r) =>
      setTimeout(() => r('running'), this.d.difftoolGraceMs ?? 1500),
    );
    const first = await Promise.race([run.then(() => 'done' as const), grace]).catch((e: unknown) => {
      throw e instanceof GitError ? toolError(`git difftool failed: ${e.serialized.stderr || e.message}`) : e;
    });
    if (first === 'running') run.catch((e: unknown) => this.d.log?.('[tools] git difftool', e));
  }

  // ---- merge tool ----

  async mergeTool(req: MergeToolRequest): Promise<MergeToolResult> {
    const svc = this.d.repos.get(req.repoId);
    this.resolvePath({ repoId: req.repoId, path: req.path });
    const id = this.d.settings.get('tools.mergeTool');
    const trust = this.d.settings.get('tools.mergeToolTrustExitCode');
    const keepBackup = this.d.settings.get('tools.mergeToolKeepBackup');
    if (id === 'none') throw toolNotFound('merge', 'no external merge tool is selected');

    const ac = new AbortController();
    if (req.waitId) this.waits.set(req.waitId, ac);
    try {
      if (id === 'git-config') {
        await this.requireGitTool(svc, 'merge');
        return await this.strategyA(req, undefined, undefined, 'git mergetool', ac.signal);
      }
      let argvFor: (v: ToolVars) => string[];
      let label: string;
      if (id === 'custom') {
        const tpl = this.d.settings.get('tools.customMergeCmd')?.trim();
        if (!tpl) throw toolNotFound('merge', 'the custom merge command is empty');
        argvFor = (v) => expandToolCommand(tpl, v);
        label = 'custom merge tool';
      } else {
        const preset = TOOL_PRESETS[id];
        if (!preset?.merge) throw toolNotFound('merge');
        label = preset.label;
        const exe = this.found('diff', id);
        if (!exe) {
          // Strategy A fallback: git knows how to drive most tools and finds them itself.
          const gitName = GIT_TOOL_NAMES[id];
          if (!gitName) throw toolNotFound('merge', `${preset.label} is not installed`);
          return await this.strategyA(req, gitName, trust, preset.label, ac.signal);
        }
        const tpl = preset.merge;
        argvFor = (v) => [exe, ...expandToolCommand(tpl, v)];
      }
      return await this.strategyB(svc, req, argvFor, label, { trust, keepBackup, signal: ac.signal });
    } finally {
      if (req.waitId) this.waits.delete(req.waitId);
    }
  }

  cancelMergeTool(waitId: string): void {
    this.waits.get(waitId)?.abort();
  }

  /** Strategy B (spec 08 §6.8): our stage temp files + the tool; mark resolved through the op queue. */
  private async strategyB(
    svc: GitService,
    req: MergeToolRequest,
    argvFor: (v: ToolVars) => string[],
    label: string,
    o: { trust: boolean; keepBackup: boolean; signal: AbortSignal },
  ): Promise<MergeToolResult> {
    const r = await openExternalMergeToolArgv(svc, req.path, (v) => argvFor(v), {
      keepBackup: o.keepBackup,
      launch: async (argv, cwd) => {
        const l = resolveLaunch(argv, this.d.env, 'merge');
        try {
          return await this.waited(l, { cwd, signal: o.signal });
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code === 'ENOENT')
            throw toolNotFound('merge', l.file);
          throw e;
        }
      },
    });
    const cancelled = o.signal.aborted;
    // Trusted exit code: 0 means resolved. Otherwise require evidence: the file changed and has no markers.
    const ok = !cancelled && r.exitCode === 0 && (o.trust || (r.changed && !r.hasMarkers));
    let resolved = false;
    if (ok) {
      await this.d.repos.runOp(req.repoId, { type: 'conflict.markResolved', paths: [req.path] });
      resolved = true;
    }
    return {
      strategy: 'tool',
      tool: label,
      exitCode: r.exitCode,
      changed: r.changed,
      hasMarkers: r.hasMarkers,
      resolved,
      cancelled,
      ...(r.backupPath ? { backupPath: r.backupPath } : {}),
    };
  }

  /** Strategy A (spec 08 §6.8): `git mergetool` as a queued op (git stages the result itself). */
  private async strategyA(
    req: MergeToolRequest,
    tool: string | undefined,
    trust: boolean | undefined,
    label: string,
    signal: AbortSignal,
  ): Promise<MergeToolResult> {
    const keepBackup = this.d.settings.get('tools.mergeToolKeepBackup');
    try {
      const r = await this.d.repos.runOp(
        req.repoId,
        {
          type: 'conflict.mergetool',
          path: req.path,
          keepBackup,
          ...(tool ? { tool } : {}),
          ...(tool && trust !== undefined ? { trustExitCode: trust } : {}),
        },
        false,
        signal,
      );
      const data = (r.data ?? {}) as { exitCode?: number; resolved?: boolean };
      return {
        strategy: 'git',
        tool: label,
        exitCode: data.exitCode ?? null,
        changed: !!data.resolved,
        hasMarkers: false,
        resolved: !!data.resolved,
        cancelled: false,
      };
    } catch (e) {
      if (e instanceof GitError && e.code === 'Cancelled') {
        return {
          strategy: 'git',
          tool: label,
          exitCode: null,
          changed: false,
          hasMarkers: false,
          resolved: false,
          cancelled: true,
        };
      }
      throw e;
    }
  }

  // ---- Preferences "Test" ----

  /** Launch the configured tool on throwaway files (spec 13 §7 step 13). Never waits for the tool. */
  async test(kind: ToolKind): Promise<LaunchResult> {
    const dir = path.join(this.d.tmpRoot, TEMP_DIR_NAME, `test-${Date.now().toString(36)}`);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, text: string): string => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, text);
      return p;
    };
    if (kind === 'editor') {
      return this.openEditor(
        { path: write('githappens-test.txt', 'GitHappens\nexternal editor test\nline 3\n') },
        3,
      );
    }
    if (kind === 'terminal') return this.openTerminal(this.d.env.homedir || dir);
    const left = write('left.txt', 'one\ntwo\nthree\n');
    const right = write('right.txt', 'one\n2\nthree\nfour\n');
    if (kind === 'diff') {
      if (this.d.settings.get('tools.diffTool') === 'git-config') {
        throw toolError(
          '"Git config default" runs git difftool inside a repository; try it from a file diff.',
        );
      }
      const { argv, label } = this.diffArgv({ LOCAL: left, REMOTE: right });
      await this.launchDetached(resolveLaunch(argv, this.d.env, 'diff'), dir, 'diff');
      return { launched: label };
    }
    const id = this.d.settings.get('tools.mergeTool');
    if (id === 'none') throw toolNotFound('merge', 'no external merge tool is selected');
    if (id === 'git-config') {
      throw toolError('"Git config default" runs git mergetool inside a repository; try it on a conflict.');
    }
    const vars: ToolVars = {
      BASE: write('base.txt', 'one\ntwo\nthree\n'),
      LOCAL: left,
      REMOTE: right,
      MERGED: write('merged.txt', 'one\ntwo\nthree\n'),
    };
    let argv: string[];
    let label: string;
    if (id === 'custom') {
      const tpl = this.d.settings.get('tools.customMergeCmd')?.trim();
      if (!tpl) throw toolNotFound('merge', 'the custom merge command is empty');
      argv = expandToolCommand(tpl, vars);
      label = 'custom merge tool';
    } else {
      const preset = TOOL_PRESETS[id];
      const exe = preset ? this.found('diff', id) : null;
      if (!preset?.merge || !exe)
        throw toolNotFound('merge', preset ? `${preset.label} is not installed` : undefined);
      argv = [exe, ...expandToolCommand(preset.merge, vars)];
      label = preset.label;
    }
    await this.launchDetached(resolveLaunch(argv, this.d.env, 'merge'), dir, 'merge');
    return { launched: label };
  }
}
