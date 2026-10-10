import fs from 'node:fs';
import path from 'node:path';

import { BUILTIN_THEMES, DEFAULT_THEME_ID, isBuiltinThemeId } from '../../shared/settings/builtin-themes';
import {
  builtinResolved,
  builtinTemplate,
  parseThemeFile,
  resolveTheme,
  themePreview,
  themeTemplate,
  type ResolvedTheme,
  type ThemeListEntry,
} from '../../shared/settings/theme-engine';
import { writeFileAtomic } from './atomic-file';

/**
 * Custom themes (spec 13 §5.3, §7 steps 7–8): `userData/themes/*.jsonc`, shared across profiles.
 * Ids: `builtin:<name>` for shipped themes, `user:<file name without .jsonc>` for files.
 * Invalid files are listed with their errors and fall back to the built-in dark theme.
 */
export interface ThemeServiceOptions {
  dir: string;
  /** Debounce for the folder watcher (ms). */
  debounceMs?: number;
  onChanged?: (ids: string[]) => void;
  log?: (message: string) => void;
}

const USER_PREFIX = 'user:';
const fileIdOf = (file: string): string => `${USER_PREFIX}${path.basename(file, '.jsonc')}`;

export class ThemeService {
  private cache = new Map<string, { mtimeMs: number; theme: ResolvedTheme | null; entry: ThemeListEntry }>();
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = new Set<string>();

  constructor(private readonly o: ThemeServiceOptions) {}

  get dir(): string {
    return this.o.dir;
  }

  /** Regenerate the `*.jsonc-default` templates (spec 13 §5.1: rewritten on each start). */
  ensureTemplates(): void {
    fs.mkdirSync(this.o.dir, { recursive: true });
    for (const id of Object.keys(BUILTIN_THEMES)) {
      const name = id.replace(/^builtin:/, '');
      try {
        writeFileAtomic(path.join(this.o.dir, `${name}.jsonc-default`), builtinTemplate(id));
      } catch (e) {
        this.o.log?.(`Could not write theme template ${name}: ${(e as Error).message}`);
      }
    }
  }

  list(): ThemeListEntry[] {
    const builtins: ThemeListEntry[] = Object.keys(BUILTIN_THEMES).map((id) => {
      const t = builtinResolved(id);
      return { id, name: t.name, scheme: t.scheme, source: 'builtin', preview: themePreview(t) };
    });
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(this.o.dir)
        .filter((f) => f.toLowerCase().endsWith('.jsonc'))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      /* folder missing: no user themes */
    }
    const users = files.map((f) => this.load(path.join(this.o.dir, f)).entry);
    return [...builtins, ...users];
  }

  /** Resolved theme by id; unknown or invalid themes resolve to the built-in dark theme (with errors). */
  get(id: string): ResolvedTheme {
    if (isBuiltinThemeId(id)) return builtinResolved(id);
    if (id.startsWith(USER_PREFIX)) {
      const name = id.slice(USER_PREFIX.length);
      if (/^[^\\/:*?"<>|]+$/.test(name) && name !== '.' && name !== '..') {
        const { theme, entry } = this.load(path.join(this.o.dir, `${name}.jsonc`));
        if (theme) return theme;
        return { ...builtinResolved(DEFAULT_THEME_ID), id, errors: entry.errors ?? [] };
      }
    }
    return {
      ...builtinResolved(DEFAULT_THEME_ID),
      errors: [{ message: `Unknown theme "${id}"; using the default dark theme.` }],
    };
  }

  /** Write a new theme file based on `baseId`'s resolved values; returns its id and path. */
  createFromCurrent(baseId: string, name?: string): { id: string; file: string } {
    fs.mkdirSync(this.o.dir, { recursive: true });
    const base = this.get(baseId);
    let n = 1;
    let file: string;
    do {
      file = path.join(this.o.dir, n === 1 ? 'my-theme.jsonc' : `my-theme-${n}.jsonc`);
      n++;
    } while (fs.existsSync(file));
    const display = name?.trim() || `My Theme${n > 2 ? ` ${n - 1}` : ''}`;
    const extendsId = isBuiltinThemeId(baseId)
      ? baseId
      : base.scheme === 'light'
        ? 'builtin:light'
        : 'builtin:dark';
    fs.writeFileSync(
      file,
      themeTemplate({
        name: display,
        scheme: base.scheme,
        extendsId,
        tokens: base.tokens,
        terminal: base.terminal,
        scopes: base.scopes,
      }),
      { flag: 'wx' },
    );
    this.cache.delete(file);
    return { id: fileIdOf(file), file };
  }

  /** Watch the themes folder; `onChanged` receives the ids of changed files (debounced). */
  watch(): void {
    if (this.watcher) return;
    fs.mkdirSync(this.o.dir, { recursive: true });
    try {
      this.watcher = fs.watch(this.o.dir, (_event, filename) => {
        const f = filename?.toString();
        if (!f || !f.toLowerCase().endsWith('.jsonc')) return;
        const full = path.join(this.o.dir, f);
        this.cache.delete(full);
        this.pending.add(fileIdOf(full));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          const ids = [...this.pending];
          this.pending.clear();
          this.o.onChanged?.(ids);
        }, this.o.debounceMs ?? 150);
      });
      this.watcher.on('error', (e) => this.o.log?.(`Theme folder watcher failed: ${e.message}`));
    } catch (e) {
      this.o.log?.(`Could not watch the themes folder: ${(e as Error).message}`);
    }
  }

  /** Drop cached parses (e.g. after a manual "Reload"). */
  invalidate(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private load(file: string): { theme: ResolvedTheme | null; entry: ThemeListEntry } {
    const id = fileIdOf(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      const entry: ThemeListEntry = {
        id,
        name: path.basename(file),
        scheme: 'dark',
        source: 'user',
        file,
        errors: [{ message: 'Theme file not found' }],
        preview: [],
      };
      return { theme: null, entry };
    }
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit;

    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    } catch (e) {
      const entry: ThemeListEntry = {
        id,
        name: path.basename(file),
        scheme: 'dark',
        source: 'user',
        file,
        errors: [{ message: (e as Error).message }],
        preview: [],
      };
      return { theme: null, entry };
    }
    const parsed = parseThemeFile(text);
    let result: { mtimeMs: number; theme: ResolvedTheme | null; entry: ThemeListEntry };
    if (!parsed.ok) {
      result = {
        mtimeMs: stat.mtimeMs,
        theme: null,
        entry: {
          id,
          name: path.basename(file),
          scheme: 'dark',
          source: 'user',
          file,
          errors: parsed.errors,
          preview: [],
        },
      };
    } else {
      const theme = resolveTheme(parsed.theme, id, { filePath: file, tree: parsed.tree, text: parsed.text });
      result = {
        mtimeMs: stat.mtimeMs,
        theme,
        entry: {
          id,
          name: theme.name,
          scheme: theme.scheme,
          source: 'user',
          file,
          errors: theme.errors.length ? theme.errors : undefined,
          preview: themePreview(theme),
        },
      };
    }
    this.cache.set(file, result);
    return result;
  }
}
