import type { WorktreeInfo } from '@githappens/git/types';

import type { AgentKind, AgentSession, AgentStatus } from '../../../../shared/ipc/agents-contract';

/** Pure helpers for the Agent Sessions panel (spec 12 §4.12). */

export const AGENT_KIND_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'GitHub Copilot CLI',
  gemini: 'Gemini CLI',
  custom: 'Custom agent',
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  waiting: 'waiting for input',
  idle: 'idle',
  exited: 'exited',
};

const STATUS_ORDER: Record<AgentStatus, number> = { waiting: 0, running: 1, idle: 2, exited: 3 };

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && normPath(a) === normPath(b);

export const folderName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export function branchLabel(w: Pick<WorktreeInfo, 'branch' | 'detached'>): string {
  if (w.branch) return w.branch.replace(/^refs\/heads\//, '');
  return w.detached ? 'detached HEAD' : '';
}

export interface WorktreeGroup {
  /** Null for sessions outside every worktree of the repo. */
  worktree: WorktreeInfo | null;
  sessions: AgentSession[];
}

/** Waiting first (needs attention), then running / idle / exited; newest first within a status. */
export function sortSessions(list: AgentSession[]): AgentSession[] {
  return [...list].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.startedAt - a.startedAt,
  );
}

/**
 * One group per (non-bare) worktree, the current worktree first, then main, then by path;
 * sessions outside all worktrees go to a trailing `worktree: null` group (only if any).
 */
export function groupSessions(worktrees: WorktreeInfo[], sessions: AgentSession[]): WorktreeGroup[] {
  const wts = worktrees
    .filter((w) => !w.bare)
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        Number(b.isMain) - Number(a.isMain) ||
        a.path.localeCompare(b.path),
    );
  const groups: WorktreeGroup[] = wts.map((w) => ({ worktree: w, sessions: [] }));
  const other: AgentSession[] = [];
  for (const s of sessions) {
    const g = s.worktreePath ? groups.find((x) => samePath(x.worktree!.path, s.worktreePath)) : undefined;
    if (g) g.sessions.push(s);
    else other.push(s);
  }
  for (const g of groups) g.sessions = sortSessions(g.sessions);
  if (other.length) groups.push({ worktree: null, sessions: sortSessions(other) });
  return groups;
}

/** Counts per status for a compact summary, e.g. "1 waiting · 2 running". */
export function statusSummary(sessions: AgentSession[]): string {
  const counts = new Map<AgentStatus, number>();
  for (const s of sessions) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return (['waiting', 'running', 'idle', 'exited'] as const)
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${AGENT_STATUS_LABEL[k]}`)
    .join(' · ');
}

const isAbsolute = (p: string): boolean => /^([a-zA-Z]:[\\/]|[\\/])/.test(p);

/** Resolves a user-entered folder against the repo root (git resolves relative worktree paths there). */
export function resolveAgainst(root: string | null, p: string): string {
  const t = p.trim();
  if (isAbsolute(t) || !root) return t;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${t.replace(/^\.[\\/]/, '')}`;
}

/** Default folder for a new worktree: a sibling of the repo, `<repo>-<branch>`. */
export function defaultWorktreeFolder(repoRoot: string | null, branch: string): string {
  const parent = repoRoot ? repoRoot.replace(/[\\/][^\\/]+$/, '') : '';
  return `${parent}${parent ? '/' : ''}${folderName(repoRoot ?? 'repo')}-${branch.replace(/[\\/]/g, '-')}`;
}
