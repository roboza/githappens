import type { SshTestKind, SshTestResult } from '../../shared/ipc/network-contract';

export type { SshTestKind, SshTestResult } from '../../shared/ipc/network-contract';

/**
 * "Test connection" (spec 13 `ssh:testConnection`): run `ssh -T git@<host>` with the same key/agent
 * selection git uses and classify the output. Git hosts never grant a shell, so success is recognised from
 * the greeting text (GitHub exits 1 on success), not from the exit code alone.
 */

const SUCCESS: Array<{ re: RegExp; user?: number }> = [
  // GitHub / GHE: "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access."
  { re: /^Hi ([^!\s]+)! You've successfully authenticated/m, user: 1 },
  // GitLab: "Welcome to GitLab, @user!"
  { re: /^Welcome to GitLab, @([^!\s]+)!/m, user: 1 },
  // Bitbucket Cloud: "authenticated via ssh key." / older "logged in as <user>."
  { re: /authenticated via ssh key/i },
  { re: /logged in as ([^.\s]+)\./i, user: 1 },
  { re: /You can use git to connect to Bitbucket/i },
  // Azure DevOps: authenticated, but no shell.
  { re: /Shell access is not supported/i },
  // Gitea / Forgejo: "Hi there, user! You've successfully authenticated with the key named …"
  { re: /^Hi there, ([^!\s]+)! You've successfully authenticated/m, user: 1 },
  // Generic "successfully authenticated".
  { re: /successfully authenticated/i },
];

const FAILURES: Array<{ re: RegExp; kind: SshTestKind; message: string }> = [
  {
    re: /REMOTE HOST IDENTIFICATION HAS CHANGED/,
    kind: 'hostkeyChanged',
    message:
      'The host key changed since you last connected. Verify it, then remove the old entry from known_hosts.',
  },
  {
    re: /UNPROTECTED PRIVATE KEY FILE|bad permissions/i,
    kind: 'permissions',
    message:
      'The private key file is readable by other users; ssh refuses to use it. Restrict its permissions.',
  },
  {
    re: /invalid format|error in libcrypto/i,
    kind: 'keyFormat',
    message: 'ssh could not read the private key (invalid format or wrong line endings).',
  },
  {
    re: /Host key verification failed/i,
    kind: 'hostkey',
    message: 'The host key was not trusted. Accept the fingerprint when asked, or add it to known_hosts.',
  },
  {
    re: /Permission denied \(|Authentication failed|no such identity|Too many authentication failures/i,
    kind: 'auth',
    message: 'The server rejected the key. Add your public key to the account, or load it into the agent.',
  },
  {
    re: /Could not resolve hostname|Connection timed out|Connection refused|Network is unreachable|No route to host|Connection closed by|kex_exchange_identification|Operation timed out/i,
    kind: 'network',
    message: 'Could not reach the server over SSH (port 22 may be blocked by a firewall or proxy).',
  },
];

export function parseSshTestOutput(
  raw: string,
  exitCode: number,
  o: { timedOut?: boolean } = {},
): SshTestResult {
  const output = raw.replace(/\r\n/g, '\n').trim().slice(-4000);
  for (const s of SUCCESS) {
    const m = s.re.exec(output);
    if (m) {
      const user = s.user ? m[s.user] : undefined;
      return {
        ok: true,
        kind: 'success',
        user,
        message: user ? `Authenticated as ${user}.` : 'Authenticated.',
        output,
      };
    }
  }
  for (const f of FAILURES)
    if (f.re.test(output)) return { ok: false, kind: f.kind, message: f.message, output };
  if (o.timedOut) return { ok: false, kind: 'timeout', message: 'The connection test timed out.', output };
  if (exitCode === 0) return { ok: true, kind: 'success', message: 'Connected.', output };
  return {
    ok: false,
    kind: 'unknown',
    message: output.split('\n').pop() || `ssh exited with code ${exitCode}.`,
    output,
  };
}

/** Accept `host`, `host:port`, `user@host`, `ssh://user@host:port`; reject anything option-like. */
export function parseSshTarget(input: string): { user: string; host: string; port?: number } {
  let t = input.trim();
  t = t.replace(/^ssh:\/\//i, '').replace(/\/.*$/, '');
  let user = 'git';
  const at = t.lastIndexOf('@');
  if (at >= 0) {
    user = t.slice(0, at);
    t = t.slice(at + 1);
  }
  let port: number | undefined;
  const pm = /^(.*):(\d{1,5})$/.exec(t);
  if (pm) {
    t = pm[1]!;
    port = Number(pm[2]);
    if (port < 1 || port > 65535) throw new Error('Invalid port.');
  }
  const okHost = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/.test(t) || /^\[[0-9a-fA-F:]+\]$/.test(t);
  if (!okHost) throw new Error('Enter a host name such as github.com.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error('Invalid user name.');
  return { user, host: t.replace(/^\[|\]$/g, ''), port };
}

/** ssh args appended to the key/agent args for a connection test. */
export function sshTestArgs(target: { user: string; host: string; port?: number }): string[] {
  return [
    '-T',
    '-o',
    'ConnectTimeout=15',
    ...(target.port ? ['-p', String(target.port)] : []),
    '--',
    `${target.user}@${target.host}`,
  ];
}
