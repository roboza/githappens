import { create } from 'zustand';

import type { TerminalId } from '../../../../shared/ipc/terminal-contract';

/**
 * Cross-component terminal state: agent ptys bound to a terminal panel (by panel root) and
 * focus requests for them. Agent tabs outlive their panel (repo tab switches): the pty keeps
 * running in main and the panel re-attaches when it mounts again.
 */

export interface BoundSession {
  ptyId: TerminalId;
  label: string;
  cwd: string;
}

export interface FocusRequest {
  seq: number;
  root: string;
  ptyId: TerminalId;
}

/** "Open in terminal" for a folder (e.g. a worktree row): a new shell tab in the panel of `root`. */
export interface ShellRequest {
  seq: number;
  root: string;
  cwd: string;
}

interface TerminalStore {
  /** Agent sessions shown as tabs, keyed by `rootKey(panel cwd)`. */
  bound: Record<string, BoundSession[]>;
  requests: FocusRequest[];
  bind(root: string, s: BoundSession): void;
  unbind(ptyId: TerminalId): void;
  /** Ask the panel of `root` to show (and select) the tab of `ptyId`. */
  request(root: string, ptyId: TerminalId): void;
  consume(seqs: number[]): void;
  shellRequests: ShellRequest[];
  /** Ask the panel of `root` to open a new shell tab in `cwd`. */
  openShell(root: string, cwd: string): void;
  consumeShell(seqs: number[]): void;
}

/** Normalized panel key for a repo / worktree root. */
export const rootKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let seq = 0;

export const useTerminalStore = create<TerminalStore>((set) => ({
  bound: {},
  requests: [],
  bind(root, s) {
    const k = rootKey(root);
    set((st) => {
      const bound: Record<string, BoundSession[]> = {};
      for (const [r, list] of Object.entries(st.bound)) {
        const rest = list.filter((b) => b.ptyId !== s.ptyId);
        if (rest.length) bound[r] = rest;
      }
      bound[k] = [...(bound[k] ?? []), s];
      return { bound };
    });
  },
  unbind(ptyId) {
    set((st) => {
      const bound: Record<string, BoundSession[]> = {};
      for (const [r, list] of Object.entries(st.bound)) {
        const rest = list.filter((b) => b.ptyId !== ptyId);
        if (rest.length) bound[r] = rest;
      }
      return { bound };
    });
  },
  request(root, ptyId) {
    set((st) => ({ requests: [...st.requests, { seq: ++seq, root: rootKey(root), ptyId }] }));
  },
  consume(seqs) {
    if (!seqs.length) return;
    const drop = new Set(seqs);
    set((st) => ({ requests: st.requests.filter((r) => !drop.has(r.seq)) }));
  },
  shellRequests: [],
  openShell(root, cwd) {
    set((st) => ({ shellRequests: [...st.shellRequests, { seq: ++seq, root: rootKey(root), cwd }] }));
  },
  consumeShell(seqs) {
    if (!seqs.length) return;
    const drop = new Set(seqs);
    set((st) => ({ shellRequests: st.shellRequests.filter((r) => !drop.has(r.seq)) }));
  },
}));

/** Root key of the panel an agent pty is bound to, if any. */
export function boundRootOf(ptyId: TerminalId): string | null {
  for (const [r, list] of Object.entries(useTerminalStore.getState().bound)) {
    if (list.some((b) => b.ptyId === ptyId)) return r;
  }
  return null;
}
