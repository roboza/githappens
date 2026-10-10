import { randomUUID } from 'node:crypto';

import { GitError } from '../errors/classify';
import { LogParser } from '../parsers/log';
import type { GitProcessRunner, GitProcessStream } from '../process/runner';
import type { CommitSummary, LogPage } from '../types';

/**
 * Paging cursor over ONE long-lived `git log` process (spec 02 §6.6).
 *
 * `next(n)` reads stdout until n commits are parsed and then simply stops pulling: the stream's buffer
 * fills, the runner pauses the child's stdout and git blocks on the pipe (no CPU). The process is
 * killed on `dispose()`, when the log is exhausted, or after `idleMs` without a `next()` call; the
 * next call then transparently re-runs git with `--skip=<consumed>` (slower but correct).
 *
 * Without a commit-graph (spec 02 §6.15.4), an ordered walk only starts printing after walking the whole
 * history (≈ 1.2 s for 200k commits). Two ways around that, both started next to the full ordered walk,
 * which takes over once it prints (minus what was already shown):
 *
 * - Windowed mode (`window`, the graph's plain `revs: 'all'` query): every page is a topologically
 *   ordered *window* that is provably consistent with all later pages, also with clock skew. The cursor
 *   keeps a frontier F (initially the query's tips; everything shown so far is exactly
 *   `R(tips) \ R(F)`, R = reachable set). For a page it reads the next commits S of one streaming
 *   default-order `git log` (cheap, streams without a commit-graph), sets
 *   `F' = (F \ S) ∪ (parents(S) \ S)` and prints `git log --topo-order F --not F'` (positives and `^`
 *   negatives on stdin): the window `W = R(F) \ R(F')` is a subset of S (any path from F into W stays
 *   inside S, or it would pass through F'), so the walk is short, and it is closed under descendants
 *   within what is left, so no commit shown later can be a child of one shown now. S \ W (only with
 *   clock skew) carries over to the next page. If a commit-graph appears meanwhile, the rest is one
 *   streaming `--topo-order` walk of F.
 * - Seeded mode (`seed`, filtered queries): a default-order probe of `LOG_SEED_COUNT` commits; the first
 *   page is the probe's commits newer than its oldest timestamp, reordered children-first (`seedOrder`),
 *   then the ordered walk without them. Without clock skew that is exactly a valid date order.
 */

export interface LogCursor {
  readonly id: string;
  next(pageSize: number): Promise<LogPage>;
  dispose(): void;
}

export const DEFAULT_LOG_IDLE_MS = 5 * 60_000;
/** Commits fetched by the seeding probe (about one first page). */
export const LOG_SEED_COUNT = 500;
/** Windowed mode: at least this many commits streamed after S are checked against each window. */
export const LOG_WINDOW_LOOKAHEAD = 500;

/** Windowed paging without a commit-graph (see the module comment). */
export interface LogWindowArgs {
  /** `git log` head without an order flag and without revs (default order, streams). */
  stream: string[];
  /** The same with the ordered flag (`--topo-order` / `--date-order`); revs come on stdin. */
  ordered: string[];
  /** The query's revs (pseudo options) for the first default-order stream. */
  revs: string[];
  /** Resolves the query's tips to commits (`rev-list --no-walk <revs> --`). */
  tips: string[];
}

export interface LogCursorArgs {
  args: string[];
  /** Default-order `--max-count` probe for a fast first page (seeded mode). */
  seed?: string[];
  /** Windowed paging (takes precedence over `seed`). */
  window?: LogWindowArgs;
  env?: Record<string, string>;
}

export interface LogCursorDeps {
  runner: GitProcessRunner;
  cwd: string;
  /** Builds the git args (without `--skip`); resolved lazily on the first `next()`. */
  buildArgs: () => Promise<LogCursorArgs>;
  signature?: boolean;
  idleMs?: number;
  /** True when a git failure means "nothing to log" (unborn HEAD). */
  isEmptyRepoError?: (e: GitError) => boolean;
  /** Windowed mode: a commit-graph was written meanwhile → the rest streams as one ordered walk. */
  hasCommitGraph?: () => boolean;
  onDispose?: (c: LogCursor) => void;
}

interface Live {
  stream: GitProcessStream;
  iter: AsyncIterator<Buffer>;
  parser: LogParser;
  /** Read issued ahead of time (windowed mode: tells when the ordered walk starts printing). */
  ahead: Promise<IteratorResult<Buffer>> | null;
}

interface WindowState {
  a: LogWindowArgs;
  env?: Record<string, string>;
  /** Default-order stream (null once exhausted). */
  stream: Live | null;
  /** Read from the stream, not shown yet (the next S starts with these). */
  carry: CommitSummary[];
  /** F; the first one is the query's resolved tips. */
  frontier: Promise<string[]>;
}

const UNBORN_RE = /does not have any commits yet|ambiguous argument 'HEAD'|bad default revision 'HEAD'/;

export function isUnbornError(e: GitError): boolean {
  return UNBORN_RE.test(e.serialized.stderr);
}

/**
 * The seed page: the probe's commits strictly newer than its oldest timestamp (all of them when the
 * probe returned the whole history), newest first with every child before its parents (`--date-order`).
 */
export function seedOrder(probe: CommitSummary[], complete: boolean): CommitSummary[] {
  if (!probe.length) return [];
  let oldest = Infinity;
  for (const c of probe) oldest = Math.min(oldest, c.commitTime);
  const set = complete ? probe : probe.filter((c) => c.commitTime > oldest);
  const index = new Map(set.map((c, i) => [c.sha, i]));
  const children = new Array<number>(set.length).fill(0);
  for (const c of set) {
    for (const p of c.parents) {
      const j = index.get(p);
      if (j !== undefined) children[j]!++;
    }
  }
  // ready = every child printed; take the newest (ties: probe order)
  const before = (a: number, b: number): boolean =>
    set[a]!.commitTime !== set[b]!.commitTime ? set[a]!.commitTime > set[b]!.commitTime : a < b;
  const ready: number[] = [];
  const insert = (i: number): void => {
    let k = ready.length;
    while (k > 0 && before(i, ready[k - 1]!)) k--;
    ready.splice(k, 0, i);
  };
  set.forEach((_, i) => {
    if (children[i] === 0) insert(i);
  });
  const out: CommitSummary[] = [];
  while (ready.length) {
    const i = ready.shift()!;
    out.push(set[i]!);
    for (const p of set[i]!.parents) {
      const j = index.get(p);
      if (j !== undefined && --children[j]! === 0) insert(j);
    }
  }
  return out;
}

/**
 * The frontier after showing the window drawn from `s` (see the module comment):
 * `F' = (F \ S) ∪ (parents(S) \ S)`.
 */
export function nextFrontier(frontier: string[], s: CommitSummary[]): string[] {
  const inS = new Set(s.map((c) => c.sha));
  const out = new Set<string>();
  for (const f of frontier) if (!inS.has(f)) out.add(f);
  for (const c of s) for (const p of c.parents) if (!inS.has(p)) out.add(p);
  return [...out];
}

/**
 * Guard against git's negative walk stopping early (clock skew deeper than its date heuristic):
 * `window` must not contain a parent of any commit still to be shown (`pending`: the rest of S and the
 * lookahead). Such commits, and their ancestors in the window, really are behind the new frontier: they
 * are dropped from this window (they come again in a later one), keeping it closed under descendants.
 */
export function windowGuard(window: CommitSummary[], pending: CommitSummary[]): CommitSummary[] {
  const inWindow = new Map(window.map((c) => [c.sha, c]));
  const shown = new Set(window.map((c) => c.sha));
  const drop: string[] = [];
  for (const c of pending) {
    if (shown.has(c.sha)) continue;
    for (const p of c.parents) if (inWindow.has(p)) drop.push(p);
  }
  if (!drop.length) return window;
  const dropped = new Set<string>();
  while (drop.length) {
    const sha = drop.pop()!;
    if (dropped.has(sha)) continue;
    dropped.add(sha);
    for (const p of inWindow.get(sha)!.parents) if (inWindow.has(p) && !dropped.has(p)) drop.push(p);
  }
  return window.filter((c) => !dropped.has(c.sha));
}

export class StreamingLogCursor implements LogCursor {
  readonly id = randomUUID();
  private live: Live | null = null;
  /** The ordered walk's command (a stdin-fed walk of the frontier after a commit-graph appeared). */
  private walk: { args: string[]; stdin?: string } | null = null;
  /** Parsed, undelivered commits; `raw` = position in the walk's output (-1: from the seed / a window). */
  private queue: { c: CommitSummary; raw: number }[] = [];
  private ended = false;
  private delivered = 0;
  /** Walk output consumed by delivered pages: the `--skip` of a restart. */
  private rawDelivered = 0;
  private rawParsed = 0;
  private done = false;
  private disposed = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private argsPromise: Promise<LogCursorArgs> | null = null;
  /** Seeded / windowed mode: SHAs already shown (skipped in the ordered walk). */
  private seeded: Set<string> | null = null;
  /** Return the seed page without waiting for the walk. */
  private yieldSeed = false;
  private win: WindowState | null = null;
  /** The ordered walk printed something (or ended): windowed mode hands over to it. */
  private walkReady = false;
  /** Number of times the walk was (re)started; >1 means the --skip fallback ran (probe excluded). */
  spawnCount = 0;
  /** Windows shown (tests / diagnostics). */
  windowCount = 0;

  constructor(private readonly deps: LogCursorDeps) {}

  next(pageSize: number): Promise<LogPage> {
    const p = this.chain.then(() => this.nextInner(Math.max(1, Math.floor(pageSize))));
    this.chain = p.catch(() => {});
    return p;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.done = true;
    this.clearIdle();
    this.kill();
    this.dropWindow();
    this.queue = [];
    this.deps.onDispose?.(this);
  }

  /** Kill the process now as if the idle timeout had fired (tests / memory pressure). */
  suspend(): void {
    this.clearIdle();
    // windowed mode ends here: what was shown is in `seeded`, the restarted walk skips it
    this.dropWindow();
    if (!this.live) return; // already exhausted: the queued tail is all that is left
    this.kill();
    // undelivered seed commits are not in the walk: keep them; the rest is printed again
    this.queue = this.queue.filter((q) => q.raw < 0);
    this.rawParsed = this.rawDelivered;
  }

  private async nextInner(pageSize: number): Promise<LogPage> {
    this.clearIdle();
    if (this.disposed || this.done) return { commits: [], cursor: null, done: true };
    try {
      if (!this.live && !this.ended && !this.win) await this.start();
      if (this.win && !this.walkReady && !this.ended && !this.disposed) {
        if (this.deps.hasCommitGraph?.()) await this.switchToGraphWalk();
        else {
          // any failure (e.g. a missing object behind the frontier): the ordered walk takes over
          const page = await this.windowPage(pageSize).catch(() => null);
          if (page) {
            if (!this.live && !this.ended && this.win) this.startFullWalk();
            return this.finish(page.map((c) => ({ c, raw: -1 })));
          }
        }
      }
      this.dropWindow();
      if (!this.live && !this.ended && !this.disposed) await this.start();
      while (this.queue.length < pageSize && !this.ended && this.live && !this.yieldSeed) {
        const r = await this.readWalk(this.live);
        if (r.done) {
          this.take(this.live.parser.end());
          this.ended = true;
          this.live = null;
          break;
        }
        this.take(this.live.parser.push(r.value));
      }
    } catch (e) {
      this.kill();
      this.dropWindow();
      if (e instanceof GitError && (this.deps.isEmptyRepoError ?? isUnbornError)(e) && this.delivered === 0) {
        this.queue = [];
        this.ended = true;
      } else {
        this.dispose();
        throw e;
      }
    }
    this.yieldSeed = false;
    if (this.disposed) return { commits: [], cursor: null, done: true };
    return this.finish(this.queue.splice(0, pageSize));
  }

  private finish(page: { c: CommitSummary; raw: number }[]): LogPage {
    for (const q of page) if (q.raw >= 0) this.rawDelivered = q.raw + 1;
    const commits = page.map((q) => q.c);
    this.delivered += commits.length;
    this.done = this.ended && this.queue.length === 0 && !this.win;
    if (this.done) {
      this.kill();
      this.deps.onDispose?.(this);
    } else {
      this.armIdle();
    }
    return { commits, cursor: this.done ? null : this.id, done: this.done };
  }

  private take(commits: CommitSummary[]): void {
    for (const c of commits) {
      const raw = this.rawParsed++;
      if (this.seeded?.has(c.sha)) continue;
      this.queue.push({ c, raw });
    }
  }

  private async start(): Promise<void> {
    this.argsPromise ??= this.deps.buildArgs();
    const { args, seed, window, env } = await this.argsPromise;
    if (this.disposed) return;
    this.walk ??= { args };
    if (window && !this.seeded) {
      // the full ordered walk starts after the first window (no competition for the first page)
      this.seeded = new Set();
      const tips = this.deps.runner
        .run({ cwd: this.deps.cwd, args: window.tips, env, readOnly: true, encoding: 'utf8' })
        .then((r) => String(r.stdout).split(/\r?\n/).filter(Boolean));
      tips.catch(() => {});
      this.win = {
        a: window,
        env,
        stream: this.streamLive([...window.stream, ...window.revs, '--'], env),
        carry: [],
        frontier: tips,
      };
      return;
    }
    if (!seed || this.seeded) {
      this.spawn(env);
      return;
    }
    this.seeded = new Set();
    // start the walk now: it covers the whole history while the probe's page is shown
    this.spawn(env);
    const probe = await this.probe(seed, env);
    if (this.disposed) return;
    const complete = probe.length < LOG_SEED_COUNT;
    const page = seedOrder(probe, complete);
    for (const c of page) this.seeded.add(c.sha);
    this.queue.unshift(...page.map((c) => ({ c, raw: -1 })));
    if (complete) {
      // the probe saw everything: no walk needed
      this.kill();
      this.ended = true;
    }
    this.yieldSeed = page.length > 0;
  }

  /**
   * One window (see the module comment); null when the ordered walk got ready meanwhile (it takes over).
   * Shown commits go into `seeded`.
   */
  private async windowPage(pageSize: number): Promise<CommitSummary[] | null> {
    const w = this.win!;
    let want = pageSize;
    for (;;) {
      const pull = async (n: number): Promise<boolean> => {
        while (w.carry.length < n && w.stream) {
          const st = w.stream;
          const r = await st.iter.next();
          const got = r.done ? st.parser.end() : st.parser.push(r.value);
          for (const c of got) if (!this.seeded!.has(c.sha)) w.carry.push(c);
          if (r.done) w.stream = null;
          if (this.disposed || this.walkReady) return false;
        }
        return true;
      };
      if (!(await pull(want))) return null;
      if (!w.carry.length) {
        // everything was shown: no walk needed
        this.kill();
        this.ended = true;
        this.win = null;
        return [];
      }
      const s = w.carry.slice(0, want);
      const frontier = await w.frontier;
      const next = nextFrontier(frontier, s);
      const run = this.deps.runner.run({
        cwd: this.deps.cwd,
        args: [...w.a.ordered, '--stdin', '--'],
        stdin: [...frontier, ...next.map((x) => `^${x}`), ''].join('\n'),
        env: w.env,
        readOnly: true,
        encoding: 'buffer',
        maxBuffer: Infinity,
        timeoutMs: 0,
      });
      run.catch(() => {});
      // meanwhile a lookahead: commits streamed right after S are checked against the window too (guard)
      const more = await pull(want + Math.max(LOG_WINDOW_LOOKAHEAD, want));
      const r = await run;
      if (!more || this.disposed) return null;
      const parser = new LogParser({ signature: this.deps.signature });
      const page = windowGuard([...parser.push(r.stdout as Buffer), ...parser.end()], w.carry);
      if (!page.length) {
        // clock skew: S is reachable from older-dated commits behind it; widen S
        if (want >= w.carry.length && !w.stream) throw new Error('log window: empty window at the end');
        want = Math.max(want * 2, 1);
        continue;
      }
      const shown = new Set(page.map((c) => c.sha));
      for (const sha of shown) this.seeded!.add(sha);
      w.carry = w.carry.filter((c) => !shown.has(c.sha));
      w.frontier = Promise.resolve(next);
      this.windowCount++;
      if (!next.length && !w.carry.length && !w.stream) {
        // that was the rest of the history
        this.kill();
        this.ended = true;
        this.win = null;
      }
      return page;
    }
  }

  /**
   * Windowed mode: the full ordered walk, which prints nothing until it has walked everything; once it
   * does, it takes over (minus what the windows showed).
   */
  private startFullWalk(): void {
    this.spawn(this.win?.env);
    const live = this.live!;
    live.ahead = live.iter.next();
    live.ahead.then(
      () => (this.walkReady = true),
      () => (this.walkReady = true), // the error surfaces when it is read
    );
  }

  /** A commit-graph appeared: the rest (R(F)) is one ordered walk of the frontier, which now streams. */
  private async switchToGraphWalk(): Promise<void> {
    const w = this.win!;
    const frontier = await w.frontier;
    this.kill();
    this.dropWindow();
    this.queue = [];
    this.rawParsed = this.rawDelivered = 0;
    if (!frontier.length) {
      this.ended = true;
      return;
    }
    this.walk = { args: [...w.a.ordered, '--stdin', '--'], stdin: `${frontier.join('\n')}\n` };
    this.spawn(w.env);
    this.walkReady = true;
  }

  private dropWindow(): void {
    const w = this.win;
    this.win = null;
    if (!w?.stream) return;
    w.stream.stream.cancel();
    w.stream.iter.return?.().catch(() => {});
  }

  private readWalk(l: Live): Promise<IteratorResult<Buffer>> {
    const ahead = l.ahead;
    l.ahead = null;
    return ahead ?? l.iter.next();
  }

  private spawn(env?: Record<string, string>): void {
    const { args, stdin } = this.walk!;
    const withSkip =
      this.rawDelivered > 0 ? [...args.slice(0, 1), `--skip=${this.rawDelivered}`, ...args.slice(1)] : args;
    this.live = this.streamLive(withSkip, env, stdin);
    this.spawnCount++;
  }

  private streamLive(args: string[], env?: Record<string, string>, stdin?: string): Live {
    const stream = this.deps.runner.stream({
      cwd: this.deps.cwd,
      args,
      env,
      stdin,
      readOnly: true,
      timeoutMs: 0,
      unpooled: true,
    });
    stream.done.catch(() => {});
    // a walk killed before it was ever read (seeded mode) destroys stdout with Cancelled: not an error
    (stream.stdout as Partial<Pick<NodeJS.EventEmitter, 'on'>>).on?.('error', () => {});
    return {
      stream,
      iter: stream.stdout[Symbol.asyncIterator](),
      parser: new LogParser({ signature: this.deps.signature }),
      ahead: null,
    };
  }

  private async probe(args: string[], env?: Record<string, string>): Promise<CommitSummary[]> {
    const s = this.deps.runner.stream({ cwd: this.deps.cwd, args, env, readOnly: true, unpooled: true });
    const parser = new LogParser({ signature: this.deps.signature });
    const out: CommitSummary[] = [];
    try {
      for await (const chunk of s.stdout) out.push(...parser.push(chunk as Buffer));
      await s.done;
    } catch (e) {
      s.cancel();
      throw e;
    }
    out.push(...parser.end());
    return out;
  }

  private kill(): void {
    const l = this.live;
    this.live = null;
    if (!l) return;
    l.stream.cancel();
    l.iter.return?.().catch(() => {});
  }

  private armIdle(): void {
    const ms = this.deps.idleMs ?? DEFAULT_LOG_IDLE_MS;
    this.idleTimer = setTimeout(() => this.suspend(), ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
