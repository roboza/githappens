import type { DiffHunk, DiffLine, FileDiff } from '../types';
import { isZeroSha, parseRawZ, type RawEntry } from './raw';

/**
 * Parser for `git diff --patch-with-raw -z --full-index --no-abbrev` (spec 02 §6.9).
 *
 * The raw block comes first and is authoritative for the file list, status and paths. Patch blocks
 * (`diff --git …`) are then mapped to raw entries **by order**, which avoids parsing quoted paths.
 * Conflicted paths (raw `U` / combined `::` records) have no `diff --git` block; `diff --cc` blocks
 * and `* Unmerged path` lines are skipped (spec 08 renders conflicts).
 */

export interface DiffParseOptions {
  /** Per-file patch size limit in bytes (default 2 MiB). Beyond → tooLarge, hunks empty. */
  maxBytesPerFile?: number;
  /** Per-file patch line limit (default 20k). */
  maxLinesPerFile?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES = 20_000;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const SUBMODULE_RE = /^Subproject commit ([0-9a-f]{7,64})(-dirty)?/;
const LFS_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)/;

export function detectLfsPointer(content: string): { oid: string; size: number } | undefined {
  const m = LFS_RE.exec(content.replace(/\r\n/g, '\n'));
  return m ? { oid: m[1]!, size: Number(m[2]) } : undefined;
}

function fromRaw(e: RawEntry): FileDiff {
  const d: FileDiff = {
    oldPath: e.oldPath,
    newPath: e.newPath,
    status: e.status,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
  if (e.score !== undefined && (e.status === 'R' || e.status === 'C')) d.similarity = e.score;
  if (e.oldMode && !isZeroSha(e.oldMode)) d.oldMode = e.oldMode;
  if (e.newMode && !isZeroSha(e.newMode)) d.newMode = e.newMode;
  if (e.oldMode === '160000' || e.newMode === '160000') {
    d.submodule = {};
    if (e.oldMode === '160000' && !isZeroSha(e.oldSha)) d.submodule.oldSha = e.oldSha;
    if (e.newMode === '160000' && !isZeroSha(e.newSha)) d.submodule.newSha = e.newSha;
  }
  return d;
}

/** Fallback when a patch block has no raw entry: `diff --git a/x b/y` with unambiguous halves. */
function fromHeader(line: string): FileDiff {
  const rest = line.slice('diff --git '.length);
  const mid = rest.indexOf(' b/');
  const oldPath = mid > 0 ? rest.slice(2, mid) : rest;
  const newPath = mid > 0 ? rest.slice(mid + 3) : rest;
  return { oldPath, newPath, status: 'M', binary: false, hunks: [], additions: 0, deletions: 0 };
}

export function parseDiff(text: string, o: DiffParseOptions = {}): FileDiff[] {
  const maxBytes = o.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const maxLines = o.maxLinesPerFile ?? DEFAULT_MAX_LINES;
  const { entries, end } = parseRawZ(text);
  const files = entries.map(fromRaw);
  const patchable = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !e.combined && e.status !== 'U')
    .map(({ i }) => i);

  let pos = end;
  while (pos < text.length && (text[pos] === '\0' || text[pos] === '\n')) pos++;
  const lines = text.slice(pos).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  let nextPatchable = 0;
  let file: FileDiff | null = null;
  let skipping = false; // inside a `diff --cc` block
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let bytes = 0;
  let lineCount = 0;
  let lastType: DiffLine['type'] | null = null;

  const finishFile = (): void => {
    if (file && !file.binary && !file.tooLarge && file.hunks.length) {
      const newSide = file.hunks
        .flatMap((h) => h.lines)
        .filter((l) => l.type !== 'del' && l.type !== 'nonewline')
        .map((l) => l.content)
        .join('\n');
      const lfs = detectLfsPointer(newSide);
      if (lfs) file.lfsPointer = lfs;
    }
    file = null;
    hunk = null;
  };

  for (const line of lines) {
    // inside a hunk: consume by count so content lines are never mistaken for headers
    if (file && hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith('\\'))) {
      const f: FileDiff = file;
      const h: DiffHunk = hunk;
      const c = line[0];
      let dl: DiffLine;
      if (c === '\\') {
        dl = { type: 'nonewline', content: line.slice(2), patchOffset: h.lines.length };
        f.noNewlineAtEof ??= { old: false, new: false };
        if (lastType === 'del') f.noNewlineAtEof.old = true;
        else if (lastType === 'add') f.noNewlineAtEof.new = true;
        else {
          f.noNewlineAtEof.old = true;
          f.noNewlineAtEof.new = true;
        }
      } else if (c === '+') {
        dl = { type: 'add', content: line.slice(1), newLineNo: newNo++, patchOffset: h.lines.length };
        newLeft--;
        f.additions++;
      } else if (c === '-') {
        dl = { type: 'del', content: line.slice(1), oldLineNo: oldNo++, patchOffset: h.lines.length };
        oldLeft--;
        f.deletions++;
      } else {
        // context (' ' or a bare empty line from tools that strip trailing spaces)
        dl = {
          type: 'context',
          content: line.slice(1),
          oldLineNo: oldNo++,
          newLineNo: newNo++,
          patchOffset: h.lines.length,
        };
        oldLeft--;
        newLeft--;
      }
      lastType = dl.type;
      bytes += line.length + 1;
      lineCount++;
      if (!f.tooLarge && (bytes > maxBytes || lineCount > maxLines)) {
        f.tooLarge = true;
        f.hunks = [];
      }
      if (!f.tooLarge) h.lines.push(dl);
      // keep counting additions/deletions even when tooLarge; sub-module lines handled below
      if (f.submodule && dl.type !== 'nonewline' && dl.type !== 'context') {
        const m = SUBMODULE_RE.exec(dl.content);
        if (m) {
          if (dl.type === 'del') f.submodule.oldSha = m[1]!;
          else f.submodule.newSha = m[1]!;
        }
      }
      continue;
    }
    hunk = null;

    if (line.startsWith('diff --git ')) {
      finishFile();
      skipping = false;
      bytes = 0;
      lineCount = 0;
      const idx = patchable[nextPatchable++];
      file = idx !== undefined ? files[idx]! : null;
      if (!file) {
        file = fromHeader(line);
        files.push(file);
      }
      continue;
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      finishFile();
      skipping = true;
      continue;
    }
    if (line.startsWith('* Unmerged path ')) {
      finishFile();
      skipping = false;
      continue;
    }
    if (skipping || !file) continue;

    const f: FileDiff = file;
    if (line.startsWith('@@ ')) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      const h: DiffHunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      if (m[5]) h.section = m[5];
      oldNo = h.oldStart;
      newNo = h.newStart;
      oldLeft = h.oldLines;
      newLeft = h.newLines;
      lastType = null;
      bytes += line.length + 1;
      if (!f.tooLarge) f.hunks.push(h);
      hunk = h;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      f.binary = true;
      continue;
    }
    if (line.startsWith('old mode ')) f.oldMode = line.slice(9);
    else if (line.startsWith('new mode ')) f.newMode = line.slice(9);
    else if (line.startsWith('deleted file mode ')) f.oldMode = line.slice(18);
    else if (line.startsWith('new file mode ')) f.newMode = line.slice(14);
    else if (line.startsWith('similarity index ')) f.similarity ??= parseInt(line.slice(17), 10);
    // index/---/+++/rename/copy lines: paths come from the raw block
  }
  finishFile();
  return files;
}
