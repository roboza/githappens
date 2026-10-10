import { redact, redactArgv, type CommandLogEntry, type RepoId } from '@githappens/git';

/** Bucket for commands that ran outside an open repository (clone, init, engine probes). */
export const NO_REPO = '' as RepoId;

export interface OutputLogOptions {
  /** Map a command's cwd to the open repository it belongs to (null = none). */
  repoIdFor: (cwd: string) => RepoId | null;
  /** Entries kept per repository (spec 02 §2: latest 500). */
  capacity?: number;
  /** Bytes of stderr / stdout preview kept per entry (the tail of stderr, the head of stdout). */
  maxOutputBytes?: number;
  /** Live append (`git:output:append`). */
  onAppend?: (repoId: RepoId, entry: CommandLogEntry) => void;
}

const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_OUTPUT = 8 * 1024;

/** Ring buffer of fixed capacity; O(1) push, oldest entries dropped. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!(capacity > 0)) throw new Error('capacity must be positive');
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    const idx = (this.start + this.count) % this.capacity;
    this.items[idx] = item;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

const tail = (s: string, max: number): string => (s.length > max ? `…${s.slice(s.length - max)}` : s);
const head = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** `-c http.extraheader=…`-style values and credential URLs are redacted again (defence in depth). */
export function sanitizeEntry(entry: CommandLogEntry, maxOutputBytes = DEFAULT_MAX_OUTPUT): CommandLogEntry {
  return {
    ...entry,
    argv: redactArgv(entry.argv),
    stdoutPreview: head(redact(entry.stdoutPreview ?? ''), maxOutputBytes),
    stderr: tail(redact(entry.stderr ?? ''), maxOutputBytes),
  };
}

/**
 * Git output log (spec 02 §2 "Activity / Output log", §5.3 `git:output:list` / `git:output:append`):
 * every git invocation reported by `GitProcessRunner.onCommand`, redacted, per repository.
 */
export class OutputLog {
  private readonly buffers = new Map<RepoId, RingBuffer<CommandLogEntry>>();
  private readonly capacity: number;
  private readonly maxOutput: number;
  private readonly listeners = new Set<(repoId: RepoId, entry: CommandLogEntry) => void>();

  constructor(private readonly o: OutputLogOptions) {
    this.capacity = o.capacity ?? DEFAULT_CAPACITY;
    this.maxOutput = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  }

  /** Pass to `new GitEngine({ onCommand })`. */
  readonly onCommand = (entry: CommandLogEntry): void => this.append(entry);

  append(raw: CommandLogEntry): void {
    const id = this.repoOf(raw.cwd) ?? NO_REPO;
    const entry = sanitizeEntry(raw, this.maxOutput);
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = new RingBuffer(this.capacity);
      this.buffers.set(id, buf);
    }
    buf.push(entry);
    this.o.onAppend?.(id, entry);
    for (const l of this.listeners) l(id, entry);
  }

  private repoOf(cwd: string): RepoId | null {
    try {
      return this.o.repoIdFor(cwd);
    } catch {
      return null;
    }
  }

  /** Newest last; `limit` keeps the newest N. */
  list(repoId: RepoId, limit?: number): CommandLogEntry[] {
    const all = this.buffers.get(repoId)?.toArray() ?? [];
    return limit && limit > 0 && all.length > limit ? all.slice(all.length - limit) : all;
  }

  /** Commands that belong to one op (error toast "Details"). */
  forOp(repoId: RepoId, opId: string): CommandLogEntry[] {
    return this.list(repoId).filter((e) => e.opId === opId);
  }

  clear(repoId: RepoId): void {
    this.buffers.get(repoId)?.clear();
  }

  /** Drop a closed repository's history. */
  forget(repoId: RepoId): void {
    this.buffers.delete(repoId);
  }

  subscribe(l: (repoId: RepoId, entry: CommandLogEntry) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** Path comparison for cwd → repo mapping (case-insensitive on Windows/macOS). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'linux' ? s : s.toLowerCase();
  };
  return norm(a) === norm(b);
}
