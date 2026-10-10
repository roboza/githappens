/**
 * Structured JSON logging. Callers only pass whitelisted fields of {@link LogFields}; request
 * bodies, headers, query strings, raw paths (which can carry blob/invite tokens), link fragments,
 * codes and tokens are never logged. Any key outside the whitelist is redacted as a second line of
 * defence.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  msg: string;
  reqId?: string;
  method?: string;
  /** Route pattern (e.g. `/v1/patches/:id`), never the concrete path. */
  route?: string;
  status?: number;
  error?: string;
  durationMs?: number;
  userId?: string;
  port?: number;
  idps?: string[];
  store?: string;
  blobs?: string;
  job?: string;
  count?: number;
  detail?: string;
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
  'status',
  'error',
  'durationMs',
  'userId',
  'port',
  'idps',
  'store',
  'job',
  'count',
  'detail',
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
      // Logging must never take the server down.
    }
  };
  return {
    debug: (f) => emit('debug', f),
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
  };
}
