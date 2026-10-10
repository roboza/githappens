import type { LfsStatus } from '@githappens/git/types';

/** Pure Git LFS helpers (spec 09 §6.8): `.gitattributes` pattern matching for the "LFS" file badge. */

function globBody(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = any leading dirs, `/**` = everything inside, lone `**` = anything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      re += glob[++i]!.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/**
 * `.gitattributes` pattern → RegExp over repo-relative `/` paths. Patterns without a `/` match the
 * basename at any depth; patterns with a `/` are anchored to the repo root (gitattributes rules).
 */
export function attributePatternRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  if (p.endsWith('/')) p = `${p}**`; // directory patterns don't apply in .gitattributes, be lenient
  if (!p.includes('/')) return new RegExp(`(?:^|/)${globBody(p)}$`);
  return new RegExp(`^${globBody(p.replace(/^\//, ''))}$`);
}

/** Path predicate for the tracked patterns (empty list → always false). */
export function lfsMatcher(tracked: readonly { pattern: string }[]): (path: string) => boolean {
  const res: RegExp[] = [];
  for (const t of tracked) {
    try {
      res.push(attributePatternRegExp(t.pattern));
    } catch {
      /* unparsable pattern */
    }
  }
  if (!res.length) return () => false;
  return (path) => {
    const p = path.replace(/\\/g, '/');
    return res.some((r) => r.test(p));
  };
}

/** Whether to offer the LFS menu: git-lfs is available (Initialize works even without patterns). */
export const lfsMenuAvailable = (s: Pick<LfsStatus, 'available'> | undefined): boolean => !!s?.available;

/** The toolbar LFS button: shown for repos that use LFS (tracked patterns or installed hooks). */
export function lfsInUse<S extends Pick<LfsStatus, 'available' | 'initialized' | 'tracked'>>(
  s: S | undefined,
): s is S {
  return !!s?.available && (s.tracked.length > 0 || s.initialized);
}

/** "Convert existing files" pattern input → patterns list or error. */
export function parsePatterns(text: string): { patterns: string[] } | { error: string } {
  const patterns = text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) return { error: 'Enter at least one pattern, e.g. *.psd' };
  const bad = patterns.find((p) => p.startsWith('-') || /[\0\r]/.test(p));
  return bad ? { error: `Invalid pattern: ${bad}` } : { patterns: [...new Set(patterns)] };
}
