import { describe, it, expect } from '@jest/globals';
import { awaitAuthorizationCode } from './oauth-loopback.js';

const REDIRECT = 'http://127.0.0.1:8799/callback';

/** Drive the listener the way a browser would, over a real socket. */
async function visit(url: string) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}

describe('awaitAuthorizationCode', () => {
  it('resolves with the code once the browser lands on the redirect', async () => {
    let opened = '';
    const pending = awaitAuthorizationCode({
      redirectUri: REDIRECT, state: 'ST', timeoutMs: 5000,
      openBrowser: async (url) => { opened = url; },
      authorizeUrl: 'https://jas.example.com/authorize?x=1',
    });

    // Give the listener a moment to bind, then act as the browser.
    await new Promise(r => setTimeout(r, 50));
    expect(opened).toBe('https://jas.example.com/authorize?x=1');
    const page = await visit(`${REDIRECT}?code=THECODE&state=ST`);

    await expect(pending).resolves.toBe('THECODE');
    expect(page.status).toBe(200);
    // The browser tab is the only place the user sees the outcome.
    expect(page.body).toMatch(/sign|close|return/i);
  });

  it('rejects a redirect whose state does not match, which is a forged callback', async () => {
    const pending = awaitAuthorizationCode({
      redirectUri: REDIRECT, state: 'EXPECTED', timeoutMs: 5000,
      openBrowser: async () => {}, authorizeUrl: 'https://x/a',
    });
    await new Promise(r => setTimeout(r, 50));
    await visit(`${REDIRECT}?code=INJECTED&state=WRONG`);

    await expect(pending).rejects.toThrow(/state/i);
  });

  it('surfaces an error redirect from the issuer instead of hanging', async () => {
    const pending = awaitAuthorizationCode({
      redirectUri: REDIRECT, state: 'ST', timeoutMs: 5000,
      openBrowser: async () => {}, authorizeUrl: 'https://x/a',
    });
    await new Promise(r => setTimeout(r, 50));
    await visit(`${REDIRECT}?error=access_denied&error_description=User+said+no&state=ST`);

    await expect(pending).rejects.toThrow(/access_denied/);
  });

  it('gives up rather than holding the port for ever when nobody signs in', async () => {
    await expect(awaitAuthorizationCode({
      redirectUri: REDIRECT, state: 'ST', timeoutMs: 150,
      openBrowser: async () => {}, authorizeUrl: 'https://x/a',
    })).rejects.toThrow(/timed out/i);
  });

  it('releases the port after every outcome, so a retry can bind it again', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(awaitAuthorizationCode({
        redirectUri: REDIRECT, state: 'ST', timeoutMs: 100,
        openBrowser: async () => {}, authorizeUrl: 'https://x/a',
      })).rejects.toThrow(/timed out/i);
    }
  });

  it('ignores a request to another path, such as a favicon fetch', async () => {
    const pending = awaitAuthorizationCode({
      redirectUri: REDIRECT, state: 'ST', timeoutMs: 5000,
      openBrowser: async () => {}, authorizeUrl: 'https://x/a',
    });
    await new Promise(r => setTimeout(r, 50));
    const stray = await visit('http://127.0.0.1:8799/favicon.ico');
    expect(stray.status).toBe(404);

    // Still listening for the real thing.
    await visit(`${REDIRECT}?code=THECODE&state=ST`);
    await expect(pending).resolves.toBe('THECODE');
  });
});
