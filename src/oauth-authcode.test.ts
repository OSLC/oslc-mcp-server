import { describe, it, expect, jest } from '@jest/globals';
import { createAuthorizationCodeRequester } from './oauth-authcode.js';

const oauth = {
  issuer: 'https://jas.example.com/oidc/endpoint/jazzop',
  clientId: 'resource-navigator', clientSecret: 's', scope: 'general',
  grant: 'authorization_code' as const,
  redirectUri: 'http://127.0.0.1:8765/callback',
};

const fresh = (rt?: string) => ({ accessToken: 'AT', expiresAt: Date.now() + 3600_000, refreshToken: rt });

function deps(over: Partial<any> = {}) {
  return {
    readStoredGrant: jest.fn<any>().mockReturnValue(null),
    saveStoredGrant: jest.fn<any>(),
    refresh: jest.fn<any>().mockResolvedValue(fresh('RT-NEW')),
    signIn: jest.fn<any>().mockResolvedValue(fresh('RT-FIRST')),
    tokenFile: '/tmp/none.json',
    ...over,
  };
}

describe('createAuthorizationCodeRequester', () => {
  it('signs in interactively when nothing is stored, and saves the refresh token', async () => {
    const d = deps();
    await expect(createAuthorizationCodeRequester(d)(oauth)).resolves.toMatchObject({ accessToken: 'AT' });

    expect(d.signIn).toHaveBeenCalledTimes(1);
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.saveStoredGrant).toHaveBeenCalledWith('/tmp/none.json', expect.any(String), { refreshToken: 'RT-FIRST', verifier: undefined });
  });

  it('refreshes silently when a token is stored, opening no browser', async () => {
    const d = deps({ readStoredGrant: jest.fn<any>().mockReturnValue({ refreshToken: 'RT-STORED', verifier: 'VER' }) });
    await expect(createAuthorizationCodeRequester(d)(oauth)).resolves.toMatchObject({ accessToken: 'AT' });

    expect(d.refresh).toHaveBeenCalledWith(oauth, 'RT-STORED', 'VER');
    expect(d.signIn).not.toHaveBeenCalled();
  });

  it('persists a rotated refresh token, or the next start would use a dead one', async () => {
    const d = deps({ readStoredGrant: jest.fn<any>().mockReturnValue({ refreshToken: 'RT-OLD', verifier: 'VER' }) });
    await createAuthorizationCodeRequester(d)(oauth);
    expect(d.saveStoredGrant).toHaveBeenCalledWith('/tmp/none.json', expect.any(String), { refreshToken: 'RT-NEW', verifier: 'VER' });
  });

  it('falls back to a browser sign-in when the stored token is revoked', async () => {
    const d = deps({
      readStoredGrant: jest.fn<any>().mockReturnValue({ refreshToken: 'RT-REVOKED' }),
      refresh: jest.fn<any>().mockRejectedValue(new Error('invalid_grant')),
    });
    await expect(createAuthorizationCodeRequester(d)(oauth)).resolves.toMatchObject({ accessToken: 'AT' });

    expect(d.signIn).toHaveBeenCalledTimes(1);
    // The dead token must be cleared, not left to fail again every start.
    expect(d.saveStoredGrant).toHaveBeenCalledWith('/tmp/none.json', expect.any(String), null);
  });

  it('does not open a browser for a network failure, which is not a revoked token', async () => {
    const d = deps({
      readStoredGrant: jest.fn<any>().mockReturnValue({ refreshToken: 'RT' }),
      refresh: jest.fn<any>().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    });
    await expect(createAuthorizationCodeRequester(d)(oauth)).rejects.toThrow(/socket hang up/);
    expect(d.signIn).not.toHaveBeenCalled();
    expect(d.saveStoredGrant).not.toHaveBeenCalled();
  });

  it('refuses a redirect URI that is not loopback, which no MCP server can receive', async () => {
    const d = deps();
    await expect(createAuthorizationCodeRequester(d)({ ...oauth, redirectUri: 'https://example.com/cb' }))
      .rejects.toThrow(/loopback/i);
  });

  it('requires a redirect URI, since it must match one registered on the client', async () => {
    const d = deps();
    await expect(createAuthorizationCodeRequester(d)({ ...oauth, redirectUri: undefined }))
      .rejects.toThrow(/redirectUri/);
  });
});

describe('reporting a failure', () => {
  it('says why on stderr, because oslc-client re-wraps the cause out of sight', async () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ signIn: jest.fn<any>().mockRejectedValue(new Error('token endpoint refused the code')) });

    await expect(createAuthorizationCodeRequester(d)(oauth)).rejects.toThrow('token endpoint refused the code');

    const said = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(said).toMatch(/token endpoint refused the code/);
    expect(said).toMatch(/jas\.example\.com/);
    warn.mockRestore();
  });

  it('reports a configuration failure too, not only an exchange failure', async () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createAuthorizationCodeRequester(deps())({ ...oauth, redirectUri: undefined }))
      .rejects.toThrow(/redirectUri/);

    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/redirectUri/);
    warn.mockRestore();
  });
});

describe('the verifier survives, because JAS wants it again on every refresh', () => {
  it('stores the verifier from the sign-in and replays it on the next refresh', async () => {
    const saved: any[] = [];
    const store: any = { value: null };
    const d = {
      tokenFile: '/tmp/none.json',
      readStoredGrant: () => store.value,
      saveStoredGrant: (_p: string, _i: string, g: any) => { saved.push(g); store.value = g; },
      refresh: jest.fn<any>().mockResolvedValue(fresh('RT-2')),
      signIn: jest.fn<any>().mockResolvedValue({ ...fresh('RT-1'), verifier: 'VERIFIER-FROM-SIGNIN' }),
    };
    const requester = createAuthorizationCodeRequester(d);

    await requester(oauth);                       // first run: browser sign-in
    expect(saved[0]).toEqual({ refreshToken: 'RT-1', verifier: 'VERIFIER-FROM-SIGNIN' });

    await requester(oauth);                       // next run: silent refresh
    // Without replaying it, JAS answers CWOAU0033E and every restart needs a browser.
    expect(d.refresh).toHaveBeenCalledWith(oauth, 'RT-1', 'VERIFIER-FROM-SIGNIN');
  });

  it('treats any 4xx from the token endpoint as a dead credential, not only invalid_grant', async () => {
    const d = deps({
      readStoredGrant: jest.fn<any>().mockReturnValue({ refreshToken: 'RT' }),
      refresh: jest.fn<any>().mockRejectedValue(
        new Error('Token endpoint returned 400: {"error":"invalid_request"}')),
    });
    // Guessing at the issuer's error vocabulary is how a recoverable state
    // becomes a server that never starts.
    await expect(createAuthorizationCodeRequester(d)(oauth)).resolves.toMatchObject({ accessToken: 'AT' });
    expect(d.signIn).toHaveBeenCalledTimes(1);
  });
});
