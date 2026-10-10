import type { ConflictFile, ConflictStage } from '../types';

/**
 * `git ls-files -u -z` (spec 02 §6.11 "Conflicts"): `<mode> <sha> <stage>\t<path>\0` per stage, grouped
 * by path; stage 1/2/3 = base/ours/theirs. Paths keep their order of first appearance.
 */
export function parseLsFilesUnmerged(text: string): ConflictFile[] {
  const byPath = new Map<string, ConflictFile>();
  for (const rec of text.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/s.exec(rec);
    if (!m) continue;
    const [, mode, sha, stage, path] = m;
    let file = byPath.get(path!);
    if (!file) byPath.set(path!, (file = { path: path!, stages: {} }));
    const s: ConflictStage = { mode: mode!, sha: sha! };
    if (stage === '1') file.stages.base = s;
    else if (stage === '2') file.stages.ours = s;
    else file.stages.theirs = s;
  }
  return [...byPath.values()];
}
