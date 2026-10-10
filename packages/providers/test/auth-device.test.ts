import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runGitHubDeviceFlow } from '../src/auth/device';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('GitHub device flow', () => {
  it('polls through authorization_pending and slow_down to success', async () => {
    const responses = [
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { error: 'authorization_pending' },
      { access_token: 'gho_device', token_type: 'bearer', scope: 'repo,read:org' },
    ];
    let deviceForm: URLSearchParams | undefined;
    const pollForms: URLSearchParams[] = [];
    server.use(
      http.post('https://github.com/login/device/code', async ({ request }) => {
        deviceForm = new URLSearchParams(await request.text());
        return HttpResponse.json({
          device_code: 'DC',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      }),
      http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
        pollForms.push(new URLSearchParams(await request.text()));
        return HttpResponse.json(responses.shift());
      }),
    );
    const sleeps: number[] = [];
    let shown: unknown;
    const t = await runGitHubDeviceFlow({
      host: 'github.com',
      clientId: 'cid',
      scopes: ['repo', 'read:org'],
      onUserCode: (i) => {
        shown = i;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(Object.fromEntries(deviceForm!)).toEqual({ client_id: 'cid', scope: 'repo read:org' });
    expect(shown).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: undefined,
      expiresIn: 900,
    });
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(pollForms).toHaveLength(4);
    expect(Object.fromEntries(pollForms[0]!)).toEqual({
      client_id: 'cid',
      device_code: 'DC',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(t).toMatchObject({ accessToken: 'gho_device', scopes: ['repo', 'read:org'] });
  });

  it('slow_down without interval adds 5 seconds; access_denied rejects', async () => {
    const responses = [{ error: 'slow_down' }, { error: 'access_denied' }];
    server.use(
      http.post('https://ghe.acme.com/login/device/code', () =>
        HttpResponse.json({
          device_code: 'DC',
          user_code: 'U',
          verification_uri: 'https://ghe.acme.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      ),
      http.post('https://ghe.acme.com/login/oauth/access_token', () => HttpResponse.json(responses.shift())),
    );
    const sleeps: number[] = [];
    await expect(
      runGitHubDeviceFlow({
        host: 'ghe.acme.com',
        clientId: 'cid',
        scopes: [],
        onUserCode: () => {},
        sleep: async (ms) => void sleeps.push(ms),
      }),
    ).rejects.toMatchObject({ code: 'auth_required', message: 'Authorization was denied.' });
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('expired_token rejects and abort stops polling', async () => {
    server.use(
      http.post('https://github.com/login/device/code', () =>
        HttpResponse.json({
          device_code: 'DC',
          user_code: 'U',
          verification_uri: 'v',
          expires_in: 900,
          interval: 1,
        }),
      ),
      http.post('https://github.com/login/oauth/access_token', () =>
        HttpResponse.json({ error: 'expired_token' }),
      ),
    );
    await expect(
      runGitHubDeviceFlow({
        host: 'github.com',
        clientId: 'c',
        scopes: [],
        onUserCode: () => {},
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ message: 'The device code expired.' });

    const ac = new AbortController();
    await expect(
      runGitHubDeviceFlow({
        host: 'github.com',
        clientId: 'c',
        scopes: [],
        onUserCode: () => ac.abort(),
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: 'auth_required', message: 'Sign-in was cancelled.' });
  });
});
