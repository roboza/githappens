import type { CheckoutTarget, GitOperation } from '../ops/types';
import { shownPath } from '../ops/raw-path';
import type { JournalKind, RepoSnapshot, SnapshotHead, SnapshotScope } from './types';

export interface EntryPlan {
  kind: JournalKind;
  label: string;
  scope: SnapshotScope;
  /** Use this snapshot as `before` instead of the current state (a resumed Git Flow finish). */
  before?: RepoSnapshot;
}

const scope = (s: Partial<SnapshotScope>): SnapshotScope => ({
  head: 'none',
  refs: [],
  trees: false,
  stash: false,
  configBranches: [],
  ...s,
});

const short = (s: string): string => s.slice(0, 7);
const shas = (list: string[]): string => (list.length === 1 ? short(list[0]!) : `${list.length} commits`);

/**
 * Scope for ops that move HEAD's branch and rewrite index + worktree (merge, rebase, cherry-pick, revert,
 * reset --mixed/--hard, fast-forward of the current branch). Undo = move the ref(s) back, re-point HEAD
 * and restore exactly the index/worktree paths the op changed — `reset --keep` semantics: local changes the
 * op did not touch survive, and paths changed since block the undo (drift check).
 */
const rewrite = (head: SnapshotHead, extraRefs: string[] = []): SnapshotScope =>
  scope({ head: 'set', refs: [...new Set([headRef(head), ...extraRefs])], trees: true });

function targetLabel(t: CheckoutTarget): string {
  switch (t.kind) {
    case 'branch':
      return t.name;
    case 'remoteBranch':
      return t.localName ?? t.name;
    case 'commit':
      return short(t.sha);
    case 'tag':
      return t.name;
  }
}

/** Ref of the current HEAD for a soft-reset style undo: its branch, or `HEAD` itself when detached. */
export function headRef(head: SnapshotHead): string {
  return head.kind === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
}

/**
 * Which kind of entry an op produces and what its snapshot must cover (spec 05 §6.11). Returns null for ops
 * the journal doesn't record. `head` is the current HEAD (needed to know which ref a commit moves).
 */
export function planFor(op: GitOperation, head: SnapshotHead): EntryPlan | null {
  switch (op.type) {
    case 'commit.create': {
      const s = scope({ head: 'check', refs: [headRef(head)] });
      return op.amend
        ? { kind: 'amend', label: `Amend commit '${op.summary}'`, scope: s }
        : { kind: 'commit', label: `Commit '${op.summary}'`, scope: s };
    }
    case 'commit.rewordHead':
      return {
        kind: 'amend',
        label: `Reword commit '${op.summary}'`,
        scope: scope({ head: 'check', refs: [headRef(head)] }),
      };
    case 'checkout.run': {
      const created = op.target.kind === 'remoteBranch' ? (op.target.localName ?? op.target.name) : null;
      if (created && op.target.kind === 'remoteBranch' && op.target.onExisting) {
        // an existing local branch is moved (ff / reset to the remote): restore it like a rewrite (spec 05 §4.5)
        return {
          kind: 'checkout',
          label: `Checkout ${created}${op.target.onExisting === 'reset' ? ` (reset to ${op.target.remote}/${op.target.name})` : ''}`,
          scope: scope({
            head: 'set',
            refs: [`refs/heads/${created}`],
            configBranches: [created],
            trees: true,
            stash: op.dirtyStrategy === 'stash',
          }),
        };
      }
      return {
        kind: 'checkout',
        label: `Checkout ${targetLabel(op.target)}`,
        scope: scope({
          head: op.dirtyStrategy === 'carry' ? 'switch' : 'set',
          refs: created ? [`refs/heads/${created}`] : [],
          configBranches: created ? [created] : [],
          trees: op.dirtyStrategy !== 'carry',
          stash: op.dirtyStrategy === 'stash',
        }),
      };
    }
    case 'wip.discard':
      return {
        kind: 'discard',
        label:
          op.paths.length === 1
            ? `Discard changes in ${shownPath(op.paths[0]!)}`
            : `Discard changes in ${op.paths.length} files`,
        scope: scope({ trees: true }),
      };
    case 'wip.discardAll':
      return { kind: 'discard', label: 'Discard all changes', scope: scope({ trees: true }) };
    case 'wip.discardHunk':
      return { kind: 'discard', label: `Discard hunk in ${op.path}`, scope: scope({ trees: true }) };
    case 'wip.discardLines':
      return { kind: 'discard', label: `Discard lines in ${op.path}`, scope: scope({ trees: true }) };
    case 'diff.revertHunk':
      return {
        kind: 'revert-hunk',
        label: `Revert ${op.hunkIndex === 'all' ? 'changes' : 'hunk'} in ${op.path}`,
        scope: scope({ trees: true }),
      };
    case 'file.checkoutAt':
      return {
        kind: 'discard',
        label: `Checkout ${op.path} at ${short(op.rev)}`,
        scope: scope({ trees: true }),
      };
    case 'branch.create':
      return {
        kind: 'branch-create',
        label: `Create branch ${op.name}`,
        scope: scope({
          head: op.checkout ? 'switch' : 'none',
          refs: [`refs/heads/${op.name}`],
          configBranches: [op.name],
        }),
      };
    case 'branch.delete': {
      const names = op.branches.map((b) => b.name);
      const remote = op.branches.some((b) => b.deleteRemote) ? ' (local only)' : '';
      return {
        kind: 'branch-delete',
        label:
          (names.length === 1 ? `Delete branch ${names[0]}` : `Delete ${names.length} branches`) + remote,
        scope: scope({ refs: names.map((n) => `refs/heads/${n}`), configBranches: names }),
      };
    }
    case 'branch.rename':
      return {
        kind: 'branch-rename',
        label: `Rename branch ${op.from} to ${op.to}`,
        scope: scope({
          refs: [`refs/heads/${op.from}`, `refs/heads/${op.to}`],
          rename: { from: op.from, to: op.to },
        }),
      };
    case 'tag.create':
      return {
        kind: 'tag-create',
        label: `Create tag ${op.name}`,
        scope: scope({ refs: [`refs/tags/${op.name}`] }),
      };
    case 'tag.delete':
      if (!op.local) return null; // remote-only deletion: a network op (barrier), not journaled here
      return {
        kind: 'tag-delete',
        label: `Delete tag ${op.name}${op.remotes.length ? ' (local only)' : ''}`,
        scope: scope({ refs: [`refs/tags/${op.name}`] }),
      };
    case 'stash.push':
      return {
        kind: 'stash-push',
        label: op.message ? `Stash '${op.message}'` : 'Stash changes',
        scope: scope({ trees: true, stash: true }),
      };
    case 'stash.pop':
      return {
        kind: 'stash-pop',
        label: `Pop stash@{${op.index}}`,
        scope: scope({ trees: true, stash: true }),
      };
    case 'stash.drop':
      return { kind: 'stash-drop', label: `Delete stash@{${op.index}}`, scope: scope({ stash: true }) };
    // ---- history rewriting (spec 05 §6.11: "reset / fast-forward / rebase / … / merge") ----
    case 'merge.run':
      return {
        kind: 'merge',
        label: op.mode === 'squash' ? `Squash merge ${op.source}` : `Merge ${op.source}`,
        scope: rewrite(head),
      };
    case 'rebase.run': {
      const b = op.branch?.replace(/^refs\/heads\//, '');
      const other = b && !(head.kind === 'branch' && head.name === b) ? [`refs/heads/${b}`] : [];
      return {
        kind: 'rebase',
        label: `Rebase ${b ? `${b} ` : ''}onto ${op.onto}`,
        scope: rewrite(head, other),
      };
    }
    case 'rebase.interactive':
      // an `edit` step leaves the rebase in progress: nothing consistent to snapshot as "after"
      if (op.todo.some((t) => t.action === 'edit')) return null;
      return { kind: 'interactive-rebase', label: 'Interactive rebase', scope: rewrite(head) };
    case 'cherryPick.run':
      return { kind: 'cherry-pick', label: `Cherry-pick ${shas(op.shas)}`, scope: rewrite(head) };
    case 'revert.run':
      return { kind: 'revert', label: `Revert ${shas(op.shas)}`, scope: rewrite(head) };
    case 'reset.run':
      return {
        kind: 'reset',
        label: `Reset to ${short(op.target)} (${op.mode})`,
        // soft: only the branch moves (index and worktree untouched)
        scope: op.mode === 'soft' ? scope({ head: 'check', refs: [headRef(head)] }) : rewrite(head),
      };
    case 'ai.compose':
      // one entry for the whole composite op: undo moves the branch back and restores the index (spec 12 §6.6)
      return {
        kind: 'ai-compose',
        label:
          op.source.kind === 'range'
            ? 'Recompose commits with AI'
            : `Compose ${op.commits.length} commit${op.commits.length === 1 ? '' : 's'} with AI`,
        scope: rewrite(head),
      };
    case 'patch.apply': {
      // one entry for the whole op: branch switch/creation, autostash, apply and optional commit
      const label = op.title ? `Apply patch '${op.title}'` : 'Apply patch';
      const t = op.target;
      // worktree target never commits (an `am` patch is applied as uncommitted changes there)
      if (t.kind === 'worktree') return { kind: 'patch-apply', label, scope: scope({ trees: true }) };
      return {
        kind: 'patch-apply',
        label,
        scope: scope({
          head: 'set',
          refs: [`refs/heads/${t.name}`],
          configBranches: t.kind === 'new-branch' ? [t.name] : [],
          trees: true,
          stash: !!t.autostash,
        }),
      };
    }
    // ---- Phase 8 (spec 05 §6.9–§6.11) ----
    case 'squash.run':
      return { kind: 'squash', label: `Squash ${op.shas.length} commits`, scope: rewrite(head) };
    case 'reset.branch': {
      const b = op.branch.replace(/^refs\/heads\//, '');
      return {
        kind: 'reset',
        label: `Reset ${b} to ${short(op.target)}`,
        scope: scope({ refs: [`refs/heads/${b}`] }),
      };
    }
    case 'reflog.restore':
      return { kind: 'reset', label: `Restore ${op.selector}`, scope: rewrite(head) };
    case 'stash.rename':
      return { kind: 'stash-rename', label: `Rename stash@{${op.index}}`, scope: scope({ stash: true }) };
    case 'stash.applyFile':
      return {
        kind: 'stash-apply',
        label: `Apply ${op.path} from stash@{${op.index}}`,
        scope: scope({ trees: true }),
      };
    case 'stash.branch':
      return {
        kind: 'branch-create',
        label: `Create branch ${op.name} from stash@{${op.index}}`,
        scope: scope({
          head: 'set',
          refs: [`refs/heads/${op.name}`],
          configBranches: [op.name],
          trees: true,
          stash: true,
        }),
      };
    case 'remote.remove':
      return {
        kind: 'remote-remove',
        label: `Remove remote ${op.name}`,
        scope: scope({ remotes: [op.name] }),
      };
    case 'conflict.markResolved':
      return {
        kind: 'mark-resolved',
        label:
          op.paths.length === 1 ? `Mark ${op.paths[0]} resolved` : `Mark ${op.paths.length} files resolved`,
        scope: scope({ indexEntries: [...op.paths] }),
      };
    case 'ff.run': {
      const b = op.branch.replace(/^refs\/heads\//, '');
      const current = head.kind === 'branch' && head.name === b;
      return {
        kind: 'fast-forward',
        label: `Fast-forward ${b}`,
        scope: current ? rewrite(head) : scope({ refs: [`refs/heads/${b}`] }),
      };
    }
    default:
      return null;
  }
}

/** Label + kind for a barrier entry (network ops; spec 05 §6.11 "not undoable"). */
export function barrierFor(op: GitOperation): { kind: JournalKind; label: string } {
  switch (op.type) {
    case 'fetch':
      return { kind: 'fetch', label: op.remote === 'all' ? 'Fetch' : `Fetch ${op.remote}` };
    case 'pull':
      return { kind: 'pull', label: 'Pull' };
    case 'push':
      return { kind: 'push', label: `Push ${op.localRef}` };
    case 'push.tags':
      return { kind: 'push', label: 'Push tags' };
    case 'push.delete':
      return { kind: 'remote-delete', label: `Delete remote ${op.refs.length === 1 ? op.refs[0] : 'refs'}` };
    case 'tag.delete':
      return { kind: 'remote-delete', label: `Delete remote tag ${op.name}` };
    case 'fastForwardBranch':
      return { kind: 'fast-forward', label: `Fast-forward ${op.localBranch}` };
    case 'branch.renameRemote':
      return { kind: 'remote-delete', label: `Rename ${op.remote}/${op.from} to ${op.to}` };
    default:
      return { kind: 'network', label: op.type };
  }
}
