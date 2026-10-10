/** Group effective bindings by command category (pure helper, exported for tests). */
export function shortcutRows(
  commands: readonly { id: string; title: string; category: string }[],
  resolved: readonly { command: string; key: string }[],
  filter: string,
  format: (chord: string) => string,
): { category: string; rows: { id: string; title: string; keys: string[] }[] }[] {
  const keysOf = new Map<string, string[]>();
  for (const b of resolved) keysOf.set(b.command, [...(keysOf.get(b.command) ?? []), format(b.key)]);
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, { id: string; title: string; keys: string[] }[]>();
  for (const c of commands) {
    const keys = keysOf.get(c.id);
    if (!keys?.length) continue;
    if (q && !`${c.title} ${c.category} ${keys.join(' ')}`.toLowerCase().includes(q)) continue;
    groups.set(c.category, [...(groups.get(c.category) ?? []), { id: c.id, title: c.title, keys }]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, rows]) => ({ category, rows: rows.sort((a, b) => a.title.localeCompare(b.title)) }));
}
