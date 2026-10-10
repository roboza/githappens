import type { GitOperationType } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';

import { on } from '../lib/api';

export interface RunningOp {
  opId: string;
  repoId: RepoId;
  type: GitOperationType;
  label: string;
  state: 'queued' | 'running';
  progress?: { phase: string; overall: number | null; text: string };
}

interface OpsStore {
  ops: Record<string, RunningOp>;
}

/** Live view of queued/running operations (spec 02 `git:op:state` / `git:progress`). */
export const useOpsStore = create<OpsStore>(() => ({ ops: {} }));

on('git:op:state', (e) => {
  useOpsStore.setState((s) => {
    const ops = { ...s.ops };
    if (e.state === 'queued' || e.state === 'running') {
      ops[e.opId] = {
        ...ops[e.opId],
        opId: e.opId,
        repoId: e.repoId,
        type: e.type,
        label: e.label,
        state: e.state,
      };
    } else delete ops[e.opId];
    return { ops };
  });
});

on('git:progress', (p) => {
  useOpsStore.setState((s) => {
    const cur = s.ops[p.opId];
    if (!cur) return s;
    return {
      ops: { ...s.ops, [p.opId]: { ...cur, progress: { phase: p.phase, overall: p.overall, text: p.text } } },
    };
  });
});

export function useRepoOps(repoId: RepoId | undefined): RunningOp[] {
  const ops = useOpsStore((s) => s.ops);
  return Object.values(ops).filter((o) => o.repoId === repoId);
}

export function useIsRunning(repoId: RepoId, types: GitOperationType[]): boolean {
  return useOpsStore((s) => Object.values(s.ops).some((o) => o.repoId === repoId && types.includes(o.type)));
}
