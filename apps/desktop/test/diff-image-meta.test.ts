import { describe, expect, it } from 'vitest';

import { formatBytes, isImagePath, sniffImage } from '../src/renderer/src/views/diff/image-meta';
import {
  allowLarge,
  countLines,
  hasLongLines,
  largeFileVerdict,
  LARGE_FILE_BYTES,
  HUGE_FILE_BYTES,
} from '../src/renderer/src/views/diff/large-file';
import { contiguousRange, EMPTY_TREE, rangeSpec } from '../src/renderer/src/views/diff/compare';
import { stepIndex } from '../src/renderer/src/views/diff/nav-store';

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const i32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

describe('image metadata (spec 07 §4.6)', () => {
  it('detects image paths by extension', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.ico', 'h.svg', 'i.avif']) {
      expect(isImagePath(p)).toBe(true);
    }
    expect(isImagePath('notes.txt')).toBe(false);
  });

  it('reads PNG, GIF, JPEG, WebP, BMP, ICO and SVG sizes', () => {
    expect(
      sniffImage(bytes([0x89], 'PNG', [13, 10, 26, 10], u32be(13), 'IHDR', u32be(640), u32be(480))),
    ).toEqual({
      format: 'png',
      width: 640,
      height: 480,
    });
    expect(sniffImage(bytes('GIF89a', u16le(32), u16le(16)))).toEqual({
      format: 'gif',
      width: 32,
      height: 16,
    });
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], // APP0 (length 4)
      [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03], // SOF0: 300 high, 200 wide
      new Array(12).fill(0),
    );
    expect(sniffImage(jpeg)).toEqual({ format: 'jpeg', width: 200, height: 300 });
    const vp8x = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8X',
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      [99, 0, 0],
      [49, 0, 0],
    );
    expect(sniffImage(vp8x)).toEqual({ format: 'webp', width: 100, height: 50 });
    const bmp = bytes('BM', new Array(16).fill(0), i32le(7), i32le(-9));
    expect(sniffImage(bmp)).toEqual({ format: 'bmp', width: 7, height: 9 });
    expect(sniffImage(bytes([0, 0, 1, 0, 1, 0, 0, 0]))).toEqual({ format: 'ico', width: 256, height: 256 });
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<svg xmlns="x" viewBox="0 0 24 12"><path/></svg>',
    );
    expect(sniffImage(svg)).toEqual({ format: 'svg', width: 24, height: 12 });
    const svg2 = new TextEncoder().encode('<svg width="100px" height="40" viewBox="0 0 1 1"></svg>');
    expect(sniffImage(svg2)).toEqual({ format: 'svg', width: 100, height: 40 });
    expect(sniffImage(bytes('hello world'))).toBeNull();
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12.4 * 1024)).toBe('12.4 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('large-file guard (spec 07 §4.14)', () => {
  it('confirms over 1 MB or 20,000 lines and refuses over 50 MB', () => {
    expect(largeFileVerdict([{ bytes: 10 }, null])).toBe('ok');
    expect(largeFileVerdict([{ bytes: LARGE_FILE_BYTES + 1 }])).toBe('confirm');
    expect(largeFileVerdict([{ bytes: 100, lines: 20_001 }])).toBe('confirm');
    expect(largeFileVerdict([{ bytes: 100 }, { bytes: HUGE_FILE_BYTES + 1 }])).toBe('refuse');
  });

  it('counts lines and finds minified long lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(hasLongLines(`short\n${'x'.repeat(10_001)}\nshort`)).toBe(true);
    expect(hasLongLines('a\n'.repeat(20_000))).toBe(false);
  });

  it('remembers "Load anyway" per session', () => {
    allowLarge.clear();
    expect(allowLarge.has('k')).toBe(false);
    allowLarge.add('k');
    expect(allowLarge.has('k')).toBe(true);
  });
});

describe('commit ranges and navigation', () => {
  it('orders a contiguous first-parent chain and rejects gaps', () => {
    const c = (sha: string, parent?: string) => ({ sha, parents: parent ? [parent] : [], commitTime: 0 });
    expect(contiguousRange([c('c', 'b'), c('a', 'root'), c('b', 'a')])).toEqual(['a', 'b', 'c']);
    expect(contiguousRange([c('c', 'b'), c('a', 'root')])).toBeNull();
    expect(contiguousRange([c('a')])).toBeNull();
    expect(rangeSpec('p', 'c', 'sha1')).toEqual({ kind: 'range', from: 'p', to: 'c' });
    expect(rangeSpec(undefined, 'c', 'sha256')).toEqual({ kind: 'range', from: EMPTY_TREE.sha256, to: 'c' });
  });

  it('steps through changes and stops at the ends', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBeNull();
    expect(stepIndex(0, 3, -1)).toBeNull();
    expect(stepIndex(0, 0, 1)).toBeNull();
  });
});
