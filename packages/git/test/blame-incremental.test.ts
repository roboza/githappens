import { describe, expect, it } from 'vitest';

import { IncrementalBlameParser } from '../src/service/file-views';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** `git blame --incremental` output: headers only the first time a sha appears, `filename` ends an entry. */
const OUTPUT = [
  `${A} 1 1 2`,
  'author Alice',
  'author-mail <alice@example.com>',
  'author-time 1704067200',
  'author-tz +0000',
  'committer Alice',
  'committer-mail <alice@example.com>',
  'committer-time 1704067200',
  'committer-tz +0000',
  'summary Initial',
  'boundary',
  'filename "dir/tab\\there.txt"',
  `${B} 3 3 1`,
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1704070000',
  'author-tz -0500',
  'committer Bob',
  'committer-mail <bob@example.com>',
  'committer-time 1704070000',
  'committer-tz -0500',
  'summary Second',
  `previous ${A} "dir/tab\\there.txt"`,
  'filename "dir/tab\\there.txt"',
  `${A} 3 4 1`,
  'filename "dir/tab\\there.txt"',
  '',
].join('\n');

describe('IncrementalBlameParser', () => {
  it('parses entries and commit headers, whatever the chunk boundaries', () => {
    for (const size of [1, 7, 64, OUTPUT.length]) {
      const p = new IncrementalBlameParser();
      const lines: { sha: string; finalLine: number; origLine: number }[] = [];
      const commits: Record<
        string,
        { summary: string; filename: string; boundary: boolean; previous?: unknown }
      > = {};
      for (let i = 0; i < OUTPUT.length; i += size) {
        p.push(OUTPUT.slice(i, i + size));
        const c = p.take();
        lines.push(...c.lines.map((l) => ({ sha: l.sha, finalLine: l.finalLine, origLine: l.origLine })));
        Object.assign(commits, c.commits);
      }
      expect(lines).toEqual([
        { sha: A, finalLine: 1, origLine: 1 },
        { sha: A, finalLine: 2, origLine: 2 },
        { sha: B, finalLine: 3, origLine: 3 },
        { sha: A, finalLine: 4, origLine: 3 },
      ]);
      expect(Object.keys(commits).sort()).toEqual([A, B]);
      expect(commits[A]).toMatchObject({ summary: 'Initial', filename: 'dir/tab\there.txt', boundary: true });
      expect(commits[B]).toMatchObject({
        summary: 'Second',
        boundary: false,
        previous: { sha: A, path: 'dir/tab\there.txt' },
      });
    }
  });

  it('reports each commit once and nothing when no new data arrived', () => {
    const p = new IncrementalBlameParser();
    p.push(OUTPUT);
    expect(Object.keys(p.take().commits)).toHaveLength(2);
    expect(p.take()).toEqual({ lines: [], commits: {} });
  });
});
