import { describe, it, expect, jest } from '@jest/globals';
import { createCredentialProvider, buildClientOptions, TokenStore } from './oauth-credential.js';

const oauth = { issuer: 'https://i', clientId: 'c', clientSecret: 's', grant: 'password' as const, username: 'u', password: 'p' };

describe('createCredentialProvider', () => {
  it('returns a complete header value', async () => {
    const request = jest.fn<any>().mockResolvedValue({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });
    const provider = createCredentialProvider(oauth, { request });

    await expect(provider({ url: 'https://x/y', forceRefresh: false })).resolves.toBe('Bearer AT');
  });

  it('reuses a cached token rather than fetching per request', async () => {
    const request = jest.fn<any>().mockResolvedValue({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });
    const provider = createCredentialProvider(oauth, { request });

    await provider({ url: 'https://x/1', forceRefresh: false });
    await provider({ url: 'https://x/2', forceRefresh: false });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refreshes ahead of expiry rather than waiting for a 401', async () => {
    const request = jest.fn<any>()
      .mockResolvedValueOnce({ accessToken: 'OLD', expiresAt: Date.now() + 30_000 })
      .mockResolvedValueOnce({ accessToken: 'NEW', expiresAt: Date.now() + 7200_000 });
    const provider = createCredentialProvider(oauth, { request });

    await provider({ url: 'https://x/1', forceRefresh: false });
    await expect(provider({ url: 'https://x/2', forceRefresh: false })).resolves.toBe('Bearer NEW');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent acquisitions into one', async () => {
    let resolveIt: (t: any) => void = () => {};
    const request = jest.fn<any>().mockReturnValue(new Promise(r => { resolveIt = r; }));
    const provider = createCredentialProvider(oauth, { request });

    const all = Promise.all(Array.from({ length: 10 }, (_, i) =>
      provider({ url: `https://x/${i}`, forceRefresh: false })));
    resolveIt({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });

    expect(await all).toEqual(Array(10).fill('Bearer AT'));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fetches a new token when the server rejected the current one', async () => {
    const request = jest.fn<any>()
      .mockResolvedValueOnce({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 })
      .mockResolvedValueOnce({ accessToken: 'AT2', expiresAt: Date.now() + 7200_000 });
    const provider = createCredentialProvider(oauth, { request });

    await provider({ url: 'https://x/1', forceRefresh: false });
    await expect(provider({ url: 'https://x/1', forceRefresh: true })).resolves.toBe('Bearer AT2');
  });

  it('lets the next caller retry after a failed acquisition', async () => {
    const request = jest.fn<any>()
      .mockRejectedValueOnce(new Error('token endpoint down'))
      .mockResolvedValueOnce({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });
    const provider = createCredentialProvider(oauth, { request });

    await expect(provider({ url: 'https://x/1', forceRefresh: false })).rejects.toThrow('token endpoint down');
    await expect(provider({ url: 'https://x/1', forceRefresh: false })).resolves.toBe('Bearer AT');
  });
});

describe('buildClientOptions', () => {
  it('supplies a credential provider when the server configures oauth', async () => {
    const options = buildClientOptions(
      { issuer: 'https://i', clientId: 'c', clientSecret: 's', grant: 'client_credentials' },
      new TokenStore(async () => ({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 }))
    );

    await expect(options.getAuthorization!({ url: 'https://x/y', forceRefresh: false }))
      .resolves.toBe('Bearer AT');
  });

  it('supplies none when the server configures no oauth, so existing servers are unaffected', () => {
    expect(buildClientOptions(null)).toEqual({});
  });
});

describe('TokenStore — one token per identity, shared across servers', () => {
  const cdcm = { ...oauth, issuer: 'https://jas' };
  const rse  = { ...oauth, issuer: 'https://jas' };   // same issuer, client, user, scope

  it('gives two servers on the same issuer ONE token, with one exchange', async () => {
    const request = jest.fn<any>().mockResolvedValue({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });
    const store = new TokenStore(request);

    const a = buildClientOptions(cdcm, store).getAuthorization!;
    const b = buildClientOptions(rse, store).getAuthorization!;

    await expect(a({ url: 'https://cdcm/x', forceRefresh: false })).resolves.toBe('Bearer AT');
    await expect(b({ url: 'https://rse/y', forceRefresh: false })).resolves.toBe('Bearer AT');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('coalesces a concurrent first use across servers into one exchange', async () => {
    let resolveIt: (t: any) => void = () => {};
    const request = jest.fn<any>().mockReturnValue(new Promise(r => { resolveIt = r; }));
    const store = new TokenStore(request);

    const a = buildClientOptions(cdcm, store).getAuthorization!;
    const b = buildClientOptions(rse, store).getAuthorization!;
    const both = Promise.all([
      a({ url: 'https://cdcm/x', forceRefresh: false }),
      b({ url: 'https://rse/y', forceRefresh: false }),
    ]);
    resolveIt({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 });

    expect(await both).toEqual(['Bearer AT', 'Bearer AT']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does NOT share between different users on the same issuer', async () => {
    const request = jest.fn<any>()
      .mockResolvedValueOnce({ accessToken: 'TOK-A', expiresAt: Date.now() + 7200_000 })
      .mockResolvedValueOnce({ accessToken: 'TOK-B', expiresAt: Date.now() + 7200_000 });
    const store = new TokenStore(request);

    const a = buildClientOptions({ ...cdcm, username: 'alice' }, store).getAuthorization!;
    const b = buildClientOptions({ ...cdcm, username: 'bob' }, store).getAuthorization!;

    await expect(a({ url: 'https://x/1', forceRefresh: false })).resolves.toBe('Bearer TOK-A');
    await expect(b({ url: 'https://x/2', forceRefresh: false })).resolves.toBe('Bearer TOK-B');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does NOT share between different scopes, which grant different access', async () => {
    const request = jest.fn<any>()
      .mockResolvedValueOnce({ accessToken: 'TOK-1', expiresAt: Date.now() + 7200_000 })
      .mockResolvedValueOnce({ accessToken: 'TOK-2', expiresAt: Date.now() + 7200_000 });
    const store = new TokenStore(request);

    const a = buildClientOptions({ ...cdcm, scope: 'general' }, store).getAuthorization!;
    const b = buildClientOptions({ ...cdcm, scope: 'service-user-roles' }, store).getAuthorization!;

    await expect(a({ url: 'https://x/1', forceRefresh: false })).resolves.toBe('Bearer TOK-1');
    await expect(b({ url: 'https://x/2', forceRefresh: false })).resolves.toBe('Bearer TOK-2');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a rejection on one server refreshes the token every server shares', async () => {
    const request = jest.fn<any>()
      .mockResolvedValueOnce({ accessToken: 'OLD', expiresAt: Date.now() + 7200_000 })
      .mockResolvedValueOnce({ accessToken: 'NEW', expiresAt: Date.now() + 7200_000 });
    const store = new TokenStore(request);

    const a = buildClientOptions(cdcm, store).getAuthorization!;
    const b = buildClientOptions(rse, store).getAuthorization!;

    await a({ url: 'https://cdcm/x', forceRefresh: false });
    // CDCM refused it; the shared token must be replaced for RSE too.
    await expect(a({ url: 'https://cdcm/x', forceRefresh: true })).resolves.toBe('Bearer NEW');
    await expect(b({ url: 'https://rse/y', forceRefresh: false })).resolves.toBe('Bearer NEW');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never puts the client secret or the user password in a cache key', () => {
    const store = new TokenStore(jest.fn<any>());
    const key = store.identityOf({ ...cdcm, clientSecret: 'SHHH', password: 'PWPW' });
    expect(key).not.toMatch(/SHHH|PWPW/);
    expect(key).toMatch(/jas/);
  });
});
