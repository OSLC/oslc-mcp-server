import { describe, it, expect, jest } from '@jest/globals';
import { createCredentialProvider, buildClientOptions } from './oauth-credential.js';

const oauth = { issuer: 'https://i', clientId: 'c', clientSecret: 's' };

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
      { issuer: 'https://i', clientId: 'c', clientSecret: 's' },
      { request: async () => ({ accessToken: 'AT', expiresAt: Date.now() + 7200_000 }) }
    );

    await expect(options.getAuthorization!({ url: 'https://x/y', forceRefresh: false }))
      .resolves.toBe('Bearer AT');
  });

  it('supplies none when the server configures no oauth, so existing servers are unaffected', () => {
    expect(buildClientOptions(null)).toEqual({});
  });
});
