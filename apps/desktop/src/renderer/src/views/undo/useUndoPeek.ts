import type { UndoPeek } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { MouseEvent } from 'react';

import { useContextMenu } from '../../components/ContextMenu';
import { invoke, on } from '../../lib/api';
import { onUndoEvent } from './api';
import { undoHistoryMenu } from './undo-actions';

export const undoPeekKey = (repoId: RepoId) => ['undoPeek', repoId] as const;

/**
 * `git:undo:peek` kept fresh by the `undo:changed` event (spec 05 §5) instead of polling on every refs/status
 * refresh. The event carries labels only, so it just invalidates the query.
 */
export function useUndoPeek(repoId: RepoId): UseQueryResult<UndoPeek> {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = (): void => void qc.invalidateQueries({ queryKey: undoPeekKey(repoId) });
    const offUndo = onUndoEvent('undo:changed', (e) => {
      if (e.repoId === repoId) refresh();
    });
    // settled ops of this repo (covers a shell without the `undo:changed` wiring)
    const offOps = on('git:op:state', (e) => {
      if (e.repoId === repoId && (e.state === 'succeeded' || e.state === 'failed')) refresh();
    });
    return () => {
      offUndo();
      offOps();
    };
  }, [qc, repoId]);
  return useQuery({
    queryKey: undoPeekKey(repoId),
    queryFn: () => invoke('git:undo:peek', { repoId }),
    staleTime: 30_000,
  });
}

/** Toolbar "Undo ▾" (spec 05 §4.7 History popover): opens the history menu under the button. */
export function openUndoHistory(repoId: RepoId, e?: MouseEvent): void {
  const r = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
  void undoHistoryMenu(repoId).then((items) =>
    useContextMenu.getState().show(r?.left ?? 200, (r?.bottom ?? 60) + 2, items),
  );
}
