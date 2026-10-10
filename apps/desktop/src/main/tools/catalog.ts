import { TOOL_PRESETS } from '../../shared/settings/external-tools';

/**
 * Known external tools and where they live (spec 12 §6.10, spec 13 External Tools). Each tool is found by its
 * PATH names first, then by well-known install paths (`%VAR%`, `~` and one `*` per segment are expanded).
 */

export type OsKey = 'win32' | 'darwin' | 'linux';
export const osKey = (p: NodeJS.Platform): OsKey =>
  p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux';

/** How an editor takes a line number. */
export type LineStyle = 'goto' | 'colon' | 'jetbrains' | 'plain';

export interface ToolDef {
  id: string;
  label: string;
  /** Executable names looked up on PATH (per OS, or for all when `bins` is an array). */
  bins: string[] | Partial<Record<OsKey, string[]>>;
  /** Well-known install locations per OS. For macOS terminals these are `.app` bundles. */
  install?: Partial<Record<OsKey, string[]>>;
  /** Only offered on these platforms. */
  os?: OsKey[];
}

export interface EditorDef extends ToolDef {
  line: LineStyle;
}

const PF = ['%ProgramFiles%', '%ProgramFiles(x86)%'];
const pf = (rel: string): string[] => PF.map((d) => `${d}\\${rel}`);
const LAPP = (rel: string): string => `%LOCALAPPDATA%\\Programs\\${rel}`;
const macApp = (app: string, rel: string): string[] => [
  `/Applications/${app}/${rel}`,
  `~/Applications/${app}/${rel}`,
];
const toolbox = (script: string): Partial<Record<OsKey, string[]>> => ({
  win32: [`%LOCALAPPDATA%\\JetBrains\\Toolbox\\scripts\\${script}.cmd`],
  darwin: [`~/Library/Application Support/JetBrains/Toolbox/scripts/${script}`],
  linux: [`~/.local/share/JetBrains/Toolbox/scripts/${script}`],
});
const merge = (...xs: Partial<Record<OsKey, string[]>>[]): Partial<Record<OsKey, string[]>> => {
  const out: Partial<Record<OsKey, string[]>> = {};
  for (const x of xs) for (const k of Object.keys(x) as OsKey[]) out[k] = [...(out[k] ?? []), ...x[k]!];
  return out;
};

export const EDITORS: EditorDef[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    line: 'goto',
    bins: ['code'],
    install: {
      win32: [LAPP('Microsoft VS Code\\bin\\code.cmd'), ...pf('Microsoft VS Code\\bin\\code.cmd')],
      darwin: macApp('Visual Studio Code.app', 'Contents/Resources/app/bin/code'),
      linux: ['/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code'],
    },
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    line: 'goto',
    bins: ['code-insiders'],
    install: {
      win32: [
        LAPP('Microsoft VS Code Insiders\\bin\\code-insiders.cmd'),
        ...pf('Microsoft VS Code Insiders\\bin\\code-insiders.cmd'),
      ],
      darwin: macApp('Visual Studio Code - Insiders.app', 'Contents/Resources/app/bin/code'),
      linux: ['/usr/bin/code-insiders', '/snap/bin/code-insiders'],
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    line: 'goto',
    bins: ['cursor'],
    install: {
      win32: [LAPP('cursor\\resources\\app\\bin\\cursor.cmd')],
      darwin: macApp('Cursor.app', 'Contents/Resources/app/bin/cursor'),
      linux: ['/usr/bin/cursor', '/opt/cursor/cursor'],
    },
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    line: 'colon',
    bins: ['subl'],
    install: {
      win32: [...pf('Sublime Text\\subl.exe'), ...pf('Sublime Text 3\\subl.exe')],
      darwin: macApp('Sublime Text.app', 'Contents/SharedSupport/bin/subl'),
      linux: ['/usr/bin/subl', '/opt/sublime_text/sublime_text', '/snap/bin/subl'],
    },
  },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    line: 'jetbrains',
    bins: { win32: ['idea64', 'idea'], darwin: ['idea'], linux: ['idea', 'idea.sh'] },
    install: merge(toolbox('idea'), {
      win32: pf('JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe'),
      darwin: [
        ...macApp('IntelliJ IDEA.app', 'Contents/MacOS/idea'),
        ...macApp('IntelliJ IDEA CE.app', 'Contents/MacOS/idea'),
      ],
      linux: ['/snap/bin/intellij-idea-ultimate', '/snap/bin/intellij-idea-community'],
    }),
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    line: 'jetbrains',
    bins: { win32: ['webstorm64', 'webstorm'], darwin: ['webstorm'], linux: ['webstorm', 'webstorm.sh'] },
    install: merge(toolbox('webstorm'), {
      win32: pf('JetBrains\\WebStorm*\\bin\\webstorm64.exe'),
      darwin: macApp('WebStorm.app', 'Contents/MacOS/webstorm'),
      linux: ['/snap/bin/webstorm'],
    }),
  },
  {
    id: 'zed',
    label: 'Zed',
    line: 'colon',
    bins: { win32: ['zed'], darwin: ['zed'], linux: ['zed', 'zeditor'] },
    install: {
      win32: [LAPP('Zed\\bin\\zed.exe'), LAPP('Zed\\Zed.exe')],
      darwin: macApp('Zed.app', 'Contents/MacOS/cli'),
      linux: ['~/.local/bin/zed', '/usr/bin/zeditor'],
    },
  },
];

/** Terminals. macOS entries are app bundles launched with `open -a <bundle> <cwd>`. */
export const TERMINALS: ToolDef[] = [
  {
    id: 'windows-terminal',
    label: 'Windows Terminal',
    os: ['win32'],
    bins: ['wt'],
    install: { win32: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe'] },
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    os: ['win32'],
    bins: ['pwsh', 'powershell'],
    install: {
      win32: [
        '%ProgramFiles%\\PowerShell\\7\\pwsh.exe',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ],
    },
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    os: ['win32'],
    bins: ['cmd'],
    install: { win32: ['%ComSpec%', '%SystemRoot%\\System32\\cmd.exe'] },
  },
  {
    id: 'git-bash',
    label: 'Git Bash',
    os: ['win32'],
    bins: ['git-bash'],
    install: { win32: [...pf('Git\\git-bash.exe'), LAPP('Git\\git-bash.exe')] },
  },
  {
    id: 'terminal-app',
    label: 'Terminal.app',
    os: ['darwin'],
    bins: [],
    install: {
      darwin: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
    },
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    os: ['darwin'],
    bins: [],
    install: { darwin: ['/Applications/iTerm.app'] },
  },
  {
    id: 'warp',
    label: 'Warp',
    os: ['darwin', 'linux'],
    bins: { linux: ['warp-terminal'] },
    install: { darwin: ['/Applications/Warp.app'] },
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    os: ['darwin', 'linux'],
    bins: { linux: ['ghostty'] },
    install: { darwin: ['/Applications/Ghostty.app'] },
  },
  { id: 'gnome-terminal', label: 'GNOME Terminal', os: ['linux'], bins: ['gnome-terminal'] },
  { id: 'konsole', label: 'Konsole', os: ['linux'], bins: ['konsole'] },
  {
    id: 'kitty',
    label: 'kitty',
    os: ['darwin', 'linux'],
    bins: { linux: ['kitty'] },
    install: { darwin: ['/Applications/kitty.app'] },
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    os: ['darwin', 'linux'],
    bins: { linux: ['alacritty'] },
    install: { darwin: ['/Applications/Alacritty.app'] },
  },
  { id: 'xterm', label: 'xterm', os: ['linux'], bins: ['xterm'] },
];

/** Debian's alternatives entry; only used for the Linux "OS default" fallback. */
export const X_TERMINAL_EMULATOR: ToolDef = {
  id: 'x-terminal-emulator',
  label: 'Terminal',
  os: ['linux'],
  bins: ['x-terminal-emulator'],
};

/** "OS default" preference order (spec 12 §6.10). */
export const DEFAULT_TERMINAL_ORDER: Record<OsKey, string[]> = {
  win32: ['windows-terminal', 'powershell', 'cmd'],
  darwin: ['terminal-app'],
  linux: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'kitty', 'alacritty', 'ghostty', 'xterm'],
};

const editor = (id: string): EditorDef => EDITORS.find((e) => e.id === id)!;

/** Install locations of the diff/merge presets (exe names come from `TOOL_PRESETS`). */
const DIFF_INSTALL: Record<string, ToolDef['install']> = {
  vscode: editor('vscode').install,
  intellij: editor('intellij').install,
  beyondcompare: {
    win32: [...pf('Beyond Compare 5\\BComp.exe'), ...pf('Beyond Compare 4\\BComp.exe')],
    darwin: macApp('Beyond Compare.app', 'Contents/MacOS/bcomp'),
    linux: ['/usr/bin/bcompare'],
  },
  p4merge: {
    win32: pf('Perforce\\p4merge.exe'),
    darwin: macApp('p4merge.app', 'Contents/Resources/launchp4merge'),
  },
  kdiff3: {
    win32: [...pf('KDiff3\\kdiff3.exe'), ...pf('KDiff3\\bin\\kdiff3.exe')],
    darwin: macApp('kdiff3.app', 'Contents/MacOS/kdiff3'),
  },
  meld: {
    win32: [...pf('Meld\\Meld.exe'), LAPP('Meld\\Meld.exe')],
    darwin: macApp('Meld.app', 'Contents/MacOS/Meld'),
  },
  kaleidoscope: { darwin: ['/usr/local/bin/ksdiff', ...macApp('Kaleidoscope.app', 'Contents/MacOS/ksdiff')] },
  araxis: {
    win32: pf('Araxis\\Araxis Merge\\Compare.exe'),
    darwin: macApp('Araxis Merge.app', 'Contents/Utilities/compare'),
  },
  filemerge: { darwin: ['/usr/bin/opendiff'] },
  winmerge: { win32: [...pf('WinMerge\\WinMergeU.exe'), LAPP('WinMerge\\WinMergeU.exe')] },
};

const DIFF_EXTRA_BINS: Record<string, string[]> = {
  beyondcompare: ['bcomp', 'BComp'],
  intellij: ['idea64'],
};

/** Diff / merge presets (the `tools.diffTool` / `tools.mergeTool` enum values minus none/custom/git-config). */
export const DIFF_TOOLS: ToolDef[] = Object.entries(TOOL_PRESETS).map(([id, p]) => ({
  id,
  label: p.label,
  bins: [p.exe, ...(DIFF_EXTRA_BINS[id] ?? [])],
  install: DIFF_INSTALL[id],
  ...(id === 'filemerge' || id === 'kaleidoscope' ? { os: ['darwin'] as OsKey[] } : {}),
  ...(id === 'winmerge' ? { os: ['win32'] as OsKey[] } : {}),
}));

/** Editor line style for a custom executable, guessed from its file name. */
export function lineStyleForExe(exe: string): LineStyle {
  const base = exe
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|sh)$/, '');
  if (/^(code|code-insiders|codium|cursor|windsurf)$/.test(base)) return 'goto';
  if (
    /^(idea|idea64|webstorm|webstorm64|pycharm|pycharm64|goland|goland64|rider|rider64|clion|clion64|phpstorm|phpstorm64|rubymine|rubymine64)$/.test(
      base,
    )
  )
    return 'jetbrains';
  if (/^(subl|sublime_text|zed|zeditor|cli)$/.test(base)) return 'colon';
  return 'plain';
}
