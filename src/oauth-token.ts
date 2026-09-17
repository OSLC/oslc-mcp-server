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
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  return postTokenRequest(oauth, form, fetchImpl);
}

/**
 * OAuth 2.0 resource owner password credentials grant.
 *
 * Unlike the client credentials grant, the token this returns represents the
 * USER named below — which is the right identity for a server acting on that
 * user's behalf, and what the deployment's access rules are written against.
 *
 * OAuth 2.1 drops this grant because a third-party client should never handle
 * a user's password. That reasoning does not bite here: this process already
 * holds the password and already submits it to the same organisation's token
 * endpoint over oslc-client's JAS bearer path, so the grant adds no exposure
 * that was not already present.
 */
export async function requestPasswordToken(
  oauth: ResolvedOAuth,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  if (!oauth.username || !oauth.password) {
    // Posting an empty username would be answered with a generic invalid_grant,
    // which reads like a wrong password rather than a missing configuration.
    throw new Error(
      `The password grant needs a username and password for issuer ${oauth.issuer}; ` +
      `set the server's \`credentials\` (usernameEnv/passwordEnv).`
    );
  }
  const form = new URLSearchParams({
    grant_type: 'password',
    username: oauth.username,
    password: oauth.password,
  });
  return postTokenRequest(oauth, form, fetchImpl);
}

/**
 * Dispatch to the configured grant. One entry point so the token cache does not
 * have to know which grant produced a token.
 */
export async function requestToken(
  oauth: ResolvedOAuth,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  return oauth.grant === 'password'
    ? requestPasswordToken(oauth, fetchImpl)
    : requestClientCredentialsToken(oauth, fetchImpl);
}

/**
 * POST a grant to the issuer's token endpoint, authenticating the CLIENT with
 * client_secret_basic. Whatever identifies the resource owner travels in the
 * form, never in this header.
 */
async function postTokenRequest(
  oauth: ResolvedOAuth,
  form: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<TokenSet> {
  const endpoint = `${oauth.issuer.replace(/\/+$/, '')}/token`;

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
