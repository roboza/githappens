import { describe, expect, it } from 'vitest';

import { decodeText, detectEol, encodeText, showFileText } from '../src/renderer/src/views/file/codec';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf16 = (s: string, le: boolean): Uint8Array => {
  const out = new Uint8Array(2 + s.length * 2);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0xfeff, le);
  for (let i = 0; i < s.length; i++) v.setUint16(2 + 2 * i, s.charCodeAt(i), le);
  return out;
};
const roundTrip = (b: Uint8Array): Uint8Array => {
  const d = decodeText(b);
  return encodeText(d.text, d.encoding, d.eol);
};

describe('editor codec round-trip (spec 07 §4.11, §9 "saved byte-identical when unchanged")', () => {
  it('keeps LF and CRLF files byte-identical, with and without a final newline', () => {
    for (const s of ['a\nb\n', 'a\r\nb\r\n', 'a\r\nb', 'no newline', '', '\r\n']) {
      expect(roundTrip(enc(s))).toEqual(enc(s));
    }
    const crlf = decodeText(enc('x\r\ny\r\n'));
    expect(crlf).toMatchObject({ text: 'x\ny\n', eol: 'crlf', encoding: 'utf8', mixed: false });
  });

  it('preserves the UTF-8 BOM', () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('héllo\r\nwörld\r\n')]);
    const d = decodeText(b);
    expect(d.encoding).toBe('utf8bom');
    expect(d.text).toBe('héllo\nwörld\n');
    expect(roundTrip(b)).toEqual(b);
  });

  it('decodes and re-encodes UTF-16 LE/BE with BOM', () => {
    for (const le of [true, false]) {
      const b = utf16('日本語\r\nline 2\r\n', le);
      const d = decodeText(b);
      expect(d.encoding).toBe(le ? 'utf16le' : 'utf16be');
      expect(d.text).toBe('日本語\nline 2\n');
      expect(d.eol).toBe('crlf');
      expect(roundTrip(b)).toEqual(b);
    }
  });

  it('falls back to read-only Latin-1 for invalid UTF-8', () => {
    const d = decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(d).toMatchObject({ text: 'café\n', encoding: 'unknown', readOnly: true });
    expect(() => encodeText(d.text, 'unknown', 'lf')).toThrow(/read-only/);
  });

  it('converts line endings and encodings on request', () => {
    expect(encodeText('a\nb\n', 'utf8', 'crlf')).toEqual(enc('a\r\nb\r\n'));
    expect(encodeText('a\r\nb', 'utf8', 'lf')).toEqual(enc('a\nb'));
    expect(encodeText('A', 'utf16be', 'lf')).toEqual(new Uint8Array([0xfe, 0xff, 0x00, 0x41]));
    expect(detectEol('a\r\nb\nc\r\n')).toEqual({ eol: 'crlf', mixed: true });
    expect(detectEol('a')).toEqual({ eol: 'lf', mixed: false });
  });

  it('reads git blobs: UTF-8 text (BOM aware) and UTF-16 sent as base64 binary', () => {
    expect(showFileText({ content: '﻿x\r\n', encoding: 'utf8' })).toMatchObject({
      text: 'x\n',
      encoding: 'utf8bom',
      eol: 'crlf',
    });
    const b64 = btoa(String.fromCharCode(...utf16('hi\n', true)));
    expect(showFileText({ content: b64, encoding: 'base64' })).toMatchObject({
      text: 'hi\n',
      encoding: 'utf16le',
    });
    expect(showFileText({ content: btoa('\x00\x01binary'), encoding: 'base64' })).toBeNull();
    expect(showFileText({ content: null, encoding: 'utf8' })).toBeNull();
  });
});
