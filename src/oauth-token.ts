import type { ResolvedOAuth } from './credentials.js';

export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * OAuth 2.0 client credentials grant.
 *
 * There is no user in this flow, so the token carries the service principal's
 * identity: every action is attributed to the configured client, and what it
 * can see is what that service account can see. That is the honest answer for
 * a service acting on its own behalf, and it is why an interactive host must
 * not use this grant.
 */
export async function requestClientCredentialsToken(
  oauth: ResolvedOAuth,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const endpoint = `${oauth.issuer.replace(/\/+$/, '')}/token`;

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  // Deliberately absent unless configured: a wrong scope authenticates and then
  // fails authorization, which is harder to diagnose than no scope at all.
  if (oauth.scope) form.set('scope', oauth.scope);

  const basic = Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: form.toString(),
  } as any);

  if (!response.ok) {
    const detail = await response.text();
    // The secret is in the request, never in the message.
    throw new Error(`Token endpoint returned ${response.status}: ${detail.slice(0, 500)}`);
  }

  const body: any = await response.json();

  // A 200 carrying no access_token is a real answer from some issuers — an
  // error object served with the wrong status. Without this the undefined
  // would be cached and sent as the literal header `Bearer undefined`, and
  // the resulting 401 would look like a rejected credential rather than a
  // malformed grant.
  if (typeof body?.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error(
      `Token endpoint returned ${response.status} with no access_token ` +
      `(keys: ${Object.keys(body ?? {}).join(', ') || 'none'}).`
    );
  }

  return {
    accessToken: body.access_token,
    // Absent expires_in means "expired now", so the next request re-fetches
    // rather than reusing a token of unknown lifetime forever.
    expiresAt: Date.now() + (Number(body.expires_in) || 0) * 1000,
  };
}
