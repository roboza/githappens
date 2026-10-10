/**
 * Credential redaction for logs, errors and crash reports (spec 02 §6.3, §9:
 * "Credentials never appear in the output log, crash reports, or argv").
 */

const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const URL_TOKEN_ONLY = /\b(https?:\/\/)([^/\s:@]{20,})@/gi;
const AUTH_HEADER = /(authorization:\s*)(basic|bearer|token)?\s*[^\s'"]+/gi;
const EXTRAHEADER = /(http\.[^=\s]*extraheader=)[^\n'"]*/gi;

export function redact(text: string): string {
  return text
    .replace(EXTRAHEADER, (_m, prefix: string) => `${prefix}***`)
    .replace(URL_CREDS, (_m, scheme: string, user: string) => `${scheme}${user}:***@`)
    .replace(URL_TOKEN_ONLY, (_m, scheme: string) => `${scheme}***@`)
    .replace(AUTH_HEADER, (_m, prefix: string, kind?: string) => `${prefix}${kind ? `${kind} ` : ''}***`);
}

/** Config keys whose values are secrets (tokens, passwords, auth headers), spec 02 §5.3 config channels. */
export const SECRET_CONFIG_KEY =
  /(pass|passwd|password|token|secret|apikey|api-key|privatekey)$|extraheader$/i;

export function redactArgv(argv: string[]): string[] {
  const out = argv.map(redact);
  // `git config [--scope] [--] <secret.key> <value>`: never log the value
  if (argv.includes('config')) {
    for (let i = 0; i < out.length - 1; i++) {
      if (SECRET_CONFIG_KEY.test(argv[i]!) && !argv[i]!.startsWith('-')) out[i + 1] = '***';
    }
  }
  return out;
}

/** Render argv as a readable (not shell-safe) command line for logs. */
export function formatCommand(argv: string[]): string {
  return ['git', ...redactArgv(argv)].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
