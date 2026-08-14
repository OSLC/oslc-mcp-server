import { describe, it, expect } from '@jest/globals';
import { resolveCredentials } from './credentials.js';
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
