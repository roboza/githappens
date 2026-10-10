import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { classifyError, GitError, makeError } from '../errors/classify';
import { ProgressParser, throttle, type ProgressKind } from '../progress/progress';
import type { CommandLogEntry, ProgressEvent } from '../types';
import { applyInvocationExtras, globalArgs, invocationEnv, type InvocationExtras } from './env';
import { killProcessTree } from './kill';
import { redact, redactArgv } from './redact';

/** What the runner needs to know about the active git executable (provided by GitLocator). */
export interface GitExecutionContext {
  gitPath: string;
  /** Base env: process env + resolved shell env + bundled-git vars. */
  baseEnv: NodeJS.ProcessEnv;
  bundled: boolean;
}

export type RunPriority = 'interactive' | 'background';

export interface GitRunOptions {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string | Buffer | NodeJS.ReadableStream;
  signal?: AbortSignal;
  /** Sets GIT_OPTIONAL_LOCKS=0. */
  readOnly?: boolean;
  progress?: (p: ProgressEvent) => void;
  progressKind?: ProgressKind;
  /** Raw stderr chunks as they arrive (commit hook output streaming, spec 06 §4.6). */
  onStderr?: (chunk: string) => void;
  /** Default 64 MiB; beyond => OutputTooLarge. */
  maxBuffer?: number;
  encoding?: 'utf8' | 'buffer';
  /** e.g. [0,1] for `diff --exit-code`, `merge-base --is-ancestor`. */
  expectedExitCodes?: number[];
  /** Network ops default none (user cancels); reads default 60 s. */
  timeoutMs?: number;
  priority?: RunPriority;
  /**
   * Long-lived helpers that idle most of the time (paused log cursors, `cat-file` readers) do not take a
   * read-pool slot, so a few open repos can never starve the pool.
   */
  unpooled?: boolean;
  opId?: string;
  askpassPath?: string;
}

export interface GitRunResult<T extends string | Buffer = string | Buffer> {
  exitCode: number;
  stdout: T;
  stderr: string;
  durationMs: number;
}

export interface GitProcessStream {
  /** Raw stdout chunks with backpressure. */
  stdout: AsyncIterable<Buffer>;
  /** Resolves when the process closes (stdout field is empty). */
  done: Promise<GitRunResult<string>>;
  cancel(): void;
}

export interface GitProcessRunnerOptions {
  context: () => GitExecutionContext;
  platform?: NodeJS.Platform;
  /** App-wide cap on concurrent git processes (spec 02 §6.1). */
  maxConcurrent?: number;
  /** Grace period before SIGKILL after cancel. */
  killGraceMs?: number;
  /**
   * After a cancelled/killed git exits, how long to wait for its stdio to close before closing our pipe
   * ends. On Windows, MSYS grandchildren (hook shells, `sh` → `sleep`) lose their Windows parent link,
   * survive `taskkill /T` and would hold the pipes open (spec 02 §9: cancel stops within 1 s).
   */
  orphanGraceMs?: number;
  onCommand?: (entry: CommandLogEntry) => void;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT = 60_000;
const PREVIEW_BYTES = 4096;

/** Two-priority counting semaphore; interactive waiters jump ahead of background ones. */
class Semaphore {
  private active = 0;
  private readonly queues: Record<RunPriority, Array<() => void>> = { interactive: [], background: [] };
  constructor(private readonly max: number) {}

  async acquire(priority: RunPriority, signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const q = this.queues[priority];
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve(this.releaser());
      };
      const onAbort = (): void => {
        const idx = q.indexOf(grant);
        if (idx >= 0) q.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      q.push(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queues.interactive.shift() ?? this.queues.background.shift();
      next?.();
    };
  }
}

/**
 * The only code that calls child_process.spawn for git (spec 02 §5.4).
 * Never uses a shell; user-supplied values must be passed after `--` by callers.
 */
export class GitProcessRunner {
  private readonly platform: NodeJS.Platform;
  private readonly sem: Semaphore;
  private readonly killGraceMs: number;
  private readonly live = new Set<ChildProcess>();
  private extras: (() => InvocationExtras | null) | null = null;

  constructor(private readonly opts: GitProcessRunnerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.sem = new Semaphore(opts.maxConcurrent ?? 8);
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  /** Run to completion, buffering stdout. Throws GitError on failure. */
  async run(o: GitRunOptions & { encoding: 'buffer' }): Promise<GitRunResult<Buffer>>;
  async run(o: GitRunOptions): Promise<GitRunResult<string>>;
  async run(o: GitRunOptions): Promise<GitRunResult> {
    this.throwIfAborted(o);
    const release = await this.acquire(o);
    try {
      return await this.exec(o);
    } finally {
      release();
    }
  }

  /** Stream stdout (log, ls-files, blame…). Caller must consume or cancel. */
  stream(o: GitRunOptions): GitProcessStream {
    const controller = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
    const out = new Readable({ read() {} });

    const done = (async (): Promise<GitRunResult<string>> => {
      this.throwIfAborted({ ...o, signal });
      const release = await this.acquire({ ...o, signal });
      try {
        const r = await this.exec({ ...o, signal, maxBuffer: Infinity, encoding: 'utf8' }, (c) => {
          c.stdout!.on('data', (b: Buffer) => {
            if (!out.push(b)) c.stdout!.pause();
          });
          out._read = () => c.stdout!.resume();
        });
        return { ...r, stdout: '' };
      } finally {
        release();
      }
    })();
    done.then(
      () => out.push(null),
      (e: unknown) => out.destroy(e instanceof Error ? e : new Error(String(e))),
    );
    return {
      stdout: out as AsyncIterable<Buffer>,
      done,
      cancel: () => controller.abort(),
    };
  }

  /**
   * App-wide env/config added to every invocation (SSH command, proxy, TLS, credential helpers; spec 09).
   * Evaluated per spawn, so setting changes apply to the next git command. Per-call `env` still wins.
   */
  setInvocationExtras(fn: (() => InvocationExtras | null) | null): void {
    this.extras = fn;
  }

  /** Kill all running git processes (app quit). */
  killAll(): void {
    for (const c of this.live) killProcessTree(c, this.platform, 'SIGKILL');
  }

  get activeCount(): number {
    return this.live.size;
  }

  private currentExtras(): InvocationExtras | null {
    try {
      return this.extras?.() ?? null;
    } catch {
      return null; // a broken settings provider must never block git
    }
  }

  private throwIfAborted(o: GitRunOptions): void {
    if (o.signal?.aborted) throw new GitError(makeError('Cancelled', { argv: o.args, opId: o.opId }));
  }

  private async acquire(o: GitRunOptions): Promise<() => void> {
    if (o.unpooled) return () => {};
    try {
      return await this.sem.acquire(o.priority ?? 'interactive', o.signal);
    } catch {
      throw new GitError(makeError('Cancelled', { argv: o.args, opId: o.opId }));
    }
  }

  private exec(o: GitRunOptions, attach?: (c: ChildProcess) => void): Promise<GitRunResult> {
    const ctx = this.opts.context();
    const fullArgs = [...globalArgs({ platform: this.platform, bundled: ctx.bundled }), ...o.args];
    const env = {
      ...applyInvocationExtras(
        invocationEnv(ctx.baseEnv, {
          platform: this.platform,
          readOnly: o.readOnly,
          askpassPath: o.askpassPath,
        }),
        this.currentExtras(),
      ),
      ...o.env,
    };
    const maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeoutMs = o.timeoutMs ?? (o.readOnly ? DEFAULT_READ_TIMEOUT : undefined);
    const expected = o.expectedExitCodes ?? [0];
    const startedAt = Date.now();

    return new Promise<GitRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(ctx.gitPath, fullArgs, {
          cwd: o.cwd,
          env,
          windowsHide: true,
          shell: false,
          detached: this.platform !== 'win32', // own process group so we can kill the tree
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new GitError(makeError('GitNotFound', { argv: o.args, opId: o.opId }, String(e))));
        return;
      }
      this.live.add(child);

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let failure: 'Cancelled' | 'Timeout' | 'OutputTooLarge' | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const parser = o.progress ? new ProgressParser(o.progressKind) : null;
      const emit = o.progress ? throttle(o.progress, 100) : null;

      const abort = (why: typeof failure): void => {
        if (failure) return;
        failure = why;
        killProcessTree(child, this.platform, 'SIGTERM');
        killTimer = setTimeout(() => killProcessTree(child, this.platform, 'SIGKILL'), this.killGraceMs);
      };
      const onAbort = (): void => abort('Cancelled');
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = timeoutMs ? setTimeout(() => abort('Timeout'), timeoutMs) : undefined;

      if (attach) attach(child);
      else {
        child.stdout!.on('data', (b: Buffer) => {
          stdoutBytes += b.length;
          if (stdoutBytes > maxBuffer) abort('OutputTooLarge');
          else stdoutChunks.push(b);
        });
      }
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (s: string) => {
        stderr += s;
        o.onStderr?.(s);
        if (parser && emit) for (const ev of parser.push(s)) emit.call(ev);
      });

      // stdin
      child.stdin!.on('error', () => {
        /* EPIPE when git exits early; surfaced via exit code */
      });
      if (o.stdin === undefined) child.stdin!.end();
      else if (typeof o.stdin === 'string' || Buffer.isBuffer(o.stdin)) child.stdin!.end(o.stdin);
      else (o.stdin as NodeJS.ReadableStream).pipe(child.stdin!);

      let spawnError: Error | null = null;
      child.on('error', (e) => {
        spawnError = e;
      });

      // A killed git whose orphaned descendants keep our pipes open: stop waiting for them.
      let orphanTimer: ReturnType<typeof setTimeout> | undefined;
      child.on('exit', () => {
        if (!failure) return;
        orphanTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        }, this.opts.orphanGraceMs ?? 1000);
      });

      // 'close' (not 'exit') so stdio is fully drained (spec 02 §8).
      child.on('close', (code) => {
        if (orphanTimer) clearTimeout(orphanTimer);
        this.live.delete(child);
        o.signal?.removeEventListener('abort', onAbort);
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (parser && emit) {
          for (const ev of parser.end()) emit.call(ev);
          emit.flush();
        }
        const durationMs = Date.now() - startedAt;
        const stdoutBuf = Buffer.concat(stdoutChunks);
        const stdout = o.encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8');

        this.opts.onCommand?.({
          id: randomUUID(),
          opId: o.opId,
          argv: redactArgv(o.args),
          cwd: o.cwd,
          startedAt,
          durationMs,
          exitCode: code,
          stdoutPreview: redact(stdoutBuf.subarray(0, PREVIEW_BYTES).toString('utf8')),
          stderr: redact(stderr),
        });

        const base = { argv: o.args, exitCode: code, stderr, opId: o.opId };
        if (spawnError) {
          const notFound = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
          reject(new GitError(makeError(notFound ? 'GitNotFound' : 'Unknown', base, spawnError.message)));
          return;
        }
        if (failure) {
          reject(new GitError(makeError(failure, base)));
          return;
        }
        if (code === null || !expected.includes(code)) {
          reject(
            new GitError(
              classifyError({
                ...base,
                stdout: typeof stdout === 'string' ? stdout : stdoutBuf.toString('utf8'),
              }),
            ),
          );
          return;
        }
        resolve({ exitCode: code, stdout, stderr, durationMs });
      });
    });
  }
}
