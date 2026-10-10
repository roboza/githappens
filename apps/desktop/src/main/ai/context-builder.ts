import fs from 'node:fs';
import path from 'node:path';

import { readComposeDiff, type ComposeDiff, type GitService } from '@githappens/git';

import type { AiRequest, ComposeHunkInfo, ExplainResult } from '../../shared/ipc/ai-contract';
import type { ContextSection } from './prompts';
import { AiProviderError } from './providers/types';

/**
 * ContextBuilder (spec 12 §6.4): gathers git data per feature through GitService read calls, drops
 * excluded/binary files (listed by name only), redacts likely secrets and fits the result into the
 * `ai.maxDiffChars` budget by truncating per-file patches with a `[truncated]` marker.
 */

export interface ContextOptions {
  maxChars: number;
  excludeGlobs: string[];
}

export interface BuiltContext {
  task: string;
  sections: ContextSection[];
  notes: string[];
  truncated: boolean;
  /** Files whose content was not sent (excluded by settings, binary). */
  omitted: string[];
  range?: ExplainResult['range'];
  compose?: { diff: ComposeDiff; hunks: ComposeHunkInfo[] };
  conflictIds?: string[];
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BUFFER = 256 * 1024 * 1024;
const TRUNCATE_STEPS = [400, 200, 100, 50, 25, 10];
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv'];
export const TRUNCATED = '[truncated]';
export const REDACTED = '[REDACTED]';

const nothing = (message: string): AiProviderError => new AiProviderError('nothing', message);
const tooLarge = (): AiProviderError =>
  new AiProviderError('too-large', 'The changes are too large to send, even truncated. Select fewer files.');

// ---- globs ----

/** Glob → RegExp over `/`-separated repo paths. Patterns without a slash match at any depth. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (!g.includes('/')) g = `**/${g}`;
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function makeExcluder(globs: string[]): (p: string) => boolean {
  const res = globs.filter((g) => g.trim()).map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

// ---- secret redaction ----

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}["']?/gi,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
];
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const isEnvFile = (p: string | undefined): boolean => !!p && /(^|\/)\.env(\.[^/]*)?$/i.test(p);

/**
 * Redact likely secrets line by line: known token formats, `key = "value"` assignments, private key blocks
 * (whole block) and every `KEY=value` line of `.env`-style files. Diff prefixes (`+`, `-`, ` `) are kept.
 */
export function redactSecrets(text: string, filePath?: string): string {
  const env = isEnvFile(filePath);
  let inKey = false;
  return text
    .split('\n')
    .map((line) => {
      const prefix = /^[-+ ]/.test(line) && !/^(---|\+\+\+) /.test(line) ? line[0]! : '';
      const body = line.slice(prefix.length);
      if (inKey) {
        if (PRIVATE_KEY_END.test(body)) inKey = false;
        return `${prefix}${REDACTED}`;
      }
      if (PRIVATE_KEY_BEGIN.test(body)) {
        inKey = !PRIVATE_KEY_END.test(body);
        return `${prefix}${REDACTED}`;
      }
      if (env) {
        const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=)\s*\S.*$/.exec(body);
        if (m) return `${prefix}${m[1]}${REDACTED}`;
      }
      let out = body;
      for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
      return prefix + out;
    })
    .join('\n');
}

// ---- diff budgeting ----

interface DiffFile {
  path: string;
  header: string;
  body: string;
  binary: boolean;
}

function filePathOf(chunk: string[]): string {
  for (const l of chunk) {
    if (l.startsWith('+++ ') && l !== '+++ /dev/null')
      return l
        .slice(4)
        .replace(/^"?b\//, '')
        .replace(/"$/, '');
    if (l.startsWith('rename to ')) return l.slice('rename to '.length);
  }
  for (const l of chunk) {
    if (l.startsWith('--- ') && l !== '--- /dev/null')
      return l
        .slice(4)
        .replace(/^"?a\//, '')
        .replace(/"$/, '');
  }
  const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(chunk[0] ?? '');
  return m ? m[2]! : (chunk[0] ?? '').slice('diff --git '.length);
}

/** Split `git diff`/`git show` patch output into per-file parts (anything before the first file is dropped). */
export function splitDiffFiles(text: string): DiffFile[] {
  const lines = text.split('\n');
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ')) {
      i++;
      continue;
    }
    const start = i++;
    while (i < lines.length && !lines[i]!.startsWith('diff --git ')) i++;
    const chunk = lines.slice(start, i);
    const firstHunk = chunk.findIndex((l) => l.startsWith('@@'));
    const headerEnd = firstHunk < 0 ? chunk.length : firstHunk;
    files.push({
      path: filePathOf(chunk),
      header: chunk.slice(0, headerEnd).join('\n'),
      body: chunk.slice(headerEnd).join('\n').replace(/\n+$/, ''),
      binary: chunk.some((l) => l === 'GIT binary patch' || /^Binary files .* differ$/.test(l)),
    });
  }
  return files;
}

export interface FittedDiff {
  text: string;
  truncated: boolean;
  omitted: string[];
}

const truncateBody = (body: string, n: number): string => {
  const lines = body.split('\n');
  return lines.length <= n ? body : `${lines.slice(0, n).join('\n')}\n${TRUNCATED}`;
};

/**
 * Fit a multi-file patch into `budget` chars (spec 12 §6.4 budgeting): (1) excluded globs and (2) binary
 * files are dropped and listed by name, (3) per-file patches are truncated to their first N lines with a
 * `[truncated]` marker (N decreasing), (4) still too large → `too-large`.
 */
export function fitDiff(raw: string, budget: number, excluded: (p: string) => boolean): FittedDiff {
  const omitted: string[] = [];
  const kept: DiffFile[] = [];
  for (const f of splitDiffFiles(raw)) {
    if (excluded(f.path)) omitted.push(f.path);
    else if (f.binary) omitted.push(`${f.path} (binary)`);
    else kept.push({ ...f, header: redactSecrets(f.header, f.path), body: redactSecrets(f.body, f.path) });
  }
  const render = (fs: DiffFile[]): string =>
    fs.map((f) => (f.body ? `${f.header}\n${f.body}` : f.header)).join('\n');
  let text = render(kept);
  if (text.length <= budget) return { text, truncated: false, omitted };
  for (const n of TRUNCATE_STEPS) {
    text = render(kept.map((f) => ({ ...f, body: truncateBody(f.body, n) })));
    if (text.length <= budget) return { text, truncated: true, omitted };
  }
  throw tooLarge();
}

// ---- repo-level switches ----

/** `githappens.ai=false` in the repo's git config disables AI for it (spec 12 §8 Privacy). */
export async function repoAiDisabled(svc: GitService): Promise<boolean> {
  const r = await svc.runRead(['config', '--type=bool', '--get', 'githappens.ai'], {
    expectedExitCodes: [0, 1, 128],
  });
  return r.exitCode === 0 && r.stdout.trim() === 'false';
}

/** `.githappens/ai-instructions.md` in the worktree root (capped). */
export function readRepoInstructions(svc: GitService, maxChars = 8000): string {
  const root = svc.repo.worktreeRoot;
  if (!root) return '';
  try {
    return fs.readFileSync(path.join(root, '.githappens', 'ai-instructions.md'), 'utf8').slice(0, maxChars);
  } catch {
    return ''; // missing
  }
}

const SAFE_REV = /^[^\s-][^\s\0]*$/;
function assertRev(rev: string, what: string): string {
  if (!SAFE_REV.test(rev) || rev.includes('..'))
    throw new AiProviderError('provider', `Invalid ${what}: "${rev}".`);
  return rev;
}

const ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export class ContextBuilder {
  private readonly excluded: (p: string) => boolean;

  constructor(
    private readonly svc: GitService,
    private readonly o: ContextOptions,
  ) {
    this.excluded = makeExcluder(o.excludeGlobs);
  }

  private async run(
    args: string[],
    codes: number[] = [0],
  ): Promise<{ stdout: string; exitCode: number | null }> {
    const r = await this.svc.runRead(args, { maxBuffer: MAX_BUFFER, expectedExitCodes: codes });
    return { stdout: r.stdout, exitCode: r.exitCode };
  }

  private async out(args: string[], codes: number[] = [0]): Promise<string> {
    const r = await this.run(args, codes);
    return r.exitCode === 0 ? r.stdout : '';
  }

  build(req: AiRequest): Promise<BuiltContext> {
    switch (req.feature) {
      case 'commitMessage':
        return req.sha
          ? this.commitMessageFor(req.sha, req.hint, req.current)
          : this.commitMessage(!!req.amend, req.hint, req.current);
      case 'stashMessage':
        return this.stashMessage();
      case 'explainCommits':
        return this.explainCommits(req.shas);
      case 'explainBranch':
        return this.branchRange(req.branch, req.base, 'explain');
      case 'explainWip':
        return this.explainWip();
      case 'conflictResolve':
        return this.conflict(req.path, req.hunks);
      case 'prDraft':
        return this.branchRange(req.head, req.base, 'pr', req.template);
      case 'composeCommits':
        return this.compose(req.source);
      case 'changelog':
        return this.changelog(req.from, req.to);
    }
  }

  /** Stat + fitted patch as two sections; the stat is always complete. */
  private diffSections(
    stat: string,
    patch: string,
    budget = this.o.maxChars,
  ): FittedDiff & { sections: ContextSection[] } {
    const s = redactSecrets(stat.trim());
    const fitted = fitDiff(patch, Math.max(0, budget - s.length), this.excluded);
    const sections: ContextSection[] = [];
    if (s) sections.push({ tag: 'stat', content: s });
    sections.push({ tag: 'diff', content: fitted.text || '(no textual changes)' });
    return { ...fitted, sections };
  }

  private omittedNotes(omitted: string[], truncated: boolean): string[] {
    const notes: string[] = [];
    if (omitted.length) notes.push(`Content not shown for: ${omitted.slice(0, 50).join(', ')}`);
    if (truncated) notes.push(`Some patches were cut at "${TRUNCATED}" to fit the size limit.`);
    return notes;
  }

  private async branchName(): Promise<string> {
    return (await this.out(['symbolic-ref', '--short', '-q', 'HEAD'], [0, 1, 128])).trim();
  }

  private async commitMessage(
    amend: boolean,
    hint?: 'shorter' | 'conventional',
    current?: string,
  ): Promise<BuiltContext> {
    const head = await this.svc.revParse('HEAD');
    const parent = amend && head ? ((await this.svc.revParse('HEAD~1')) ?? EMPTY_TREE) : null;
    const against = parent ? [parent] : [];
    const stat = await this.out(['diff', '--cached', ...DIFF, '--stat=200', '-M', ...against, '--']);
    if (!stat.trim()) throw nothing(amend ? 'There is nothing to amend.' : 'Stage changes first.');
    const patch = await this.out(['diff', '--cached', ...DIFF, '-U3', '--find-renames', ...against, '--']);
    const d = this.diffSections(stat, patch);
    const branch = await this.branchName();
    const subjects = (await this.out(['log', '-10', '--format=%s', '--'], [0, 128])).trim();
    const notes = this.omittedNotes(d.omitted, d.truncated);
    const sections: ContextSection[] = [];
    if (branch) {
      const key = ISSUE_KEY.exec(branch)?.[1];
      notes.unshift(`Branch: ${branch}${key ? ` (issue key ${key})` : ''}`);
    }
    if (subjects) sections.push({ tag: 'recent-subjects', content: subjects });
    if (amend && head) {
      const msg = (await this.out(['log', '-1', '--format=%B', 'HEAD', '--'])).trim();
      if (msg) sections.push({ tag: 'current-message', content: redactSecrets(msg) });
    }
    sections.push(...d.sections);
    let task = amend
      ? 'Write a commit message for the amended commit: the diff shows the commit being amended plus the staged changes.'
      : 'Write a commit message for the staged changes below.';
    if (subjects) task += ' Match the style of the recent subjects where sensible.';
    if (hint === 'shorter') {
      task += ' Make it shorter than the current message: a concise summary and at most a two-line body.';
      if (current?.trim())
        sections.unshift({ tag: 'current-message', content: redactSecrets(current.trim()) });
    }
    if (hint === 'conventional') task += ' Use the Conventional Commits format for this message.';
    return { task, sections, notes, truncated: d.truncated, omitted: d.omitted };
  }

  /** Message for an existing commit ("Reword with AI" in the interactive rebase view): `git show <sha>`. */
  private async commitMessageFor(
    shaIn: string,
    hint?: 'shorter' | 'conventional',
    current?: string,
  ): Promise<BuiltContext> {
    const sha = assertRev(shaIn, 'commit');
    const stat = await this.out(['show', ...DIFF, '--format=', '--stat=200', '-M', sha, '--']);
    if (!stat.trim()) throw nothing(`Commit ${sha.slice(0, 7)} has no changes to describe.`);
    const patch = await this.out(['show', ...DIFF, '--format=', '-U3', '--find-renames', sha, '--']);
    const d = this.diffSections(stat, patch);
    const original = (await this.out(['log', '-1', '--format=%B', sha, '--'])).trim();
    const subjects = (await this.out(['log', '-10', '--format=%s', `${sha}~1`, '--'], [0, 128])).trim();
    const branch = await this.branchName();
    const notes = this.omittedNotes(d.omitted, d.truncated);
    if (branch) {
      const key = ISSUE_KEY.exec(branch)?.[1];
      notes.unshift(`Branch: ${branch}${key ? ` (issue key ${key})` : ''}`);
    }
    const sections: ContextSection[] = [];
    if (subjects) sections.push({ tag: 'recent-subjects', content: subjects });
    // The message being reworded: the edited one when the user already changed it, else the commit's own.
    const shown = current?.trim() || original;
    if (shown) sections.push({ tag: 'current-message', content: redactSecrets(shown) });
    sections.push(...d.sections);
    let task =
      `Write a new commit message for the existing commit ${sha.slice(0, 12)} (it is being reworded). ` +
      'The current message is given for reference; keep what is accurate and describe the diff below.';
    if (subjects) task += ' Match the style of the recent subjects where sensible.';
    if (hint === 'shorter')
      task += ' Make it shorter than the current message: a concise summary and at most a two-line body.';
    if (hint === 'conventional') task += ' Use the Conventional Commits format for this message.';
    return { task, sections, notes, truncated: d.truncated, omitted: d.omitted };
  }

  private async stashMessage(): Promise<BuiltContext> {
    let stat = await this.out(['diff', '--cached', ...DIFF, '--stat=200', '-M', '--']);
    let patch: string;
    let what = 'staged changes';
    if (stat.trim()) patch = await this.out(['diff', '--cached', ...DIFF, '-U3', '-M', '--']);
    else {
      stat = await this.out(['diff', 'HEAD', ...DIFF, '--stat=200', '-M', '--'], [0, 128]);
      patch = await this.out(['diff', 'HEAD', ...DIFF, '-U3', '-M', '--'], [0, 128]);
      what = 'uncommitted changes';
    }
    const untracked = (await this.out(['ls-files', '--others', '--exclude-standard'])).trim();
    if (!stat.trim() && !untracked) throw nothing('There are no changes to stash.');
    const d = this.diffSections(stat, patch);
    const sections = [...d.sections];
    if (untracked)
      sections.push({ tag: 'untracked-files', content: untracked.split('\n').slice(0, 200).join('\n') });
    return {
      task: `Write a stash message (one line, at most 72 characters) describing these ${what}.`,
      sections,
      notes: this.omittedNotes(d.omitted, d.truncated),
      truncated: d.truncated,
      omitted: d.omitted,
    };
  }

  private async explainCommits(shas: string[]): Promise<BuiltContext> {
    if (!shas.length) throw nothing('Select a commit to explain.');
    const list = shas.slice(0, 50);
    const per = Math.floor(this.o.maxChars / list.length);
    const sections: ContextSection[] = [];
    let truncated = shas.length > list.length;
    const omitted: string[] = [];
    for (const sha of list) {
      const out = await this.out([
        'show',
        ...DIFF,
        '--stat=200',
        '--patch',
        '--format=fuller',
        assertRev(sha, 'commit'),
        '--',
      ]);
      const at = out.indexOf('\ndiff --git ');
      const head = redactSecrets(at < 0 ? out : out.slice(0, at)).trim();
      const fitted = fitDiff(at < 0 ? '' : out.slice(at + 1), Math.max(0, per - head.length), this.excluded);
      truncated ||= fitted.truncated;
      omitted.push(...fitted.omitted);
      sections.push({
        tag: 'commit',
        attrs: { sha: sha.slice(0, 12) },
        content: `${head}\n\n${fitted.text}`,
      });
    }
    return {
      task:
        list.length === 1
          ? 'Explain what this commit does and why, for a developer reviewing it.'
          : `Explain what these ${list.length} commits do together, for a developer reviewing them.`,
      sections,
      notes: this.omittedNotes(omitted, truncated),
      truncated,
      omitted,
    };
  }

  private async defaultBase(branch: string): Promise<string> {
    const origin = (await this.out(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], [0, 1, 128])).trim();
    const candidates = [
      origin.replace(/^refs\/remotes\//, ''),
      'main',
      'master',
      'develop',
      'origin/main',
      'origin/master',
    ];
    const self = await this.svc.revParse(branch);
    for (const c of candidates) {
      if (!c || c === branch) continue;
      const sha = await this.svc.revParse(c);
      if (sha && sha !== self) return c;
    }
    throw nothing('Could not find a base branch to compare with.');
  }

  private async branchRange(
    branch: string,
    baseIn: string | undefined,
    mode: 'explain' | 'pr',
    template?: string,
  ): Promise<BuiltContext> {
    assertRev(branch, 'branch');
    const baseRef = assertRev(baseIn?.trim() || (await this.defaultBase(branch)), 'base');
    const mb = (await this.out(['merge-base', baseRef, branch], [0, 1, 128])).trim();
    if (!mb) throw nothing(`${branch} and ${baseRef} have no common history.`);
    const count = Number((await this.out(['rev-list', '--count', `${mb}..${branch}`, '--'])).trim()) || 0;
    if (!count) throw nothing(`${branch} has no commits that are not in ${baseRef}.`);
    const log = (await this.out(['log', '--format=%h %s', '-200', `${mb}..${branch}`, '--'])).trim();
    const stat = await this.out(['diff', ...DIFF, '--stat=200', '-M', mb, branch, '--']);
    const files = (await this.out(['diff', '--name-only', '-M', mb, branch, '--']))
      .split('\n')
      .filter(Boolean).length;
    const sections: ContextSection[] = [{ tag: 'commits', content: redactSecrets(log) }];
    let budget = this.o.maxChars - log.length;
    if (mode === 'pr') {
      const bodies = (
        await this.out(['log', '--format=%s%n%b%n---', '-50', `${mb}..${branch}`, '--'])
      ).trim();
      const b = redactSecrets(bodies).slice(0, Math.floor(this.o.maxChars / 5));
      sections.push({ tag: 'commit-messages', content: b });
      budget -= b.length;
      if (template?.trim()) {
        const t = template.slice(0, 8000);
        sections.push({ tag: 'template', content: t });
        budget -= t.length;
      }
    }
    const patch = await this.out(['diff', ...DIFF, '-U3', '-M', mb, branch, '--']);
    const d = this.diffSections(stat, patch, Math.max(0, budget));
    sections.push(...d.sections);
    const notes = [
      `Comparing ${branch} with ${baseRef} (merge base ${mb.slice(0, 7)}).`,
      ...this.omittedNotes(d.omitted, d.truncated),
    ];
    return {
      task:
        mode === 'pr'
          ? `Write a pull request title and description for merging ${branch} into ${baseRef}.`
          : `Explain what the branch ${branch} changes compared to ${baseRef}.`,
      sections,
      notes,
      truncated: d.truncated,
      omitted: d.omitted,
      range: { base: mb, baseRef, commits: count, files },
    };
  }

  private async explainWip(): Promise<BuiltContext> {
    const born = !!(await this.svc.revParse('HEAD'));
    const against = born ? ['HEAD'] : ['--cached'];
    const stat = await this.out(['diff', ...against, ...DIFF, '--stat=200', '-M', '--']);
    const patch = await this.out(['diff', ...against, ...DIFF, '-U3', '-M', '--']);
    const untracked = (await this.out(['ls-files', '--others', '--exclude-standard'])).trim();
    if (!stat.trim() && !untracked) throw nothing('There are no uncommitted changes.');
    const d = this.diffSections(stat, patch);
    const sections = [...d.sections];
    if (untracked)
      sections.push({ tag: 'untracked-files', content: untracked.split('\n').slice(0, 200).join('\n') });
    return {
      task: 'Explain the uncommitted changes (staged and unstaged) below.',
      sections,
      notes: this.omittedNotes(d.omitted, d.truncated),
      truncated: d.truncated,
      omitted: d.omitted,
    };
  }

  private async conflict(
    file: string,
    hunks: { hunkId: string; ours: string; theirs: string; base?: string }[],
  ): Promise<BuiltContext> {
    if (this.excluded(file)) {
      throw new AiProviderError('disabled', `${file} matches an excluded pattern in Preferences → AI.`);
    }
    if (!hunks.length) throw nothing('There are no conflicts in this file.');
    const sections: ContextSection[] = [];
    for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const subjects = (await this.out(['log', '--format=%s', '-5', ref, '--'], [0, 128])).trim();
      if (subjects) {
        sections.push({ tag: 'theirs-commits', attrs: { ref }, content: redactSecrets(subjects) });
        break;
      }
    }
    const ours = (await this.out(['log', '--format=%s', '-5', 'HEAD', '--'], [0, 128])).trim();
    if (ours) sections.push({ tag: 'ours-commits', content: redactSecrets(ours) });
    let budget = this.o.maxChars;
    let truncated = false;
    const hunkSections: ContextSection[] = hunks.map((h) => {
      let content = `--- ours (current branch) ---\n${h.ours}\n--- theirs (incoming) ---\n${h.theirs}`;
      if (h.base !== undefined) content = `--- base (common ancestor) ---\n${h.base}\n${content}`;
      return { tag: 'hunk', attrs: { id: h.hunkId }, content: redactSecrets(content, file) };
    });
    const hunkChars = hunkSections.reduce((n, s) => n + s.content.length, 0);
    if (hunkChars > budget) throw tooLarge();
    budget -= hunkChars;
    const root = this.svc.repo.worktreeRoot;
    if (root && budget > 2000) {
      try {
        let text = redactSecrets(fs.readFileSync(path.join(root, file), 'utf8'), file);
        if (text.length > budget) {
          text = `${text.slice(0, budget)}\n${TRUNCATED}`;
          truncated = true;
        }
        sections.push({
          tag: 'file',
          attrs: { path: file, note: 'whole file with conflict markers, for context' },
          content: text,
        });
      } catch {
        /* deleted on one side or unreadable: hunks alone */
      }
    }
    sections.push(...hunkSections);
    return {
      task: `Resolve each conflicted hunk of ${file}. Return one proposal per hunk id.`,
      sections,
      notes: truncated ? [`The file was cut at "${TRUNCATED}".`] : [],
      truncated,
      omitted: [],
      conflictIds: hunks.map((h) => h.hunkId),
    };
  }

  private async compose(
    source: Extract<AiRequest, { feature: 'composeCommits' }>['source'],
  ): Promise<BuiltContext> {
    if (source.kind === 'range') {
      assertRev(source.from, 'range start');
      assertRev(source.to, 'range end');
    }
    const diff = await readComposeDiff(this.svc, source);
    if (!diff.units.length)
      throw nothing(source.kind === 'staged' ? 'Stage changes first.' : 'The range has no changes.');
    const omitted = new Set<string>();
    const hunks: ComposeHunkInfo[] = diff.units.map((u) => ({
      path: u.path,
      hunkId: u.hunkId,
      kind: u.kind,
      status: u.status,
      binary: u.binary,
      header: u.header,
      additions: u.additions,
      deletions: u.deletions,
      preview: (u.fileHeader + u.body).slice(0, 20_000),
    }));
    const bodies = diff.units.map((u) => {
      if (this.excluded(u.path)) {
        omitted.add(u.path);
        return '[content not shared: excluded by settings]';
      }
      if (u.binary) {
        omitted.add(`${u.path} (binary)`);
        return '[binary file]';
      }
      return redactSecrets(u.body, u.path);
    });
    const render = (n: number | null): ContextSection[] =>
      diff.units.map((u, i) => ({
        tag: 'hunk',
        attrs: { id: u.hunkId, path: u.path, change: u.kind === 'file' ? u.header : 'modified' },
        content: n === null ? bodies[i]! : truncateBody(bodies[i]!, n),
      }));
    const size = (s: ContextSection[]): number => s.reduce((n, x) => n + x.content.length + 60, 0);
    let sections = render(null);
    let truncated = false;
    if (size(sections) > this.o.maxChars) {
      truncated = true;
      sections = [];
      for (const n of TRUNCATE_STEPS) {
        const s = render(n);
        if (size(s) <= this.o.maxChars) {
          sections = s;
          break;
        }
      }
      if (!sections.length) throw tooLarge();
    }
    const notes = this.omittedNotes([...omitted], truncated);
    if (source.kind === 'range') {
      const subjects = (await this.out(['log', '--format=%s', `${source.from}^..${source.to}`, '--'])).trim();
      if (subjects) sections.unshift({ tag: 'original-commits', content: redactSecrets(subjects) });
    }
    return {
      task: `Split these ${diff.units.length} hunks into a sequence of logical commits. Every hunk id must be used exactly once.`,
      sections,
      notes,
      truncated,
      omitted: [...omitted],
      compose: { diff, hunks },
    };
  }

  private async changelog(from: string, to: string): Promise<BuiltContext> {
    const range = `${assertRev(from, 'from')}..${assertRev(to, 'to')}`;
    const raw = await this.out(['log', '--no-merges', '--format=%H%x00%s%x00%b%x00%an%x1e', range, '--']);
    const entries = raw
      .split('\x1e')
      .map((r) => r.replace(/^\n/, ''))
      .filter((r) => r.includes('\0'))
      .map((r) => {
        const [sha, subject, body, author] = r.split('\0');
        const prs = [...`${subject} ${body}`.matchAll(/(?:#|pull\/)(\d+)\b/g)].map((m) => `#${m[1]}`);
        return {
          sha: sha!,
          subject: subject!,
          body: (body ?? '').trim(),
          author: author!.trim(),
          prs: [...new Set(prs)],
        };
      });
    if (!entries.length) throw nothing(`There are no commits in ${range}.`);
    const render = (bodyLines: number): string =>
      entries
        .map((e) => {
          let s = `- ${e.subject} (${e.sha.slice(0, 7)}, ${e.author}${e.prs.length ? `, ${e.prs.join(' ')}` : ''})`;
          if (bodyLines > 0 && e.body) s += `\n  ${e.body.split('\n').slice(0, bodyLines).join('\n  ')}`;
          return s;
        })
        .join('\n');
    let text = render(8);
    let truncated = false;
    for (const n of [3, 1, 0]) {
      if (text.length <= this.o.maxChars) break;
      text = render(n);
      truncated = true;
    }
    if (text.length > this.o.maxChars) {
      text = `${text.slice(0, this.o.maxChars)}\n${TRUNCATED}`;
      truncated = true;
    }
    return {
      task: `Write a changelog for the ${entries.length} commits in ${range}.`,
      sections: [{ tag: 'commits', content: redactSecrets(text) }],
      notes: truncated ? ['Commit bodies were shortened to fit the size limit.'] : [],
      truncated,
      omitted: [],
    };
  }
}
