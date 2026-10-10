import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { classifyPrompt, type ClassifiedPrompt } from './prompt';
import type { AskpassShims } from './shims';

export interface AskpassRequest extends ClassifiedPrompt {
  opId: string;
  /** Raw prompt text from git / ssh. */
  prompt: string;
}

/** Resolve a prompt: the answer, or null to cancel (the shim exits 1). */
export type AskpassPromptHandler = (req: AskpassRequest) => Promise<string | null>;

export interface AskpassServerOptions {
  shims: AskpassShims;
  onPrompt: AskpassPromptHandler;
  /** Override the pipe / socket path (tests). */
  pipePath?: string;
  /** Diagnostics; never receives answers. */
  log?: (message: string) => void;
}

interface TokenEntry {
  opId: string;
  nonInteractive: boolean;
  /** Per-op answer cache: one prompt per host + username (spec 09 §8 "prompt storms"). */
  cache: Map<string, string>;
  cancelled: boolean;
}

const MAX_REQUEST_BYTES = 64 * 1024;

function defaultPipePath(): string {
  const id = `githappens-askpass-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
}

/**
 * Credential bridge between git's askpass shim and the UI (spec 02 §6.3). One server per app; each op gets
 * a random token via `envFor`, and only requests carrying a live token are answered.
 */
export class AskpassServer {
  private server: net.Server | null = null;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly byOp = new Map<string, Set<string>>();
  private readonly sockets = new Set<net.Socket>();
  readonly pipePath: string;

  constructor(private readonly o: AskpassServerOptions) {
    this.pipePath = o.pipePath ?? defaultPipePath();
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== 'win32') await fs.promises.rm(this.pipePath, { force: true });
    const server = net.createServer((s) => this.handle(s));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pipePath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await fs.promises.chmod(this.pipePath, 0o600).catch(() => undefined);
    this.server = server;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    for (const sock of this.sockets) sock.destroy();
    this.tokens.clear();
    this.byOp.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
    if (process.platform !== 'win32')
      await fs.promises.rm(this.pipePath, { force: true }).catch(() => undefined);
  }

  /**
   * Env for one git invocation of `opId` (spec 02 §6.3). Background ops pass `nonInteractive: true`: their
   * prompts are cancelled without asking. Call `release(opId)` when the op ends.
   */
  envFor(opId: string, o: { nonInteractive: boolean }): Record<string, string> {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { opId, nonInteractive: o.nonInteractive, cache: new Map(), cancelled: false });
    const set = this.byOp.get(opId) ?? new Set<string>();
    set.add(token);
    this.byOp.set(opId, set);
    const { shims } = this.o;
    const env: Record<string, string> = {
      GIT_ASKPASS: shims.shPath,
      SSH_ASKPASS: process.platform === 'win32' ? shims.cmdPath : shims.shPath,
      SSH_ASKPASS_REQUIRE: 'force',
      GITHAPPENS_ASKPASS_PIPE: this.pipePath,
      GITHAPPENS_ASKPASS_TOKEN: token,
    };
    if (shims.runAsNodeEnv) env.ELECTRON_RUN_AS_NODE = '1';
    if (process.platform !== 'win32' && !process.env.DISPLAY) env.DISPLAY = ':0';
    return env;
  }

  /** True if any prompt of `opId` was cancelled (map AuthenticationFailed → AuthCancelled). */
  wasCancelled(opId: string): boolean {
    for (const t of this.byOp.get(opId) ?? []) if (this.tokens.get(t)?.cancelled) return true;
    return false;
  }

  /** Revoke the op's tokens; pending prompts are answered with cancel. */
  release(opId: string): void {
    for (const t of this.byOp.get(opId) ?? []) this.tokens.delete(t);
    this.byOp.delete(opId);
  }

  private handle(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    let handled = false;
    const reply = (answer: string | null): void => {
      if (sock.destroyed) return;
      sock.end(`${JSON.stringify(answer === null ? { ok: false } : { ok: true, answer })}\n`);
    };
    sock.on('data', (d: string) => {
      if (handled) return;
      buf += d;
      if (buf.length > MAX_REQUEST_BYTES) {
        handled = true;
        sock.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      void this.respond(buf.slice(0, nl)).then(reply, () => reply(null));
    });
    sock.on('error', () => undefined);
    sock.on('close', () => this.sockets.delete(sock));
  }

  private findToken(token: string): TokenEntry | undefined {
    const given = Buffer.from(token);
    for (const [t, entry] of this.tokens) {
      const b = Buffer.from(t);
      if (b.length === given.length && timingSafeEqual(b, given)) return entry;
    }
    return undefined;
  }

  private async respond(line: string): Promise<string | null> {
    let msg: { token?: unknown; prompt?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return null;
    }
    if (typeof msg.token !== 'string' || typeof msg.prompt !== 'string') return null;
    const entry = this.findToken(msg.token);
    if (!entry) {
      this.o.log?.('askpass: rejected request with unknown token');
      return null;
    }
    const prompt = msg.prompt;
    const c = classifyPrompt(prompt);
    this.o.log?.(`askpass: ${c.kind} prompt for op ${entry.opId}${c.host ? ` (${c.host})` : ''}`);
    if (entry.nonInteractive) {
      entry.cancelled = true;
      // host keys must be refused explicitly so ssh fails fast
      return c.kind === 'hostkey' ? 'no' : null;
    }
    const key =
      c.kind === 'username' || c.kind === 'password' ? `${c.kind}|${c.host ?? ''}|${c.username ?? ''}` : null;
    if (key && entry.cache.has(key)) return entry.cache.get(key)!;
    const answer = await this.o.onPrompt({ ...c, opId: entry.opId, prompt });
    if (answer === null) {
      entry.cancelled = true;
      return null;
    }
    if (!this.tokens.has(msg.token)) return null; // released while waiting
    if (key) entry.cache.set(key, answer);
    return answer;
  }
}
