import { describe, it, expect } from '@jest/globals';
import { requestClientCredentialsToken } from './oauth-token.js';

const oauth = {
  issuer: 'https://jas.example.com/oidc/endpoint/jazzop',
  clientId: 'mcp-server', clientSecret: 's3cret', scope: 'service-user-roles',
};

describe('requestClientCredentialsToken', () => {
  it('posts the client credentials grant with client_secret_basic', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 7200 }) };
    }) as any;

    const before = Date.now();
    const tokens = await requestClientCredentialsToken(oauth, fetchImpl);

    expect(calls[0][0]).toBe('https://jas.example.com/oidc/endpoint/jazzop/token');
    expect(calls[0][1].headers['Authorization']).toBe('Basic ' + Buffer.from('mcp-server:s3cret').toString('base64'));

    const form = new URLSearchParams(calls[0][1].body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('service-user-roles');

    expect(tokens.accessToken).toBe('AT');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
  });

  it('omits scope when none is configured, rather than guessing one', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 60 }) };
    }) as any;

    await requestClientCredentialsToken({ ...oauth, scope: undefined }, fetchImpl);

    expect(new URLSearchParams(calls[0].body).has('scope')).toBe(false);
  });

  it('tolerates a trailing slash on the issuer rather than posting to a double slash', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 60 }) };
    }) as any;

    await requestClientCredentialsToken({ ...oauth, issuer: `${oauth.issuer}/` }, fetchImpl);

    expect(calls[0]).toBe('https://jas.example.com/oidc/endpoint/jazzop/token');
  });

  it('throws with the server error and never the secret', async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 401, text: async () => '{"error":"invalid_client"}',
    })) as any;

    await expect(requestClientCredentialsToken(oauth, fetchImpl)).rejects.toThrow(/invalid_client/);
    await expect(requestClientCredentialsToken(oauth, fetchImpl)).rejects.not.toThrow(/s3cret/);
  });

  it('rejects a 200 that carries no access_token instead of caching undefined', async () => {
    const fetchImpl = (async () => ({
      ok: true, status: 200, json: async () => ({ error: 'unsupported_grant_type' }),
    })) as any;

    await expect(requestClientCredentialsToken(oauth, fetchImpl))
      .rejects.toThrow(/no access_token/i);
  });
});
