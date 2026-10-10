import { NodeKind, WIP_SHA, type GraphModel, type GraphCommitInput, type RefPill } from '@githappens/graph';
import type { RepoInfo } from '@githappens/git/types';

/** Keyboard navigation targets (spec 04 §2.5, §6.13). Pure, so it is unit-tested without a DOM. */

export interface NavKey {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export type NavResult =
  | { kind: 'move'; row: number }
  /** Shift+Alt+↑/↓: extend the selection to `row` (our addition, §4.9). */
  | { kind: 'extend'; row: number }
  | null;

export function navTarget<C extends GraphCommitInput>(
  model: GraphModel<C>,
  cur: number,
  e: NavKey,
  pageRows: number,
): NavResult {
  const n = model.rowCount;
  if (n === 0) return null;
  const last = n - 1;
  const from = cur < 0 ? -1 : Math.min(cur, last);
  const k = e.key;
  const mod = !!(e.ctrlKey || e.metaKey);
  const lower = k.length === 1 ? k.toLowerCase() : k;
  const down = k === 'ArrowDown' || lower === 'j';
  const up = k === 'ArrowUp' || lower === 'k';

  if (e.shiftKey && e.altKey && (k === 'ArrowDown' || k === 'ArrowUp')) {
    const row = k === 'ArrowDown' ? Math.min(last, from + 1) : Math.max(0, from - 1);
    return { kind: 'extend', row };
  }
  if (mod && (k === 'Home' || k === 'ArrowUp')) return { kind: 'move', row: 0 };
  if (mod && (k === 'End' || k === 'ArrowDown')) return { kind: 'move', row: last };
  if (e.shiftKey && !e.altKey && (down || up)) {
    // first-parent navigation: Shift+J / Shift+↓ → first parent, Shift+K / Shift+↑ → first-parent child
    if (from < 0) return { kind: 'move', row: 0 };
    const row = down ? model.firstParentRow(from) : model.firstParentChild(from);
    return row >= 0 ? { kind: 'move', row } : null;
  }
  if (e.shiftKey || e.altKey || mod) return null;
  if (down) return { kind: 'move', row: Math.min(last, from + 1) };
  if (up) return { kind: 'move', row: Math.max(0, from - 1) };
  if (k === 'Home') return { kind: 'move', row: 0 };
  if (k === 'End') return { kind: 'move', row: last };
  if (k === 'PageDown') return { kind: 'move', row: Math.min(last, Math.max(0, from) + pageRows) };
  if (k === 'PageUp') return { kind: 'move', row: Math.max(0, from - pageRows) };
  return null;
}

/** Screen-reader summary of a row (spec 04 §6.14): "Merge commit by Ann, 3 hours ago, branches main, origin/main". */
export function rowAriaLabel(
  model: GraphModel<GraphCommitInput & { subject?: string; authorName?: string }>,
  row: number,
  pills: readonly RefPill[] | undefined,
  when: string,
): string {
  const kind = model.nodeKindAt(row);
  const sha = model.shaAt(row);
  if (sha === WIP_SHA) return kind === NodeKind.Conflict ? 'Conflict: work in progress' : 'Work in progress';
  if (kind === NodeKind.Stash) return `Stash${pills?.[0] ? ` ${pills[0].label}` : ''}`;
  const c = model.commitAt(row);
  const parts = [`${kind === NodeKind.Merge ? 'Merge commit' : 'Commit'} ${c?.subject ?? ''}`.trim()];
  if (c?.authorName) parts.push(`by ${c.authorName}`);
  if (when) parts.push(when);
  const branches = (pills ?? []).flatMap((p) =>
    p.refs.map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, '')),
  );
  if (branches.length) parts.push(`refs ${branches.join(', ')}`);
  if (sha === model.headSha) parts.push('HEAD');
  return parts.join(', ');
}

/** Label of the conflict row for the operation in progress (spec 04 §4.4). */
export function conflictLabel(state: RepoInfo['state']): string {
  switch (state) {
    case 'rebasing':
    case 'rebasing-interactive':
    case 'applying-mailbox':
      return 'Rebase conflict';
    case 'cherry-picking':
      return 'Cherry-pick conflict';
    case 'reverting':
      return 'Revert conflict';
    default:
      return 'Merge conflict';
  }
}
