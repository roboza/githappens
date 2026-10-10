import { converter, formatHex, formatRgb, parse as parseColor, type Color } from 'culori';
import {
  findNodeAtLocation,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';
import { z } from 'zod';

import {
  BUILTIN_THEMES,
  builtinForScheme,
  DEFAULT_THEME_ID,
  type ThemeScheme,
  type ThemeTokens,
} from './builtin-themes';
import { monacoBaseFor, SCOPED_GROUPS, type ResolvedTheme, type ThemeError } from './theme-model';

export * from './theme-model';

/**
 * Custom theme engine (spec 13 §5.3): JSONC theme files → resolved token maps.
 *
 * Values may use `var(--name)` (resolved against the theme's own tokens, with cycle detection),
 * CSS functions passed through (`calc`, `rgb[a]`, `hsl[a]`, `min`, `max`, …) and LESS colour
 * functions computed here: `darken`, `lighten`, `saturate`, `desaturate`, `fade`, `fadein`,
 * `fadeout`, `spin`, `mix`/`mixLess`, `tint`, `shade`.
 *
 * Pure (no fs / DOM) so it runs in main and in unit tests.
 */

// ---------------------------------------------------------------------------------------------
// File schema
// ---------------------------------------------------------------------------------------------

const tokenMap = z.record(
  z.string(),
  z.union([z.string(), z.number()]).transform((v) => String(v)),
);

export const themeFileSchema = z.object({
  meta: z.object({
    name: z.string().trim().min(1, 'meta.name is required'),
    scheme: z.enum(['dark', 'light']),
    extends: z.string().optional(),
  }),
  themeValues: z
    .object({
      root: tokenMap.optional(),
      toolbar: tokenMap.optional(),
      tabsbar: tokenMap.optional(),
      terminal: tokenMap.optional(),
      editor: z
        .object({
          monacoBase: z.enum(['vs', 'vs-dark', 'hc-black', 'hc-light']).optional(),
          rules: z
            .array(
              z.object({
                token: z.string(),
                foreground: z.string().optional(),
                background: z.string().optional(),
                fontStyle: z.string().optional(),
              }),
            )
            .optional(),
          colors: tokenMap.optional(),
        })
        .optional(),
    })
    .default({}),
});

export type ThemeFile = z.infer<typeof themeFileSchema>;

export type ParseThemeResult =
  | { ok: true; theme: ThemeFile; tree: JsonNode | undefined; text: string }
  | { ok: false; errors: ThemeError[] };

export function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

/** Parse + validate a JSONC theme file. Syntax errors carry line/column. */
export function parseThemeFile(text: string): ParseThemeResult {
  const errs: ParseError[] = [];
  const tree = parseTree(text, errs, { allowTrailingComma: true, disallowComments: false });
  if (errs.length > 0 || !tree) {
    const list = errs.length ? errs : [{ error: 0, offset: 0, length: 0 } as unknown as ParseError];
    return {
      ok: false,
      errors: list.map((e) => ({
        message: errs.length ? `Syntax error: ${printParseErrorCode(e.error)}` : 'File is empty',
        ...offsetToLineCol(text, e.offset),
      })),
    };
  }
  const raw = nodeValue(tree);
  const r = themeFileSchema.safeParse(raw);
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => {
        const node = findNodeAtLocation(tree, i.path as (string | number)[]);
        return {
          message: `${i.path.join('.') || 'file'}: ${i.message}`,
          ...(node ? offsetToLineCol(text, node.offset) : {}),
        };
      }),
    };
  }
  return { ok: true, theme: r.data, tree, text };
}

function nodeValue(n: JsonNode): unknown {
  switch (n.type) {
    case 'object':
      return Object.fromEntries(
        (n.children ?? []).flatMap((p) =>
          p.children && p.children.length === 2
            ? [[String(p.children[0]!.value), nodeValue(p.children[1]!)]]
            : [],
        ),
      );
    case 'array':
      return (n.children ?? []).map(nodeValue);
    default:
      return n.value;
  }
}

// ---------------------------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------------------------

type ExprNode = { kind: 'text'; value: string } | { kind: 'call'; name: string; args: ExprNode[][] };

export class ThemeEvalError extends Error {}

/** Tiny parser: identifiers followed by `(` become calls; args split on top-level commas. */
export function parseExpression(src: string): ExprNode[] {
  let i = 0;
  const parseSeq = (stopAtArgEnd: boolean): ExprNode[] => {
    const out: ExprNode[] = [];
    let text = '';
    const flush = (): void => {
      if (text) out.push({ kind: 'text', value: text });
      text = '';
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (stopAtArgEnd && (ch === ',' || ch === ')')) break;
      if (ch === '"' || ch === "'") {
        const end = src.indexOf(ch, i + 1);
        const stop = end === -1 ? src.length : end + 1;
        text += src.slice(i, stop);
        i = stop;
        continue;
      }
      const m = /^[a-zA-Z_-][a-zA-Z0-9_-]*\(/.exec(src.slice(i));
      if (m && !/[a-zA-Z0-9_-]$/.test(text)) {
        flush();
        const name = m[0].slice(0, -1);
        i += m[0].length;
        const args: ExprNode[][] = [];
        for (;;) {
          args.push(parseSeq(true));
          if (i >= src.length) throw new ThemeEvalError(`Missing ")" after ${name}(`);
          if (src[i] === ',') {
            i++;
            continue;
          }
          i++; // ')'
          break;
        }
        out.push({ kind: 'call', name, args });
        continue;
      }
      if (ch === '(') {
        // Bare parenthesised group, e.g. inside calc(): keep as text but balance it.
        let depth = 0;
        const start = i;
        while (i < src.length) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) break;
          i++;
        }
        text += src.slice(start, i + 1);
        i++;
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return out;
  };
  const seq = parseSeq(false);
  if (i < src.length) throw new ThemeEvalError(`Unexpected "${src[i]}"`);
  return seq;
}

const normalizeName = (n: string): string => n.trim().replace(/^--/, '').replace(/^kl-/, '');

const toRgb = converter('rgb');
const toHsl = converter('hsl');

function color(s: string): Color {
  const c = parseColor(s.trim());
  if (!c) throw new ThemeEvalError(`"${s.trim()}" is not a colour`);
  return c;
}

/** `20%` → 0.2; bare numbers ≤ 1 are fractions, larger ones percentages (LESS-style). */
function amount(s: string | undefined, fallback?: number): number {
  if (s === undefined || s.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new ThemeEvalError('Missing amount');
  }
  const t = s.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) throw new ThemeEvalError(`"${t}" is not a number`);
  if (t.endsWith('%')) return n / 100;
  return Math.abs(n) <= 1 ? n : n / 100;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function formatColor(c: Color): string {
  const rgb = toRgb(c);
  const alpha = rgb.alpha ?? 1;
  if (alpha >= 1) return formatHex(rgb);
  const r = formatRgb({ ...rgb, alpha: Math.round(alpha * 1000) / 1000 });
  return r.replace(/\s+/g, '');
}

function adjustHsl(c: string, f: (h: { h: number; s: number; l: number; alpha: number }) => void): string {
  const hsl = toHsl(color(c));
  const v = { h: hsl.h ?? 0, s: hsl.s ?? 0, l: hsl.l ?? 0, alpha: hsl.alpha ?? 1 };
  f(v);
  return formatColor({ mode: 'hsl', h: v.h, s: clamp01(v.s), l: clamp01(v.l), alpha: clamp01(v.alpha) });
}

/** LESS `mix()` algorithm (alpha-aware weighting). `weight` is the share of `c1` (0..1). */
export function mixColors(c1s: string, c2s: string, weight = 0.5): string {
  const c1 = toRgb(color(c1s));
  const c2 = toRgb(color(c2s));
  const a1 = c1.alpha ?? 1;
  const a2 = c2.alpha ?? 1;
  const w = weight * 2 - 1;
  const a = a1 - a2;
  const w1 = ((w * a === -1 ? w : (w + a) / (1 + w * a)) + 1) / 2;
  const w2 = 1 - w1;
  return formatColor({
    mode: 'rgb',
    r: c1.r * w1 + c2.r * w2,
    g: c1.g * w1 + c2.g * w2,
    b: c1.b * w1 + c2.b * w2,
    alpha: a1 * weight + a2 * (1 - weight),
  });
}

export const LESS_FUNCTIONS: Record<string, (args: string[]) => string> = {
  lighten: ([c, p]) => adjustHsl(c!, (h) => void (h.l += amount(p))),
  darken: ([c, p]) => adjustHsl(c!, (h) => void (h.l -= amount(p))),
  saturate: ([c, p]) => adjustHsl(c!, (h) => void (h.s += amount(p))),
  desaturate: ([c, p]) => adjustHsl(c!, (h) => void (h.s -= amount(p))),
  fade: ([c, p]) => adjustHsl(c!, (h) => void (h.alpha = amount(p))),
  fadein: ([c, p]) => adjustHsl(c!, (h) => void (h.alpha += amount(p))),
  fadeout: ([c, p]) => adjustHsl(c!, (h) => void (h.alpha -= amount(p))),
  spin: ([c, deg]) =>
    adjustHsl(c!, (h) => {
      h.h = (((h.h + parseFloat(deg ?? '0')) % 360) + 360) % 360;
    }),
  mix: ([a, b, w]) => mixColors(a!, b!, amount(w, 0.5)),
  mixLess: ([a, b, w]) => mixColors(a!, b!, amount(w, 0.5)),
  tint: ([c, w]) => mixColors('#ffffff', c!, amount(w, 0.5)),
  shade: ([c, w]) => mixColors('#000000', c!, amount(w, 0.5)),
};

const ARITY: Record<string, number> = {
  lighten: 2,
  darken: 2,
  saturate: 2,
  desaturate: 2,
  fade: 2,
  fadein: 2,
  fadeout: 2,
  spin: 2,
  mix: 2,
  mixLess: 2,
  tint: 1,
  shade: 1,
};

export interface EvaluateResult {
  tokens: ThemeTokens;
  errors: ThemeError[];
}

/**
 * Evaluate a token map. `fallback` supplies values for keys that fail to evaluate;
 * `parent` resolves `var()` names not defined in `defs` (scoped groups → root tokens).
 */
export function evaluateTokens(
  defs: Record<string, string>,
  opts: { fallback?: ThemeTokens; parent?: (name: string) => string | undefined; prefix?: string } = {},
): EvaluateResult {
  const src = new Map<string, string>();
  for (const [k, v] of Object.entries(defs)) src.set(normalizeName(k), v);
  const done = new Map<string, string>();
  const stack: string[] = [];

  const resolve = (name: string): string => {
    const cached = done.get(name);
    if (cached !== undefined) return cached;
    const raw = src.get(name);
    if (raw === undefined) {
      const p = opts.parent?.(name);
      if (p !== undefined) return p;
      throw new ThemeEvalError(`Unknown variable --${name}`);
    }
    if (stack.includes(name)) {
      throw new ThemeEvalError(`Cycle in var(): ${[...stack.slice(stack.indexOf(name)), name].join(' → ')}`);
    }
    stack.push(name);
    try {
      const v = evalSeq(parseExpression(raw));
      done.set(name, v);
      return v;
    } finally {
      stack.pop();
    }
  };

  const evalSeq = (nodes: ExprNode[]): string => nodes.map(evalNode).join('').trim();

  const evalNode = (n: ExprNode): string => {
    if (n.kind === 'text') return n.value;
    if (n.name === 'var') {
      const name = normalizeName(evalSeq(n.args[0] ?? []));
      try {
        return resolve(name);
      } catch (e) {
        if (n.args.length > 1 && !(e instanceof ThemeEvalError && /^Cycle/.test(e.message))) {
          return evalSeq(n.args.slice(1).flat());
        }
        throw e;
      }
    }
    const fn = LESS_FUNCTIONS[n.name];
    const args = n.args.map(evalSeq);
    if (fn) {
      const need = ARITY[n.name] ?? 1;
      if (args.filter((a) => a !== '').length < need) {
        throw new ThemeEvalError(`${n.name}() needs ${need} argument${need > 1 ? 's' : ''}`);
      }
      return fn(args);
    }
    return `${n.name}(${args.join(',')})`;
  };

  const tokens: ThemeTokens = {};
  const errors: ThemeError[] = [];
  for (const key of src.keys()) {
    try {
      tokens[key] = resolve(key);
    } catch (e) {
      errors.push({ key: `${opts.prefix ?? ''}${key}`, message: (e as Error).message });
      const fb = opts.fallback?.[key];
      if (fb !== undefined) tokens[key] = fb;
    }
  }
  return { tokens, errors };
}

// ---------------------------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------------------------

/** Evaluate a parsed theme file against its base theme. Never throws. */
export function resolveTheme(
  file: ThemeFile,
  id: string,
  opts: { filePath?: string; tree?: JsonNode; text?: string } = {},
): ResolvedTheme {
  const { meta, themeValues: tv } = file;
  const errors: ThemeError[] = [];
  let baseId = meta.extends ?? builtinForScheme(meta.scheme);
  if (!Object.hasOwn(BUILTIN_THEMES, baseId)) {
    errors.push({
      message: `meta.extends: unknown theme "${baseId}"; using ${builtinForScheme(meta.scheme)}`,
    });
    baseId = builtinForScheme(meta.scheme);
  }
  const base = BUILTIN_THEMES[baseId]!;

  const root = evaluateTokens(
    { ...base.tokens, ...(tv.root ?? {}) },
    { fallback: base.tokens, prefix: 'root.' },
  );
  errors.push(...root.errors);
  const fromRoot = (name: string): string | undefined => root.tokens[name];

  const scopes: Record<string, ThemeTokens> = {};
  for (const g of SCOPED_GROUPS) {
    const defs = tv[g];
    if (!defs) continue;
    const r = evaluateTokens(defs, { parent: fromRoot, prefix: `${g}.` });
    scopes[g] = r.tokens;
    errors.push(...r.errors);
  }

  const term = evaluateTokens(
    { ...base.terminal, ...(tv.terminal ?? {}) },
    { fallback: base.terminal, parent: fromRoot, prefix: 'terminal.' },
  );
  errors.push(...term.errors);

  const editor = tv.editor;
  const monacoColors = evaluateTokens(editor?.colors ?? {}, { parent: fromRoot, prefix: 'editor.colors.' });
  errors.push(...monacoColors.errors);

  // Attach line numbers to evaluation errors where we can find the key in the source.
  if (opts.tree && opts.text) {
    for (const e of errors) {
      if (!e.key || e.line) continue;
      const [group, ...rest] = e.key.split('.');
      const keyName = rest.join('.');
      const path =
        group === 'editor'
          ? ['themeValues', 'editor', 'colors', rest.slice(1).join('.')]
          : ['themeValues', group!, keyName];
      const node = findNodeAtLocation(opts.tree, path);
      if (node) Object.assign(e, offsetToLineCol(opts.text, node.offset));
    }
  }

  return {
    id,
    name: meta.name,
    scheme: meta.scheme,
    source: 'user',
    file: opts.filePath,
    tokens: root.tokens,
    scopes,
    terminal: term.tokens,
    monaco: {
      base: editor?.monacoBase ?? monacoBaseFor(meta.scheme),
      inherit: true,
      rules: editor?.rules ?? [],
      colors: monacoColors.tokens,
    },
    errors,
  };
}

/** CSS for a resolved theme: `:root{--kl-*}` plus scoped region overrides. */

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

const HEADER = `// GitHappens theme file (JSONC — comments and trailing commas allowed).
//
// To create your own theme: copy this file, rename it to <something>.jsonc (in this folder),
// and give it a unique "meta.name". Saved changes are applied instantly.
//
// Values can be any CSS colour, var(--token) references to other tokens in this file, CSS
// functions (calc, rgb[a], hsl[a], min, max), and LESS colour functions:
//   lighten(c, 10%)  darken(c, 10%)  saturate(c, 10%)  desaturate(c, 10%)
//   fade(c, 40%)     fadein(c, 10%)  fadeout(c, 10%)   spin(c, 30)
//   mix(c1, c2, 50%) tint(c, 20%)    shade(c, 20%)
// Tokens become CSS variables named --kl-<token>. Invalid values fall back to the base theme.
`;

const q = (s: string): string => JSON.stringify(s);

function block(entries: ThemeTokens, indent: string): string {
  return Object.entries(entries)
    .map(([k, v]) => `${indent}${q(k)}: ${q(v)},`)
    .join('\n');
}

/** JSONC text for a theme template (`dark.jsonc-default`, "Create theme from current"). */
export function themeTemplate(opts: {
  name: string;
  scheme: ThemeScheme;
  extendsId?: string;
  tokens: ThemeTokens;
  terminal: ThemeTokens;
  scopes?: Record<string, ThemeTokens>;
}): string {
  const ext = opts.extendsId ?? builtinForScheme(opts.scheme);
  const scopes = opts.scopes ?? {};
  return `${HEADER}{
  "meta": {
    "name": ${q(opts.name)},
    // "dark" or "light": drives native controls and the Monaco base theme.
    "scheme": ${q(opts.scheme)},
    // Tokens you leave out are inherited from this built-in theme.
    "extends": ${q(ext)},
  },
  "themeValues": {
    // Global tokens.
    "root": {
${block(opts.tokens, '      ')}
    },
    // Overrides applied only inside the toolbar / tab bar.
    "toolbar": {
${block(scopes.toolbar ?? {}, '      ')}
    },
    "tabsbar": {
${block(scopes.tabsbar ?? {}, '      ')}
    },
    // Integrated terminal (xterm.js theme keys).
    "terminal": {
${block(opts.terminal, '      ')}
    },
    // Diff / file editor (Monaco). "monacoBase": vs | vs-dark | hc-black | hc-light.
    "editor": {
      "monacoBase": ${q(monacoBaseFor(opts.scheme))},
      "rules": [],
      "colors": {},
    },
  },
}
`;
}

export function builtinTemplate(id: string): string {
  const t = BUILTIN_THEMES[id] ?? BUILTIN_THEMES[DEFAULT_THEME_ID]!;
  return themeTemplate({
    name: `My ${t.name} Theme`,
    scheme: t.scheme,
    extendsId: id,
    tokens: t.tokens,
    terminal: t.terminal,
  });
}
