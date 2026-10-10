import { describe, expect, it } from 'vitest';

import {
  autoResolveTrivial,
  chunkSource,
  compose,
  editorLayout,
  emptyState,
  findChunk,
  flipOrder,
  hasMarkers,
  isResolved,
  parseMerged,
  regionLines,
  resolveEmpty,
  serializeEditorText,
  sideCheck,
  sideLines,
  takeAll,
  takeBoth,
  toggleLine,
  toggleSide,
  unresolvedCount,
  type ChunkState,
} from '../src/renderer/src/views/merge/merge-model';

const DIFF3 = [
  'line 1',
  'line 2',
  '<<<<<<< ours',
  'a1',
  'a2',
  '||||||| base',
  'base1',
  '=======',
  'b1',
  '>>>>>>> theirs',
  'middle',
  '<<<<<<< ours',
  'x',
  '||||||| base',
  'y',
  '=======',
  '>>>>>>> theirs',
  'end',
  '',
].join('\n');

const states = (n: number): ChunkState[] => Array.from({ length: n }, emptyState);

describe('parseMerged', () => {
  it('splits stable and conflict segments with sides and labels', () => {
    const doc = parseMerged(DIFF3);
    expect(doc.segments.map((s) => s.type)).toEqual(['stable', 'conflict', 'stable', 'conflict', 'stable']);
    expect(doc.chunks).toHaveLength(2);
    const [c0, c1] = doc.chunks;
    expect(c0).toMatchObject({ id: 0, a: ['a1', 'a2'], base: ['base1'], b: ['b1'], hasBase: true });
    expect(c0!.aLabel).toBe('ours');
    expect(c0!.bLabel).toBe('theirs');
    expect(c1).toMatchObject({ a: ['x'], base: ['y'], b: [] });
    expect(c0!.aStartLine).toBe(2);
    expect(c1!.aStartLine).toBe(5);
    expect(c1!.bStartLine).toBe(4);
    expect(doc.finalNewline).toBe(true);
    expect(doc.eol).toBe('\n');
  });

  it('round-trips unresolved chunks to the original text', () => {
    const doc = parseMerged(DIFF3);
    expect(compose(doc, states(2))).toBe(DIFF3);
  });

  it('handles CRLF, no final newline, 2-way blocks and custom marker sizes', () => {
    const text = ['a', '<<<<<<<<< HEAD', 'x', '=========', 'y', '>>>>>>>>> b', 'z'].join('\r\n');
    const doc = parseMerged(text);
    expect(doc.eol).toBe('\r\n');
    expect(doc.finalNewline).toBe(false);
    expect(doc.chunks[0]).toMatchObject({ a: ['x'], b: ['y'], hasBase: false, markerSize: 9 });
    expect(compose(doc, states(1))).toBe(text);
    expect(compose(doc, takeAll(doc, 'b'))).toBe('a\r\ny\r\nz');
  });

  it('keeps malformed blocks and differently sized markers as stable text', () => {
    const text = 'a\n<<<<<<< x\nb\n=======\nc\n';
    const doc = parseMerged(text);
    expect(doc.chunks).toHaveLength(0);
    expect(compose(doc, [])).toBe(text);
    const inner = parseMerged('<<<<<<<<< o\n=======\n>>>>>>>\n=========\nq\n>>>>>>>>> t\n');
    expect(inner.chunks[0]!.a).toEqual(['=======', '>>>>>>>']);
  });
});

describe('selection', () => {
  const doc = parseMerged(DIFF3);
  const c0 = doc.chunks[0]!;

  it('composes lines in click order and removes on untick', () => {
    let st = toggleLine(emptyState(), 'b', 0);
    st = toggleLine(st, 'a', 1);
    st = toggleLine(st, 'a', 0);
    expect(compose(doc, [st, resolveEmpty()])).toBe('line 1\nline 2\nb1\na2\na1\nmiddle\nend\n');
    st = toggleLine(st, 'a', 1);
    expect(compose(doc, [st, resolveEmpty()])).toBe('line 1\nline 2\nb1\na1\nmiddle\nend\n');
    expect(chunkSource(st)).toBe('mixed');
  });

  it('chunk checkbox appends missing lines, reports partial state, and unticks all', () => {
    let st = toggleLine(emptyState(), 'a', 1);
    expect(sideCheck(c0, st, 'a')).toBe('some');
    st = toggleSide(c0, st, 'a');
    expect(st.selected).toEqual([
      { side: 'a', line: 1 },
      { side: 'a', line: 0 },
    ]);
    expect(sideCheck(c0, st, 'a')).toBe('all');
    st = toggleSide(c0, st, 'a');
    expect(st.selected).toEqual([]);
    expect(isResolved(st)).toBe(false);
  });

  it('take both / flip order', () => {
    const st = takeBoth(c0, 'b');
    expect(compose(doc, [st, resolveEmpty()]).split('\n').slice(2, 5)).toEqual(['b1', 'a1', 'a2']);
    expect(
      compose(doc, [flipOrder(st), resolveEmpty()])
        .split('\n')
        .slice(2, 5),
    ).toEqual(['a1', 'a2', 'b1']);
  });

  it('taking an empty side resolves the chunk as empty', () => {
    const all = takeAll(doc, 'b');
    expect(isResolved(all[1]!)).toBe(true);
    expect(compose(doc, all)).toBe('line 1\nline 2\nb1\nmiddle\nend\n');
    expect(unresolvedCount(all)).toBe(0);
    expect(unresolvedCount(states(2))).toBe(2);
  });

  it('edited chunks override picks; edits with markers stay unresolved', () => {
    const st: ChunkState = { selected: [{ side: 'a', line: 0 }], edited: ['custom'] };
    expect(compose(doc, [st, resolveEmpty()])).toBe('line 1\nline 2\ncustom\nmiddle\nend\n');
    expect(isResolved({ selected: [], edited: ['<<<<<<< ours'] })).toBe(false);
    expect(chunkSource(st)).toBe('edited');
  });

  it('navigates with wrap-around', () => {
    const s = [resolveEmpty(), emptyState(), resolveEmpty(), emptyState()];
    expect(findChunk(s, 1, 1, (x) => !isResolved(x))).toBe(3);
    expect(findChunk(s, 3, 1, (x) => !isResolved(x))).toBe(1);
    expect(findChunk(s, 1, -1, (x) => !isResolved(x))).toBe(3);
    expect(findChunk([resolveEmpty()], 0, 1, (x) => !isResolved(x))).toBe(-1);
  });
});

describe('auto-resolve trivial', () => {
  it('resolves whitespace-only and identical chunks', () => {
    const text = [
      '<<<<<<< o',
      'foo  bar',
      '||||||| b',
      'foo bar',
      '=======',
      'baz',
      '>>>>>>> t',
      '<<<<<<< o',
      'same',
      '||||||| b',
      'old',
      '=======',
      'same ',
      '>>>>>>> t',
      '<<<<<<< o',
      'p',
      '||||||| b',
      'q',
      '=======',
      'r',
      '>>>>>>> t',
      '',
    ].join('\n');
    const doc = parseMerged(text);
    const out = autoResolveTrivial(doc, states(3));
    expect(out[0]).toMatchObject({ auto: 'trivial', selected: [{ side: 'b', line: 0 }] });
    expect(out[1]).toMatchObject({ auto: 'trivial', selected: [{ side: 'a', line: 0 }] });
    expect(out[2]).toEqual(emptyState());
  });
});

describe('editor layout & serialization', () => {
  it('tracks chunk regions as offsets', () => {
    const doc = parseMerged(DIFF3);
    const st = [toggleLine(emptyState(), 'b', 0), resolveEmpty()];
    const { text, regions } = editorLayout(doc, st);
    expect(text).toBe('line 1\nline 2\nb1\nmiddle\nend\n');
    expect(text.slice(regions[0]!.start, regions[0]!.end)).toBe('b1');
    expect(regions[1]!.start).toBe(regions[1]!.end);
    expect(text.slice(regions[1]!.start)).toBe('end\n');
    expect(regionLines('')).toEqual([]);
    expect(regionLines('a\nb')).toEqual(['a', 'b']);
  });

  it('serializes with the original EOL and final newline', () => {
    expect(serializeEditorText('a\nb\n', '\r\n', true)).toBe('a\r\nb\r\n');
    expect(serializeEditorText('a\nb\n', '\n', false)).toBe('a\nb');
  });

  it('detects leftover markers and builds side views', () => {
    expect(hasMarkers('ok\n=======\n')).toBe(true);
    expect(hasMarkers('ok\n======== not\n')).toBe(false);
    const doc = parseMerged(DIFF3);
    expect(sideLines(doc, 'b')).toEqual(['line 1', 'line 2', 'b1', 'middle', 'end']);
  });
});
