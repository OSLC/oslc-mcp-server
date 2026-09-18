import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Refresh tokens on disk, so a browser sign-in is a once-ever event rather than
 * a once-per-restart one.
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

type Store = Record<string, string>;

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

/** The stored refresh token for this identity, or null. */
export function readRefreshToken(path: string, identity: string): string | null {
  const value = load(path)[keyFor(identity)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Store (or, with null, forget) the refresh token for one identity. */
export function saveRefreshToken(path: string, identity: string, token: string | null): void {
  const store = load(path);
  const key = keyFor(identity);
  if (token) store[key] = token; else delete store[key];

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is created, so an
  // existing world-readable file would silently keep its mode.
  chmodSync(path, 0o600);
}
