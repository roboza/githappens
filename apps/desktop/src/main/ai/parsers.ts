import { z } from 'zod';

import type {
  CommitMessageResult,
  ComposeHunkRef,
  ComposeProposal,
  ConflictProposal,
  PrDraftResult,
} from '../../shared/ipc/ai-contract';

/**
 * Output schemas and post-processing (spec 12 §6.5). Model output is untrusted: everything is validated
 * structurally before it can fill a UI field, and nothing here ever runs a command.
 */

export const CommitMessageSchema = z.object({
  summary: z.string().describe('One line, imperative mood, at most 72 characters (ideally 50).'),
  description: z.string().describe('Body explaining why; empty string when the summary says it all.'),
});

export const PrDraftSchema = z.object({
  title: z.string().describe('Pull request title, at most 72 characters.'),
  body: z.string().describe('Pull request description in GitHub-flavored markdown.'),
});

export const ConflictSchema = z.object({
  proposals: z.array(
    z.object({
      hunkId: z.string(),
      resolvedText: z
        .string()
        .describe('Full replacement text for the conflicted region, no conflict markers.'),
      explanation: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export const ComposeSchema = z.object({
  commits: z.array(
    z.object({
      summary: z.string(),
      description: z.string(),
      hunkIds: z.array(z.string()),
    }),
  ),
});

export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

/**
 * Pull a JSON object out of model text: strips markdown fences and leading/trailing prose that small
 * local models add despite instructions.
 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new InvalidOutputError('The response did not contain a JSON object.');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new InvalidOutputError(`The response was not valid JSON: ${(e as Error).message}`);
  }
}

export function parseWith<T>(schema: z.ZodType<T>, text: string): T {
  const r = schema.safeParse(extractJson(text));
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new InvalidOutputError(
      `The response did not match the expected shape${issue ? ` (${issue.path.join('.') || 'root'}: ${issue.message})` : ''}.`,
    );
  }
  return r.data;
}

// ---- text post-processing ----

/** First line, trimmed, one trailing period removed (an ellipsis is kept). */
export function cleanSummary(s: string): string {
  let line = (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  line = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (line.endsWith('.') && !line.endsWith('..')) line = line.slice(0, -1).trimEnd();
  return line;
}

const LISTISH = /^\s*([-*+]\s|\d+[.)]\s|>|\|)/;

/** Greedy word wrap of one paragraph at `width` (words longer than width stay whole). */
function wrapParagraph(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Hard-wrap a commit body at 72 columns, paragraph by paragraph. Bodies with code blocks, lists, quotes,
 * tables or indented lines are left as written (only trailing whitespace is trimmed).
 */
export function wrapDescription(text: string, width = 72): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (!body) return '';
  const lines = body.split('\n');
  if (body.includes('```') || lines.some((l) => LISTISH.test(l) || /^( {4}|\t)/.test(l))) return body;
  return body
    .split(/\n{2,}/)
    .map((p) => wrapParagraph(p.replace(/\n/g, ' '), width).join('\n'))
    .join('\n\n');
}

export function postCommitMessage(r: CommitMessageResult): CommitMessageResult {
  return { summary: cleanSummary(r.summary), description: wrapDescription(r.description) };
}

export function postPrDraft(r: PrDraftResult): PrDraftResult {
  return { title: cleanSummary(r.title), body: r.body.trim() };
}

const MARKER = /^(<{7}|={7}|>{7}|\|{7})(\s|$)/m;

/** Keep proposals for known hunks (first one wins); any with conflict markers are downgraded to low. */
export function postConflicts(
  proposals: z.infer<typeof ConflictSchema>['proposals'],
  known: string[],
): ConflictProposal[] {
  const ids = new Set(known);
  const seen = new Set<string>();
  const out: ConflictProposal[] = [];
  for (const p of proposals) {
    if (!ids.has(p.hunkId) || seen.has(p.hunkId)) continue;
    seen.add(p.hunkId);
    const proposal: ConflictProposal = {
      hunkId: p.hunkId,
      resolvedText: p.resolvedText,
      explanation: p.explanation.trim(),
      confidence: p.confidence,
    };
    if (MARKER.test(p.resolvedText)) {
      proposal.confidence = 'low';
      proposal.warning = 'The proposal still contains conflict markers.';
    }
    out.push(proposal);
  }
  return out;
}

/**
 * Compose validation (spec 12 §6.5): every input hunk exactly once. Unknown ids are dropped, duplicates
 * keep their first commit, missing ids go to `unassigned`, commits left without hunks are removed.
 */
export function postCompose(raw: z.infer<typeof ComposeSchema>, hunks: ComposeHunkRef[]): ComposeProposal {
  const byId = new Map(hunks.map((h) => [h.hunkId, h]));
  const used = new Set<string>();
  const commits: ComposeProposal['commits'] = [];
  for (const c of raw.commits) {
    const refs: ComposeHunkRef[] = [];
    for (const id of c.hunkIds) {
      const h = byId.get(id);
      if (!h || used.has(id)) continue;
      used.add(id);
      refs.push({ path: h.path, hunkId: h.hunkId });
    }
    if (!refs.length) continue;
    const msg = postCommitMessage({ summary: c.summary, description: c.description });
    commits.push({ ...msg, hunks: refs });
  }
  const unassigned = hunks
    .filter((h) => !used.has(h.hunkId))
    .map((h) => ({ path: h.path, hunkId: h.hunkId }));
  return { commits, unassigned };
}

// ---- streaming helpers ----

/**
 * Best-effort value of a string field in an incomplete JSON document (`{"summary": "Fix the pa`), for
 * progressive fill while a structured response streams. Returns undefined until the field starts.
 */
export function partialStringField(text: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(text);
  if (!m) return undefined;
  let out = '';
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = text[i + 1];
    if (n === undefined) return out;
    i++;
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (hex.length < 4) return out;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}
