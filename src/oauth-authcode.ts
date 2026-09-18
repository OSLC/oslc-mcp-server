import type { ResolvedOAuth } from './credentials.js';
import { exchangeAuthorizationCode, refreshAccessToken, type TokenSet } from './oauth-token.js';
import { awaitAuthorizationCode } from './oauth-loopback.js';
import { buildAuthorizeUrl, createPkcePair, randomState } from './pkce.js';
import { readStoredGrant as defaultRead, saveStoredGrant as defaultSave, type StoredGrant } from './token-file.js';

export interface AuthCodeDeps {
  tokenFile: string;
  readStoredGrant?: (path: string, identity: string) => StoredGrant | null;
  saveStoredGrant?: (path: string, identity: string, grant: StoredGrant | null) => void;
  refresh?: (oauth: ResolvedOAuth, refreshToken: string, verifier?: string) => Promise<TokenSet>;
  /** Resolves with the tokens AND the verifier they are bound to. */
  signIn?: (oauth: ResolvedOAuth) => Promise<TokenSet & { verifier?: string }>;
}

/** The stored-credential key. Same shape as the in-memory cache key, minus secrets. */
function identityOf(oauth: ResolvedOAuth): string {
  return [oauth.issuer, oauth.clientId, oauth.grant, oauth.username ?? '', oauth.scope ?? ''].join('\n');
}

/**
 * Whether a failed refresh means "this credential is dead, sign in again" or
 * "the network is having a bad day, try later".
 *
 * The distinction matters: opening a browser because a proxy blipped would be
 * a hostile thing to do to an MCP server running unattended, and clearing a
 * perfectly good refresh token on a transient error would force an
 * interactive sign-in that was never needed.
 */
function isCredentialDead(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The issuer answered and refused — whatever it objected to, the stored
  // credential cannot be used, and a browser sign-in is the recovery. Matching
  // the status rather than a list of error codes: `invalid_request` from a
  // rejected refresh is just as dead as `invalid_grant`, and guessing at the
  // vocabulary is how a recoverable state becomes a server that never starts.
  return /Token endpoint returned 4\d\d/.test(message)
      || /invalid_grant|invalid_token|unauthorized_client|expired|revoked/i.test(message);
}

/**
 * Run the interactive half: browser, loopback redirect, code exchange.
 *
 * Everything is logged to stderr. This process speaks MCP over stdout, so a
 * single stray stdout write would corrupt the protocol stream.
 */
async function interactiveSignIn(oauth: ResolvedOAuth): Promise<TokenSet & { verifier?: string }> {
  const redirectUri = oauth.redirectUri!;
  const { verifier, challenge } = createPkcePair();
  const state = randomState();

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: `${oauth.issuer.replace(/\/+$/, '')}/authorize`,
    clientId: oauth.clientId,
    redirectUri,
    state,
    challenge,
    scope: oauth.scope,
  });

  console.error(`[oauth] Opening a browser to sign in at ${oauth.issuer}`);
  console.error(`[oauth] If no browser opens, visit this URL yourself:\n${authorizeUrl}`);

  const code = await awaitAuthorizationCode({ redirectUri, state, authorizeUrl });
  const tokens = await exchangeAuthorizationCode(oauth, { code, verifier, redirectUri });
  console.error('[oauth] Signed in. The refresh token is stored, so this will not be asked again.');
  // The verifier travels with the tokens: JAS demands it again on every refresh.
  return { ...tokens, verifier };
}

/**
 * Build the token requester for the authorization code flow.
 *
 * Order matters: a stored refresh token is used first, so a restart is silent.
 * Only when there is none — or the issuer says the one we have is dead — does a
 * browser open. That is what makes this usable for a server launched by an MCP
 * client rather than by a person at a prompt.
 */
export function createAuthorizationCodeRequester(
  deps: AuthCodeDeps
): (oauth: ResolvedOAuth) => Promise<TokenSet> {
  const read = deps.readStoredGrant ?? defaultRead;
  const save = deps.saveStoredGrant ?? defaultSave;
  const refresh = deps.refresh ?? ((o, rt, v) => refreshAccessToken(o, rt, v));
  const signIn = deps.signIn ?? interactiveSignIn;

  const acquire = async (oauth: ResolvedOAuth): Promise<TokenSet> => {
    if (!oauth.redirectUri) {
      throw new Error(
        `Issuer ${oauth.issuer}: the authorization_code grant needs \`redirectUri\`, ` +
        `and it must exactly match one registered on the OAuth client.`
      );
    }
    // RFC 8252 §7.3. A remote redirect URI could never reach this process, and
    // accepting one would send the code somewhere we cannot read it.
    const host = new URL(oauth.redirectUri).hostname;
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      throw new Error(
        `Issuer ${oauth.issuer}: \`redirectUri\` must be a loopback address ` +
        `(http://127.0.0.1:<port>/…) — this server has no way to receive a redirect anywhere else.`
      );
    }

    const identity = identityOf(oauth);
    const stored = read(deps.tokenFile, identity);

    if (stored) {
      try {
        const tokens = await refresh(oauth, stored.refreshToken, stored.verifier);
        if (tokens.refreshToken && tokens.refreshToken !== stored.refreshToken) {
          // The issuer rotated it; the old one may already be void. The
          // verifier carries forward — it belongs to the original grant, not
          // to any one refresh token in the chain.
          save(deps.tokenFile, identity, { refreshToken: tokens.refreshToken, verifier: stored.verifier });
        }
        return tokens;
      } catch (error) {
        if (!isCredentialDead(error)) throw error;
        console.error('[oauth] The stored credential was refused; signing in again.');
        save(deps.tokenFile, identity, null);
      }
    }

    const tokens = await signIn(oauth);
    if (tokens.refreshToken) {
      save(deps.tokenFile, identity, { refreshToken: tokens.refreshToken, verifier: tokens.verifier });
    }
    return tokens;
  };

  // Say why, here, where the reason still exists.
  //
  // oslc-client wraps whatever this throws in a CredentialRejectedError, and
  // the caller above that re-wraps using only `.message` — so by the time a
  // failure reaches the console it reads "Credential provider failed: <url>"
  // with the actual cause stripped off. That is unactionable, and it is the
  // error an operator will be staring at.
  return async (oauth: ResolvedOAuth): Promise<TokenSet> => {
    try {
      return await acquire(oauth);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[oauth] Could not obtain a token from ${oauth.issuer}: ${reason}`);
      throw error;
    }
  };
}
