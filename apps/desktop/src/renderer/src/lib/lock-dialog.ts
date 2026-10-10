import type { SerializedGitError } from '@githappens/git/types';

/** "3 min" / "45 s" for the lock dialog. */
function formatAge(sec: number): string {
  if (sec >= 3600) return `${Math.round(sec / 3600)} h`;
  if (sec >= 60) return `${Math.round(sec / 60)} min`;
  return `${sec} s`;
}

/**
 * Lock dialog text (spec 02 §4 "Lock dialog", §6.13 rule 3): which lock, how old, and whether it looks
 * stale (older than 60 s with no git process running in the repository).
 */
export function lockDialogText(details: SerializedGitError['details']): string {
  const lockPath = String(details?.lockPath ?? '');
  const name = lockPath.split(/[\\/]/).slice(-2).join('/') || 'index.lock';
  const age = Number(details?.ageSec ?? 0);
  const created = age > 0 ? `, created ${formatAge(age)} ago` : '';
  const stale = Number(details?.stale ?? 0) === 1;
  return stale
    ? `A git lock file exists (${name}${created}). No Git process seems to be using this repository, so the lock looks stale and can be deleted.`
    : `A git lock file exists (${name}${created}). Another Git process may be running. If no other Git tool is busy with this repository, the lock can be deleted.`;
}
