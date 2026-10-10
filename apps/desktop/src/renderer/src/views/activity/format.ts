import type { CommandLogEntry } from '@githappens/git/types';

/** `git <argv>` as a readable (not shell-safe) line; argv is already redacted by main. */
export function formatCommandLine(argv: string[]): string {
  return ['git', ...argv].map((a) => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');
}

/** Subcommand for filtering/grouping (skips `-c k=v` / `-C dir`). */
export function subcommand(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return '';
}

export type ActivityFilter = 'ops' | 'all' | 'failed';

export function filterEntries(
  entries: CommandLogEntry[],
  filter: ActivityFilter,
  text = '',
): CommandLogEntry[] {
  const q = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter === 'ops' && !e.opId) return false;
    if (filter === 'failed' && e.exitCode === 0) return false;
    return !q || formatCommandLine(e.argv).toLowerCase().includes(q) || e.stderr.toLowerCase().includes(q);
  });
}
