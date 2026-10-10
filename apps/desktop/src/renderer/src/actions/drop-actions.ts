import type { InProgressOp, Sha } from '@githappens/git/types';

/**
 * Drag-and-drop matrix (spec 05 §4.4) as a pure function, so every cell is unit-tested.
 * The UI resolves ancestry (`git:isAncestor`) before calling it and maps the result
 * to a context menu at the drop point.
 */

export type DragSource =
  | { kind: 'local'; name: string; sha: Sha }
  | { kind: 'remote'; name: string; sha: Sha } // "origin/feature"
  | { kind: 'tag'; name: string; sha: Sha }
  | { kind: 'commit'; sha: Sha }
  | { kind: 'stash'; sha: Sha; index: number; message: string };

export type DropTarget =
  | { kind: 'local'; name: string; sha: Sha }
  | { kind: 'remote'; name: string; sha: Sha }
  | { kind: 'remoteNode'; remote: string }
  | { kind: 'tag'; name: string; sha: Sha }
  | { kind: 'commit'; sha: Sha };

export interface DropContext {
  /** Checked-out branch name, null when detached. */
  head: string | null;
  headSha: Sha | null;
  inProgress: InProgressOp | null;
  /** Target is an ancestor of the source (fast-forward of target to source possible). */
  targetIsAncestorOfSource: boolean;
  /** HEAD is an ancestor of the source (fast-forward of HEAD to source possible). */
  headIsAncestorOfSource: boolean;
  /** A remote of this repo belongs to a connected hosting account (enables "Start a pull request"). */
  canCreatePr?: boolean;
  /** The refs being integrated share no history (`git merge-base` fails): rebase is impossible (spec 05 §4.4). */
  noCommonAncestor?: boolean;
  /** Shallow clone: a missing merge base may only be missing history (spec 05 §8). */
  shallow?: boolean;
}

export type DoAction =
  | { type: 'merge'; source: string; /** `ask` = choose the merge mode first (Phase 8). */ mode?: 'ask' }
  | { type: 'rebase'; onto: string }
  | { type: 'irebase'; upstream: Sha; label: string }
  | { type: 'ff'; branch: string; to: string }
  | { type: 'reset'; target: Sha; mode: 'soft' | 'mixed' | 'hard'; label: string }
  | { type: 'push'; local: string; remote: string; remoteBranch: string; force: boolean }
  | { type: 'pushNew'; local: string; remote: string }
  | { type: 'pushTag'; tag: string; remote: string }
  | { type: 'cherryPick'; sha: Sha }
  | { type: 'stashApply'; index: number; sha: Sha }
  | { type: 'stashPop'; index: number; sha: Sha }
  | { type: 'abort' }
  | { type: 'createPr'; head: string; base: string };

export interface DropAction {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Null for informational rows ("Nothing to do"). */
  action: DoAction | null;
}

const split = (remoteName: string): { remote: string; branch: string } => {
  const [remote, ...rest] = remoteName.split('/');
  return { remote: remote!, branch: rest.join('/') };
};

const resets = (target: Sha, label: string, who: string): DropAction[] =>
  (['soft', 'mixed', 'hard'] as const).map((mode) => ({
    id: `reset-${mode}`,
    label: `Reset ${who} to ${label} (${mode})`,
    danger: mode === 'hard',
    action: { type: 'reset', target, mode, label },
  }));

function sourceLabel(s: DragSource): string {
  switch (s.kind) {
    case 'commit':
      return s.sha.slice(0, 7);
    case 'stash':
      return `stash@{${s.index}}`;
    default:
      return s.name;
  }
}

export function computeDropActions(source: DragSource, target: DropTarget, ctx: DropContext): DropAction[] {
  const targetSha = 'sha' in target ? target.sha : null;
  if (targetSha && 'sha' in source && source.sha === targetSha && target.kind !== 'remoteNode') {
    if (!(source.kind === 'local' && target.kind === 'remote')) {
      return [{ id: 'none', label: 'Nothing to do (same commit)', disabled: true, action: null }];
    }
  }

  const H = ctx.head;
  const S = sourceLabel(source);
  const targetIsHead = target.kind === 'local' && target.name === H;
  const sourceIsHead = source.kind === 'local' && source.name === H;
  const out: DropAction[] = [];

  // ---- source is the checked-out branch: operate on S using T ----
  if (sourceIsHead && source.kind === 'local') {
    if (target.kind === 'local' && !targetIsHead) {
      out.push(
        {
          id: 'merge',
          label: `Merge ${target.name} into ${S}`,
          action: { type: 'merge', source: target.name },
        },
        {
          id: 'rebase',
          label: `Rebase ${S} onto ${target.name}`,
          action: { type: 'rebase', onto: target.name },
        },
        {
          id: 'irebase',
          label: `Interactive rebase ${S} onto ${target.name}`,
          action: { type: 'irebase', upstream: target.sha, label: target.name },
        },
      );
      if (ctx.targetIsAncestorOfSource) {
        out.push({
          id: 'ff',
          label: `Fast-forward ${target.name} to ${S}`,
          action: { type: 'ff', branch: target.name, to: S },
        });
      }
      out.push(...resets(target.sha, target.name, S));
    } else if (target.kind === 'remote') {
      const { remote, branch } = split(target.name);
      out.push(
        {
          id: 'merge',
          label: `Merge ${target.name} into ${S}`,
          action: { type: 'merge', source: target.name },
        },
        {
          id: 'rebase',
          label: `Rebase ${S} onto ${target.name}`,
          action: { type: 'rebase', onto: target.name },
        },
        {
          id: 'irebase',
          label: `Interactive rebase ${S} onto ${target.name}`,
          action: { type: 'irebase', upstream: target.sha, label: target.name },
        },
        ctx.targetIsAncestorOfSource || source.sha === target.sha
          ? {
              id: 'push',
              label: `Push ${S} to ${target.name}`,
              action: { type: 'push', local: S, remote, remoteBranch: branch, force: false },
            }
          : {
              id: 'push-force',
              label: `Force push ${S} to ${target.name} (with lease)`,
              danger: true,
              action: { type: 'push', local: S, remote, remoteBranch: branch, force: true },
            },
      );
    } else if (target.kind === 'remoteNode') {
      out.push({
        id: 'push-new',
        label: `Push ${S} to ${target.remote}`,
        action: { type: 'pushNew', local: S, remote: target.remote },
      });
    } else if (target.kind === 'tag') {
      out.push(
        {
          id: 'merge',
          label: `Merge ${target.name} into ${S}`,
          action: { type: 'merge', source: target.name },
        },
        {
          id: 'rebase',
          label: `Rebase ${S} onto ${target.name}`,
          action: { type: 'rebase', onto: target.name },
        },
        ...resets(target.sha, target.name, S),
      );
    } else if (target.kind === 'commit') {
      const label = target.sha.slice(0, 7);
      out.push(
        { id: 'rebase', label: `Rebase ${S} onto ${label}`, action: { type: 'rebase', onto: target.sha } },
        ...resets(target.sha, label, S),
      );
    }
  }
  // ---- something dropped on the checked-out branch: operate on H using S ----
  else if (targetIsHead && H) {
    switch (source.kind) {
      case 'local':
      case 'remote':
        out.push(
          { id: 'merge', label: `Merge ${S} into ${H}`, action: { type: 'merge', source: S } },
          { id: 'rebase', label: `Rebase ${H} onto ${S}`, action: { type: 'rebase', onto: S } },
          {
            id: 'irebase',
            label: `Interactive rebase ${H} onto ${S}`,
            action: { type: 'irebase', upstream: source.sha, label: S },
          },
        );
        if (ctx.headIsAncestorOfSource) {
          out.push({
            id: 'ff',
            label: `Fast-forward ${H} to ${S}`,
            action: { type: 'ff', branch: H, to: S },
          });
        }
        out.push(...resets(source.sha, S, H));
        break;
      case 'tag':
        out.push(
          { id: 'merge', label: `Merge ${S} into ${H}`, action: { type: 'merge', source: S } },
          { id: 'rebase', label: `Rebase ${H} onto ${S}`, action: { type: 'rebase', onto: S } },
          ...resets(source.sha, S, H),
        );
        break;
      case 'commit':
        out.push(
          {
            id: 'cherry-pick',
            label: `Cherry-pick ${S} onto ${H}`,
            action: { type: 'cherryPick', sha: source.sha },
          },
          { id: 'rebase', label: `Rebase ${H} onto ${S}`, action: { type: 'rebase', onto: source.sha } },
          ...resets(source.sha, S, H),
        );
        break;
      case 'stash':
        out.push(
          {
            id: 'stash-apply',
            label: `Apply ${S}`,
            action: { type: 'stashApply', index: source.index, sha: source.sha },
          },
          {
            id: 'stash-pop',
            label: `Pop ${S}`,
            action: { type: 'stashPop', index: source.index, sha: source.sha },
          },
        );
        break;
    }
  }
  // ---- neither side is HEAD ----
  else if (target.kind === 'local' && (source.kind === 'local' || source.kind === 'remote')) {
    if (ctx.targetIsAncestorOfSource) {
      out.push({
        id: 'ff',
        label: `Fast-forward ${target.name} to ${S}`,
        action: { type: 'ff', branch: target.name, to: S },
      });
    }
  } else if (target.kind === 'remote' && source.kind === 'local') {
    const { remote, branch } = split(target.name);
    out.push(
      ctx.targetIsAncestorOfSource
        ? {
            id: 'push',
            label: `Push ${S} to ${target.name}`,
            action: { type: 'push', local: S, remote, remoteBranch: branch, force: false },
          }
        : {
            id: 'push-force',
            label: `Force push ${S} to ${target.name} (with lease)`,
            danger: true,
            action: { type: 'push', local: S, remote, remoteBranch: branch, force: true },
          },
    );
  } else if (target.kind === 'remoteNode' && source.kind === 'local') {
    out.push({
      id: 'push-new',
      label: `Push ${S} to ${target.remote}`,
      action: { type: 'pushNew', local: S, remote: target.remote },
    });
  } else if (target.kind === 'remoteNode' && source.kind === 'tag') {
    out.push({
      id: 'push-tag',
      label: `Push tag ${S} to ${target.remote}`,
      action: { type: 'pushTag', tag: S, remote: target.remote },
    });
  }

  // Branch onto branch: offer a pull request between them (spec 10 §6.4, "drag to create PR").
  if (
    ctx.canCreatePr &&
    (source.kind === 'local' || source.kind === 'remote') &&
    (target.kind === 'local' || target.kind === 'remote') &&
    source.name !== target.name
  ) {
    out.push({
      id: 'create-pr',
      label: `Start a pull request from ${S} to ${target.name}`,
      action: { type: 'createPr', head: source.name, base: target.name },
    });
  }

  if (out.length === 0)
    return [{ id: 'none', label: 'No actions for this drop', disabled: true, action: null }];

  // Every merge row gets a "…" sibling that asks for the merge mode (spec 05 §6.5, Phase 8).
  for (let i = out.length - 1; i >= 0; i--) {
    const a = out[i]!;
    if (a.id === 'merge' && a.action?.type === 'merge') {
      out.splice(i + 1, 0, {
        id: 'merge-options',
        label: `${a.label}…`,
        title: 'Choose: fast-forward if possible, merge commit, fast-forward only or squash',
        action: { ...a.action, mode: 'ask' },
      });
    }
  }

  // Rebase needs a merge base (spec 05 §4.4 rules, §8 shallow clones).
  if (ctx.noCommonAncestor) {
    const why = ctx.shallow ? 'History is shallow' : 'No common ancestor';
    for (const a of out) {
      if (a.action?.type === 'rebase' || a.action?.type === 'irebase') {
        a.disabled = true;
        a.title = why;
      }
    }
  }

  // An operation in progress blocks everything except aborting it (spec 05 §4.4 rules).
  if (ctx.inProgress) {
    return [
      ...out.map((a) => ({ ...a, disabled: true, title: `A ${ctx.inProgress} is in progress` })),
      { id: 'abort', label: `Abort current ${ctx.inProgress}`, danger: true, action: { type: 'abort' } },
    ];
  }
  return out;
}
