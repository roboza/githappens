import type { GitOperationType, OpStateEvent, RepoId } from '@githappens/git';

export interface DesktopNotifierOptions {
  /** `notifications.desktop`. */
  enabled: () => boolean;
  /** Any app window focused (no OS notification then; the toast is enough). */
  isFocused: () => boolean;
  /** Electron `new Notification({ title, body }).show()`; returns false when unsupported. */
  show: (n: { title: string; body?: string; onClick?: () => void }) => boolean;
  /** Bring the main window to the front (notification click). */
  focusWindow?: () => void;
  /** Display name for a repo ("api"), used in titles. */
  repoName?: (repoId: RepoId) => string | undefined;
  /** Ops that ran at least this long count as "long" (default 3 s). */
  longOpMs?: number;
  now?: () => number;
}

/** Network / long-running ops worth a completion notification (spec 01 §4.10: clone/fetch/push…). */
const NOTABLE: ReadonlySet<GitOperationType> = new Set<GitOperationType>([
  'fetch',
  'pull',
  'push',
  'push.tags',
  'push.delete',
  'fastForwardBranch',
  'rebase.run',
  'rebase.interactive',
  'merge.run',
  'submodule.update',
  'submodule.add',
  'lfs.pull',
  'lfs.push',
  'lfs.fetch',
  'pr.checkout',
  'gitflow.finish',
  'ai.compose',
]);

/**
 * OS notifications (spec 01 §4.10, `notify:desktop`): background completions and failures while the
 * window is not focused. Fed with `git:op:state` events; background ops (auto-fetch) are silent on
 * success and only notify failures when the caller says so (`notifications.autoFetchErrors`).
 */
export class DesktopNotifier {
  private readonly started = new Map<string, number>();

  constructor(private readonly o: DesktopNotifierOptions) {}

  /** Explicit request (renderer `notify:desktop`). `force` skips the focus check (still needs the setting). */
  notify(title: string, body?: string, force = false): boolean {
    if (!this.safe(this.o.enabled)) return false;
    if (!force && this.safe(this.o.isFocused)) return false;
    try {
      return this.o.show({ title, body, onClick: this.o.focusWindow });
    } catch {
      return false;
    }
  }

  /**
   * Op lifecycle. `background` marks auto-fetch ops; `notifyBackgroundFailure` is the
   * `notifications.autoFetchErrors` setting.
   */
  onOpState(
    repoId: RepoId,
    e: OpStateEvent,
    o: { background?: boolean; notifyBackgroundFailure?: boolean } = {},
  ): void {
    const now = this.o.now?.() ?? Date.now();
    if (e.state === 'running') {
      this.started.set(e.opId, now);
      return;
    }
    if (e.state === 'queued') return;
    const started = this.started.get(e.opId);
    this.started.delete(e.opId);
    if (e.state === 'cancelled') return;
    const repo = this.o.repoName?.(repoId);
    const where = repo ? ` — ${repo}` : '';
    if (e.state === 'failed') {
      if (o.background && !o.notifyBackgroundFailure) return;
      if (e.error?.code === 'Cancelled' || e.error?.code === 'AuthCancelled') return;
      this.notify(`${e.label} failed${where}`, e.error?.message);
      return;
    }
    // succeeded
    if (o.background) return;
    const long = started !== undefined && now - started >= (this.o.longOpMs ?? 3000);
    if (NOTABLE.has(e.type) || long) this.notify(`${e.label} finished${where}`);
  }

  private safe(fn: () => boolean): boolean {
    try {
      return fn();
    } catch {
      return false;
    }
  }
}
