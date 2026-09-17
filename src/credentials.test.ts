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
