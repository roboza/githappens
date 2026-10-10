/**
 * Terminal git autocomplete (spec 12 §4.3 / §6.2): the generated option table
 * (`completions.json`, see `scripts/gen-completions.ts`), a shell-ish tokenizer for the line being
 * typed, and the suggestion engine. Pure — the renderer supplies refs / changed paths from its
 * repo store and aliases from `git config --get-regexp ^alias\.`.
 */
import data from './completions.json';

export interface CompletionCommand {
  description?: string;
  /** Options (`--flag`, `--opt=` takes a value, short `-x`). */
  flags: string[];
  /** `--no-…` forms, offered once the user typed `--no`. */
  negations?: string[];
  /** Sub-subcommands (`stash push`, `worktree add`, …). */
  subcommands?: string[];
}

export interface CompletionTable {
  gitVersion: string;
  commands: Record<string, CompletionCommand>;
}

export const completionTable: CompletionTable = data as CompletionTable;

// ---- tokenizer ----

export interface Token {
  /** Unquoted / unescaped value. */
  value: string;
  /** Offset of the token's first char in the line. */
  start: number;
  /** Offset just past the token. */
  end: number;
  /** Quote still open at the end of the input (only possible for the last token). */
  openQuote?: '"' | "'";
}

/**
 * Splits `line` like a POSIX shell would (whitespace, '…', "…", backslash escapes). `;`, `&&`,
 * `|` start a new command: only the tokens of the last command are returned.
 */
export function tokenize(line: string): { tokens: Token[]; trailingSpace: boolean } {
  let tokens: Token[] = [];
  let cur: Token | null = null;
  let quote: '"' | "'" | null = null;
  const begin = (i: number): Token => (cur ??= { value: '', start: i, end: i });
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length && /["\\$`]/.test(line[i + 1]!)) {
        cur!.value += line[++i]!;
      } else cur!.value += c;
      cur!.end = i + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (cur) tokens.push(cur);
      cur = null;
      continue;
    }
    if (c === ';' || c === '|' || c === '&') {
      if (cur) tokens.push(cur);
      cur = null;
      tokens = [];
      continue;
    }
    const t = begin(i);
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && i + 1 < line.length) t.value += line[++i]!;
    else t.value += c;
    t.end = i + 1;
  }
  const last = cur as Token | null;
  if (last) {
    if (quote) last.openQuote = quote;
    tokens.push(last);
  }
  return { tokens, trailingSpace: !last && /[ \t]$/.test(line) };
}

// ---- line analysis ----

/** Global options that take a separate value (`git -C dir status`). */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

export interface GitLineContext {
  /** Index into `tokens` of the subcommand (or -1 while it is being typed). */
  subcommand: string | null;
  /** Args after the subcommand, excluding the one being typed. */
  args: string[];
  /** Text of the token being completed ('' after a space). */
  prefix: string;
  /** The current token is quoted (open quote). */
  quoted: boolean;
  /** Chars of raw input that make up the current token (for replacing it). */
  rawPrefixLength: number;
  /** Completing the subcommand position. */
  atSubcommand: boolean;
  /** A `--` was typed: only paths follow. */
  afterDoubleDash: boolean;
}

/** Analyses the input up to the cursor; null when it is not a `git …` command line. */
export function parseGitLine(line: string): GitLineContext | null {
  const { tokens, trailingSpace } = tokenize(line);
  if (!tokens.length) return null;
  let i = 0;
  // `VAR=x git …`
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.value)) i++;
  const gitTok = tokens[i];
  if (!gitTok || !/^git(\.exe)?$/i.test(gitTok.value)) return null;
  const hasCurrent = !trailingSpace;
  // Need at least "git " (a space after git) before completing.
  if (i === tokens.length - 1 && hasCurrent) return null;
  const last = tokens.length - 1;
  const current = hasCurrent ? tokens[last]! : null;
  const complete = hasCurrent ? tokens.slice(i + 1, last) : tokens.slice(i + 1);
  let j = 0;
  while (j < complete.length) {
    const v = complete[j]!.value;
    if (GLOBAL_WITH_VALUE.has(v)) j += 2;
    else if (v.startsWith('-')) j += 1;
    else break;
  }
  const base = {
    prefix: current?.value ?? '',
    quoted: !!current?.openQuote,
    rawPrefixLength: current ? current.end - current.start : 0,
  };
  if (j >= complete.length) {
    // The subcommand is being typed — unless the current token is a global option or its value
    // (`git -C <dir>`: j skipped past the end).
    if (j > complete.length || base.prefix.startsWith('-')) return null;
    return { subcommand: null, args: [], atSubcommand: true, afterDoubleDash: false, ...base };
  }
  const sub = complete[j]!.value;
  const args = complete.slice(j + 1).map((t) => t.value);
  return {
    subcommand: sub,
    args,
    atSubcommand: false,
    afterDoubleDash: args.includes('--'),
    ...base,
  };
}

// ---- suggestions ----

export interface CompletionSources {
  table?: CompletionTable;
  /** `alias.<name>` → expansion. */
  aliases?: { name: string; expansion: string }[];
  /** Local / remote branch and tag names (short names). */
  refs?: string[];
  /** Changed paths (WIP) first, then other files. */
  paths?: string[];
  /** Max items (default 8). */
  limit?: number;
}

export interface CompletionItem {
  label: string;
  /** Text to type at the cursor (after deleting `deleteBefore` chars). */
  insert: string;
  /** Chars to erase before inserting (when the current token must be re-quoted). */
  deleteBefore: number;
  detail?: string;
  kind: 'subcommand' | 'alias' | 'flag' | 'ref' | 'path';
}

/** Most-used first when the prefix is short. */
const POPULAR = [
  'status',
  'add',
  'commit',
  'checkout',
  'switch',
  'push',
  'pull',
  'fetch',
  'log',
  'diff',
  'branch',
  'merge',
  'rebase',
  'stash',
  'restore',
  'reset',
  'show',
  'tag',
  'cherry-pick',
  'remote',
];

const REF_COMMANDS = new Set([
  'checkout',
  'switch',
  'merge',
  'rebase',
  'branch',
  'push',
  'pull',
  'cherry-pick',
  'reset',
  'revert',
  'diff',
  'log',
  'show',
  'tag',
  'range-diff',
  'merge-base',
  'cherry',
  'describe',
  'shortlog',
]);
const PATH_COMMANDS = new Set([
  'add',
  'restore',
  'rm',
  'mv',
  'diff',
  'checkout',
  'reset',
  'stage',
  'blame',
  'log',
]);
/** Commands where paths come first (refs make no sense). */
const PATH_ONLY = new Set(['add', 'rm', 'mv', 'stage', 'blame']);

const NEEDS_QUOTE = /[^A-Za-z0-9_\-.,:/@%+=~^]/;
const quoteSingle = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function item(
  label: string,
  ctx: GitLineContext,
  kind: CompletionItem['kind'],
  detail?: string,
): CompletionItem | null {
  if (!ctx.quoted && NEEDS_QUOTE.test(label) && (kind === 'path' || kind === 'ref')) {
    return { label, insert: quoteSingle(label), deleteBefore: ctx.rawPrefixLength, detail, kind };
  }
  if (!label.startsWith(ctx.prefix)) {
    // case-insensitive path match: retype the whole token
    return { label, insert: label, deleteBefore: ctx.rawPrefixLength, detail, kind };
  }
  const rest = label.slice(ctx.prefix.length);
  if (!rest && kind !== 'subcommand') return null;
  return { label, insert: rest, deleteBefore: 0, detail, kind };
}

function rank(names: string[], prefix: string): string[] {
  const pop = (n: string): number => {
    const i = POPULAR.indexOf(n);
    return i < 0 ? POPULAR.length : i;
  };
  return names
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => (prefix.length < 2 ? pop(a) - pop(b) : 0) || a.localeCompare(b));
}

/** Resolves an alias to its git subcommand; null for shell aliases (`!…`). */
function aliasTarget(name: string, aliases: CompletionSources['aliases']): string | null | undefined {
  const a = aliases?.find((x) => x.name === name);
  if (!a) return undefined;
  const exp = a.expansion.trim();
  if (exp.startsWith('!')) return null;
  return exp.split(/\s+/)[0] ?? null;
}

/** Suggestions for the input `line` (text before the cursor). Empty when nothing applies. */
export function suggestGit(line: string, src: CompletionSources = {}): CompletionItem[] {
  const ctx = parseGitLine(line);
  if (!ctx) return [];
  const table = src.table ?? completionTable;
  const limit = src.limit ?? 8;
  const out: CompletionItem[] = [];
  const push = (it: CompletionItem | null): boolean => {
    if (it && !out.some((o) => o.label === it.label)) out.push(it);
    return out.length >= limit;
  };

  if (ctx.atSubcommand) {
    const aliasNames = (src.aliases ?? []).map((a) => a.name);
    for (const n of rank([...Object.keys(table.commands), ...aliasNames], ctx.prefix)) {
      const alias = src.aliases?.find((a) => a.name === n);
      const it = alias
        ? item(n, ctx, 'alias', `alias → ${alias.expansion}`)
        : item(n, ctx, 'subcommand', table.commands[n]?.description);
      if (push(it)) break;
    }
    return out;
  }

  let sub = ctx.subcommand!;
  const target = aliasTarget(sub, src.aliases);
  if (target === null) return []; // shell alias: no hints
  if (target) sub = target;
  const cmd = table.commands[sub];

  if (ctx.prefix.startsWith('-') && !ctx.afterDoubleDash) {
    if (ctx.prefix.includes('=')) return []; // typing a value
    if (!cmd) return [];
    const pool = ctx.prefix.startsWith('--no') ? [...cmd.flags, ...(cmd.negations ?? [])] : cmd.flags;
    const matches = pool.filter((f) => f.startsWith(ctx.prefix));
    // long options for `--…`, short ones for a lone `-`
    matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const f of matches) if (push(item(f, ctx, 'flag'))) break;
    return out;
  }

  const positional = ctx.args.filter((a) => !a.startsWith('-'));
  if (cmd?.subcommands?.length && positional.length === 0 && !ctx.afterDoubleDash) {
    for (const s of cmd.subcommands.filter((x) => x.startsWith(ctx.prefix)))
      if (push(item(s, ctx, 'subcommand'))) break;
    if (out.length) return out;
  }

  const wantRefs = REF_COMMANDS.has(sub) && !ctx.afterDoubleDash && !PATH_ONLY.has(sub);
  const wantPaths = PATH_COMMANDS.has(sub) || ctx.afterDoubleDash;
  const lower = ctx.prefix.toLowerCase();
  if (wantRefs) {
    for (const r of src.refs ?? []) {
      if (r.startsWith(ctx.prefix) && push(item(r, ctx, 'ref'))) return out;
    }
  }
  if (wantPaths) {
    const paths = src.paths ?? [];
    for (const p of paths) if (p.startsWith(ctx.prefix) && push(item(p, ctx, 'path'))) return out;
    if (ctx.prefix) {
      for (const p of paths) {
        if (!p.startsWith(ctx.prefix) && p.toLowerCase().startsWith(lower) && push(item(p, ctx, 'path')))
          return out;
      }
    }
  }
  return out;
}
