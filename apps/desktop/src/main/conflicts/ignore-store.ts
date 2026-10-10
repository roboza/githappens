import fs from 'node:fs';
import path from 'node:path';

import type { ConflictIgnoreRule, ConflictIgnoreScope } from '../../shared/ipc/conflicts-contract';

/** Per-repo ignore rules, persisted next to the repo's git config (`<commonDir>/githappens-conflicts.json`). */
export const IGNORE_FILE = 'githappens-conflicts.json';

const SCOPES = new Set<ConflictIgnoreScope>(['file', 'branch', 'target']);

const active = (r: ConflictIgnoreRule, now: number): boolean => !r.until || Date.parse(r.until) > now;

export class IgnoreStore {
  private readonly cache = new Map<string, ConflictIgnoreRule[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private file(commonDir: string): string {
    return path.join(commonDir, IGNORE_FILE);
  }

  /** Active rules (expired ones are dropped on the next write). */
  list(commonDir: string): ConflictIgnoreRule[] {
    let rules = this.cache.get(commonDir);
    if (!rules) {
      rules = [];
      try {
        const doc = JSON.parse(fs.readFileSync(this.file(commonDir), 'utf8')) as { ignores?: unknown };
        if (Array.isArray(doc.ignores)) {
          for (const r of doc.ignores as Partial<ConflictIgnoreRule>[]) {
            if (r && SCOPES.has(r.scope!) && typeof r.value === 'string') {
              rules.push({
                scope: r.scope!,
                value: r.value,
                ...(typeof r.until === 'string' ? { until: r.until } : {}),
              });
            }
          }
        }
      } catch {
        /* missing or unreadable → no rules */
      }
      this.cache.set(commonDir, rules);
    }
    const now = this.now();
    return rules.filter((r) => active(r, now));
  }

  set(commonDir: string, rule: ConflictIgnoreRule, remove = false): ConflictIgnoreRule[] {
    if (!SCOPES.has(rule.scope) || typeof rule.value !== 'string' || !rule.value) {
      throw new Error('Invalid ignore rule');
    }
    if (rule.until !== undefined && Number.isNaN(Date.parse(rule.until))) throw new Error('Invalid until');
    const next = this.list(commonDir).filter((r) => !(r.scope === rule.scope && r.value === rule.value));
    if (!remove)
      next.push({ scope: rule.scope, value: rule.value, ...(rule.until ? { until: rule.until } : {}) });
    const tmp = `${this.file(commonDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ignores: next }, null, 2));
    fs.renameSync(tmp, this.file(commonDir));
    this.cache.set(commonDir, next);
    return next;
  }

  matches(commonDir: string, scope: ConflictIgnoreScope, value: string): boolean {
    return this.list(commonDir).some((r) => r.scope === scope && r.value === value);
  }
}
