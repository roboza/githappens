import type { RefInfo, RepoId, RepoInfo } from '@githappens/git/types';
import type { DragEvent } from 'react';

import { useContextMenu, type MenuEntry } from '../components/ContextMenu';
import { intInvoke } from '../integrations/api';
import { invoke } from '../lib/api';
import { quiet, runOp } from '../lib/ops';
import { conflictHintTitle, withHint } from '../views/merge/prediction-cache';
import { endHoverPredict, hoverPredict, predictCached, setDragSource } from '../views/merge/prediction';
import { mergeWithOptions } from '../views/ops/branching-actions';
import { openCreatePullRequest } from '../views/pr/CreatePullRequest';
import { undoInvoke } from '../views/undo/api';
import { computeDropActions, type DoAction, type DragSource, type DropTarget } from './drop-actions';
import {
  cherryPick,
  fastForward,
  interactiveRebase,
  merge,
  pushTo,
  rebase,
  reset,
  stashApply,
  stashPop,
} from './git-actions';

/** Drag-and-drop of refs, commits and stashes (spec 04 §4.11, spec 05 §4.4). */

const MIME = 'application/x-githappens-ref';

/** A ref as a drag source / drop target (spec 05 §4.4). */
export function refTarget(r: RefInfo): DragSource & DropTarget {
  const kind = r.type === 'remote' ? 'remote' : r.type === 'tag' ? 'tag' : 'local';
  return { kind, name: r.shortName, sha: r.sha };
}

export function dragProps(source: DragSource) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(MIME, JSON.stringify(source));
      e.dataTransfer.effectAllowed = 'move';
      setDragSource(source); // dragover can't read the payload: hover prediction needs the source sha
    },
    onDragEnd: () => {
      setDragSource(null);
      endHoverPredict();
    },
  };
}

const readSource = (e: DragEvent): DragSource | null => {
  const raw = e.dataTransfer.getData(MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragSource;
  } catch {
    return null;
  }
};

/** Props for a drop target; highlights while a ref is dragged over it. */
export function dropProps(repoId: RepoId, target: DropTarget, hoverClass?: string) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (hoverClass) (e.currentTarget as HTMLElement).classList.add(hoverClass);
      // spec 08 §4.9: 500 ms over a target predicts conflicts (tooltip + warm cache for the drop menu)
      hoverPredict(repoId, e.currentTarget as HTMLElement, 'sha' in target ? target.sha : undefined);
    },
    onDragLeave: (e: DragEvent) => {
      if (hoverClass) (e.currentTarget as HTMLElement).classList.remove(hoverClass);
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) endHoverPredict();
    },
    onDrop: (e: DragEvent) => {
      if (hoverClass) (e.currentTarget as HTMLElement).classList.remove(hoverClass);
      endHoverPredict();
      const source = readSource(e);
      if (!source) return;
      e.preventDefault();
      e.stopPropagation();
      void showDropMenu(repoId, source, target, e.clientX, e.clientY);
    },
  };
}

const IN_PROGRESS: Partial<Record<RepoInfo['state'], 'merge' | 'rebase' | 'cherry-pick' | 'revert'>> = {
  merging: 'merge',
  rebasing: 'rebase',
  'rebasing-interactive': 'rebase',
  'cherry-picking': 'cherry-pick',
  reverting: 'revert',
};

const sourceRev = (s: DragSource): string => ('name' in s ? s.name : s.sha);

export async function showDropMenu(
  repoId: RepoId,
  source: DragSource,
  target: DropTarget,
  x: number,
  y: number,
): Promise<void> {
  const info = await invoke('git:repo:info', { repoId });
  const head = info.head.kind === 'branch' ? info.head.name : null;
  const targetRev = 'name' in target ? target.name : 'sha' in target ? target.sha : null;
  const [targetIsAncestorOfSource, headIsAncestorOfSource] = await Promise.all([
    targetRev
      ? invoke('git:isAncestor', { repoId, ancestor: targetRev, descendant: sourceRev(source) }).catch(
          () => false,
        )
      : false,
    info.head.sha
      ? invoke('git:isAncestor', { repoId, ancestor: 'HEAD', descendant: sourceRev(source) }).catch(
          () => false,
        )
      : false,
  ]);
  const branchDrop =
    (source.kind === 'local' || source.kind === 'remote') &&
    (target.kind === 'local' || target.kind === 'remote');
  const canCreatePr = branchDrop
    ? await intInvoke('provider:resolveRemotes', { repoId })
        .then((rs) => rs.some((r) => r.integrationKey))
        .catch(() => false)
    : false;
  // Rebase needs shared history: "No common ancestor" / "History is shallow" (spec 05 §4.4, §8)
  const relation =
    info.head.sha && target.kind !== 'remoteNode'
      ? await undoInvoke('branching:relation', {
          repoId,
          a: sourceRev(source),
          b: targetRev ?? 'HEAD',
        }).catch(() => null)
      : null;
  const actions = computeDropActions(source, target, {
    head,
    headSha: info.head.sha,
    inProgress: IN_PROGRESS[info.state] ?? null,
    targetIsAncestorOfSource,
    headIsAncestorOfSource,
    canCreatePr,
    noCommonAncestor: relation ? !relation.mergeBase : false,
    shallow: relation?.shallow ?? false,
  });

  // Conflict prediction for merge/rebase into HEAD (spec 08 §4.9): shared sha-keyed cache (views/merge),
  // usually already warm from the 500 ms drag hover. "Will conflict in N files" + hover list.
  const integrates = actions.find((a) => a.action?.type === 'merge' || a.action?.type === 'rebase');
  let prediction: Awaited<ReturnType<typeof predictCached>> = null;
  if (integrates && info.head.sha) {
    const other =
      integrates.action!.type === 'merge'
        ? integrates.action.source
        : (integrates.action as { onto: string }).onto;
    const otherSha =
      other === sourceRev(source)
        ? source.sha
        : 'sha' in target && (other === targetRev || other === target.sha)
          ? target.sha
          : null;
    prediction = otherSha
      ? await predictCached(repoId, info.head.sha, otherSha)
      : await invoke('git:conflict:predict', { repoId, ours: 'HEAD', theirs: other }).catch(() => null);
  }
  const hintTitle = conflictHintTitle(prediction);

  const items: MenuEntry[] = actions.map((a) => {
    const integrate = a.action?.type === 'merge' || a.action?.type === 'rebase';
    return {
      label: integrate ? withHint(a.label, prediction) : a.label,
      danger: a.danger,
      disabled: a.disabled || !a.action,
      title: integrate && hintTitle ? [a.title, hintTitle].filter(Boolean).join('\n\n') : a.title,
      onSelect: a.action ? () => void execute(repoId, a.action!) : undefined,
    };
  });
  useContextMenu.getState().show(x, y, items);
}

async function execute(repoId: RepoId, a: DoAction): Promise<void> {
  switch (a.type) {
    case 'merge':
      return a.mode === 'ask' ? mergeWithOptions(repoId, a.source) : merge(repoId, a.source);
    case 'rebase':
      return rebase(repoId, a.onto);
    case 'irebase':
      return interactiveRebase(repoId, a.upstream, a.label);
    case 'createPr':
      return openCreatePullRequest(repoId, { headBranch: a.head, baseBranch: a.base });
    case 'ff':
      return fastForward(repoId, a.branch, a.to);
    case 'reset':
      return reset(repoId, a.target, a.mode, a.label);
    case 'push':
      return pushTo(repoId, a.local, a.remote, a.remoteBranch, a.force);
    case 'pushNew':
      quiet(
        runOp(
          repoId,
          {
            type: 'push',
            localRef: a.local,
            remote: a.remote,
            remoteBranch: a.local,
            setUpstream: true,
            force: 'none',
          },
          { successToast: `Pushed ${a.local} to ${a.remote}` },
        ),
      );
      return;
    case 'pushTag':
      quiet(
        runOp(
          repoId,
          { type: 'tag.push', name: a.tag, remote: a.remote },
          { successToast: `Pushed tag ${a.tag}` },
        ),
      );
      return;
    case 'cherryPick':
      return cherryPick(repoId, [a.sha]);
    case 'stashApply':
      return stashApply(repoId, a.index, a.sha);
    case 'stashPop':
      return stashPop(repoId, a.index, a.sha);
    case 'abort': {
      const state = await invoke('git:repo:info', { repoId });
      const op =
        state.state === 'merging'
          ? 'merge.abort'
          : state.state.startsWith('rebasing')
            ? 'rebase.abort'
            : 'sequencer.abort';
      quiet(runOp(repoId, { type: op }));
      return;
    }
  }
}
