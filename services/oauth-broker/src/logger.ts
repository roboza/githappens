/**
 * Structured JSON logging. Callers only ever pass the whitelisted fields of {@link LogFields};
 * request bodies, headers, query strings, codes, tokens, verifiers and secrets are never logged.
 * As a second line of defence, any key outside that whitelist is redacted.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  msg: string;
  reqId?: string;
  method?: string;
  route?: string;
  provider?: string;
  host?: string;
  grant?: string;
  status?: number;
  upstreamStatus?: number;
  upstreamError?: string;
  error?: string;
  durationMs?: number;
  port?: number;
  providers?: string[];
}

export interface LogEntry extends LogFields {
  ts: string;
  level: LogLevel;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const SAFE_KEYS = new Set([
  'msg',
  'reqId',
  'method',
  'route',
  'provider',
  'host',
  'grant',
  'status',
  'upstreamStatus',
  'upstreamError',
  'error',
  'durationMs',
  'port',
  'providers',
  'ts',
  'level',
]);

function scrub(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = SAFE_KEYS.has(k) ? v : '[redacted]';
  }
  return out as unknown as LogFields;
}

export const stdoutSink: LogSink = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export function createLogger(sink: LogSink = stdoutSink, now: () => Date = () => new Date()): Logger {
  const emit = (level: LogLevel, fields: LogFields): void => {
    try {
      sink({ ts: now().toISOString(), level, ...scrub(fields) });
    } catch {
      // Logging must never take the broker down.
    }
  };
  return {
    debug: (f) => emit('debug', f),
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
  };
}
