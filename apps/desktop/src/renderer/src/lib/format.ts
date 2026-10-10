import type { SettingValue } from '../../../shared/settings/registry';

type DateFormat = SettingValue<'ui.dateFormat'>;

/** Locale / clock for every formatted date (spec 13 `ui.dateLocale`, `ui.hour12`). */
export interface DateOptions {
  /** BCP-47 tag; undefined follows the OS. */
  locale?: string;
  /** undefined follows the locale. */
  hour12?: boolean;
}

/** Resolve the settings into Intl options; invalid locales fall back to the OS locale. */
export function dateOptionsFrom(
  locale: string | undefined,
  hour12: SettingValue<'ui.hour12'> | undefined,
): DateOptions {
  const o: DateOptions = {};
  const tag = locale?.trim();
  if (tag && tag !== 'system') {
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length) o.locale = tag;
    } catch {
      /* RangeError: invalid tag → OS locale */
    }
  }
  if (hour12 === '12') o.hour12 = true;
  if (hour12 === '24') o.hour12 = false;
  return o;
}

let current: DateOptions = {};
let rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Apply `ui.dateLocale` / `ui.hour12` app-wide (called by the settings bridge). */
export function configureDates(o: DateOptions): void {
  current = { ...o };
  rtf = new Intl.RelativeTimeFormat(o.locale, { numeric: 'auto' });
}

export const dateOptions = (): DateOptions => current;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const withClock = (o: Intl.DateTimeFormatOptions, d: DateOptions): Intl.DateTimeFormatOptions =>
  d.hour12 === undefined ? o : { ...o, hour12: d.hour12 };

type DateStyles = Pick<Intl.DateTimeFormatOptions, 'dateStyle' | 'timeStyle'>;
/**
 * `Date#toLocaleString(locale, options)` builds a new Intl formatter on every call (≈ 3 µs+ each; the graph
 * formats a full date per visible row while scrolling), so formatters are cached per locale / clock / style.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(style: DateStyles, opts: DateOptions): Intl.DateTimeFormat {
  const key = `${opts.locale ?? ''}|${opts.hour12 ?? ''}|${style.dateStyle}|${style.timeStyle}`;
  let f = formatters.get(key);
  if (!f) {
    if (formatters.size > 64) formatters.clear();
    f = new Intl.DateTimeFormat(opts.locale, withClock(style, opts));
    formatters.set(key, f);
  }
  return f;
}

/** Commit date per `ui.dateFormat` (spec 13). `unixSeconds` as stored by spec 02. */
export function formatDate(
  unixSeconds: number,
  format: DateFormat = 'relative',
  now = Date.now(),
  opts: DateOptions = current,
): string {
  const d = new Date(unixSeconds * 1000);
  switch (format) {
    case 'iso':
      return d.toISOString().replace('T', ' ').slice(0, 19);
    case 'short':
      return dateTimeFormat({ dateStyle: 'short', timeStyle: 'short' }, opts).format(d);
    case 'long':
      return dateTimeFormat({ dateStyle: 'long', timeStyle: 'medium' }, opts).format(d);
    default: {
      const diff = unixSeconds - now / 1000;
      const f = opts === current ? rtf : new Intl.RelativeTimeFormat(opts.locale, { numeric: 'auto' });
      for (const [unit, secs] of UNITS) {
        if (Math.abs(diff) >= secs) return f.format(Math.round(diff / secs), unit);
      }
      return 'just now';
    }
  }
}

export const fullDate = (unixSeconds: number, opts: DateOptions = current): string =>
  dateTimeFormat({ dateStyle: 'full', timeStyle: 'long' }, opts).format(new Date(unixSeconds * 1000));

/** Clock time (toasts, activity log). */
export const formatTime = (epochMs: number, opts: DateOptions = current): string =>
  new Date(epochMs).toLocaleTimeString(opts.locale, withClock({ timeStyle: 'medium' }, opts));

export const shortSha = (sha: string, n = 7): string => sha.slice(0, n);

/** Stable color + initials for author avatars (spec 04 initials mode). */
export function authorInitials(name: string, email: string): { text: string; color: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const text =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : (parts[0]?.slice(0, 2) ?? email.slice(0, 2) ?? '?');
  let h = 0;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { text: text.toUpperCase(), color: `hsl(${h % 360} 45% 42%)` };
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Case-insensitive fuzzy subsequence match (spec 01 §4.5); returns matched indices or null. */
export function fuzzyMatch(text: string, query: string): number[] | null {
  if (!query) return [];
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const hits: number[] = [];
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return null;
    hits.push(ti++);
  }
  return hits;
}

export interface TreeNode<T> {
  name: string;
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

/** Build a folder tree from `/`-separated names (refs, file paths). Single-child folders are not merged. */
export function buildTree<T>(items: T[], nameOf: (t: T) => string): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [] };
  for (const item of items) {
    const segs = nameOf(item).split('/');
    let node = root;
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join('/');
      const leaf = i === segs.length - 1;
      let child = node.children.find((c) => c.name === seg && (leaf ? !c.children.length : !c.item));
      if (!child || leaf) {
        child = { name: seg, path: p, children: [] };
        node.children.push(child);
      }
      if (leaf) child.item = item;
      node = child;
    });
  }
  const sort = (n: TreeNode<T>): void => {
    n.children.sort((a, b) => Number(!!a.item) - Number(!!b.item) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
