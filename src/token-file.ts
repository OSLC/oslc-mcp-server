import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * The stored half of an OAuth grant, so a browser sign-in is a once-ever event
 * rather than a once-per-restart one.
 *
 * A refresh token is a long-lived credential — it is the thing that lets this
 * process act as the user indefinitely — so the file is written 0600 and an
 * existing file's mode is tightened rather than trusted.
 *
 * Keys are a hash of the credential identity, not the identity itself. The
 * identity contains the user name, and this file is a plain JSON document an
 * operator may well open, paste or attach to a ticket; it should not carry
 * anything that reads as personal data.
 */

export interface StoredGrant {
  refreshToken: string;
  /**
   * The PKCE verifier the refresh token is bound to.
   *
   * RFC 6749 does not ask for `code_verifier` on a refresh, but IBM Jazz
   * Authorization Server does when the original grant used PKCE: without it the
   * token endpoint answers `CWOAU0033E: A required runtime parameter was
   * missing: code_verifier`. So the verifier has to outlive the sign-in that
   * produced it.
   */
  verifier?: string;
}

type Store = Record<string, StoredGrant | string>;

function keyFor(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function load(path: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Store : {};
  } catch {
    // Missing, unreadable or corrupt all mean the same thing to a caller: no
    // stored credential, so sign in again. Never fatal — a damaged cache must
    // not stop the server from starting.
    return {};
  }
}

/** The stored grant for this identity, or null. */
export function readStoredGrant(path: string, identity: string): StoredGrant | null {
  const value = load(path)[keyFor(identity)];
  // A bare string is the shape an earlier version wrote: a refresh token with
  // no verifier. Readable rather than discarded, so an upgrade does not force
  // a needless sign-in.
  if (typeof value === 'string') return value.length > 0 ? { refreshToken: value } : null;
  if (value && typeof value.refreshToken === 'string' && value.refreshToken.length > 0) return value;
  return null;
}

/** Store (or, with null, forget) the grant for one identity. */
export function saveStoredGrant(path: string, identity: string, grant: StoredGrant | null): void {
  const store = load(path);
  const key = keyFor(identity);
  if (grant) store[key] = grant; else delete store[key];

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is created, so an
  // existing world-readable file would silently keep its mode.
  chmodSync(path, 0o600);
}
