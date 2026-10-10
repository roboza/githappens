/**
 * C-style path unquoting (spec 02 §6.10): git quotes paths containing control characters, quotes or
 * backslashes (and non-ASCII bytes unless `core.quotepath=false`) as `"..."` with `\n`, `\t`, `\"`,
 * `\\` and 3-digit octal byte escapes. Octal escapes are UTF-8 bytes. Unquoted input is returned as is.
 */
export function unquoteCPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = Array.from(s.slice(1, -1));
  const bytes: number[] = [];
  const pushText = (t: string): void => {
    for (const b of Buffer.from(t, 'utf8')) bytes.push(b);
  };
  const SIMPLE: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      pushText(c);
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) {
      pushText(c);
      break;
    }
    if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4).join(''))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4).join(''), 8) & 0xff);
      i += 3;
      continue;
    }
    const simple = SIMPLE[n];
    if (simple !== undefined) bytes.push(simple);
    else pushText(n);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}
