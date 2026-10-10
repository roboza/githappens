/** Askpass prompt classification (spec 02 §6.3). Pure. */

export type AskpassPromptKind = 'username' | 'password' | 'passphrase' | 'hostkey' | 'generic';

export interface ClassifiedPrompt {
  kind: AskpassPromptKind;
  /** Host the prompt is about (from the URL, or the SSH host-key message). */
  host?: string;
  /** Username embedded in the URL (`https://user@host`). */
  username?: string;
  /** The URL git asked about (username/password prompts). */
  url?: string;
  /** SSH key path (passphrase prompts). */
  keyPath?: string;
}

function parseUrl(u: string): { host?: string; username?: string } {
  try {
    const url = new URL(u);
    return {
      ...(url.host ? { host: url.host } : {}),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    };
  } catch {
    const m = /^(?:[a-z+]+:\/\/)?(?:([^@/]+)@)?([^/:]+)/i.exec(u);
    return m ? { ...(m[2] ? { host: m[2] } : {}), ...(m[1] ? { username: m[1] } : {}) } : {};
  }
}

export function classifyPrompt(prompt: string): ClassifiedPrompt {
  const p = prompt.trim();
  let m = /^Username for '(.+)':?$/i.exec(p);
  if (m) {
    const { host } = parseUrl(m[1]!);
    return { kind: 'username', url: m[1]!, ...(host ? { host } : {}) };
  }
  m = /^Password for '(.+)':?$/i.exec(p);
  if (m) return { kind: 'password', url: m[1]!, ...parseUrl(m[1]!) };
  m = /Enter passphrase for (?:key )?'?([^':]+)'?:?/i.exec(p);
  if (m) return { kind: 'passphrase', keyPath: m[1]!.trim() };
  if (/Are you sure you want to continue connecting/i.test(p)) {
    const h = /authenticity of host '([^' (]+)/i.exec(p);
    return { kind: 'hostkey', ...(h ? { host: h[1]! } : {}) };
  }
  m = /^(.+?)@([^'\s]+)'s password:?$/i.exec(p);
  if (m) return { kind: 'password', username: m[1]!, host: m[2]! };
  return { kind: 'generic' };
}
