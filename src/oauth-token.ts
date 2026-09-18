import type { ResolvedOAuth } from './credentials.js';

export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /**
   * Present for the authorization code flow. Persisting it is what makes the
   * browser sign-in a once-ever event rather than a once-per-restart one.
   */
  refreshToken?: string;
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
 * Redeem an authorization code (RFC 6749 §4.1.3).
 *
 * `redirect_uri` is repeated here even though no redirect happens: the issuer
 * compares it with the one from the authorize request, and a mismatch is
 * rejected. `code_verifier` is the PKCE half that never travelled in a URL.
 */
export async function exchangeAuthorizationCode(
  oauth: ResolvedOAuth,
  params: { code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
  // No scope here, deliberately: the grant's scope was fixed at the authorize
  // step, and repeating it can only narrow what was already approved.
  return postTokenRequest(oauth, form, fetchImpl, { withScope: false });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The issuer may or may not rotate the refresh token. When it returns a new
 * one we keep that; when it returns none we carry the old one forward, because
 * dropping it would force a browser sign-in on the next start.
 */
export async function refreshAccessToken(
  oauth: ResolvedOAuth,
  refreshToken: string,
  verifier?: string,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  // RFC 6749 does not define `code_verifier` on a refresh, but IBM Jazz
  // Authorization Server requires it when the original grant used PKCE —
  // without it the token endpoint answers `CWOAU0033E: A required runtime
  // parameter was missing: code_verifier`. Sent only when we have one, and
  // harmless where it is not wanted: an authorization server must ignore
  // request parameters it does not recognise.
  if (verifier) form.set('code_verifier', verifier);
  const tokens = await postTokenRequest(oauth, form, fetchImpl, { withScope: false });
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/**
 * Dispatch to the configured grant. One entry point so the token cache does not
 * have to know which grant produced a token.
 */
export async function requestToken(
  oauth: ResolvedOAuth,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  if (oauth.grant === 'authorization_code') {
    // Not a silent fall-through to client credentials: that would quietly swap
    // the user's identity for the service principal's, which is the whole
    // distinction the grant was chosen for. The interactive flow needs a
    // browser and a token file, so it is assembled by its own factory.
    throw new Error(
      'The authorization_code grant cannot be run from requestToken — it needs a browser ' +
      'and a refresh-token store. Use createAuthorizationCodeRequester() from oauth-authcode.js.'
    );
  }
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
  fetchImpl: typeof fetch,
  opts: { withScope?: boolean } = {}
): Promise<TokenSet> {
  const endpoint = `${oauth.issuer.replace(/\/+$/, '')}/token`;

  // Deliberately absent unless configured: a wrong scope authenticates and then
  // fails authorization, which is harder to diagnose than no scope at all.
  if (oauth.scope && opts.withScope !== false) form.set('scope', oauth.scope);

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
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}
