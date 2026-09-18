import { describe, it, expect } from '@jest/globals';
import { requestClientCredentialsToken, requestToken, exchangeAuthorizationCode, refreshAccessToken } from './oauth-token.js';

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

describe('requestToken — password grant', () => {
  const userOauth = { ...oauth, grant: 'password' as const, username: 'jamsden', password: 'pw' };

  it('posts the password grant with the user, authenticating the client with Basic', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ access_token: 'USERTOKEN', expires_in: 3600 }) };
    }) as any;

    const tokens = await requestToken(userOauth, fetchImpl);

    expect(calls[0][0]).toBe('https://jas.example.com/oidc/endpoint/jazzop/token');
    // The CLIENT authenticates with Basic; the USER travels in the form.
    expect(calls[0][1].headers['Authorization'])
      .toBe('Basic ' + Buffer.from('mcp-server:s3cret').toString('base64'));

    const form = new URLSearchParams(calls[0][1].body);
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('username')).toBe('jamsden');
    expect(form.get('password')).toBe('pw');
    expect(form.get('scope')).toBe('service-user-roles');
    expect(tokens.accessToken).toBe('USERTOKEN');
  });

  it('routes the client_credentials grant to the client credentials exchange', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 60 }) };
    }) as any;

    await requestToken({ ...oauth, grant: 'client_credentials' as const }, fetchImpl);

    const form = new URLSearchParams(calls[0].body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.has('username')).toBe(false);
  });

  it('refuses a password grant with no user rather than posting an empty one', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called'); }) as any;
    await expect(requestToken({ ...oauth, grant: 'password' as const }, fetchImpl))
      .rejects.toThrow(/username and password/i);
  });

  it('never puts the user password in the error when the exchange fails', async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 400, text: async () => '{"error":"invalid_grant"}',
    })) as any;

    await expect(requestToken(userOauth, fetchImpl)).rejects.toThrow(/invalid_grant/);
    await expect(requestToken(userOauth, fetchImpl)).rejects.not.toThrow(/pw|s3cret/);
  });
});

describe('authorization code exchange and refresh', () => {
  function capture(body: unknown) {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => body };
    }) as any;
    return { calls, fetchImpl };
  }

  it('redeems the code with the verifier and the same redirect_uri', async () => {
    const { calls, fetchImpl } = capture({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' });

    const tokens = await exchangeAuthorizationCode(
      oauth, { code: 'CODE', verifier: 'VERIFIER', redirectUri: 'http://127.0.0.1:8765/callback' }, fetchImpl);

    const form = new URLSearchParams(calls[0][1].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('CODE');
    expect(form.get('code_verifier')).toBe('VERIFIER');
    // RFC 6749 4.1.3: redirect_uri must be repeated and must match the authorize request.
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
  });

  it('does not send scope on the code exchange, which would narrow the grant', async () => {
    const { calls, fetchImpl } = capture({ access_token: 'AT', expires_in: 60 });
    await exchangeAuthorizationCode(oauth, { code: 'C', verifier: 'V', redirectUri: 'http://x/cb' }, fetchImpl);
    expect(new URLSearchParams(calls[0][1].body).has('scope')).toBe(false);
  });

  it('refreshes with the refresh token and keeps the new one when the issuer rotates it', async () => {
    const { calls, fetchImpl } = capture({ access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2' });

    const tokens = await refreshAccessToken(oauth, 'RT1', fetchImpl);

    const form = new URLSearchParams(calls[0][1].body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('RT1');
    expect(tokens.refreshToken).toBe('RT2');
  });

  it('keeps the existing refresh token when the issuer returns none', async () => {
    const { fetchImpl } = capture({ access_token: 'AT2', expires_in: 3600 });
    const tokens = await refreshAccessToken(oauth, 'RT1', fetchImpl);
    // Dropping it here would force a browser sign-in on the next start.
    expect(tokens.refreshToken).toBe('RT1');
  });

  it('never puts the refresh token in an error when the exchange fails', async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 400, text: async () => '{"error":"invalid_grant"}',
    })) as any;
    await expect(refreshAccessToken(oauth, 'SECRET-RT', fetchImpl)).rejects.toThrow(/invalid_grant/);
    await expect(refreshAccessToken(oauth, 'SECRET-RT', fetchImpl)).rejects.not.toThrow(/SECRET-RT/);
  });
});
