import { GraphModel, historyUnchanged, type GraphLayoutOptions, type VisibleTips } from '@githappens/graph';
import type { CommitSummary, RepoInfo, StashEntry, StatusResult } from '@githappens/git/types';
import { useState } from 'react';

import type { History } from './useHistory';

export interface ModelInputs {
  history: History;
  info: RepoInfo;
  status: StatusResult | undefined;
  /** Visible stashes (hidden stashes are passed via `omit`). */
  stashes: StashEntry[] | undefined;
  mergeHead: string | null | undefined;
  /** Pinned branch tips (lanes 1..k, spec 04 §2.6). */
  pinnedTips?: readonly string[];
  /** Commits that never become rows (hidden stashes and their helper commits). */
  omit?: readonly string[];
  /** `graph.convergenceReuse`: lay out new generations reusing the previous model (§6.10). */
  reuse?: boolean;
}

/** Does the working tree have anything to show as a WIP row (spec 04 §4.4)? */
export function wipKind(status: StatusResult | undefined): 'wip' | 'conflict' | null {
  if (!status) return null;
  const entries = status.entries.filter((e) => e.kind !== 'ignored');
  if (entries.some((e) => e.kind === 'unmerged')) return 'conflict';
  return entries.length ? 'wip' : null;
}

/**
 * Holds one GraphModel per history generation + layout options and appends new pages
 * incrementally (spec 04 §6). Appends are tracked by count, so repeated calls with the
 * same inputs (e.g. StrictMode double renders) are no-ops: a ref-only change (same history
 * generation, same layout key) returns the very same model without any relayout (§6.10 case 2).
 *
 * A new generation (history restarted because the visible tips changed) or a new layout key (WIP
 * toggled, HEAD moved, pins changed) builds a new model. With `reuse` the previous model is passed
 * as `reuseFrom`, so the unchanged tail is adopted instead of re-laid out (convergence reuse, §6.10);
 * the old model is never touched again.
 */
export class GraphModelCache {
  private model: GraphModel<CommitSummary> | null = null;
  private gen = -1;
  private key = '';
  private appended = 0;
  /** Number of models built (diagnostics / tests). */
  builds = 0;

  get(
    history: Pick<History, 'commits' | 'generation' | 'done'>,
    opts: GraphLayoutOptions,
    key: string,
    reuse = true,
  ): GraphModel<CommitSummary> {
    if (!this.model || this.gen !== history.generation || this.key !== key) {
      const prev = this.model;
      this.model = new GraphModel<CommitSummary>(opts, reuse && prev ? prev : undefined);
      this.builds++;
      this.gen = history.generation;
      this.key = key;
      this.appended = 0;
    }
    if (this.appended < history.commits.length) {
      this.model.append(history.commits.slice(this.appended), history.done);
      this.appended = history.commits.length;
    } else if (history.done && !this.model.complete) {
      this.model.finish();
    }
    return this.model;
  }
}

/**
 * Decides which key the history is loaded with (spec 04 §6.10 decision tree). A new visible-tip key
 * normally restarts the log stream; it is ignored when the commit set cannot have changed (only new tips
 * at commits that are already laid out, e.g. a tag or branch created at an existing commit), so such a
 * ref change only updates pills: no reload, no relayout.
 */
export class HistoryKeyTracker {
  /** Key of a load started before the refs were known (see `pending`). */
  static readonly PENDING = 'pending';
  private current: { key: string; tipKey: string; tips: VisibleTips } | null = null;
  private model: Pick<GraphModel, 'rowOf'> | null = null;
  private provisional = false;
  private adopted: string | null = null;

  /**
   * Key for a history load started while refs / stashes are still loading, allowed when the rev query does
   * not depend on them (no hide / solo, i.e. `git log --all`): the log then runs in parallel with
   * `for-each-ref` instead of after it (spec 04 §9 first rows). The first resolved key adopts that load,
   * so it is not restarted once the refs arrive.
   */
  pending(): string {
    if (!this.current) this.provisional = true;
    return HistoryKeyTracker.PENDING;
  }

  resolve(tipKey: string, tips: VisibleTips): string {
    const key = this.resolveKey(tipKey, tips);
    if (this.provisional) {
      this.provisional = false;
      this.adopted = key;
    }
    return key === this.adopted ? HistoryKeyTracker.PENDING : key;
  }

  private resolveKey(tipKey: string, tips: VisibleTips): string {
    const cur = this.current;
    if (!cur) {
      this.current = { key: tipKey, tipKey, tips };
      return tipKey;
    }
    if (cur.tipKey === tipKey) return cur.key;
    const m = this.model;
    if (m && historyUnchanged(cur.tips, tips, (sha) => m.rowOf(sha) >= 0)) {
      this.current = { key: cur.key, tipKey, tips };
      return cur.key;
    }
    this.current = { key: tipKey, tipKey, tips };
    return tipKey;
  }

  /** The model currently on screen (answers "is this tip already laid out?"). */
  observe(model: Pick<GraphModel, 'rowOf'>): void {
    this.model = model;
  }
}

/** Layout options + their identity key for the current repo state. */
export function layoutOptions(i: Omit<ModelInputs, 'history' | 'reuse'>): {
  opts: GraphLayoutOptions;
  key: string;
} {
  const headSha = i.info.head.sha;
  const wip = wipKind(i.status);
  const opts: GraphLayoutOptions = {
    headSha,
    wip:
      wip === 'conflict' && headSha
        ? { kind: 'conflict', parents: i.mergeHead ? [headSha, i.mergeHead] : [headSha] }
        : wip === 'wip'
          ? true
          : undefined,
    stashes: i.stashes ?? [],
    pinnedTips: i.pinnedTips ?? [],
    omit: i.omit ?? [],
  };
  const key = JSON.stringify([
    headSha,
    opts.wip,
    (i.stashes ?? []).map((s) => s.sha),
    opts.pinnedTips,
    opts.omit,
  ]);
  return { opts, key };
}

export function useGraphModel(inputs: ModelInputs): GraphModel<CommitSummary> {
  const [cache] = useState(() => new GraphModelCache());
  const { opts, key } = layoutOptions(inputs);
  return cache.get(inputs.history, opts, key, inputs.reuse !== false);
}
