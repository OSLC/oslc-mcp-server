import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 §4.1: the verifier's alphabet is the URL-unreserved set. base64url is a subset. */
function unreserved(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export interface PkcePair {
  /** Kept locally and sent only at the token exchange — never in the authorize URL. */
  verifier: string;
  /** Sent in the authorize URL. */
  challenge: string;
  method: 'S256';
}

/**
 * A PKCE verifier and its S256 challenge (RFC 7636).
 *
 * PKCE is what makes a loopback redirect safe: any process on this machine can
 * bind a port once ours releases it, and any local program can read a redirect
 * URL. Without the verifier, an intercepted code would be redeemable; with it,
 * the code is useless to anyone who did not generate the verifier.
 *
 * `plain` is deliberately not offered even though this issuer advertises it —
 * it provides no protection at all.
 */
export function createPkcePair(): PkcePair {
  // 32 bytes -> 43 base64url characters, the RFC's minimum and ample entropy.
  const verifier = unreserved(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/**
 * An unguessable `state`, which ties a redirect back to the request that began
 * it. Without it a stray or forged call to our loopback port could inject an
 * attacker's authorization code into our session.
 */
export function randomState(): string {
  return unreserved(24);
}

export interface AuthorizeUrlParts {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
}

/** The URL the user's browser is sent to in order to sign in. */
export function buildAuthorizeUrl(parts: AuthorizeUrlParts): string {
  const url = new URL(parts.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', parts.clientId);
  url.searchParams.set('redirect_uri', parts.redirectUri);
  url.searchParams.set('state', parts.state);
  url.searchParams.set('code_challenge', parts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Absent rather than empty when unconfigured: some issuers treat an empty
  // scope as a request for none at all.
  if (parts.scope) url.searchParams.set('scope', parts.scope);
  return url.toString();
}
