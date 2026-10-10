/**
 * Pure helpers for clone / init requests (spec 03 §6): custom clone flag allowlist, credential stripping for
 * URLs, sparse pattern classification and LFS detection. No processes, no fs (except `usesLfs`).
 */

/** Clone flags a user may add through "custom flags" (spec 03 §6 allowlist). */
export const CLONE_FLAG_ALLOWLIST = [
  '--depth',
  '--shallow-since',
  '--shallow-exclude',
  '--single-branch',
  '--no-single-branch',
  '--no-tags',
  '--filter',
  '--origin',
  '--jobs',
  '--reference',
  '--dissociate',
] as const;

/** Allowlisted flags that take a value (`--flag=value` or `--flag value`). */
const VALUE_FLAGS = new Set([
  '--depth',
  '--shallow-since',
  '--shallow-exclude',
  '--filter',
  '--origin',
  '--jobs',
  '--reference',
]);

/** Shell-words tokenizer: whitespace separated, single/double quotes, backslash escapes outside single quotes. */
export function tokenizeFlags(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length && /["\\]/.test(input[i + 1]!))
        cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in custom flags.');
  if (has) out.push(cur);
  return out;
}

/**
 * Validate "custom flags" against the allowlist and normalize to `--flag=value` argv entries. Anything else
 * (e.g. `--upload-pack`, `-u`, `--config`, `-c`, positionals) is rejected: no arbitrary command execution.
 */
export function parseCustomCloneFlags(input: string | undefined): string[] {
  if (!input?.trim()) return [];
  const tokens = tokenizeFlags(input);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/[\0\r\n]/.test(t)) throw new Error('Custom flags must not contain control characters.');
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(0, eq) : t;
    if (!(CLONE_FLAG_ALLOWLIST as readonly string[]).includes(name)) {
      throw new Error(`The flag "${name}" is not allowed. Allowed: ${CLONE_FLAG_ALLOWLIST.join(', ')}.`);
    }
    if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (eq > 0) value = t.slice(eq + 1);
      else value = tokens[++i];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new Error(`The flag "${name}" needs a value.`);
      }
      if ((name === '--depth' || name === '--jobs') && !/^\d+$/.test(value)) {
        throw new Error(`The flag "${name}" needs a number.`);
      }
      out.push(`${name}=${value}`);
    } else {
      if (eq > 0) throw new Error(`The flag "${name}" does not take a value.`);
      out.push(name);
    }
  }
  return out;
}

/** `https://user:token@host/x.git` → `https://host/x.git` (spec 03 §8). scp-style / local paths unchanged. */
export function stripUrlCredentials(url: string): { url: string; hadCredentials: boolean } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)(.*)$/i.exec(url.trim());
  if (!m) return { url: url.trim(), hadCredentials: false };
  const userinfo = m[2]!.slice(0, -1);
  // `ssh://git@host` carries a user name only — that is not a secret and ssh needs it.
  if (/^ssh:|^git\+ssh:/i.test(m[1]!) && !userinfo.includes(':'))
    return { url: url.trim(), hadCredentials: false };
  return { url: `${m[1]}${m[3]}`, hadCredentials: true };
}

/** True when the URL carries a password/token (or an http(s) user name) in its userinfo. */
export const urlHasCredentials = (url: string): boolean => stripUrlCredentials(url).hadCredentials;

/** Sparse patterns: cone mode unless a pattern needs gitignore-style matching (globs, negation, root anchors). */
export function sparseUsesCone(patterns: string[]): boolean {
  return patterns.every((p) => !/[*?[\]!]/.test(p) && !p.startsWith('/'));
}

/** Clean up a sparse path list (one per line in the UI): trim, drop blanks/dupes, normalise separators. */
export function normalizeSparsePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim().replace(/\\/g, '/');
    if (!p || p.startsWith('#')) continue;
    if (/[\0\r\n]/.test(p) || p.startsWith('-')) throw new Error(`Invalid sparse path: "${raw}".`);
    if (p.split('/').includes('..'))
      throw new Error(`Sparse paths must stay inside the repository: "${raw}".`);
    const cleaned = sparseUsesCone([p]) ? p.replace(/\/+$/, '') : p;
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** Does `.gitattributes` text route anything through the LFS filter? */
export function attributesUseLfs(text: string): boolean {
  return text.split(/\r?\n/).some((l) => !l.trimStart().startsWith('#') && /(^|\s)filter=lfs(\s|$)/.test(l));
}
