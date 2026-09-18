import type { ResolvedOAuth } from './credentials.js';
import { exchangeAuthorizationCode, refreshAccessToken, type TokenSet } from './oauth-token.js';
import { awaitAuthorizationCode } from './oauth-loopback.js';
import { buildAuthorizeUrl, createPkcePair, randomState } from './pkce.js';
import { readRefreshToken as defaultRead, saveRefreshToken as defaultSave } from './token-file.js';

export interface AuthCodeDeps {
  tokenFile: string;
  readRefreshToken?: (path: string, identity: string) => string | null;
  saveRefreshToken?: (path: string, identity: string, token: string | null) => void;
  refresh?: (oauth: ResolvedOAuth, refreshToken: string) => Promise<TokenSet>;
  signIn?: (oauth: ResolvedOAuth) => Promise<TokenSet>;
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
  // The issuer answered, and what it said was that the grant is no good.
  return /invalid_grant|invalid_token|unauthorized_client|expired|revoked/i.test(message);
}

/**
 * Run the interactive half: browser, loopback redirect, code exchange.
 *
 * Everything is logged to stderr. This process speaks MCP over stdout, so a
 * single stray stdout write would corrupt the protocol stream.
 */
async function interactiveSignIn(oauth: ResolvedOAuth): Promise<TokenSet> {
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
  return tokens;
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
  const read = deps.readRefreshToken ?? defaultRead;
  const save = deps.saveRefreshToken ?? defaultSave;
  const refresh = deps.refresh ?? ((o, rt) => refreshAccessToken(o, rt));
  const signIn = deps.signIn ?? interactiveSignIn;

  return async (oauth: ResolvedOAuth): Promise<TokenSet> => {
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
        const tokens = await refresh(oauth, stored);
        if (tokens.refreshToken && tokens.refreshToken !== stored) {
          // The issuer rotated it; the old one may already be void.
          save(deps.tokenFile, identity, tokens.refreshToken);
        }
        return tokens;
      } catch (error) {
        if (!isCredentialDead(error)) throw error;
        console.error('[oauth] The stored credential was refused; signing in again.');
        save(deps.tokenFile, identity, null);
      }
    }

    const tokens = await signIn(oauth);
    if (tokens.refreshToken) save(deps.tokenFile, identity, tokens.refreshToken);
    return tokens;
  };
}
