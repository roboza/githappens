/**
 * Image detection and metadata for the image diff (spec 07 §4.6). Pure — works on raw bytes so the
 * dimensions are known even before the browser decodes the image.
 */

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

/** Images over this are shown as a binary card instead (spec 07 §4.6). */
export const IMAGE_MAX_BYTES = 50 * 1024 * 1024;

export const isImagePath = (path: string): boolean => IMAGE_EXT.test(path);

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'svg' | 'avif';

export interface ImageMeta {
  format: ImageFormat;
  width: number | null;
  height: number | null;
}

const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const i32le = (b: Uint8Array, o: number): number =>
  b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
const ascii = (b: Uint8Array, o: number, n: number): string =>
  String.fromCharCode(...Array.from(b.subarray(o, o + n)));

function svgSize(text: string): { width: number | null; height: number | null } {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return { width: null, height: null };
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag);
    return m ? Math.round(Number(m[1])) : null;
  };
  let width = attr('width');
  let height = attr('height');
  if (width === null || height === null) {
    const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
    if (vb) {
      width ??= Math.round(Number(vb[1]));
      height ??= Math.round(Number(vb[2]));
    }
  }
  return { width, height };
}

/** Sniff format and pixel size from the first bytes of a file (null for unknown formats). */
export function sniffImage(b: Uint8Array): ImageMeta | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', width: u16be(b, o + 7), height: u16be(b, o + 5) };
      }
      o += 2 + u16be(b, o + 2);
    }
    return { format: 'jpeg', width: null, height: null };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8 ')
      return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: 'webp', width: null, height: null };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { format: 'bmp', width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  }
  if (b.length >= 8 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    return { format: 'ico', width: b[6] || 256, height: b[7] || 256 };
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && /^avi[fs]$/.test(ascii(b, 8, 4))) {
    return { format: 'avif', width: null, height: null };
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096));
  if (/<svg\b/i.test(head)) return { format: 'svg', ...svgSize(head) };
  return null;
}

/** "12.4 KB" style sizes (1024-based). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
