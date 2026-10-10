/**
 * Tiny, safe Markdown subset for the bundled CHANGELOG (spec 15 §4 "What's new"): headings, bullet /
 * numbered lists, fenced code, paragraphs; inline code, bold, italics and http(s) links. Produces a
 * plain AST that React renders as text nodes — no HTML is ever injected.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; text: string }
  | { type: 'paragraph'; inline: Inline[] };

const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;

export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  };
  let pos = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    pushText(src.slice(pos, idx));
    pos = idx + m[0].length;
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: 'strong', text: m[2] ?? m[3] ?? '' });
    else if (m[4] !== undefined && m[5] !== undefined) {
      if (isSafeHref(m[5])) out.push({ type: 'link', text: m[4], href: m[5] });
      else pushText(m[4]);
    } else out.push({ type: 'em', text: m[6] ?? m[7] ?? '' });
  }
  pushText(src.slice(pos));
  return out;
}

const BULLET_RE = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (): void => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith(fence[1] ?? '```'); i++) {
        body.push(lines[i] ?? '');
      }
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: 'heading', level: (h[1] ?? '#').length, inline: parseInline(h[2] ?? '') });
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      if (para.length) flush();
      const ordered = b[1] !== undefined;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(b[2] ?? '');
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}
