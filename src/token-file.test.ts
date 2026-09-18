import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readStoredGrant, saveStoredGrant } from './token-file.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokfile-')); file = join(dir, 'tokens.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('refresh token persistence', () => {
  it('returns null when nothing has been stored yet', () => {
    expect(readStoredGrant(file, 'identity')).toBeNull();
  });

  it('round-trips the refresh token and the verifier it is bound to', () => {
    saveStoredGrant(file, 'identity', { refreshToken: 'RT', verifier: 'VER' });
    expect(readStoredGrant(file, 'identity')).toEqual({ refreshToken: 'RT', verifier: 'VER' });
  });

  it('reads a bare string written by an earlier version as a refresh token', () => {
    const key = createHash('sha256').update('identity').digest('hex').slice(0, 32);
    writeFileSync(file, JSON.stringify({ [key]: 'RT-OLD' }), { mode: 0o600 });
    expect(readStoredGrant(file, 'identity')).toEqual({ refreshToken: 'RT-OLD' });
  });

  it('keeps identities apart, so one issuer cannot use another', () => {
    saveStoredGrant(file, 'issuer-a', { refreshToken: 'RT-A' });
    saveStoredGrant(file, 'issuer-b', { refreshToken: 'RT-B' });
    expect(readStoredGrant(file, 'issuer-a')!.refreshToken).toBe('RT-A');
    expect(readStoredGrant(file, 'issuer-b')!.refreshToken).toBe('RT-B');
  });

  it('writes the file readable only by its owner', () => {
    saveStoredGrant(file, 'identity', { refreshToken: 'RT' });
    // A refresh token is a long-lived credential; 0600 is the whole point.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a file that already existed too permissively', () => {
    writeFileSync(file, '{}', { mode: 0o644 });
    saveStoredGrant(file, 'identity', { refreshToken: 'RT' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('treats an unreadable or corrupt store as empty rather than crashing the server', () => {
    writeFileSync(file, 'not json at all', { mode: 0o600 });
    expect(readStoredGrant(file, 'identity')).toBeNull();
    // and can still be written over
    saveStoredGrant(file, 'identity', { refreshToken: 'RT' });
    expect(readStoredGrant(file, 'identity')!.refreshToken).toBe('RT');
  });

  it('forgets one identity without disturbing the others', () => {
    saveStoredGrant(file, 'a', { refreshToken: 'RT-A' });
    saveStoredGrant(file, 'b', { refreshToken: 'RT-B' });
    saveStoredGrant(file, 'a', null);
    expect(readStoredGrant(file, 'a')).toBeNull();
    expect(readStoredGrant(file, 'b')!.refreshToken).toBe('RT-B');
  });

  it('does not write the identity string itself, which may name a user', () => {
    saveStoredGrant(file, 'https://jas\nresource-navigator\nauthorization_code\njamsden\ngeneral', { refreshToken: 'RT' });
    // The identity is hashed into a key: the file should not carry the user name.
    expect(readFileSync(file, 'utf8')).not.toContain('jamsden');
  });
});
