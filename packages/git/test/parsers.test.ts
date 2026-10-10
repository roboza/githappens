import { describe, expect, it } from 'vitest';

import {
  batchPathspec,
  buildRevSet,
  detectLfsPointer,
  GitError,
  LOG_FORMAT,
  LogParser,
  logFormat,
  objectName,
  parseCommitDetailHeader,
  parseDiff,
  parseDiscovery,
  parseForEachRef,
  parseLog,
  parseNumstat,
  parseRawNumstat,
  parseRawZ,
  parseRemotesConfig,
  parseRemoteVerbose,
  parseRevParse,
  parseStashList,
  parseStatusV2,
  parseTrack,
  REFS_FORMAT_NO_TRACK,
  REFS_FORMAT_TRACK,
  repoStateFrom,
  splitLimit,
  withPathspec,
} from '../src';

// Golden tests with captured-style git output (NULs written as \0).

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const Z = '0'.repeat(40);

describe('status porcelain v2', () => {
  it('parses headers, ordinary, renamed, unmerged, untracked, ignored', () => {
    const out = [
      `# branch.oid ${A}`,
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '# stash 3',
      `1 .M N... 100644 100644 100644 ${A} ${A} ünï cødé file.txt`,
      `1 A. N... 000000 100644 100644 ${Z} ${B} with space/a b.txt`,
      `2 R. N... 100644 100644 100644 ${A} ${A} R100 new name.txt`,
      'old name.txt',
      `2 C. N... 100644 100644 100644 ${A} ${A} C75 copy.txt`,
      'orig.txt',
      `u UU N... 100644 100644 100644 100644 ${A} ${B} ${C} conflict file.txt`,
      `u AA N... 000000 100644 100644 100644 ${Z} ${B} ${C} add-add.txt`,
      `u DU N... 100644 000000 100644 000000 ${A} ${Z} ${C} delete-modify.txt`,
      `1 .M SC.U 160000 160000 160000 ${A} ${A} lib`,
      '? new 新しい.txt',
      '? dir/',
      '! ignored.log',
      '',
    ].join('\0');
    const r = parseStatusV2(out);
    expect(r.branch).toEqual({ oid: A, head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(r.stashCount).toBe(3);
    expect(r.entries[0]).toEqual({
      kind: 'ordinary',
      path: 'ünï cødé file.txt',
      index: '.',
      worktree: 'M',
      submodule: null,
      modeHead: '100644',
      modeIndex: '100644',
      modeWorktree: '100644',
      shaHead: A,
      shaIndex: A,
    });
    expect(r.entries[1]).toMatchObject({ path: 'with space/a b.txt', index: 'A', worktree: '.' });
    expect(r.entries[2]).toMatchObject({
      kind: 'renamed',
      path: 'new name.txt',
      origPath: 'old name.txt',
      op: 'R',
      score: 100,
    });
    expect(r.entries[3]).toMatchObject({ kind: 'renamed', op: 'C', score: 75, origPath: 'orig.txt' });
    expect(r.entries[4]).toEqual({
      kind: 'unmerged',
      path: 'conflict file.txt',
      conflict: 'UU',
      submodule: null,
      stages: { base: A, ours: B, theirs: C },
    });
    expect(r.entries[5]).toMatchObject({ conflict: 'AA', stages: { ours: B, theirs: C } });
    expect((r.entries[5] as { stages: object }).stages).not.toHaveProperty('base');
    expect(r.entries[6]).toMatchObject({ conflict: 'DU', stages: { base: A, theirs: C } });
    expect(r.entries[7]).toMatchObject({
      path: 'lib',
      submodule: { commitChanged: true, modified: false, untracked: true },
    });
    expect(r.entries.slice(8)).toEqual([
      { kind: 'untracked', path: 'new 新しい.txt' },
      { kind: 'untracked', path: 'dir/' },
      { kind: 'ignored', path: 'ignored.log' },
    ]);
  });

  it('handles (initial) and (detached)', () => {
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').branch).toEqual({
      oid: null,
      head: 'main',
    });
    expect(parseStatusV2(`# branch.oid ${A}\0# branch.head (detached)\0`).branch).toEqual({
      oid: A,
      head: null,
    });
    expect(parseStatusV2('')).toEqual({ branch: { oid: null, head: null }, stashCount: 0, entries: [] });
  });

  it('splitLimit keeps spaces in the last field', () => {
    expect(splitLimit('a b c d e', 3)).toEqual(['a', 'b', 'c d e']);
    expect(splitLimit('a', 3)).toEqual(['a']);
  });
});

describe('for-each-ref', () => {
  const rec = (...f: string[]) => f.join('\0') + '\x1e\n';
  it('parses branches with tracking, tags, remotes, stash', () => {
    const out =
      rec(
        'refs/heads/main',
        A,
        'commit',
        '',
        'refs/remotes/origin/main',
        'ahead 2, behind 1',
        '*',
        '',
        'C:/repo',
        '1704070800',
        'Main subject',
      ) +
      rec(
        'refs/heads/feature',
        B,
        'commit',
        '',
        'refs/remotes/origin/feature',
        'gone',
        ' ',
        '',
        'C:/wt/feature',
        '1704074400',
        'feat',
      ) +
      rec('refs/heads/local', B, 'commit', '', '', '', ' ', '', '', '1704074400', 'x') +
      rec(
        'refs/remotes/origin/HEAD',
        A,
        'commit',
        '',
        '',
        '',
        ' ',
        'refs/remotes/origin/main',
        '',
        '1704070800',
        's',
      ) +
      rec('refs/tags/v1.0', C, 'tag', A, '', '', ' ', '', '', '1704078000', 'Release 1.0') +
      rec('refs/tags/light', B, 'commit', '', '', '', ' ', '', '', '1704074400', 'feat') +
      rec('refs/stash', D, 'commit', '', '', '', ' ', '', '', '1704080000', 'On main: wip') +
      rec('refs/githappens/undo/1', D, 'commit', '', '', '', ' ', '', '', '1', 'hidden') +
      'refs/heads/broken\0only-two\x1e\n';
    const warnings: string[] = [];
    const refs = parseForEachRef(out, {
      mapWorktreePath: (p) => (p === 'C:/repo' ? undefined : p),
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toHaveLength(1);
    expect(refs.map((r) => r.fullName)).toEqual([
      'refs/heads/main',
      'refs/heads/feature',
      'refs/heads/local',
      'refs/remotes/origin/HEAD',
      'refs/tags/v1.0',
      'refs/tags/light',
      'refs/stash',
    ]);
    expect(refs[0]).toEqual({
      fullName: 'refs/heads/main',
      shortName: 'main',
      type: 'local',
      sha: A,
      isHead: true,
      upstream: { fullName: 'refs/remotes/origin/main', ahead: 2, behind: 1, gone: false },
      creatorDate: 1704070800,
      subject: 'Main subject',
    });
    expect(refs[1]).toMatchObject({
      upstream: { gone: true, ahead: 0, behind: 0 },
      worktreePath: 'C:/wt/feature',
    });
    expect(refs[2]!.upstream).toBeUndefined();
    expect(refs[3]).toMatchObject({
      type: 'remote',
      shortName: 'origin/HEAD',
      symrefTarget: 'refs/remotes/origin/main',
    });
    expect(refs[4]).toMatchObject({ type: 'tag', shortName: 'v1.0', sha: A, tagObjectSha: C });
    expect(refs[5]).toMatchObject({ type: 'tag', sha: B });
    expect(refs[5]!.tagObjectSha).toBeUndefined();
    expect(refs[6]).toMatchObject({ type: 'stash', shortName: 'stash' });
  });

  it('track field variants and format layout', () => {
    expect(parseTrack('ahead 2')).toEqual({ ahead: 2, behind: 0, gone: false });
    expect(parseTrack('behind 7')).toEqual({ ahead: 0, behind: 7, gone: false });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(REFS_FORMAT_TRACK.split('%00')).toHaveLength(11);
    expect(REFS_FORMAT_NO_TRACK.split('%00')).toHaveLength(11);
    expect(REFS_FORMAT_NO_TRACK).not.toContain('upstream');
  });
});

describe('log', () => {
  const record = (sha: string, parents: string, subject: string, extra: string[] = []) =>
    [
      sha,
      parents,
      'Ålice Ëxample',
      'alice@example.com',
      '1704070800',
      'Bob',
      'bob@example.com',
      '1704074400',
      subject,
      ...extra,
    ]
      .map((f) => f + '\0')
      .join('') + '\0';

  it('parses records incl. root, merge, empty subject and unicode', () => {
    const out = record(A, `${B} ${C}`, "Merge branch 'x'") + record(B, C, '') + record(C, '', 'Initial 日本');
    const commits = parseLog(out);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toEqual({
      sha: A,
      parents: [B, C],
      authorName: 'Ålice Ëxample',
      authorEmail: 'alice@example.com',
      authorTime: 1704070800,
      committerName: 'Bob',
      committerEmail: 'bob@example.com',
      commitTime: 1704074400,
      subject: "Merge branch 'x'",
    });
    expect(commits[1]!.subject).toBe('');
    expect(commits[2]!.parents).toEqual([]);
    expect(commits[2]!.subject).toBe('Initial 日本');
  });

  it('parses incrementally across arbitrary chunk boundaries (incl. split UTF-8)', () => {
    const buf = Buffer.from(record(A, B, 'ünï') + record(B, C, 'two') + record(C, '', 'three'));
    for (const size of [1, 3, 7, 64]) {
      const p = new LogParser();
      const got = [];
      for (let i = 0; i < buf.length; i += size) got.push(...p.push(buf.subarray(i, i + size)));
      got.push(...p.end());
      expect(got.map((c) => c.subject)).toEqual(['ünï', 'two', 'three']);
    }
  });

  it('emits a record as soon as its terminator arrives', () => {
    const p = new LogParser();
    expect(p.push(record(A, '', 'one').slice(0, -1))).toEqual([]);
    expect(p.push('\0')).toHaveLength(1);
  });

  it('parses signature status when requested', () => {
    expect(logFormat({ signature: true })).toContain('%G?');
    expect(LOG_FORMAT).not.toContain('%G?');
    const [c] = parseLog(record(A, '', 's', ['G']), { signature: true });
    expect(c!.signature).toBe('G');
  });

  it('parses commit detail header + body', () => {
    const fields = [A, B, 'A', 'a@x', '1', 'C', 'c@x', '2', 'Subject'].map((f) => f + '\0').join('');
    const { summary, body } = parseCommitDetailHeader(fields + 'Body line 1\r\n\nBody 2\n\n\0');
    expect(summary.subject).toBe('Subject');
    expect(summary.parents).toEqual([B]);
    expect(body).toBe('Body line 1\r\n\nBody 2');
  });
});

describe('raw + numstat', () => {
  it('parses raw records incl. renames, copies and combined entries', () => {
    const raw =
      `:100644 100644 ${A} ${B} M\0a.txt\0` +
      `:100644 100644 ${A} ${A} R087\0old name.txt\0new name.txt\0` +
      `:100644 100644 ${A} ${A} C100\0src.txt\0copy.txt\0` +
      `:000000 100644 ${Z} ${B} A\0added.txt\0` +
      `:100644 000000 ${A} ${Z} D\0gone.txt\0` +
      `::100644 100644 100644 ${A} ${B} ${Z} MM\0conflict.txt\0`;
    const { entries, end } = parseRawZ(raw);
    expect(end).toBe(raw.length);
    expect(entries.map((e) => [e.status, e.oldPath, e.newPath, e.score])).toEqual([
      ['M', 'a.txt', 'a.txt', undefined],
      ['R', 'old name.txt', 'new name.txt', 87],
      ['C', 'src.txt', 'copy.txt', 100],
      ['A', null, 'added.txt', undefined],
      ['D', 'gone.txt', null, undefined],
      ['U', 'conflict.txt', 'conflict.txt', undefined],
    ]);
    expect(entries[5]!.combined).toBe(true);
  });

  it('pairs raw with numstat, collapses conflicted duplicates, binary = null counts', () => {
    const out =
      `:100644 100644 ${A} ${B} M\0a.txt\0` +
      `:100644 100644 ${A} ${A} R087\0old.txt\0new.txt\0` +
      `:100644 100644 ${A} ${B} M\0bin.dat\0` +
      '3\t1\ta.txt\0' +
      '1\t1\t\0old.txt\0new.txt\0' +
      '-\t-\tbin.dat\0';
    expect(parseRawNumstat(out)).toEqual([
      { path: 'a.txt', status: 'M', additions: 3, deletions: 1, binary: false },
      { path: 'new.txt', oldPath: 'old.txt', status: 'R', additions: 1, deletions: 1, binary: false },
      { path: 'bin.dat', status: 'M', additions: null, deletions: null, binary: true },
    ]);
    const conflict =
      `:000000 100644 ${Z} ${Z} U\0c.txt\0:100644 100644 ${A} ${Z} M\0c.txt\0:100644 100644 ${A} ${Z} M\0k.txt\0` +
      '0\t0\tc.txt\0' +
      '4\t0\tc.txt\0' +
      '1\t0\tk.txt\0';
    expect(parseRawNumstat(conflict)).toEqual([
      { path: 'c.txt', status: 'U', additions: 0, deletions: 0, binary: false },
      { path: 'k.txt', status: 'M', additions: 1, deletions: 0, binary: false },
    ]);
    // --no-index /dev/null shows up as a pseudo-rename in numstat; raw paths win
    const noIndex = `:000000 100644 ${Z} ${Z} A\0u.txt\0` + '1\t0\t\0nul\0u.txt\0';
    expect(parseRawNumstat(noIndex)).toEqual([
      { path: 'u.txt', status: 'A', additions: 1, deletions: 0, binary: false },
    ]);
  });

  it('parses plain numstat', () => {
    expect(parseNumstat('1\t2\tx y.txt\0-\t-\tb.bin\0' + '0\t0\t\0o\0n\0')).toEqual([
      { path: 'x y.txt', status: 'M', additions: 1, deletions: 2, binary: false },
      { path: 'b.bin', status: 'M', additions: null, deletions: null, binary: true },
      { path: 'n', oldPath: 'o', status: 'R', additions: 0, deletions: 0, binary: false },
    ]);
  });
});

describe('diff (raw + patch)', () => {
  const sample =
    `:100644 100644 ${A} ${B} M\0src/ünï cødé.txt\0` +
    `:100644 100644 ${A} ${A} R100\0a.txt\0b c.txt\0` +
    `:100644 100755 ${C} ${C} M\0run.sh\0` +
    `:100644 100644 ${A} ${B} M\0bin.dat\0` +
    `:000000 100644 ${Z} ${B} A\0new.txt\0` +
    `:100644 000000 ${A} ${Z} D\0old.txt\0` +
    `:160000 160000 ${C} ${D} M\0lib\0` +
    `:100644 100644 ${A} ${B} M\0crlf.txt\0` +
    '\0' +
    [
      'diff --git a/src/ünï cødé.txt b/src/ünï cødé.txt',
      `index ${A}..${B} 100644`,
      '--- a/src/ünï cødé.txt',
      '+++ b/src/ünï cødé.txt',
      '@@ -1,3 +1,4 @@ function foo()',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' end',
      '\\ No newline at end of file',
      '@@ -10 +11 @@',
      '-x',
      '+y',
      'diff --git a/a.txt b/b c.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to b c.txt',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/bin.dat b/bin.dat',
      `index ${A}..${B} 100644`,
      'Binary files a/bin.dat and b/bin.dat differ',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      `index ${Z}..${B}`,
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+no eol',
      '\\ No newline at end of file',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      `index ${A}..${Z}`,
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-diff --git a/fake b/fake',
      '-@@ -1 +1 @@',
      'diff --git a/lib b/lib',
      `index ${C}..${D} 160000`,
      '--- a/lib',
      '+++ b/lib',
      '@@ -1 +1 @@',
      `-Subproject commit ${C}`,
      `+Subproject commit ${D}-dirty`,
      'diff --git a/crlf.txt b/crlf.txt',
      `index ${A}..${B} 100644`,
      '--- a/crlf.txt',
      '+++ b/crlf.txt',
      '@@ -1,2 +1,2 @@',
      ' one\r',
      '-two\r',
      '+TWO\r',
      '',
    ].join('\n');

  const files = parseDiff(sample);

  it('maps patch blocks to raw entries by order', () => {
    expect(files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ['M', 'src/ünï cødé.txt', 'src/ünï cødé.txt'],
      ['R', 'a.txt', 'b c.txt'],
      ['M', 'run.sh', 'run.sh'],
      ['M', 'bin.dat', 'bin.dat'],
      ['A', null, 'new.txt'],
      ['D', 'old.txt', null],
      ['M', 'lib', 'lib'],
      ['M', 'crlf.txt', 'crlf.txt'],
    ]);
  });

  it('parses hunks with line numbers, sections and no-EOL markers', () => {
    const f = files[0]!;
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.noNewlineAtEof).toEqual({ old: true, new: true });
    expect(f.hunks).toHaveLength(2);
    const h = f.hunks[0]!;
    expect(h).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      section: 'function foo()',
    });
    expect(h.header).toBe('@@ -1,3 +1,4 @@ function foo()');
    expect(h.lines).toEqual([
      { type: 'context', content: 'one', oldLineNo: 1, newLineNo: 1, patchOffset: 0 },
      { type: 'del', content: 'two', oldLineNo: 2, patchOffset: 1 },
      { type: 'add', content: 'TWO', newLineNo: 2, patchOffset: 2 },
      { type: 'add', content: 'three', newLineNo: 3, patchOffset: 3 },
      { type: 'context', content: 'end', oldLineNo: 3, newLineNo: 4, patchOffset: 4 },
      { type: 'nonewline', content: 'No newline at end of file', patchOffset: 5 },
    ]);
    expect(f.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 1 });
    expect(f.hunks[1]!.section).toBeUndefined();
  });

  it('renames, mode changes, binary, new/deleted, submodule, CRLF', () => {
    expect(files[1]).toMatchObject({ similarity: 100, hunks: [], additions: 0 });
    expect(files[2]).toMatchObject({ oldMode: '100644', newMode: '100755', hunks: [] });
    expect(files[3]).toMatchObject({ binary: true, hunks: [] });
    expect(files[4]).toMatchObject({
      newMode: '100644',
      additions: 1,
      noNewlineAtEof: { old: false, new: true },
    });
    expect(files[4]!.oldMode).toBeUndefined();
    // content lines that look like headers stay content
    expect(files[5]!.hunks[0]!.lines.map((l) => l.content)).toEqual([
      'diff --git a/fake b/fake',
      '@@ -1 +1 @@',
    ]);
    expect(files[5]).toMatchObject({ oldMode: '100644', deletions: 2 });
    expect(files[6]!.submodule).toEqual({ oldSha: C, newSha: D });
    expect(files[7]!.hunks[0]!.lines.map((l) => l.content)).toEqual(['one\r', 'two\r', 'TWO\r']);
  });

  it('marks oversized files tooLarge but keeps counts', () => {
    const big = parseDiff(sample, { maxBytesPerFile: 20 });
    expect(big[0]).toMatchObject({ tooLarge: true, hunks: [], additions: 3, deletions: 2 });
    expect(parseDiff(sample, { maxLinesPerFile: 2 })[0]!.tooLarge).toBe(true);
  });

  it('skips unmerged paths and combined diffs', () => {
    const out =
      `:100644 000000 ${A} ${Z} U\0c.txt\0:100644 100644 ${A} ${B} M\0k.txt\0\0` +
      '* Unmerged path c.txt\n' +
      'diff --cc c.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n' +
      `diff --git a/k.txt b/k.txt\nindex ${A}..${B} 100644\n--- a/k.txt\n+++ b/k.txt\n@@ -1 +1 @@\n-keep\n+fk\n`;
    const d = parseDiff(out);
    expect(d.map((f) => [f.status, f.newPath, f.additions])).toEqual([
      ['U', 'c.txt', 0],
      ['M', 'k.txt', 1],
    ]);
  });

  it('detects LFS pointers', () => {
    const oid = 'e'.repeat(64);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2048\n`;
    expect(detectLfsPointer(pointer)).toEqual({ oid, size: 2048 });
    expect(detectLfsPointer('hello')).toBeUndefined();
    const out =
      `:000000 100644 ${Z} ${B} A\0asset.bin\0\0diff --git a/asset.bin b/asset.bin\nnew file mode 100644\n` +
      `--- /dev/null\n+++ b/asset.bin\n@@ -0,0 +1,3 @@\n` +
      pointer
        .trimEnd()
        .split('\n')
        .map((l) => '+' + l)
        .join('\n') +
      '\n';
    expect(parseDiff(out)[0]!.lfsPointer).toEqual({ oid, size: 2048 });
  });

  it('returns [] for empty output', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('stash, remotes, rev-parse', () => {
  it('parses stash list', () => {
    const out =
      ['stash@{0}', A, `${B} ${C}`, 'On main: custom msg', '1704070800'].map((f) => f + '\0').join('') +
      '\0' +
      ['stash@{1}', B, `${C} ${D} ${A}`, 'WIP on main: abc123 subject', '1704067200']
        .map((f) => f + '\0')
        .join('') +
      '\0';
    expect(parseStashList(out)).toEqual([
      {
        index: 0,
        ref: 'stash@{0}',
        sha: A,
        parents: [B, C],
        message: 'On main: custom msg',
        time: 1704070800,
      },
      {
        index: 1,
        ref: 'stash@{1}',
        sha: B,
        parents: [C, D, A],
        message: 'WIP on main: abc123 subject',
        time: 1704067200,
      },
    ]);
    expect(parseStashList('')).toEqual([]);
  });

  it('parses remotes from config (names with dots, pushurl)', () => {
    const out =
      'remote.origin.url\nhttps://github.com/a/b.git\0' +
      'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0' +
      'remote.my.fork.url\ngit@host:x/y.git\0' +
      'remote.my.fork.pushurl\ngit@host:me/y.git\0' +
      'remote.my.fork.fetch\n+refs/heads/main:refs/remotes/my.fork/main\0' +
      'remote.my.fork.fetch\n+refs/tags/*:refs/tags/*\0';
    expect(parseRemotesConfig(out)).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://github.com/a/b.git',
        pushUrl: 'https://github.com/a/b.git',
        fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      },
      {
        name: 'my.fork',
        fetchUrl: 'git@host:x/y.git',
        pushUrl: 'git@host:me/y.git',
        fetchRefspecs: ['+refs/heads/main:refs/remotes/my.fork/main', '+refs/tags/*:refs/tags/*'],
      },
    ]);
    expect(
      parseRemoteVerbose('origin\thttps://x (fetch)\norigin\thttps://y (push)\nup\tfile:///C:/r b (fetch)\n'),
    ).toEqual([
      { name: 'origin', fetchUrl: 'https://x', pushUrl: 'https://y', fetchRefspecs: [] },
      { name: 'up', fetchUrl: 'file:///C:/r b', pushUrl: '', fetchRefspecs: [] },
    ]);
  });

  it('parses discovery and rev-parse output', () => {
    const d = parseDiscovery('false\ntrue\nsha256\nC:/r/.git/worktrees/wt\nC:/r/.git\n');
    expect(d).toMatchObject({ isBare: false, isShallow: true, objectFormat: 'sha256' });
    expect(d.commonDir).not.toBe(d.gitDir);
    expect(parseRevParse(`${A}\n`)).toBe(A);
    expect(parseRevParse('e'.repeat(64))).toBe('e'.repeat(64));
    expect(parseRevParse('')).toBeNull();
  });

  it('derives repo state from state files', () => {
    const st = (...files: string[]) => repoStateFrom((f) => files.includes(f));
    expect(st()).toBe('clean');
    expect(st('rebase-merge', 'rebase-merge/interactive')).toBe('rebasing-interactive');
    expect(st('rebase-merge')).toBe('rebasing');
    expect(st('rebase-apply', 'rebase-apply/applying')).toBe('applying-mailbox');
    expect(st('rebase-apply')).toBe('rebasing');
    expect(st('MERGE_HEAD')).toBe('merging');
    expect(st('CHERRY_PICK_HEAD')).toBe('cherry-picking');
    expect(st('REVERT_HEAD')).toBe('reverting');
    expect(st('BISECT_LOG')).toBe('bisecting');
  });
});

describe('rev-set, pathspec, blob object names', () => {
  it('builds the all-refs rev set without --all and with hidden excludes before each glob', () => {
    const args = buildRevSet({ revs: 'all', hiddenRefs: ['refs/remotes/upstream/*'], stashTips: [A] });
    expect(args).not.toContain('--all');
    expect(args).toEqual([
      '--exclude=refs/githappens/*',
      '--exclude=refs/remotes/upstream/*',
      '--glob=refs/heads/*',
      '--exclude=refs/githappens/*',
      '--exclude=refs/remotes/upstream/*',
      '--glob=refs/remotes/*',
      '--exclude=refs/githappens/*',
      '--exclude=refs/remotes/upstream/*',
      '--glob=refs/tags/*',
      'HEAD',
      A,
    ]);
    expect(buildRevSet({ revs: 'all', includeHead: false })).not.toContain('HEAD');
    expect(buildRevSet({ revs: ['main', '^origin/main'] })).toEqual(['main', '^origin/main']);
    expect(() => buildRevSet({ revs: ['--output=/tmp/x'] })).toThrow(GitError);
  });

  it('withPathspec switches to --pathspec-from-file above the thresholds', () => {
    expect(withPathspec(['add'], ['a b.txt', '-x'])).toEqual({
      args: ['add', '--', 'a b.txt', '-x'],
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    const many = Array.from({ length: 51 }, (_, i) => `f${i}`);
    const r = withPathspec(['add'], many);
    expect(r.args).toEqual(['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(r.stdin!.toString().split('\0')).toHaveLength(52);
    expect(withPathspec(['add'], ['x'.repeat(9000)]).stdin).toBeDefined();
    expect(withPathspec(['log'], ['*.ts'], { glob: true }).env).toEqual({ GIT_LITERAL_PATHSPECS: '0' });
    expect(withPathspec(['status'], []).args).toEqual(['status']);
  });

  it('batchPathspec splits long path lists', () => {
    const many = Array.from({ length: 120 }, (_, i) => `f${i}`);
    const batches = batchPathspec(['clean', '-f'], many);
    expect(batches).toHaveLength(3);
    expect(batches.flatMap((b) => b.args.slice(3))).toEqual(many);
    expect(batches[0]!.args.slice(0, 3)).toEqual(['clean', '-f', '--']);
  });

  it('builds cat-file object names for revisions and index stages', () => {
    expect(objectName('HEAD', 'dir\\a b.txt')).toBe('HEAD:dir/a b.txt');
    expect(objectName(':0', 'x')).toBe(':0:x');
    expect(objectName(':2', 'x')).toBe(':2:x');
    expect(objectName(':', 'x')).toBe(':0:x');
  });
});
