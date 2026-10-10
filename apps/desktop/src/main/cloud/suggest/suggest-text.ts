/**
 * Code Suggest text helpers (spec 14 §6.4): the PR comment we post, finding our links in PR comments
 * (works without the server), filtering a patch by file and the co-author trailer.
 */

export const SUGGESTION_LABEL = 'code-suggestion';

/** Hidden marker so comments are recognised even if the visible text is edited. */
const MARKER_RE = /<!--\s*githappens-suggestion\s+([^>]*?)\s*-->/;
const DEEP_RE = /githappens:\/\/suggestion\/([A-Za-z0-9-]{6,64})(?:#k=([A-Za-z0-9_-]{16,128}))?/;
const WEB_RE = /(https?:\/\/[^\s)<>"']+?)\/p\/([A-Za-z0-9]{22})(?:#k=([A-Za-z0-9_-]{16,128}))?/;

export interface SuggestionCommentInput {
  title: string;
  fileCount: number;
  /** Server suggestion id (absent when the server could not record it). */
  id?: string;
  patchId: string;
  /** `<server>/p/<patchId>` (without key). */
  webUrl: string;
  key?: string;
}

export function suggestionDeepLink(idOrPatch: string, key?: string): string {
  return `githappens://suggestion/${idOrPatch}${key ? `#k=${key}` : ''}`;
}

/** Markdown comment posted on the PR (provider-agnostic). */
export function formatSuggestionComment(c: SuggestionCommentInput): string {
  const frag = c.key ? `#k=${c.key}` : '';
  const deep = suggestionDeepLink(c.id ?? c.patchId, c.key);
  const title = c.title.replace(/[\r\n]+/g, ' ').replace(/([*_`[\]])/g, '\\$1');
  return [
    `💡 **Code suggestion:** ${title} — ${c.fileCount} file${c.fileCount === 1 ? '' : 's'}`,
    '',
    `Open in GitHappens: ${deep} · View: ${c.webUrl}${frag}`,
    '',
    `<!-- githappens-suggestion ${c.id ? `id=${c.id} ` : ''}patch=${c.patchId} -->`,
  ].join('\n');
}

export interface ParsedSuggestionComment {
  id?: string;
  patchId: string;
  key?: string;
  /** Server origin from the web link. */
  server?: string;
  webUrl: string;
  title?: string;
}

/** Our links in a comment body, or null. */
export function parseSuggestionComment(body: string): ParsedSuggestionComment | null {
  const web = WEB_RE.exec(body);
  const deep = DEEP_RE.exec(body);
  const marker = MARKER_RE.exec(body);
  const attrs = new Map(
    (marker?.[1] ?? '')
      .split(/\s+/)
      .map((kv) => kv.split('=') as [string, string])
      .filter((kv) => kv.length === 2),
  );
  const patchId = web?.[2] ?? attrs.get('patch');
  if (!patchId || !/^[A-Za-z0-9]{22}$/.test(patchId)) return null;
  if (!web && !deep && !marker) return null;
  const markerId = attrs.get('id');
  const deepId = deep?.[1] && deep[1] !== patchId ? deep[1] : undefined;
  const id = markerId && /^[0-9a-f-]{36}$/i.test(markerId) ? markerId : deepId;
  const key = web?.[3] ?? deep?.[2];
  const title = /\*\*Code suggestion:\*\*\s*(.+?)\s+—\s+\d+ files?/
    .exec(body)?.[1]
    ?.replace(/\\([*_`[\]])/g, '$1');
  return {
    ...(id ? { id } : {}),
    patchId,
    ...(key ? { key } : {}),
    ...(web ? { server: web[1] } : {}),
    webUrl: web ? `${web[1]}/p/${patchId}` : '',
    ...(title ? { title } : {}),
  };
}

/** Split `git diff --binary` output into per-file chunks (in order). */
export function splitPatchByFile(patch: string): string[] {
  const out: string[] = [];
  const lines = patch.split('\n');
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (cur) out.push(cur.join('\n'));
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join('\n'));
  return out.map((c) => (c.endsWith('\n') ? c : `${c}\n`));
}

/** Keep only the chunks at `keep` (indexes into `splitPatchByFile`). */
export function filterPatch(patch: string, keep: ReadonlySet<number>): string {
  return splitPatchByFile(patch)
    .filter((_c, i) => keep.has(i))
    .join('');
}

/** Commit message for "Commit & push to PR branch" with the `Co-authored-by` trailer. */
export function suggestionCommitMessage(title: string, coAuthor?: { name: string; email: string }): string {
  const subject = `Apply code suggestion: ${title.replace(/[\r\n]+/g, ' ').trim()}`;
  if (!coAuthor) return subject;
  const name = coAuthor.name.replace(/[<>\r\n]/g, '').trim();
  const email = coAuthor.email.replace(/[<>\s]/g, '');
  return `${subject}\n\nCo-authored-by: ${name} <${email}>`;
}

/** Fallback co-author from a provider login (GitHub noreply address on github.com). */
export function coAuthorFromLogin(login: string, host: string): { name: string; email: string } {
  const h = host.toLowerCase();
  const domain = h === 'github.com' ? 'users.noreply.github.com' : `users.noreply.${h}`;
  return { name: login, email: `${login}@${domain}` };
}
