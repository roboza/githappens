import type { SettingsValues } from './registry';

/** One git config write; `value: null` unsets the key. */
export interface GitConfigEntry {
  key: string;
  value: string | null;
}

/**
 * Git config entries for the Commit Signing section (spec 13 §6 "Signing").
 * Empty optional values unset the key so stale configuration does not linger.
 */
export function signingGitConfig(
  v: Pick<
    SettingsValues,
    | 'signing.format'
    | 'signing.gpgProgram'
    | 'signing.signingKey'
    | 'signing.allowedSignersFile'
    | 'signing.signCommits'
    | 'signing.signTags'
  >,
): GitConfigEntry[] {
  const opt = (s: string): string | null => (s.trim() ? s.trim() : null);
  const entries: GitConfigEntry[] = [
    { key: 'gpg.format', value: v['signing.format'] },
    { key: 'user.signingkey', value: opt(v['signing.signingKey']) },
    { key: 'commit.gpgsign', value: String(v['signing.signCommits']) },
    { key: 'tag.gpgsign', value: String(v['signing.signTags']) },
  ];
  if (v['signing.format'] === 'ssh') {
    entries.push({ key: 'gpg.ssh.allowedSignersFile', value: opt(v['signing.allowedSignersFile']) });
  } else if (v['signing.format'] === 'openpgp') {
    entries.push({ key: 'gpg.program', value: opt(v['signing.gpgProgram']) });
  } else {
    entries.push({ key: 'gpg.x509.program', value: opt(v['signing.gpgProgram']) });
  }
  return entries;
}

/** Keys git accepts for writes from the Preferences bridge (defense in depth for IPC). */
export const WRITABLE_GIT_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'user.signingkey',
  'gpg.format',
  'gpg.program',
  'gpg.x509.program',
  'gpg.ssh.allowedSignersFile',
  'commit.gpgsign',
  'tag.gpgsign',
]);
