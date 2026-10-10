/**
 * Atlassian Document Format ↔ markdown-ish text (spec 10 §7 step 20: paragraphs, headings,
 * lists, code, links, mentions; tables rendered as simple pipe tables, read-only).
 */

export interface AdfNode {
  type: string;
  /** Only on the root `doc` node. */
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      const marks = n.marks ?? [];
      const code = marks.some((m) => m.type === 'code');
      if (code) t = `\`${t}\``;
      for (const m of marks) {
        if (m.type === 'strong') t = `**${t}**`;
        else if (m.type === 'em') t = `*${t}*`;
        else if (m.type === 'strike') t = `~~${t}~~`;
      }
      const link = marks.find((m) => m.type === 'link');
      if (link) t = `[${t}](${String(link.attrs?.href ?? '')})`;
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const txt = String(n.attrs?.text ?? n.attrs?.id ?? '');
      return txt.startsWith('@') ? txt : `@${txt}`;
    }
    case 'emoji':
      return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return String(n.attrs?.url ?? '');
    case 'status':
      return `[${String(n.attrs?.text ?? '')}]`;
    case 'date': {
      const ts = Number(n.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'media':
    case 'mediaInline':
      return `[attachment${n.attrs?.alt ? `: ${String(n.attrs.alt)}` : ''}]`;
    default:
      return n.content ? inline(n.content) : (n.text ?? '');
  }
}

function list(n: AdfNode, ordered: boolean, depth: number): string {
  const start = Number(n.attrs?.order ?? 1);
  return (n.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}.` : '-';
      const pad = '  '.repeat(depth);
      const parts = (item.content ?? []).map((c) =>
        c.type === 'bulletList' || c.type === 'orderedList'
          ? list(c, c.type === 'orderedList', depth + 1)
          : block(c, depth + 1).replace(/\n/g, `\n${pad}  `),
      );
      const [first = '', ...rest] = parts;
      return [`${pad}${marker} ${first}`, ...rest].join('\n');
    })
    .join('\n');
}

function block(n: AdfNode, depth = 0): string {
  switch (n.type) {
    case 'doc':
      return blocks(n.content);
    case 'paragraph':
      return inline(n.content);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inline(n.content)}`;
    case 'bulletList':
      return list(n, false, depth);
    case 'orderedList':
      return list(n, true, depth);
    case 'taskList':
      return (n.content ?? [])
        .map((t) => `- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t.content)}`)
        .join('\n');
    case 'codeBlock': {
      const lang = n.attrs?.language ? String(n.attrs.language) : '';
      return `\`\`\`${lang}\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n\`\`\``;
    }
    case 'blockquote':
      return blocks(n.content)
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
    case 'panel': {
      const kind = String(n.attrs?.panelType ?? 'info');
      return `> **${kind}:** ${blocks(n.content).replace(/\n/g, '\n> ')}`;
    }
    case 'rule':
      return '---';
    case 'table': {
      const rows = (n.content ?? []).map((r) =>
        (r.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, ' ').replace(/\|/g, '\\|')),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
      return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map(inlineNode).join(' ');
    case 'expand':
    case 'nestedExpand':
      return [n.attrs?.title ? `**${String(n.attrs.title)}**` : '', blocks(n.content)]
        .filter(Boolean)
        .join('\n\n');
    default:
      return n.content ? blocks(n.content) : inlineNode(n);
  }
}

function blocks(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map((c) => block(c))
    .filter((s) => s !== '')
    .join('\n\n');
}

/** Converts an ADF document (or a plain string, returned as-is) to markdown-ish text. */
export function adfToMarkdown(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object' || !('type' in doc)) return '';
  return block(doc as AdfNode).trim();
}

/** Minimal markdown → ADF: paragraphs (blank-line separated), hard breaks, fenced code, headings. */
export function markdownToAdf(md: string): AdfNode {
  const content: AdfNode[] = [];
  const text = md.replace(/\r\n/g, '\n');
  const fence = /```(\w*)\n([\s\S]*?)\n?```/g;
  let last = 0;
  const pushText = (chunk: string) => {
    for (const para of chunk.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      const h = /^(#{1,6})\s+(.*)$/.exec(p);
      if (h && !p.includes('\n')) {
        content.push({
          type: 'heading',
          attrs: { level: h[1]!.length },
          content: [{ type: 'text', text: h[2]! }],
        });
        continue;
      }
      const lines = p.split('\n');
      const inl: AdfNode[] = [];
      lines.forEach((l, i) => {
        if (i > 0) inl.push({ type: 'hardBreak' });
        if (l) inl.push({ type: 'text', text: l });
      });
      content.push({ type: 'paragraph', content: inl });
    }
  };
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    pushText(text.slice(last, m.index));
    content.push({
      type: 'codeBlock',
      ...(m[1] ? { attrs: { language: m[1] } } : {}),
      content: m[2] ? [{ type: 'text', text: m[2] }] : [],
    });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return { type: 'doc', version: 1, content };
}
