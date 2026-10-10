import type { DetectedTool, DetectedTools } from '../../shared/ipc/tools-contract';
import { DIFF_TOOLS, EDITORS, osKey, TERMINALS, X_TERMINAL_EMULATOR, type ToolDef } from './catalog';
import { expandGlob, expandPath, findExe, type ToolEnv } from './env';

/** Where a tool lives: PATH names first (what the user's shell would run), then known install paths. */
export function locate(def: ToolDef, e: ToolEnv): Pick<DetectedTool, 'path' | 'source'> {
  const os = osKey(e.platform);
  if (def.os && !def.os.includes(os)) return { path: null, source: null };
  const bins = Array.isArray(def.bins) ? def.bins : (def.bins[os] ?? []);
  for (const b of bins) {
    const hit = findExe(b, e);
    if (hit) return { path: hit, source: 'path' };
  }
  for (const raw of def.install?.[os] ?? []) {
    const p = expandPath(raw, e);
    if (!p) continue;
    const matches = expandGlob(p, e).reverse();
    // macOS terminals are app bundles (directories); everything else must be a file.
    const hit = matches.find((m) => (/\.app$/i.test(m) ? e.isDir(m) : e.isFile(m)));
    if (hit) return { path: hit, source: 'install' };
  }
  return { path: null, source: null };
}

const row = (def: ToolDef, e: ToolEnv): DetectedTool => ({ id: def.id, label: def.label, ...locate(def, e) });

/** Scan every known editor, terminal and diff/merge tool for this platform. */
export function detectTools(e: ToolEnv, now = Date.now()): DetectedTools {
  const os = osKey(e.platform);
  const forOs = (d: ToolDef): boolean => !d.os || d.os.includes(os);
  return {
    platform: e.platform,
    editors: EDITORS.filter(forOs).map((d) => row(d, e)),
    terminals: TERMINALS.filter(forOs).map((d) => row(d, e)),
    diffTools: DIFF_TOOLS.filter(forOs).map((d) => row(d, e)),
    scannedAt: now,
  };
}

/** Cached detection (spec 13 "detected list"); `refresh` re-scans after the user installs something. */
export class ToolDetector {
  private cache: DetectedTools | null = null;
  constructor(private readonly env: ToolEnv) {}

  detect(refresh = false): DetectedTools {
    if (!this.cache || refresh) this.cache = detectTools(this.env);
    return this.cache;
  }

  /** One tool's path from the cached scan (falls back to a fresh lookup for ids not in the lists). */
  find(kind: 'editor' | 'terminal' | 'diff', id: string): string | null {
    const d = this.detect();
    const list = kind === 'editor' ? d.editors : kind === 'terminal' ? d.terminals : d.diffTools;
    const hit = list.find((t) => t.id === id);
    if (hit) return hit.path;
    if (id === X_TERMINAL_EMULATOR.id) return locate(X_TERMINAL_EMULATOR, this.env).path;
    return null;
  }
}
