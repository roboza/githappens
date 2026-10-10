/**
 * External diff / merge tool command templates (spec 13 §4.2 External Tools, spec 08 §6.8).
 * Templates use `$BASE $LOCAL $REMOTE $MERGED`; values are substituted as separate argv
 * entries (never through a shell), so paths with spaces are safe.
 */

export type ToolVars = Partial<Record<'BASE' | 'LOCAL' | 'REMOTE' | 'MERGED', string>>;

export interface ToolPreset {
  label: string;
  /** Executable name looked up on PATH (or a well-known install path by the detector). */
  exe: string;
  diff?: string;
  merge?: string;
}

/** Built-in presets keyed by the `tools.diffTool` / `tools.mergeTool` enum values. */
export const TOOL_PRESETS: Record<string, ToolPreset> = {
  vscode: {
    label: 'VS Code',
    exe: 'code',
    diff: '--wait --diff $LOCAL $REMOTE',
    merge: '--wait --merge $REMOTE $LOCAL $BASE $MERGED',
  },
  beyondcompare: {
    label: 'Beyond Compare',
    exe: 'bcompare',
    diff: '$LOCAL $REMOTE',
    merge: '$LOCAL $REMOTE $BASE $MERGED',
  },
  p4merge: {
    label: 'P4Merge',
    exe: 'p4merge',
    diff: '$LOCAL $REMOTE',
    merge: '$BASE $LOCAL $REMOTE $MERGED',
  },
  kdiff3: {
    label: 'KDiff3',
    exe: 'kdiff3',
    diff: '$LOCAL $REMOTE',
    merge: '$BASE $LOCAL $REMOTE -o $MERGED',
  },
  meld: {
    label: 'Meld',
    exe: 'meld',
    diff: '$LOCAL $REMOTE',
    merge: '$LOCAL $BASE $REMOTE --output=$MERGED',
  },
  kaleidoscope: {
    label: 'Kaleidoscope',
    exe: 'ksdiff',
    diff: '--partial-changeset $LOCAL $REMOTE',
    merge: '--merge --output $MERGED --base $BASE -- $LOCAL $REMOTE',
  },
  araxis: {
    label: 'Araxis Merge',
    exe: 'compare',
    diff: '-wait $LOCAL $REMOTE',
    merge: '-wait -merge -3 $BASE $LOCAL $REMOTE $MERGED',
  },
  intellij: {
    label: 'IntelliJ IDEA',
    exe: 'idea',
    diff: 'diff $LOCAL $REMOTE',
    merge: 'merge $LOCAL $REMOTE $BASE $MERGED',
  },
  filemerge: {
    label: 'FileMerge',
    exe: 'opendiff',
    diff: '$LOCAL $REMOTE',
    merge: '$LOCAL $REMOTE -ancestor $BASE -merge $MERGED',
  },
  winmerge: {
    label: 'WinMerge',
    exe: 'WinMergeU',
    diff: '-u -e $LOCAL $REMOTE',
    merge: '-u -e -wr $LOCAL $BASE $REMOTE -o $MERGED',
  },
};

/** Split a command template into argv, honouring "double" and 'single' quotes. */
export function splitArgs(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Expand a template into argv. Tokens may be embedded (`--output=$MERGED`); unknown or missing
 * tokens throw so a misconfigured tool never runs with a literal `$BASE`.
 */
export function expandToolCommand(template: string, vars: ToolVars): string[] {
  return splitArgs(template).map((arg) =>
    arg.replace(/\$(BASE|LOCAL|REMOTE|MERGED)\b/g, (_m, name: keyof ToolVars) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`The command uses $${name}, which is not available here.`);
      return v;
    }),
  );
}

/** Tokens a template uses (for validation hints in Preferences). */
export function templateTokens(template: string): string[] {
  return [...new Set([...template.matchAll(/\$(BASE|LOCAL|REMOTE|MERGED)\b/g)].map((m) => m[1]!))];
}

/** git's built-in difftool / mergetool names for the presets (Strategy A fallback, spec 08 §6.8). */
export const GIT_TOOL_NAMES: Readonly<Record<string, string>> = {
  vscode: 'vscode',
  beyondcompare: 'bc',
  p4merge: 'p4merge',
  kdiff3: 'kdiff3',
  meld: 'meld',
  araxis: 'araxis',
  filemerge: 'opendiff',
  winmerge: 'winmerge',
};
