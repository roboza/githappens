/**
 * Shell-integration escape sequences (spec 12 §6.1): OSC 7 reports the shell's cwd and OSC 133
 * (FinalTerm / "semantic prompt") marks prompt start (A), prompt end (B), command start (C) and
 * command finish with exit code (D). The scanner tolerates sequences split across pty chunks.
 */

export type ShellEvent =
  | { kind: 'cwd'; cwd: string }
  | { kind: 'promptStart' }
  | { kind: 'promptEnd' }
  | { kind: 'commandStart' }
  | { kind: 'commandEnd'; exitCode?: number };

/** Unterminated sequences longer than this are dropped (not a real OSC 7 / 133). */
const MAX_PENDING = 4096;

/** Translates one OSC payload (between `ESC ]` and the terminator); null when not ours. */
export function parseOscPayload(payload: string, platform: NodeJS.Platform): ShellEvent | null {
  if (payload.startsWith('7;')) {
    const cwd = fileUrlToPath(payload.slice(2), platform);
    return cwd ? { kind: 'cwd', cwd } : null;
  }
  if (!payload.startsWith('133;')) return null;
  const [code, arg] = payload.slice(4).split(';');
  switch (code) {
    case 'A':
      return { kind: 'promptStart' };
    case 'B':
      return { kind: 'promptEnd' };
    case 'C':
      return { kind: 'commandStart' };
    case 'D': {
      const n = arg !== undefined && /^-?\d+$/.test(arg) ? Number(arg) : undefined;
      return n === undefined ? { kind: 'commandEnd' } : { kind: 'commandEnd', exitCode: n };
    }
    default:
      return null;
  }
}

/**
 * `file://host/path` → a local path. Shells rarely percent-encode, so decoding is best effort.
 * On Windows `/c/x` (MSYS), `/C:/x` and `//server/share` become `C:\x` and `\\server\share`.
 */
export function fileUrlToPath(url: string, platform: NodeJS.Platform): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)$/i.exec(url.trim());
  if (!m) return null;
  let p = m[2]!;
  if (/%[0-9a-f]{2}/i.test(p)) {
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep it raw
    }
  }
  if (platform !== 'win32') return p;
  let win: string;
  const drive = /^\/([A-Za-z]):?(?=\/|$)(.*)$/.exec(p);
  if (drive) win = `${drive[1]!.toUpperCase()}:${drive[2] || '/'}`;
  else if (p.startsWith('//')) win = p;
  else return null; // a WSL / remote path; not meaningful for the Windows side
  return win.replace(/\//g, '\\');
}

/** Incremental OSC 7 / 133 scanner over raw pty output. */
export class OscScanner {
  private pending = '';

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  feed(chunk: string): ShellEvent[] {
    const s = this.pending ? this.pending + chunk : chunk;
    this.pending = '';
    if (!s.includes('\x1b]')) {
      // A lone trailing ESC may start the next chunk's `ESC ]`.
      if (s.endsWith('\x1b')) this.pending = '\x1b';
      return [];
    }
    const out: ShellEvent[] = [];
    let i = 0;
    for (;;) {
      const start = s.indexOf('\x1b]', i);
      if (start < 0) {
        if (s.endsWith('\x1b')) this.pending = '\x1b';
        break;
      }
      const bel = s.indexOf('\x07', start + 2);
      const st = s.indexOf('\x1b\\', start + 2);
      let end = -1;
      let termLen = 1;
      if (bel >= 0 && (st < 0 || bel < st)) end = bel;
      else if (st >= 0) {
        end = st;
        termLen = 2;
      }
      if (end < 0) {
        const rest = s.slice(start);
        if (rest.length <= MAX_PENDING) this.pending = rest;
        break;
      }
      const ev = parseOscPayload(s.slice(start + 2, end), this.platform);
      if (ev) out.push(ev);
      i = end + termLen;
    }
    return out;
  }
}
