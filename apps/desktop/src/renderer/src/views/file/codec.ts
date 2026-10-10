/**
 * Text codec for the in-app editor (spec 07 §4.11, §6.3): BOM detection (UTF-8, UTF-16LE/BE), strict
 * UTF-8, latin1 fallback (read-only), EOL detection and byte-exact re-encoding. Pure; uses TextDecoder.
 */

export type TextEncodingId = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'unknown';
export type Eol = 'lf' | 'crlf';

export interface DecodedText {
  /** Text with `\n` line endings (Monaco's model EOL is set separately). */
  text: string;
  encoding: TextEncodingId;
  /** Dominant line ending; `mixed` is true when both appear. */
  eol: Eol;
  mixed: boolean;
  /** Content can't be re-encoded exactly (unknown encoding): edit is read-only. */
  readOnly: boolean;
  /** `TextDecoder` label used for non-UTF-8 content (per-repo display encoding, spec 13). */
  label?: string;
}

export const ENCODING_LABELS: Record<TextEncodingId, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 with BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  unknown: 'Unknown (Latin-1, read-only)',
};

export function detectBom(b: Uint8Array): TextEncodingId | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf8bom';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf16le';
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf16be';
  return null;
}

export function detectEol(text: string): { eol: Eol; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return { eol: crlf > lf ? 'crlf' : 'lf', mixed: crlf > 0 && lf > 0 };
}

/**
 * @param fallbackLabel per-repo display encoding (spec 13 Repo › Encoding) used instead of Latin-1 when
 * the bytes are not valid UTF-8; the result stays read-only (it can't be re-encoded byte-exactly).
 */
export function decodeText(bytes: Uint8Array, fallbackLabel?: string): DecodedText {
  const bom = detectBom(bytes);
  let raw: string;
  let label: string | undefined;
  let encoding: TextEncodingId;
  let readOnly = false;
  if (bom === 'utf8bom') {
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
    encoding = 'utf8bom';
  } else if (bom === 'utf16le' || bom === 'utf16be') {
    raw = new TextDecoder(bom === 'utf16le' ? 'utf-16le' : 'utf-16be', { ignoreBOM: true }).decode(
      bytes.subarray(2),
    );
    encoding = bom;
  } else {
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      encoding = 'utf8';
    } catch {
      const legacy = decodeLegacy(bytes, fallbackLabel);
      raw = legacy ?? latin1(bytes);
      if (legacy !== null) label = fallbackLabel;
      encoding = 'unknown';
      readOnly = true;
    }
  }
  const { eol, mixed } = detectEol(raw);
  return { text: raw.replace(/\r\n/g, '\n'), encoding, eol, mixed, readOnly, ...(label ? { label } : {}) };
}

/** Decode with a WHATWG label (per-repo display encoding); null when unset, UTF-8 or unsupported. */
function decodeLegacy(b: Uint8Array, label: string | undefined): string | null {
  if (!label || /^utf-?8$/i.test(label)) return null;
  try {
    return new TextDecoder(label).decode(b);
  } catch {
    return null;
  }
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000)));
  return s;
}

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

/** Encode editor text (with `\n` endings) back to bytes in `encoding` with `eol` line endings. */
export function encodeText(text: string, encoding: TextEncodingId, eol: Eol): Uint8Array {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
  switch (encoding) {
    case 'utf8':
      return new TextEncoder().encode(body);
    case 'utf8bom': {
      const enc = new TextEncoder().encode(body);
      const out = new Uint8Array(enc.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(enc, 3);
      return out;
    }
    case 'utf16le':
      return utf16(body, true);
    case 'utf16be':
      return utf16(body, false);
    case 'unknown':
      throw new Error('Files in an unknown encoding are read-only.');
  }
}

/** Base64 → bytes (renderer side of `ShowFileResult` with `encoding: 'base64'`). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text for a git blob read through `git:show:file` (UTF-16 with BOM arrives as base64 "binary"). */
export function showFileText(r: { content: string | null; encoding: 'utf8' | 'base64' }): DecodedText | null {
  if (r.content === null) return null;
  if (r.encoding === 'utf8') {
    const bomless = r.content.startsWith('﻿') ? r.content.slice(1) : r.content;
    const { eol, mixed } = detectEol(bomless);
    return {
      text: bomless.replace(/\r\n/g, '\n'),
      encoding: bomless === r.content ? 'utf8' : 'utf8bom',
      eol,
      mixed,
      readOnly: false,
    };
  }
  const bytes = base64ToBytes(r.content);
  const bom = detectBom(bytes);
  return bom === 'utf16le' || bom === 'utf16be' ? decodeText(bytes) : null;
}
