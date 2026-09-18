import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRefreshToken, saveRefreshToken } from './token-file.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokfile-')); file = join(dir, 'tokens.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('refresh token persistence', () => {
  it('returns null when nothing has been stored yet', () => {
    expect(readRefreshToken(file, 'identity')).toBeNull();
  });

  it('round-trips a token for one identity', () => {
    saveRefreshToken(file, 'identity', 'RT');
    expect(readRefreshToken(file, 'identity')).toBe('RT');
  });

  it('keeps identities apart, so one issuer cannot use another', () => {
    saveRefreshToken(file, 'issuer-a', 'RT-A');
    saveRefreshToken(file, 'issuer-b', 'RT-B');
    expect(readRefreshToken(file, 'issuer-a')).toBe('RT-A');
    expect(readRefreshToken(file, 'issuer-b')).toBe('RT-B');
  });

  it('writes the file readable only by its owner', () => {
    saveRefreshToken(file, 'identity', 'RT');
    // A refresh token is a long-lived credential; 0600 is the whole point.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a file that already existed too permissively', () => {
    writeFileSync(file, '{}', { mode: 0o644 });
    saveRefreshToken(file, 'identity', 'RT');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('treats an unreadable or corrupt store as empty rather than crashing the server', () => {
    writeFileSync(file, 'not json at all', { mode: 0o600 });
    expect(readRefreshToken(file, 'identity')).toBeNull();
    // and can still be written over
    saveRefreshToken(file, 'identity', 'RT');
    expect(readRefreshToken(file, 'identity')).toBe('RT');
  });

  it('forgets one identity without disturbing the others', () => {
    saveRefreshToken(file, 'a', 'RT-A');
    saveRefreshToken(file, 'b', 'RT-B');
    saveRefreshToken(file, 'a', null);
    expect(readRefreshToken(file, 'a')).toBeNull();
    expect(readRefreshToken(file, 'b')).toBe('RT-B');
  });

  it('does not write the identity string itself, which may name a user', () => {
    saveRefreshToken(file, 'https://jas\nresource-navigator\nauthorization_code\njamsden\ngeneral', 'RT');
    // The identity is hashed into a key: the file should not carry the user name.
    expect(readFileSync(file, 'utf8')).not.toContain('jamsden');
  });
});
