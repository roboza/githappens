import { PassThrough } from 'node:stream';

import type { GitProcessRunner, GitProcessStream } from '../process/runner';
import type { ShowFileResult } from '../types';

/**
 * Long-lived per-repo blob reader (spec 02 §6.8, §6.15.7, §11). One `git cat-file --batch-command`
 * process serves both `read` (contents) and `stat` (info), so other specs never spawn
 * `git show <rev>:<path>` per file. Restarted transparently when the process dies; a request that was
 * in flight during a crash is retried once on the new process.
 */

export const DEFAULT_SHOW_MAX_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export interface BlobStat {
  sha: string;
  type: string;
  size: number;
}

interface Request {
  kind: 'contents' | 'info';
  object: string;
  maxBytes: number;
  retried: boolean;
  resolve: (v: { header: BlobStat | null; data: Buffer | null }) => void;
  reject: (e: unknown) => void;
}

interface Body {
  req: Request;
  header: BlobStat;
  remaining: number; // content bytes + trailing LF still to read
  keepLimit: number;
  kept: Buffer[];
  keptBytes: number;
}

/** `:0`..`:3` (or `:`) select an index stage; anything else is a revision. */
export function objectName(rev: string, path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const stage = /^:([0-3])?$/.exec(rev);
  if (stage) return `:${stage[1] ?? '0'}:${p}`;
  return `${rev}:${p}`;
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export class BlobReader {
  private proc: { stream: GitProcessStream; stdin: PassThrough } | null = null;
  private pending: Request[] = [];
  private head: Buffer = Buffer.alloc(0);
  private body: Body | null = null;
  private disposed = false;

  constructor(
    private readonly runner: GitProcessRunner,
    private readonly cwd: string,
  ) {}

  async read(rev: string, path: string, maxBytes = DEFAULT_SHOW_MAX_BYTES): Promise<ShowFileResult> {
    const { header, data } = await this.request('contents', objectName(rev, path), maxBytes);
    if (!header || header.type !== 'blob' || !data) {
      return { content: null, binary: false, size: 0, encoding: 'utf8', missing: true };
    }
    const binary = isBinary(data);
    if (header.size > maxBytes) {
      return {
        content: null,
        binary,
        size: header.size,
        encoding: binary ? 'base64' : 'utf8',
        tooLarge: true,
      };
    }
    return binary
      ? { content: data.toString('base64'), binary, size: header.size, encoding: 'base64' }
      : { content: data.toString('utf8'), binary, size: header.size, encoding: 'utf8' };
  }

  /** Raw blob bytes (spec 07 `githappens-rev://` protocol); `data` null when missing or larger than `maxBytes`. */
  async readBytes(
    rev: string,
    path: string,
    maxBytes = DEFAULT_SHOW_MAX_BYTES,
  ): Promise<{ size: number; data: Buffer | null; missing?: boolean; tooLarge?: boolean }> {
    const { header, data } = await this.request('contents', objectName(rev, path), maxBytes);
    if (!header || header.type !== 'blob' || !data) return { size: 0, data: null, missing: true };
    if (header.size > maxBytes) return { size: header.size, data: null, tooLarge: true };
    return { size: header.size, data };
  }

  async stat(rev: string, path: string): Promise<BlobStat | null> {
    return (await this.request('info', objectName(rev, path), 0)).header;
  }

  /** Raw object lookup (`<sha>`, `<rev>^{commit}`, …). */
  async statObject(object: string): Promise<BlobStat | null> {
    return (await this.request('info', object, 0)).header;
  }

  dispose(): void {
    this.disposed = true;
    const err = new Error('BlobReader disposed');
    for (const r of this.pending.splice(0)) r.reject(err);
    this.kill();
  }

  private request(
    kind: Request['kind'],
    object: string,
    maxBytes: number,
  ): Promise<{ header: BlobStat | null; data: Buffer | null }> {
    if (this.disposed) return Promise.reject(new Error('BlobReader disposed'));
    if (/[\n\r\0]/.test(object)) return Promise.resolve({ header: null, data: null });
    return new Promise((resolve, reject) => {
      const req: Request = { kind, object, maxBytes, retried: false, resolve, reject };
      this.pending.push(req);
      this.send(req);
    });
  }

  private send(req: Request): void {
    this.ensureProcess().stdin.write(`${req.kind} ${req.object}\n`);
  }

  private ensureProcess(): { stream: GitProcessStream; stdin: PassThrough } {
    if (this.proc) return this.proc;
    const stdin = new PassThrough();
    const stream = this.runner.stream({
      cwd: this.cwd,
      args: ['cat-file', '--batch-command'],
      stdin,
      readOnly: true,
      timeoutMs: 0,
      unpooled: true,
    });
    const proc = { stream, stdin };
    this.proc = proc;
    this.head = Buffer.alloc(0);
    this.body = null;
    void this.pump(proc);
    return proc;
  }

  private async pump(proc: { stream: GitProcessStream; stdin: PassThrough }): Promise<void> {
    let error: unknown = new Error('git cat-file exited');
    try {
      for await (const chunk of proc.stream.stdout) this.feed(chunk);
    } catch (e) {
      error = e;
    }
    if (this.proc !== proc) return; // killed deliberately
    this.proc = null;
    if (this.disposed) return;
    // Crash: retry in-flight requests once on a fresh process.
    const inflight = this.pending.splice(0);
    for (const r of inflight) {
      if (r.retried) r.reject(error);
      else {
        r.retried = true;
        this.pending.push(r);
        this.send(r);
      }
    }
  }

  private kill(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    p.stdin.end();
    p.stream.cancel();
    p.stream.done.catch(() => {});
  }

  private feed(chunk: Buffer): void {
    let data = chunk;
    while (data.length) {
      if (this.body) {
        const b = this.body;
        const take = Math.min(b.remaining, data.length);
        if (b.keptBytes < b.keepLimit) {
          const part = data.subarray(0, Math.min(take, b.keepLimit - b.keptBytes));
          b.kept.push(part);
          b.keptBytes += part.length;
        }
        b.remaining -= take;
        data = data.subarray(take);
        if (b.remaining === 0) {
          this.body = null;
          this.pending.shift();
          const buf = Buffer.concat(b.kept).subarray(0, Math.min(b.header.size, b.keepLimit));
          b.req.resolve({ header: b.header, data: buf });
        }
        continue;
      }
      const buf = this.head.length ? Buffer.concat([this.head, data]) : data;
      const nl = buf.indexOf(10);
      if (nl < 0) {
        this.head = Buffer.from(buf);
        return;
      }
      this.head = Buffer.alloc(0);
      const line = buf.subarray(0, nl).toString('utf8');
      data = buf.subarray(nl + 1);
      this.onHeader(line);
    }
  }

  private onHeader(line: string): void {
    const req = this.pending[0];
    if (!req) return;
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line);
    if (!m) {
      // `<object> missing` / `<object> ambiguous`
      this.pending.shift();
      req.resolve({ header: null, data: null });
      return;
    }
    const header: BlobStat = { sha: m[1]!, type: m[2]!, size: Number(m[3]) };
    if (req.kind === 'info') {
      this.pending.shift();
      req.resolve({ header, data: null });
      return;
    }
    const keepLimit = header.size <= req.maxBytes ? header.size : Math.min(header.size, BINARY_SNIFF_BYTES);
    this.body = { req, header, remaining: header.size + 1, keepLimit, kept: [], keptBytes: 0 };
  }
}
