import type { AskpassRequest } from '@githappens/git';
import { describe, expect, it } from 'vitest';

import type { SecretStore } from '../src/main/secrets/secret-store';
import { CredentialService } from '../src/main/services/credentials';

class MemorySecrets implements SecretStore {
  readonly available = true;
  readonly backend = 'memory';
  readonly map = new Map<string, string>();
  get(a: string): string | null {
    return this.map.get(a) ?? null;
  }
  set(a: string, s: string): void {
    this.map.set(a, s);
  }
  delete(a: string): boolean {
    return this.map.delete(a);
  }
  deleteByPrefix(prefix: string): number {
    let n = 0;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix) && this.map.delete(k)) n++;
    return n;
  }
  listAccounts(prefix = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

type Prompt = (req: AskpassRequest) => Promise<string | null>;

function setup(o: { integration?: { username: string; password: string } | null } = {}) {
  const secrets = new MemorySecrets();
  const shown: Array<{ promptId: string; kind: string }> = [];
  const failedHosts: string[] = [];
  const svc = new CredentialService({
    shimsDir: '',
    nodeExecutable: '',
    secrets,
    profileId: () => 'p1',
    showPrompt: (p) => shown.push(p),
    integrationLogin: () => o.integration ?? null,
    integrationAccounts: () => (o.integration ? [{ host: 'github.com', login: 'octo' }] : []),
    onIntegrationAuthFailed: (h) => failedHosts.push(h),
  });
  const prompt = (svc as unknown as { onPrompt: Prompt }).onPrompt.bind(svc);
  /** Answer the next UI prompt once it is shown. */
  const answerNext = async (value: string | null, remember: boolean): Promise<void> => {
    for (let i = 0; i < 50 && !shown.length; i++) await new Promise((r) => setTimeout(r, 1));
    const p = shown.shift()!;
    svc.answer(p.promptId, value, remember);
  };
  return { svc, secrets, shown, prompt, answerNext, failedHosts };
}

const req = (
  opId: string,
  kind: AskpassRequest['kind'],
  extra: Partial<AskpassRequest> = {},
): AskpassRequest => ({
  opId,
  kind,
  prompt: `${kind}:`,
  host: 'example.com',
  ...extra,
});

describe('CredentialService chain (spec 09 §6.6)', () => {
  it('saves a remembered login only after the op succeeds', async () => {
    const { svc, secrets, prompt, answerNext } = setup();
    const u = prompt(req('op1', 'username'));
    await answerNext('alice', false);
    expect(await u).toBe('alice');
    const p = prompt(req('op1', 'password'));
    await answerNext('s3cret', true);
    expect(await p).toBe('s3cret');
    expect(secrets.map.size).toBe(0); // not yet: the op is still running
    svc.finish('op1');
    expect(JSON.parse(secrets.get('p1/git/example.com')!)).toEqual({ username: 'alice', password: 's3cret' });
  });

  it('drops a remembered login when the op fails', async () => {
    const { svc, secrets, prompt, answerNext } = setup();
    const p = prompt(req('op2', 'password', { username: 'bob' }));
    await answerNext('wrong', true);
    await p;
    svc.finish('op2', 'AuthenticationFailed');
    svc.finish('op2'); // runClone calls finish twice; the second must not resurrect the login
    expect(secrets.map.size).toBe(0);
  });

  it('commits remembered SSH passphrases after success', async () => {
    const { svc, secrets, prompt, answerNext } = setup();
    const p = prompt(req('op3', 'passphrase', { keyPath: '/k/id_ed25519' }));
    await answerNext('pass phrase', true);
    await p;
    svc.finish('op3');
    expect(secrets.listAccounts()).toEqual(['p1/ssh-passphrase//k/id_ed25519']);
  });

  it('answers from a connected integration before the keychain', async () => {
    const { svc, secrets, prompt, shown } = setup({
      integration: { username: 'x-access-token', password: 'tok' },
    });
    secrets.set('p1/git/example.com', JSON.stringify({ username: 'alice', password: 'stored' }));
    expect(await prompt(req('op4', 'username'))).toBe('x-access-token');
    expect(await prompt(req('op4', 'password', { username: 'x-access-token' }))).toBe('tok');
    expect(shown).toHaveLength(0);
    svc.finish('op4');
  });

  it('falls back to the keychain after an integration token fails, and reports it', async () => {
    const { svc, secrets, prompt, failedHosts } = setup({
      integration: { username: 'x-access-token', password: 'bad' },
    });
    secrets.set('p1/git/example.com', JSON.stringify({ username: 'alice', password: 'stored' }));
    expect(await prompt(req('op5', 'password'))).toBe('bad');
    svc.finish('op5', 'AuthenticationFailed');
    expect(failedHosts).toEqual(['example.com']);
    expect(secrets.get('p1/git/example.com')).not.toBeNull(); // integration failure keeps keychain logins
    expect(await prompt(req('op6', 'username'))).toBe('alice');
    expect(await prompt(req('op6', 'password', { username: 'alice' }))).toBe('stored');
  });

  it('forgets keychain logins that were served and then failed', async () => {
    const { svc, secrets, prompt } = setup();
    secrets.set('p1/git/example.com', JSON.stringify({ username: 'alice', password: 'old' }));
    expect(await prompt(req('op7', 'password', { username: 'alice' }))).toBe('old');
    svc.finish('op7', 'AuthenticationFailed');
    expect(secrets.get('p1/git/example.com')).toBeNull();
  });

  it('lists, forgets one, and forgets all stored credentials', () => {
    const { svc, secrets } = setup({ integration: { username: 'x', password: 'y' } });
    secrets.set('p1/git/example.com', JSON.stringify({ username: 'alice', password: 'a' }));
    secrets.set('p1/git/gitlab.local', JSON.stringify({ username: 'bob', password: 'b' }));
    secrets.set('p1/proxy/proxy:8080', JSON.stringify({ username: 'pu', password: 'pp' }));
    secrets.set('p1/integration/github:github.com', 'token'); // never listed / removed here
    secrets.set('p2/git/example.com', 'other profile');
    const list = svc.list();
    expect(list.map((c) => [c.kind, c.host, c.username])).toEqual([
      ['git', 'example.com', 'alice'],
      ['git', 'gitlab.local', 'bob'],
      ['proxy', 'proxy:8080', 'pu'],
      ['integration', 'github.com', 'octo'],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/"a"|"b"|pp/);
    svc.forget('git/gitlab.local');
    expect(secrets.get('p1/git/gitlab.local')).toBeNull();
    expect(() => svc.forget('integration/github.com/octo')).toThrow();
    expect(svc.forgetAll()).toBe(2);
    expect(secrets.listAccounts('p1/')).toEqual(['p1/integration/github:github.com']);
    expect(secrets.get('p2/git/example.com')).toBe('other profile');
  });
});
