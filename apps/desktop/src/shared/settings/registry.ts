import { z } from 'zod';

import { AI_EFFORTS, AI_FEATURE_GROUPS } from '../ipc/ai-contract';

/**
 * Settings registry (spec 13 §5.2). One entry per setting drives validation,
 * defaults, the Preferences UI (generic `SettingRow`), search and the JSON schema.
 *
 * Settings whose consumer has not shipped yet are flagged `planned: true`; the
 * Preferences UI shows them with a "Not applied yet" badge (honest UI) and the
 * descriptor's description says so.
 */

export type SettingScope = 'app' | 'profile' | 'repo' | 'gitGlobal' | 'gitLocal';

/** Preferences sections, in sidebar order (spec 13 §4.1). */
export const SETTINGS_SECTIONS = [
  'General',
  'Profiles',
  'Git',
  'UI Customization',
  'Notifications',
  'Themes',
  'Editor & Diff',
  'In-App Terminal',
  'External Tools',
  'Commit Signing',
  'SSH',
  'Network',
  'Integrations',
  'AI',
  'Workspaces',
  'Account',
  'Keybindings',
  'Experimental',
  'Advanced',
  'About',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingDescriptor {
  key: string;
  scope: SettingScope;
  section: SettingsSection;
  /** Optional sub-heading inside a section. */
  group?: string;
  title: string;
  description: string;
  /** `list` = string[] edited one entry per line. */
  type: 'boolean' | 'number' | 'string' | 'enum' | 'path' | 'color' | 'font' | 'object' | 'list';
  default: unknown;
  enum?: unknown[];
  /** Display labels for enum values. */
  enumLabels?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  /** `path` settings: what the picker selects. */
  pathKind?: 'file' | 'directory';
  keywords?: string[];
  requiresRestart?: boolean;
  platforms?: NodeJS.Platform[];
  /** Stored, but no feature reads it yet. */
  planned?: boolean;
  /** Value is written to git config by an explicit action (Commit Signing → Apply). */
  gitConfigKey?: string;
}

type DescriptorExtras = Omit<SettingDescriptor, 'key' | 'default' | 'enum' | 'min' | 'max'>;

interface Def<S extends z.ZodType> extends DescriptorExtras {
  schema: S;
  default: z.infer<S>;
}

const def = <S extends z.ZodType>(d: Def<S>): Def<S> => d;

const gitExecutable = z.union([z.literal('bundled'), z.literal('system'), z.string().min(1)]);
const optionalPath = z.string().max(4096);
const commandTemplate = z.string().max(4096);

const MERGE_TOOLS = [
  'none',
  'git-config',
  'vscode',
  'beyondcompare',
  'p4merge',
  'kdiff3',
  'meld',
  'kaleidoscope',
  'araxis',
  'intellij',
  'filemerge',
  'winmerge',
  'custom',
] as const;
const TOOL_LABELS: Record<(typeof MERGE_TOOLS)[number], string> = {
  none: 'None (built-in)',
  'git-config': 'Git config default (git difftool / mergetool)',
  vscode: 'VS Code',
  beyondcompare: 'Beyond Compare',
  p4merge: 'P4Merge',
  kdiff3: 'KDiff3',
  meld: 'Meld',
  kaleidoscope: 'Kaleidoscope',
  araxis: 'Araxis Merge',
  intellij: 'IntelliJ IDEA',
  filemerge: 'FileMerge (opendiff)',
  winmerge: 'WinMerge',
  custom: 'Custom command',
};

const EDITORS = [
  'none',
  'vscode',
  'vscode-insiders',
  'cursor',
  'sublime',
  'intellij',
  'webstorm',
  'zed',
  'custom',
] as const;

const TERMINALS = [
  'os',
  'windows-terminal',
  'powershell',
  'cmd',
  'git-bash',
  'terminal-app',
  'iterm2',
  'gnome-terminal',
  'konsole',
  'warp',
  'ghostty',
  'kitty',
  'alacritty',
  'xterm',
  'custom',
] as const;

export const SETTINGS = {
  // =========================================================================================
  // app scope (app.json)
  // =========================================================================================
  'updates.channel': def({
    scope: 'app',
    section: 'General',
    group: 'Updates',
    title: 'Update channel',
    description: 'Stable receives tested releases; Preview receives early builds.',
    type: 'enum',
    schema: z.enum(['stable', 'preview']),
    default: 'stable',
    enumLabels: { stable: 'Stable', preview: 'Preview' },
  }),
  'updates.autoDownload': def({
    scope: 'app',
    section: 'General',
    group: 'Updates',
    title: 'Automatically download updates',
    description: 'Download updates in the background and prompt to restart.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),

  // =========================================================================================
  // General
  // =========================================================================================
  'general.autoFetchInterval': def({
    scope: 'profile',
    section: 'General',
    title: 'Auto-fetch interval',
    description: 'How often to fetch remotes in the background. 0 disables auto-fetch.',
    type: 'number',
    unit: 'min',
    schema: z.number().int().min(0).max(60),
    default: 1,
    keywords: ['fetch', 'remote', 'background'],
  }),
  'general.autoPrune': def({
    scope: 'profile',
    section: 'General',
    title: 'Prune on fetch',
    description: 'Remove remote-tracking branches that no longer exist on the remote.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['fetch', 'prune'],
  }),
  'general.rememberTabs': def({
    scope: 'profile',
    section: 'General',
    title: 'Remember open tabs',
    description: 'Reopen the repositories that were open when the app was closed.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'general.defaultBranchName': def({
    scope: 'profile',
    section: 'General',
    title: 'Default branch name',
    description: 'Initial branch name for newly initialized repositories.',
    type: 'string',
    schema: z
      .string()
      .min(1)
      .regex(/^[^\s~^:?*[\\]+$/, 'Not a valid branch name'),
    default: 'main',
    keywords: ['init', 'main', 'master'],
  }),
  'general.defaultCloneDirectory': def({
    scope: 'profile',
    section: 'General',
    title: 'Default clone directory',
    description: 'Folder suggested when cloning a repository. Empty remembers the last folder used.',
    type: 'path',
    pathKind: 'directory',
    schema: optionalPath,
    default: '',
    keywords: ['clone', 'folder'],
  }),
  'general.stashIncludeUntracked': def({
    scope: 'profile',
    section: 'General',
    title: 'Include untracked files when stashing',
    description: 'The Stash button also stashes new, untracked files.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'general.autoUpdateSubmodules': def({
    scope: 'profile',
    section: 'General',
    title: 'Keep submodules up to date',
    description: 'Update submodules automatically after checkout, pull and merge.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'general.deleteOrigFiles': def({
    scope: 'profile',
    section: 'General',
    title: 'Delete .orig files after merge',
    description: 'Remove the backup files merge tools leave behind.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'general.showAllCommits': def({
    scope: 'profile',
    section: 'General',
    group: 'Commit graph',
    title: 'Show all commits in graph',
    description: 'Load the whole history instead of a first page.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'general.initialCommitCount': def({
    scope: 'profile',
    section: 'General',
    group: 'Commit graph',
    title: 'Commits loaded initially',
    description: 'Number of commits loaded when a repository opens.',
    type: 'number',
    step: 500,
    schema: z.number().int().min(500).max(100000),
    default: 2000,
  }),
  'general.lazyLoadCommits': def({
    scope: 'profile',
    section: 'General',
    group: 'Commit graph',
    title: 'Load more commits on scroll',
    description: 'Fetch further history when scrolling near the end of the graph.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'general.extendedLogging': def({
    scope: 'profile',
    section: 'General',
    title: 'Extended logging',
    description:
      'Write detailed diagnostics (every git command, warnings) to logs/main.log. Open the folder from About.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    keywords: ['debug', 'logs'],
  }),

  // =========================================================================================
  // Git
  // =========================================================================================
  'git.executable': def({
    scope: 'profile',
    section: 'Git',
    title: 'Git executable',
    description: 'Use the bundled Git, the system Git found on PATH, or a specific git binary.',
    type: 'string',
    schema: gitExecutable,
    default: 'bundled',
    keywords: ['git', 'binary', 'path', 'system'],
  }),
  'git.pullMode': def({
    scope: 'profile',
    section: 'Git',
    group: 'Pull & push',
    title: 'Default pull',
    description:
      'What the Pull button does: fast-forward if possible (else merge), fast-forward only, rebase, or always merge.',
    type: 'enum',
    schema: z.enum(['ff-if-possible', 'ff-only', 'rebase', 'merge-no-ff']),
    default: 'ff-if-possible',
    enumLabels: {
      'ff-if-possible': 'Fast-forward if possible',
      'ff-only': 'Fast-forward only',
      rebase: 'Rebase',
      'merge-no-ff': 'Always create a merge commit',
    },
  }),
  'git.pullRebaseMerges': def({
    scope: 'profile',
    section: 'Git',
    group: 'Pull & push',
    title: 'Preserve merges when pulling with rebase',
    description: 'Pass --rebase-merges when the pull mode is rebase.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'git.pushFollowTags': def({
    scope: 'profile',
    section: 'Git',
    group: 'Pull & push',
    title: 'Push tags with branches',
    description: 'Push annotated tags reachable from the pushed commits (--follow-tags).',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'git.useCredentialHelpers': def({
    scope: 'profile',
    section: 'Git',
    group: 'Pull & push',
    title: 'Use Git credential helpers',
    description: 'Let configured credential helpers answer before GitHappens prompts.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['password', 'credential manager'],
  }),
  'git.mergeBehavior': def({
    scope: 'profile',
    section: 'Git',
    group: 'Merge & reset',
    title: 'Merge behavior',
    description:
      'What "Merge X into Y" does: fast-forward when possible, always create a merge commit, fast-forward only, or squash (stage the result and commit it yourself).',
    type: 'enum',
    schema: z.enum(['default', 'no-ff', 'ff-only', 'squash']),
    default: 'default',
    enumLabels: {
      default: 'Fast-forward if possible',
      'no-ff': 'Always create a merge commit',
      'ff-only': 'Fast-forward only',
      squash: 'Squash',
    },
    keywords: ['merge', 'squash', 'no-ff', 'fast-forward'],
  }),
  'git.confirmHardReset': def({
    scope: 'profile',
    section: 'Git',
    group: 'Merge & reset',
    title: 'Confirm hard resets',
    description: 'Ask before a hard reset discards uncommitted changes (it can still be undone).',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['reset', 'hard', 'confirm', 'discard'],
  }),
  'checkout.autostash': def({
    scope: 'profile',
    section: 'Git',
    group: 'Checkout',
    title: 'Stash changes on checkout',
    description: 'What to do with uncommitted changes that would block a checkout.',
    type: 'enum',
    schema: z.enum(['ask', 'always', 'never']),
    default: 'ask',
    enumLabels: { ask: 'Ask', always: 'Always stash', never: 'Never' },
  }),
  'checkout.autoPopStash': def({
    scope: 'profile',
    section: 'Git',
    group: 'Checkout',
    title: 'Pop the auto-stash after checkout',
    description: 'Re-apply the stash created for a checkout once it completes.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'commit.autoApplyTemplate': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit',
    title: 'Apply the commit template automatically',
    description:
      'Fill an empty commit message with the template (commit.template, or the one saved with "Save as template").',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['template', 'message'],
  }),
  'commit.stripComments': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit',
    title: 'Strip # comment lines from commit messages',
    description:
      'Commit with --cleanup=strip (template comments are removed); off keeps them (--cleanup=whitespace).',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['cleanup', 'template'],
  }),
  'commit.stickyCoAuthors': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit',
    title: 'Keep co-authors after committing',
    description: 'Co-authors stay in the composer for the next commit instead of being cleared.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    keywords: ['co-author', 'pair'],
  }),
  'commit.rememberSkipHooks': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit',
    title: 'Remember "Skip hooks" between commits',
    description: 'Otherwise the Skip hooks checkbox resets after every commit.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    keywords: ['no-verify', 'hooks'],
  }),
  'graph.order': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit graph',
    title: 'Commit order',
    description: 'Order commits by date or topologically.',
    type: 'enum',
    schema: z.enum(['date', 'topo']),
    default: 'topo',
    enumLabels: { date: 'Date', topo: 'Topological' },
  }),
  'graph.maintainCommitGraph': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit graph',
    title: 'Maintain commit-graph file',
    description:
      'Write the commit-graph file in the background for large repositories to speed up the graph.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'graph.convergenceReuse': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit graph',
    title: 'Reuse layout on refresh',
    description: 'Keep lane assignments stable when the graph refreshes (advanced).',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'graph.conflictBadges': def({
    scope: 'profile',
    section: 'Git',
    group: 'Commit graph',
    title: 'Conflict warnings on branch labels',
    description:
      'Show a ⚠ on branch labels that would conflict when merged into the checked-out branch (git merge-tree, computed lazily).',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    keywords: ['conflict prediction', 'merge-tree'],
  }),

  // =========================================================================================
  // UI Customization
  // =========================================================================================
  'ui.zoom': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Zoom',
    description: 'Interface zoom factor (Ctrl+= / Ctrl+- / Ctrl+0).',
    type: 'number',
    step: 0.1,
    schema: z.number().min(0.5).max(3),
    default: 1,
    keywords: ['font size', 'scale'],
  }),
  'ui.dateFormat': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Date format',
    description: 'How commit dates are displayed.',
    type: 'enum',
    schema: z.enum(['relative', 'short', 'long', 'iso']),
    default: 'relative',
    enumLabels: { relative: 'Relative (3 days ago)', short: 'Short', long: 'Long', iso: 'ISO 8601' },
    keywords: ['time'],
  }),
  'ui.dateLocale': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Date locale',
    description: 'BCP-47 locale for dates, e.g. en-GB. "system" follows the OS.',
    type: 'string',
    schema: z.string().min(1).max(35),
    default: 'system',
  }),
  'ui.hour12': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Clock',
    description: '12- or 24-hour times.',
    type: 'enum',
    schema: z.enum(['locale', '12', '24']),
    default: 'locale',
    enumLabels: { locale: 'Per locale', '12': '12-hour', '24': '24-hour' },
  }),
  'ui.notificationLocation': def({
    scope: 'profile',
    section: 'Notifications',
    title: 'Notification location',
    description: 'Where toast notifications appear.',
    type: 'enum',
    schema: z.enum(['bottom-left', 'bottom-right', 'top-left', 'top-right']),
    default: 'bottom-left',
    enumLabels: {
      'bottom-left': 'Bottom left',
      'bottom-right': 'Bottom right',
      'top-left': 'Top left',
      'top-right': 'Top right',
    },
    keywords: ['toast'],
  }),
  'ui.toolbarLabels': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Show toolbar labels',
    description: 'Show text under the toolbar buttons.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'ui.groupWorktreeTabs': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Group worktree tabs',
    description: 'Show tabs of the same repository and its worktrees next to each other, bracketed together.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['tabs', 'worktree'],
  }),
  'ui.reduceMotion': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Reduce motion',
    description: 'Disable animations. "Follow OS" uses the system accessibility setting.',
    type: 'enum',
    schema: z.enum(['os', 'on', 'off']),
    default: 'os',
    enumLabels: { os: 'Follow OS', on: 'On', off: 'Off' },
    keywords: ['animation', 'accessibility'],
  }),
  'ui.authorDisplay': def({
    scope: 'profile',
    section: 'UI Customization',
    group: 'Commit graph',
    title: 'Author display',
    description: 'Show author avatars or initials in the graph.',
    type: 'enum',
    schema: z.enum(['avatar', 'initials']),
    default: 'avatar',
    enumLabels: { avatar: 'Avatars', initials: 'Initials' },
  }),
  'ui.useGravatar': def({
    scope: 'profile',
    section: 'UI Customization',
    group: 'Commit graph',
    title: 'Use Gravatar',
    description: 'Fetch avatars from gravatar.com using a hash of the author email.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['avatar', 'privacy'],
  }),
  'ui.graphHoverHighlight': def({
    scope: 'profile',
    section: 'UI Customization',
    group: 'Commit graph',
    title: 'Highlight related commits on hover',
    description: 'Dim unrelated rows while hovering a branch label.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'ui.graphRowHeight': def({
    scope: 'profile',
    section: 'UI Customization',
    group: 'Commit graph',
    title: 'Row density',
    description: 'Normal (28px) or compact (22px) graph rows.',
    type: 'enum',
    schema: z.enum(['normal', 'compact']),
    default: 'normal',
    enumLabels: { normal: 'Normal', compact: 'Compact' },
  }),
  'ui.graphEdgeStyle': def({
    scope: 'profile',
    section: 'UI Customization',
    group: 'Commit graph',
    title: 'Edge style',
    description: 'Shape of the lines connecting commits.',
    type: 'enum',
    schema: z.enum(['rounded', 'bezier']),
    default: 'rounded',
    enumLabels: { rounded: 'Rounded', bezier: 'Bezier' },
  }),
  'notifications.desktop': def({
    scope: 'profile',
    section: 'Notifications',
    title: 'Desktop notifications',
    description: 'Show OS notifications when operations finish or fail while the window is not focused.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'notifications.autoFetchErrors': def({
    scope: 'profile',
    section: 'Notifications',
    title: 'Show auto-fetch errors',
    description: 'Show a toast (and an OS notification when unfocused) every time a background fetch fails.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'notifications.prEvents': def({
    scope: 'profile',
    section: 'Notifications',
    title: 'Pull request events',
    description: 'Notify when a pull request needs your review, is approved, or its checks fail.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['launchpad', 'review', 'pr', 'approved', 'checks'],
  }),
  'experimental.flags': def({
    scope: 'app',
    section: 'Experimental',
    title: 'Experimental flags',
    description: 'Enabled experiments, one id per line. Known experiments have their own toggles above.',
    type: 'list',
    schema: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).max(64),
    default: [],
    keywords: ['experiment', 'feature flag', 'preview'],
  }),

  // =========================================================================================
  // Themes
  // =========================================================================================
  'ui.theme': def({
    scope: 'profile',
    section: 'Themes',
    title: 'Theme',
    description: 'Color theme used when not following the OS.',
    type: 'string',
    schema: z.string().min(1),
    default: 'builtin:dark',
  }),
  'ui.themeFollowOs': def({
    scope: 'profile',
    section: 'Themes',
    title: 'Follow OS light/dark mode',
    description: 'Switch between the light and dark theme below with the operating system.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'ui.themeLight': def({
    scope: 'profile',
    section: 'Themes',
    title: 'Light theme',
    description: 'Theme used when following the OS and the OS is in light mode.',
    type: 'string',
    schema: z.string().min(1),
    default: 'builtin:light',
  }),
  'ui.themeDark': def({
    scope: 'profile',
    section: 'Themes',
    title: 'Dark theme',
    description: 'Theme used when following the OS and the OS is in dark mode.',
    type: 'string',
    schema: z.string().min(1),
    default: 'builtin:dark',
  }),

  // =========================================================================================
  // Editor & Diff
  // =========================================================================================
  'editor.fontFamily': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Font family',
    description: 'Monospace font stack for diffs and the file editor.',
    type: 'font',
    schema: z.string().min(1).max(500),
    default: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  }),
  'editor.fontSize': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Font size',
    description: 'Font size for diffs and the file editor.',
    type: 'number',
    unit: 'px',
    schema: z.number().int().min(8).max(32),
    default: 12,
  }),
  'editor.tabSize': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Tab size',
    description: 'Width of a tab character in diffs and the editor.',
    type: 'number',
    schema: z.number().int().min(1).max(16),
    default: 4,
  }),
  'editor.wordWrap': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Word wrap',
    description: 'Wrap long lines in diffs and the file editor.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'editor.lineNumbers': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Line numbers',
    description: 'Show line numbers in diffs and the file editor.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'editor.syntaxHighlighting': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Syntax highlighting',
    description: 'Colorize code by language.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'editor.renderWhitespace': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Render whitespace',
    description: 'Show spaces and tabs as visible markers.',
    type: 'enum',
    schema: z.enum(['none', 'boundary', 'all']),
    default: 'none',
    enumLabels: { none: 'None', boundary: 'Boundary', all: 'All' },
  }),
  'editor.showEol': def({
    scope: 'profile',
    section: 'Editor & Diff',
    title: 'Show end-of-line characters',
    description: 'Mark CRLF / LF line endings.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'diff.defaultView': def({
    scope: 'profile',
    section: 'Editor & Diff',
    group: 'Diff',
    title: 'Default diff view',
    description: 'Hunk, inline or split view when opening a diff.',
    type: 'enum',
    schema: z.enum(['hunk', 'inline', 'split']),
    default: 'hunk',
    enumLabels: { hunk: 'Hunk', inline: 'Inline', split: 'Split' },
  }),
  'diff.contextLines': def({
    scope: 'profile',
    section: 'Editor & Diff',
    group: 'Diff',
    title: 'Context lines',
    description: 'Unchanged lines shown around each change.',
    type: 'number',
    schema: z.number().int().min(0).max(50),
    default: 3,
  }),
  'diff.whitespace': def({
    scope: 'profile',
    section: 'Editor & Diff',
    group: 'Diff',
    title: 'Ignore whitespace',
    description: 'Which whitespace changes diffs ignore.',
    type: 'enum',
    schema: z.enum(['none', 'eol', 'amount', 'all']),
    default: 'none',
    enumLabels: {
      none: 'Show all changes',
      eol: 'Ignore at end of line',
      amount: 'Ignore amount',
      all: 'Ignore all whitespace',
    },
  }),
  'diff.ignoreBlankLines': def({
    scope: 'profile',
    section: 'Editor & Diff',
    group: 'Diff',
    title: 'Ignore blank lines',
    description: 'Hide changes that only add or remove empty lines.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'diff.renameLimit': def({
    scope: 'profile',
    section: 'Editor & Diff',
    group: 'Diff',
    title: 'Rename detection limit',
    description: 'Maximum number of files considered for rename detection (diff.renameLimit).',
    type: 'number',
    schema: z.number().int().min(0).max(100000),
    default: 1000,
  }),

  // =========================================================================================
  // In-App Terminal
  // =========================================================================================
  'terminal.fontFamily': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Font family',
    description: 'Font stack for the integrated terminal.',
    type: 'font',
    schema: z.string().min(1).max(500),
    default: "'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  }),
  'terminal.fontSize': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Font size',
    description: 'Font size for the integrated terminal.',
    type: 'number',
    unit: 'px',
    schema: z.number().int().min(8).max(32),
    default: 12,
  }),
  'terminal.lineHeight': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Line height',
    description: 'Line height multiplier.',
    type: 'number',
    step: 0.1,
    schema: z.number().min(1).max(2),
    default: 1.2,
  }),
  'terminal.cursorStyle': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Cursor style',
    description: 'Shape of the terminal cursor.',
    type: 'enum',
    schema: z.enum(['block', 'bar', 'underline']),
    default: 'block',
    enumLabels: { block: 'Block', bar: 'Bar', underline: 'Underline' },
  }),
  'terminal.cursorBlink': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Blinking cursor',
    description: 'Blink the terminal cursor.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'terminal.scrollback': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Scrollback',
    description: 'Lines kept in the terminal buffer.',
    type: 'number',
    unit: 'lines',
    step: 1000,
    schema: z.number().int().min(100).max(100000),
    default: 5000,
  }),
  'terminal.shell': def({
    scope: 'profile',
    section: 'In-App Terminal',
    group: 'Shell',
    title: 'Shell',
    description:
      'Path to the shell executable for new terminals. Empty uses the OS default (pwsh/PowerShell on Windows, $SHELL elsewhere).',
    type: 'path',
    pathKind: 'file',
    placeholder: 'OS default',
    schema: optionalPath,
    default: '',
    keywords: ['pwsh', 'bash', 'zsh', 'cmd', 'wsl'],
  }),
  'terminal.shellArgs': def({
    scope: 'profile',
    section: 'In-App Terminal',
    group: 'Shell',
    title: 'Shell arguments',
    description: 'Arguments passed to the shell, one per line. Empty uses sensible defaults per shell.',
    type: 'list',
    schema: z.array(z.string().max(1000)).max(50),
    default: [],
  }),
  'terminal.dimWhenUnfocused': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Dim when unfocused',
    description: 'Lower the terminal contrast while it does not have focus.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'terminal.autocomplete': def({
    scope: 'profile',
    section: 'In-App Terminal',
    title: 'Git autocomplete',
    description:
      'Suggest git subcommands, flags, branches and changed files while typing `git …`. Turned off automatically when another completion tool (Fig, Amazon Q) is detected.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['completion', 'suggestions', 'intellisense'],
  }),
  'terminal.shellIntegration': def({
    scope: 'profile',
    section: 'In-App Terminal',
    group: 'Shell',
    title: 'Shell integration',
    description:
      'Load a small snippet into bash, zsh and PowerShell that reports the current folder and command boundaries (OSC 7 / OSC 133), so the graph refreshes when a command finishes. Applies to new terminals.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
    keywords: ['osc', 'prompt', 'refresh'],
  }),

  // =========================================================================================
  // External Tools
  // =========================================================================================
  'tools.diffTool': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'External diff tool',
    description: 'Tool opened by "Open in external diff tool".',
    type: 'enum',
    schema: z.enum(MERGE_TOOLS),
    default: 'none',
    enumLabels: TOOL_LABELS,
  }),
  'tools.customDiffCmd': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'Custom diff command',
    description: 'Used when the diff tool is "Custom command". Tokens: $LOCAL $REMOTE (quoted for you).',
    type: 'string',
    placeholder: 'mytool --diff $LOCAL $REMOTE',
    schema: commandTemplate,
    default: '',
  }),
  'tools.mergeTool': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'External merge tool',
    description: 'Tool used to resolve conflicts outside the built-in merge editor.',
    type: 'enum',
    schema: z.enum(MERGE_TOOLS),
    default: 'none',
    enumLabels: TOOL_LABELS,
  }),
  'tools.customMergeCmd': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'Custom merge command',
    description:
      'Used when the merge tool is "Custom command". Tokens: $BASE $LOCAL $REMOTE $MERGED (quoted for you).',
    type: 'string',
    placeholder: 'mytool $LOCAL $REMOTE $BASE -o $MERGED',
    schema: commandTemplate,
    default: '',
  }),
  'tools.mergeToolTrustExitCode': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'Trust merge tool exit code',
    description: 'Mark the file resolved when the tool exits with code 0.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'tools.mergeToolKeepBackup': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'Keep .orig backups',
    description: 'Keep the conflicted file as <file>.orig after the merge tool runs.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'tools.useExternalMergeToolByDefault': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Diff & merge',
    title: 'Use external merge tool by default',
    description: 'Open conflicts in the external tool instead of the built-in merge editor.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'tools.editor': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Editor & terminal',
    title: 'External editor',
    description: 'Editor used by "Open in editor".',
    type: 'enum',
    schema: z.enum(EDITORS),
    default: 'vscode',
    enumLabels: {
      none: 'None',
      vscode: 'VS Code',
      'vscode-insiders': 'VS Code Insiders',
      cursor: 'Cursor',
      sublime: 'Sublime Text',
      intellij: 'IntelliJ IDEA',
      webstorm: 'WebStorm',
      zed: 'Zed',
      custom: 'Custom path',
    },
  }),
  'tools.editorPath': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Editor & terminal',
    title: 'Editor path',
    description: 'Executable used when the editor is "Custom path" (or to override detection).',
    type: 'path',
    pathKind: 'file',
    schema: optionalPath,
    default: '',
  }),
  'tools.terminal': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Editor & terminal',
    title: 'External terminal',
    description: 'Terminal opened by "Open repo in terminal".',
    type: 'enum',
    schema: z.enum(TERMINALS),
    default: 'os',
    enumLabels: {
      os: 'OS default',
      'windows-terminal': 'Windows Terminal',
      powershell: 'PowerShell',
      cmd: 'Command Prompt',
      'git-bash': 'Git Bash',
      'terminal-app': 'Terminal.app',
      iterm2: 'iTerm2',
      'gnome-terminal': 'GNOME Terminal',
      konsole: 'Konsole',
      warp: 'Warp',
      ghostty: 'Ghostty',
      kitty: 'kitty',
      alacritty: 'Alacritty',
      xterm: 'xterm',
      custom: 'Custom command',
    },
  }),
  'tools.terminalCommand': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Editor & terminal',
    title: 'Custom terminal command',
    description: 'Used when the terminal is "Custom command". %d is replaced by the repository folder.',
    type: 'string',
    placeholder: 'pwsh -WorkingDirectory %d',
    schema: commandTemplate,
    default: '',
  }),

  // =========================================================================================
  // Commit Signing (applied to git config by the "Apply" action)
  // =========================================================================================
  'signing.format': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Signing format',
    description: 'GPG (OpenPGP), SSH (git 2.34+) or X.509 (gpgsm).',
    type: 'enum',
    schema: z.enum(['openpgp', 'ssh', 'x509']),
    default: 'openpgp',
    enumLabels: { openpgp: 'GPG (OpenPGP)', ssh: 'SSH', x509: 'X.509' },
    gitConfigKey: 'gpg.format',
    keywords: ['gpg', 'sign'],
  }),
  'signing.gpgProgram': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'GPG program',
    description: 'Path to gpg. Empty lets git find gpg on PATH.',
    type: 'path',
    pathKind: 'file',
    placeholder: 'gpg',
    schema: optionalPath,
    default: '',
    gitConfigKey: 'gpg.program',
  }),
  'signing.signingKey': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Signing key',
    description: 'GPG key id, or for SSH the path to the .pub file (or "key::ssh-ed25519 AAAA…").',
    type: 'string',
    placeholder: '3AA5C34371567BD2',
    schema: z.string().max(10000),
    default: '',
    gitConfigKey: 'user.signingkey',
  }),
  'signing.allowedSignersFile': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Allowed signers file',
    description: 'SSH signing: file used to verify signatures (gpg.ssh.allowedSignersFile).',
    type: 'path',
    pathKind: 'file',
    schema: optionalPath,
    default: '',
    gitConfigKey: 'gpg.ssh.allowedSignersFile',
  }),
  'signing.signCommits': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Sign commits by default',
    description: 'commit.gpgsign',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    gitConfigKey: 'commit.gpgsign',
  }),
  'signing.signTags': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Sign tags by default',
    description: 'tag.gpgsign',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    gitConfigKey: 'tag.gpgsign',
  }),
  'signing.writeScope': def({
    scope: 'profile',
    section: 'Commit Signing',
    title: 'Write to',
    description: 'Apply writes these values to your global ~/.gitconfig or to the active repository.',
    type: 'enum',
    schema: z.enum(['global', 'local']),
    default: 'global',
    enumLabels: { global: 'Global (~/.gitconfig)', local: 'This repository (.git/config)' },
  }),

  // =========================================================================================
  // SSH
  // =========================================================================================
  'ssh.useLocalAgent': def({
    scope: 'profile',
    section: 'SSH',
    title: 'Use local SSH agent',
    description: 'Authenticate with keys loaded in ssh-agent (or Pageant on Windows) instead of a key file.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'ssh.privateKeyPath': def({
    scope: 'profile',
    section: 'SSH',
    title: 'SSH private key',
    description: 'Key passed to ssh with -i for git network operations.',
    type: 'path',
    pathKind: 'file',
    placeholder: '~/.ssh/id_ed25519',
    schema: optionalPath,
    default: '',
  }),
  'ssh.publicKeyPath': def({
    scope: 'profile',
    section: 'SSH',
    title: 'SSH public key',
    description: 'Usually the private key path with .pub appended.',
    type: 'path',
    pathKind: 'file',
    placeholder: '~/.ssh/id_ed25519.pub',
    schema: optionalPath,
    default: '',
  }),
  'ssh.useSshConfig': def({
    scope: 'profile',
    section: 'SSH',
    title: 'Honor ~/.ssh/config',
    description: 'Use host aliases and options from your SSH config file.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'ssh.windowsAgent': def({
    scope: 'profile',
    section: 'SSH',
    title: 'Windows SSH agent',
    description: 'Which agent to talk to when using the local agent.',
    type: 'enum',
    schema: z.enum(['openssh', 'pageant']),
    default: 'openssh',
    enumLabels: { openssh: 'OpenSSH agent', pageant: 'Pageant' },
    platforms: ['win32'],
  }),
  'ssh.preferSshForProviders': def({
    scope: 'profile',
    section: 'SSH',
    title: 'Prefer SSH URLs when cloning from providers',
    description: 'Clone hosted repositories over SSH instead of HTTPS.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),

  // =========================================================================================
  // Network (spec 09 §6.11: git proxy/TLS env + Electron session proxy)
  // =========================================================================================
  'network.proxyMode': def({
    scope: 'profile',
    section: 'Network',
    title: 'Proxy',
    description: 'Use the system proxy, a manual proxy, or none.',
    type: 'enum',
    schema: z.enum(['system', 'manual', 'none']),
    default: 'system',
    enumLabels: { system: 'System', manual: 'Manual', none: 'No proxy' },
  }),
  'network.proxyUrl': def({
    scope: 'profile',
    section: 'Network',
    title: 'Proxy URL',
    description:
      'Manual proxy, e.g. http://proxy.example.com:8080. Credentials are stored securely, not here.',
    type: 'string',
    placeholder: 'http://host:port',
    schema: z
      .string()
      .max(2048)
      .refine(
        (s) => s === '' || /^(https?|socks5?):\/\/[^\s/@]+(:\d+)?\/?$/i.test(s),
        'Expected scheme://host:port',
      ),
    default: '',
  }),
  'network.noProxy': def({
    scope: 'profile',
    section: 'Network',
    title: 'Bypass proxy for',
    description: 'Hosts reached directly, one per line (e.g. localhost, *.corp.example).',
    type: 'list',
    schema: z.array(z.string().min(1).max(255)).max(200),
    default: [],
  }),
  'network.useOsCertStore': def({
    scope: 'profile',
    section: 'Network',
    title: 'Use the Windows certificate store',
    description: 'Verify TLS with the OS store (http.sslBackend=schannel).',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
    platforms: ['win32'],
  }),
  'network.caBundlePath': def({
    scope: 'profile',
    section: 'Network',
    title: 'Custom CA bundle',
    description: 'PEM file with extra trusted certificate authorities (http.sslCAInfo).',
    type: 'path',
    pathKind: 'file',
    schema: optionalPath,
    default: '',
  }),
  // =========================================================================================
  // Workspaces & Launchpad (spec 11)
  // =========================================================================================
  'workspaces.bulkConcurrency': def({
    scope: 'profile',
    section: 'Workspaces',
    title: 'Bulk operation concurrency',
    description: 'How many repositories a workspace Fetch / Pull / Clone works on at the same time.',
    type: 'number',
    schema: z.number().int().min(1).max(16),
    default: 4,
  }),
  'workspaces.scanDepth': def({
    scope: 'profile',
    section: 'Workspaces',
    title: 'Folder scan depth',
    description: 'How many folder levels to search for repositories when scanning a folder.',
    type: 'number',
    schema: z.number().int().min(1).max(4),
    default: 2,
  }),
  'workspaces.showFocusOnHome': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Home & Launchpad',
    title: 'Show Focus on the Home view',
    description: 'Show pull requests, issues and uncommitted work next to recent repositories in a new tab.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'launchpad.statusBar': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Home & Launchpad',
    title: 'Launchpad summary in the status bar',
    description: 'Show counts of pull requests that need you (review, ready to merge, blocked).',
    type: 'enum',
    schema: z.enum(['auto', 'always', 'never']),
    default: 'auto',
    enumLabels: { auto: 'When something needs me', always: 'Always', never: 'Never' },
  }),
  'launchpad.refreshMinutes': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Home & Launchpad',
    title: 'Launchpad refresh interval',
    description: 'How often the Launchpad refreshes while it is visible.',
    type: 'number',
    unit: 'min',
    schema: z.number().int().min(1).max(60),
    default: 3,
  }),

  // =========================================================================================
  // AI (spec 12 §4.5). API keys live in the SecretStore (`<profile>/ai/<provider>`), never here.
  // =========================================================================================
  'ai.enabled': def({
    scope: 'profile',
    section: 'AI',
    title: 'Enable AI features',
    description:
      'Commit messages, explanations, PR descriptions, conflict help and commit composition. When off, all AI buttons are hidden.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'ai.provider': def({
    scope: 'profile',
    section: 'AI',
    title: 'Provider',
    description:
      'Which AI service receives your diffs. Requests go directly from this computer to the provider.',
    type: 'enum',
    schema: z.enum(['anthropic', 'openai', 'azure-openai', 'gemini', 'openai-compatible']),
    default: 'anthropic',
    enumLabels: {
      anthropic: 'Anthropic (Claude)',
      openai: 'OpenAI',
      'azure-openai': 'Azure OpenAI',
      gemini: 'Google Gemini',
      'openai-compatible': 'OpenAI-compatible URL (Ollama, LM Studio…)',
    },
  }),
  'ai.model': def({
    scope: 'profile',
    section: 'AI',
    title: 'Model',
    description:
      'Model id sent to the provider. Leave empty for the provider default (Anthropic: claude-sonnet-5-5).',
    type: 'string',
    placeholder: 'claude-sonnet-5-5',
    schema: z.string().max(200),
    default: '',
  }),
  'ai.baseUrl': def({
    scope: 'profile',
    section: 'AI',
    title: 'Endpoint URL',
    description: 'Base URL for Azure OpenAI or an OpenAI-compatible server (e.g. http://localhost:11434/v1).',
    type: 'string',
    placeholder: 'http://localhost:11434/v1',
    schema: z.string().max(2048),
    default: '',
  }),
  'ai.effort': def({
    scope: 'profile',
    section: 'AI',
    title: 'Effort',
    description:
      'How hard the model thinks. Auto uses low for messages, medium for explanations and PRs, high for conflicts and composing.',
    type: 'enum',
    schema: z.enum(['auto', 'low', 'medium', 'high']),
    default: 'auto',
    enumLabels: { auto: 'Auto (per feature)', low: 'Low', medium: 'Medium', high: 'High' },
  }),
  'ai.commitStyle': def({
    scope: 'profile',
    section: 'AI',
    group: 'Output',
    title: 'Commit message style',
    description: 'Style used for generated commit and stash messages.',
    type: 'enum',
    schema: z.enum(['free', 'conventional', 'gitmoji']),
    default: 'free',
    enumLabels: { free: 'Free form', conventional: 'Conventional Commits', gitmoji: 'Gitmoji' },
  }),
  'ai.language': def({
    scope: 'profile',
    section: 'AI',
    group: 'Output',
    title: 'Output language',
    description: 'Language for generated text. Empty = English.',
    type: 'string',
    placeholder: 'English',
    schema: z.string().max(60),
    default: '',
  }),
  'ai.instructions': def({
    scope: 'profile',
    section: 'AI',
    group: 'Output',
    title: 'Custom instructions',
    description:
      'Added to every AI request (e.g. "Reference the Jira key from the branch name"). A repository can add more in .githappens/ai-instructions.md.',
    type: 'string',
    schema: z.string().max(8000),
    default: '',
  }),
  // Per-feature overrides (spec 12 §2.2 / §4.5); edited in AiPrefsPanel ("Per-feature settings").
  'ai.effortOverrides': def({
    scope: 'profile',
    section: 'AI',
    group: 'Per feature',
    title: 'Effort per feature',
    description:
      'Effort override per feature (commit, explain, stash, pr, conflicts, composer, changelog). Unset features use the Effort setting.',
    type: 'object',
    keywords: ['effort', 'per-feature'],
    schema: z.partialRecord(z.enum(AI_FEATURE_GROUPS), z.enum(AI_EFFORTS)),
    default: {},
  }),
  'ai.featureInstructions': def({
    scope: 'profile',
    section: 'AI',
    group: 'Per feature',
    title: 'Custom instructions per feature',
    description:
      'Extra instructions per feature, added after the global custom instructions and before .githappens/ai-instructions.md.',
    type: 'object',
    keywords: ['instructions', 'prompt', 'per-feature'],
    schema: z.partialRecord(z.enum(AI_FEATURE_GROUPS), z.string().max(8000)),
    default: {},
  }),
  'ai.maxDiffChars': def({
    scope: 'profile',
    section: 'AI',
    group: 'Privacy & limits',
    title: 'Maximum diff size sent',
    description: 'Larger diffs are truncated per file; the result notes that it is based on a partial diff.',
    type: 'number',
    unit: 'chars',
    schema: z.number().int().min(10_000).max(1_000_000),
    default: 120_000,
    step: 10_000,
  }),
  'ai.excludeGlobs': def({
    scope: 'profile',
    section: 'AI',
    group: 'Privacy & limits',
    title: 'Never send these files',
    description:
      'Glob patterns (one per line). Matching files are listed by name only. Likely secrets are always redacted.',
    type: 'list',
    schema: z.array(z.string().max(500)).max(200),
    default: [
      '**/*.lock',
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/*.min.js',
      '**/dist/**',
      '**/.env*',
      '**/*.pem',
      '**/*.key',
    ],
  }),
  'ai.consent': def({
    scope: 'profile',
    section: 'AI',
    group: 'Privacy & limits',
    title: 'Consent given for',
    description: 'Provider and endpoint you agreed to send code to. Clear it to be asked again.',
    type: 'string',
    schema: z.string().max(2048),
    default: '',
  }),

  // =========================================================================================
  // Agent sessions (spec 12 §4.12)
  // =========================================================================================
  'ui.showAgentsToggle': def({
    scope: 'profile',
    section: 'UI Customization',
    title: 'Show Agents view',
    description: 'Adds a List | Agents switch to the left panel listing coding-agent sessions per worktree.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'tools.agentCommand': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Coding agents',
    title: 'Agent command',
    description: 'Command started by "New agent session" (e.g. claude, codex, gemini).',
    type: 'string',
    placeholder: 'claude',
    schema: z.string().max(500),
    default: 'claude',
  }),
  'tools.agentArgs': def({
    scope: 'profile',
    section: 'External Tools',
    group: 'Coding agents',
    title: 'Agent arguments',
    description: 'Arguments passed to the agent command (one per line).',
    type: 'list',
    schema: z.array(z.string().max(1000)).max(50),
    default: [],
  }),
  // =========================================================================================
  // Account & cloud (spec 14). Everything is off until a server is configured and the user signs in.
  // =========================================================================================
  'cloud.serverUrl': def({
    scope: 'app',
    section: 'Account',
    title: 'Cloud server',
    description:
      'GitHappens Cloud server for sign-in, settings sync, Cloud Patches and team features (self-hosted). Empty = cloud features off.',
    type: 'string',
    placeholder: 'https://cloud.example.com',
    schema: z.string().max(2048),
    default: '',
  }),
  'sync.enabled': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Sync settings',
    description: 'Keep the categories below in sync across your computers (end-to-end encrypted).',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'sync.preferences': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Preferences',
    description: 'Profile settings (never paths, tokens or keys).',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'sync.keybindings': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Keybindings',
    description: 'Custom keyboard shortcuts.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'sync.themes': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Themes',
    description: 'Custom themes.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'sync.workspaces': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Workspaces',
    description: 'Workspace definitions without local paths.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'sync.launchpad': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Launchpad state',
    description: 'Pins, snoozes and saved views.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'sync.integrationsList': def({
    scope: 'profile',
    section: 'Account',
    group: 'Settings sync',
    title: 'Connected services list',
    description: 'Which services are connected (never tokens); other computers show Reconnect prompts.',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'cloud.launchpadState': def({
    scope: 'profile',
    section: 'Account',
    group: 'Launchpad state',
    title: 'Keep Launchpad state on the server (not encrypted)',
    description:
      'Store pins, snoozes and saved views on the cloud server as plain JSON so they follow you without settings sync. Ignored while end-to-end encrypted sync of Launchpad state is on.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'insights.deploySignal': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Insights',
    title: 'Deployment signal',
    description:
      'What counts as a deployment for the DORA tiles (deployment frequency, lead time, change failure rate, MTTR).',
    type: 'enum',
    schema: z.enum(['none', 'tags', 'github-deployments']),
    default: 'none',
    enumLabels: {
      none: 'None (hide DORA tiles)',
      tags: 'Git tags',
      'github-deployments': 'GitHub deployments',
    },
  }),
  'insights.deployTagPattern': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Insights',
    title: 'Deployment tag pattern',
    description: 'Tags matching this pattern (* and ? wildcards) mark deployments, e.g. v* or release-*.',
    type: 'string',
    placeholder: 'v*',
    schema: z.string().max(200),
    default: 'v*',
  }),
  'insights.deployEnvironment': def({
    scope: 'profile',
    section: 'Workspaces',
    group: 'Insights',
    title: 'Deployment environment',
    description: 'GitHub deployments environment to count (GitHub deployments signal).',
    type: 'string',
    placeholder: 'production',
    schema: z.string().max(200),
    default: 'production',
  }),
  'team.footprints': def({
    scope: 'profile',
    section: 'Account',
    group: 'Team',
    title: 'Share work footprints with my organization',
    description:
      'Upload which files and line ranges your unmerged branches change (no contents; paths hashed unless the org allows names) to warn teammates about overlaps.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
  'conflicts.detectTarget': def({
    scope: 'profile',
    section: 'Git',
    group: 'Conflict prevention',
    title: 'Warn about conflicts with the target branch',
    description:
      'After fetches and commits, check in the background whether the current branch would conflict with its target (e.g. origin/main).',
    type: 'boolean',
    schema: z.boolean(),
    default: true,
  }),
  'conflicts.includeWip': def({
    scope: 'profile',
    section: 'Git',
    group: 'Conflict prevention',
    title: 'Include uncommitted changes',
    description: 'Also check your working-tree changes against the target branch.',
    type: 'boolean',
    schema: z.boolean(),
    default: false,
  }),
} as const;

/**
 * Keys removed from the registry whose stored value moves to another key on load (a stored
 * value for the new key wins). E.g. `general.conflictDetection` duplicated `conflicts.detectTarget`.
 */
export const RENAMED_SETTINGS: Readonly<Record<string, SettingKey>> = {
  'general.conflictDetection': 'conflicts.detectTarget',
};

export type SettingsDefs = typeof SETTINGS;
export type SettingKey = keyof SettingsDefs;
export type SettingValue<K extends SettingKey> = z.infer<SettingsDefs[K]['schema']>;
export type SettingsValues = { [K in SettingKey]: SettingValue<K> };
export type AppSettingKey = {
  [K in SettingKey]: SettingsDefs[K]['scope'] extends 'app' ? K : never;
}[SettingKey];
export type ProfileSettingKey = Exclude<SettingKey, AppSettingKey>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Known experiments stored in `experimental.flags` (spec 13 Experimental), each with a consumer. */
export const EXPERIMENTS = [
  {
    id: 'monacoTokenRules',
    title: 'Theme token colours in editors',
    description:
      'Apply the token colouring rules (editor.rules) of custom theme files to the diff and file editors. Editor colours (editor.colors) always apply.',
  },
  {
    id: 'repoDisplayEncoding',
    title: 'Per-repository display encoding',
    description:
      'Decode files that are not valid UTF-8 with the encoding chosen in Preferences › Repo › Encoding instead of Latin-1 (read-only).',
  },
] as const;
export type ExperimentId = (typeof EXPERIMENTS)[number]['id'];

export const hasExperiment = (flags: readonly string[] | undefined, id: ExperimentId): boolean =>
  !!flags?.includes(id);

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);

export function defaultValues(): SettingsValues {
  return Object.fromEntries(
    SETTING_KEYS.map((k) => [k, structuredClone(SETTINGS[k].default)]),
  ) as SettingsValues;
}

const PLANNED_NOTE = 'Not applied yet — saved for an upcoming feature.';

/** Serializable descriptors (no zod objects) for the renderer / JSON schema. */
export function descriptors(): SettingDescriptor[] {
  return SETTING_KEYS.map((key) => {
    const { schema, ...rest } = SETTINGS[key] as Def<z.ZodType>;
    const d: SettingDescriptor = { key, ...structuredClone(rest) };
    if (d.planned) d.description = `${d.description} ${PLANNED_NOTE}`;
    if (schema instanceof z.ZodEnum) d.enum = [...schema.options];
    if (schema instanceof z.ZodNumber) {
      if (schema.minValue !== null && Number.isFinite(schema.minValue)) d.min = schema.minValue;
      if (schema.maxValue !== null && Number.isFinite(schema.maxValue)) d.max = schema.maxValue;
    }
    return d;
  });
}

export function validateSetting<K extends SettingKey>(
  key: K,
  value: unknown,
): { ok: true; value: SettingValue<K> } | { ok: false; error: string } {
  const r = SETTINGS[key].schema.safeParse(value);
  return r.success
    ? { ok: true, value: r.data as SettingValue<K> }
    : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
}

/** Case-insensitive search over title / description / keywords / key / section (spec 13 §4.1). */
export function matchesSettingQuery(d: SettingDescriptor, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [d.key, d.title, d.description, d.section, d.group ?? '', ...(d.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Minimal JSON Schema for `settings.json` values (spec 13 §5.2), e.g. for Monaco validation. */
export function settingsJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const def = SETTINGS[key] as Def<z.ZodType>;
    try {
      const s = z.toJSONSchema(def.schema, { unrepresentable: 'any' }) as Record<string, unknown>;
      delete s.$schema;
      properties[key] = { ...s, description: def.description, default: def.default };
    } catch {
      properties[key] = { description: def.description, default: def.default };
    }
  }
  return { type: 'object', properties, additionalProperties: true };
}
