import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

import { formatCommand, redact, type CommandLogEntry } from '@githappens/git';

export interface FileLoggerOptions {
  /** `userData/logs`. */
  dir: string;
  /** `general.extendedLogging`; nothing is written while false. */
  enabled: () => boolean;
  /** Rotate when main.log reaches this size (default 5 MiB). */
  maxBytes?: number;
  /** Rotated files kept: main.1.log … main.N.log (default 3). */
  maxFiles?: number;
  now?: () => Date;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Extended logging (spec 13 General, spec 15 diagnostics): verbose main-process log in
 * `userData/logs/main.log` with size-based rotation. Lines are redacted like the output log.
 */
export class FileLogger {
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private size = -1;
  private restoreConsole: (() => void) | null = null;

  constructor(private readonly o: FileLoggerOptions) {
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, o.maxFiles ?? 3);
  }

  get file(): string {
    return path.join(this.o.dir, 'main.log');
  }

  get enabled(): boolean {
    try {
      return this.o.enabled();
    } catch {
      return false;
    }
  }

  log(level: LogLevel, scope: string, message: string): void {
    if (!this.enabled) return;
    const ts = (this.o.now?.() ?? new Date()).toISOString();
    this.write(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}\n`);
  }

  /** One line per git command (+ stderr tail on failure). */
  command(e: CommandLogEntry): void {
    if (!this.enabled) return;
    const status = e.exitCode === 0 ? 'ok' : `exit ${e.exitCode ?? 'killed'}`;
    let msg = `${formatCommand(e.argv)} (${e.durationMs} ms, ${status}) cwd=${e.cwd}${e.opId ? ` op=${e.opId}` : ''}`;
    if (e.exitCode !== 0 && e.stderr.trim())
      msg += `\n    ${e.stderr.trim().split(/\r?\n/).slice(-10).join('\n    ')}`;
    this.log('debug', 'git', msg);
  }

  /**
   * Mirror `console.*` into the file while extended logging is on (main-process diagnostics that
   * are otherwise only on stdout). Returns the uninstaller.
   */
  tapConsole(target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = console): () => void {
    if (this.restoreConsole) return this.restoreConsole;
    const levels: [keyof typeof target, LogLevel][] = [
      ['log', 'info'],
      ['info', 'info'],
      ['debug', 'debug'],
      ['warn', 'warn'],
      ['error', 'error'],
    ];
    const originals = levels.map(([k]) => [k, target[k]] as const);
    for (const [k, level] of levels) {
      const orig = target[k].bind(target);
      target[k] = (...args: unknown[]) => {
        orig(...args);
        try {
          this.log(level, 'main', format(...args));
        } catch {
          /* never break console */
        }
      };
    }
    this.restoreConsole = () => {
      for (const [k, fn] of originals) target[k] = fn;
      this.restoreConsole = null;
    };
    return this.restoreConsole;
  }

  private write(line: string): void {
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      if (this.size < 0) {
        try {
          this.size = fs.statSync(this.file).size;
        } catch {
          this.size = 0;
        }
      }
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
    } catch {
      /* logging must never throw */
    }
  }

  /** main.log → main.1.log → … → main.N.log (oldest dropped). */
  rotate(): void {
    const name = (i: number): string => path.join(this.o.dir, i === 0 ? 'main.log' : `main.${i}.log`);
    try {
      fs.rmSync(name(this.maxFiles), { force: true });
      for (let i = this.maxFiles - 1; i >= 0; i--) {
        if (fs.existsSync(name(i))) fs.renameSync(name(i), name(i + 1));
      }
    } catch {
      /* best effort */
    }
    this.size = 0;
  }
}
