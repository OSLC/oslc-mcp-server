import { describe, it, expect } from '@jest/globals';
import { resolveCredentials, resolveOAuth } from './credentials.js';
import type { ServerEntry } from './config-file.js';

const base: ServerEntry = { alias: 'dng', baseUrl: 'https://elm.example.com/rm' };

describe('resolveCredentials', () => {
  it('resolves from the named environment variables', () => {
    const server = { ...base, credentials: { usernameEnv: 'U', passwordEnv: 'P' } };
    expect(resolveCredentials(server, { U: 'jim', P: 'secret' })).toEqual({
      username: 'jim',
      password: 'secret',
    });
  });

  it('uses literal credentials when given', () => {
    const server = { ...base, credentials: { username: 'jim', password: 'secret' } };
    expect(resolveCredentials(server, {})).toEqual({
      username: 'jim',
      password: 'secret',
    });
  });

  it('prefers environment references over literals when both are present', () => {
    const server = {
      ...base,
      credentials: {
        usernameEnv: 'U', passwordEnv: 'P',
        username: 'literal', password: 'literal-secret',
      },
    };
    expect(resolveCredentials(server, { U: 'jim', P: 'secret' })).toEqual({
      username: 'jim',
      password: 'secret',
    });
  });

  it('returns empty credentials when none are configured', () => {
    expect(resolveCredentials(base, {})).toEqual({ username: '', password: '' });
  });

  it('names the server and the missing variable when unset', () => {
    const server = { ...base, credentials: { usernameEnv: 'U', passwordEnv: 'P' } };
    expect(() => resolveCredentials(server, { U: 'jim' })).toThrow(/dng.*P/s);
  });

  it('does not leak the password value in the error', () => {
    const server = { ...base, credentials: { usernameEnv: 'U', passwordEnv: 'P' } };
    try {
      resolveCredentials(server, { P: 'secret' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain('secret');
    }
  });
});

const withOauth = (oauth: any) => ({ alias: 'cdcm', baseUrl: 'https://x', oauth } as any);

describe('resolveOAuth', () => {
  it('returns null when a server configures no oauth, so nothing changes for it', () => {
    expect(resolveOAuth({ alias: 'dng', baseUrl: 'https://x' } as any, {})).toBeNull();
  });

  it('reads the environment variables the config names', () => {
    const resolved = resolveOAuth(
      withOauth({ issuer: 'https://i', clientIdEnv: 'CID', clientSecretEnv: 'CSEC', scope: 's' }),
      { CID: 'the-client', CSEC: 'the-secret' }
    );
    expect(resolved).toEqual({
      issuer: 'https://i', clientId: 'the-client', clientSecret: 'the-secret', scope: 's',
      // This server configures no credentials, so there is no user for a token
      // to represent and the grant falls back to the client itself.
      grant: 'client_credentials', username: undefined, password: undefined,
    });
  });

  it('prefers environment references over literals, so an operator can override the file', () => {
    const resolved = resolveOAuth(
      withOauth({ issuer: 'https://i', clientId: 'literal', clientIdEnv: 'CID',
                  clientSecret: 'literal', clientSecretEnv: 'CSEC' }),
      { CID: 'from-env', CSEC: 'secret-from-env' }
    );
    expect(resolved!.clientId).toBe('from-env');
  });

  it('names the server and the missing variable, never a value', () => {
    expect(() => resolveOAuth(
      withOauth({ issuer: 'https://i', clientIdEnv: 'CID', clientSecretEnv: 'CSEC' }),
      { CID: 'the-client' }
    )).toThrow(/cdcm.*CSEC/);

    try {
      resolveOAuth(withOauth({ issuer: 'https://i', clientIdEnv: 'CID', clientSecretEnv: 'CSEC' }),
                   { CID: 'the-client' });
    } catch (e: any) {
      expect(e.message).not.toContain('the-client');
    }
  });
});

describe('resolveOAuth — grant selection and the resource owner', () => {
  const withBoth = (oauth: any, credentials: any) =>
    ({ alias: 'cdcm', baseUrl: 'https://x', oauth, credentials } as any);

  it('defaults to the password grant when the server has credentials, so the token is the user', () => {
    const resolved = resolveOAuth(
      withBoth({ issuer: 'https://i', clientId: 'c', clientSecretEnv: 'CS' },
               { usernameEnv: 'U', passwordEnv: 'P' }),
      { CS: 'sec', U: 'jamsden', P: 'pw' }
    );
    expect(resolved).toMatchObject({ grant: 'password', username: 'jamsden', password: 'pw' });
  });

  it('defaults to client credentials when there is no user to represent', () => {
    const resolved = resolveOAuth(
      withBoth({ issuer: 'https://i', clientId: 'c', clientSecretEnv: 'CS' }, undefined),
      { CS: 'sec' }
    );
    expect(resolved!.grant).toBe('client_credentials');
    expect(resolved!.username).toBeUndefined();
  });

  it('honours an explicit grant over the default', () => {
    const resolved = resolveOAuth(
      withBoth({ issuer: 'https://i', clientId: 'c', clientSecretEnv: 'CS', grant: 'client_credentials' },
               { usernameEnv: 'U', passwordEnv: 'P' }),
      { CS: 'sec', U: 'jamsden', P: 'pw' }
    );
    expect(resolved!.grant).toBe('client_credentials');
    // A service-principal token must not carry the user's password with it.
    expect(resolved!.password).toBeUndefined();
  });

  it('rejects an unknown grant rather than silently choosing one', () => {
    expect(() => resolveOAuth(
      withBoth({ issuer: 'https://i', clientId: 'c', clientSecretEnv: 'CS', grant: 'implicit' },
               { usernameEnv: 'U', passwordEnv: 'P' }),
      { CS: 'sec', U: 'u', P: 'p' }
    )).toThrow(/grant/i);
  });

  it('names the server when the password grant has no credentials to use', () => {
    expect(() => resolveOAuth(
      withBoth({ issuer: 'https://i', clientId: 'c', clientSecretEnv: 'CS', grant: 'password' }, undefined),
      { CS: 'sec' }
    )).toThrow(/cdcm.*credentials/i);
  });
});
