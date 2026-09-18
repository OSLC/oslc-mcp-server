import type { OSLCClientOptions } from 'oslc-client';
import type { ResolvedOAuth } from './credentials.js';
import { requestToken, type TokenSet } from './oauth-token.js';

/** Refresh this long before expiry rather than waiting for a rejection. */
const REFRESH_MARGIN_MS = 60_000;

type TokenRequest = (oauth: ResolvedOAuth) => Promise<TokenSet>;

/**
 * One token per credential identity, shared by every server that uses it.
 *
 * A deployment is typically one ELM application group behind one issuer: DNG,
 * ETM, EWM, CDCM and RSE are five server entries but one identity. Caching per
 * server would exchange five tokens for the same user at the same issuer, and
 * — worse — a rejection on one server would leave the other four holding the
 * credential that had just been refused.
 *
 * The key is the identity the token represents, not merely the issuer: issuer,
 * client, grant, user and scope. Two entries that agree on all five genuinely
 * share one token; two that differ must not, because a token minted for one
 * user or scope carries the wrong access for the other. It contains no secret,
 * so it is safe to hold in a Map and to print while debugging.
 */
export class TokenStore {
  private readonly tokens = new Map<string, TokenSet>();
  private readonly inFlight = new Map<string, Promise<TokenSet>>();

  constructor(private readonly request: TokenRequest = requestToken) {}

  /**
   * The cache key: everything that changes what a token means, and nothing
   * secret. The client secret and the user's password are deliberately absent —
   * they authenticate the request for a token, they do not distinguish one.
   */
  identityOf(oauth: ResolvedOAuth): string {
    return [oauth.issuer, oauth.clientId, oauth.grant, oauth.username ?? '', oauth.scope ?? ''].join('\n');
  }

  async get(oauth: ResolvedOAuth, forceRefresh: boolean): Promise<TokenSet> {
    const key = this.identityOf(oauth);
    const cached = this.tokens.get(key);
    const stale = !cached || Date.now() >= cached.expiresAt - REFRESH_MARGIN_MS;

    if (cached && !stale && !forceRefresh) return cached;

    // Discard before refetching so that a server which had its token refused
    // cannot hand the refused value to another server while the new exchange
    // is still in flight.
    if (forceRefresh) this.tokens.delete(key);

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.request(oauth)
        .then(tokens => { this.tokens.set(key, tokens); return tokens; })
        // Cleared either way, so a failed exchange does not poison later
        // attempts with a permanently rejected promise.
        .finally(() => { this.inFlight.delete(key); });
      this.inFlight.set(key, pending);
    }
    return pending;
  }
}

/**
 * Build the `getAuthorization` provider oslc-client calls before every request.
 *
 * oslc-client caches nothing — only the host knows a credential's lifetime and
 * how to renew it — so caching is the store's. Single-flight matters because
 * discovery fetches many resources concurrently: without it, an expired token
 * makes every in-flight request start its own exchange.
 *
 * Every request is authenticated, `rootservices` included. That looks wrong,
 * since rootservices is where a client learns the URLs it needs IN ORDER TO
 * authenticate, so an exemption was tried. Measured against trs-filter on
 * 2026-09-18, unauthenticated vs. a bearer token the server cannot validate:
 *
 *     /cdcm/<space>/rootservices   200   401
 *     /rm/rootservices             200   200
 *     /api/rootservices  (RSE)     200   200
 *
 * So CDCM reaches rootservices without a credential but VALIDATES an
 * Authorization header whenever one is present, while ELM and RSE ignore it.
 * Authenticating everything is therefore both correct here — a valid token
 * passes CDCM's check — and robust to a deployment that requires a credential
 * on rootservices outright, which an exemption would break with a bare
 * `WWW-Authenticate: Bearer` carrying no token_uri for oslc-client's ladder.
 *
 * It costs an OAuth-configured server nothing: it needs the token for every
 * other request anyway, so deferring it merely moves the failure. A stale
 * token 401s here and is refreshed and retried like any other rejection.
 *
 * A caller arriving with `forceRefresh` while an exchange is already in flight
 * joins it rather than starting another. That is safe because the exchange
 * always mints a NEW token at the endpoint; it can never hand back the one the
 * server just refused, which was removed from the cache above.
 */
export function createCredentialProvider(
  oauth: ResolvedOAuth,
  deps: { request?: TokenRequest; store?: TokenStore } = {}
): (ctx: { url: string; forceRefresh: boolean }) => Promise<string | null> {
  const store = deps.store ?? new TokenStore(deps.request);
  return async ({ forceRefresh }) => {
    const tokens = await store.get(oauth, forceRefresh);
    return `Bearer ${tokens.accessToken}`;
  };
}

/**
 * Options for the OSLCClient of one server.
 *
 * Without oauth this returns `{}`, so a server that authenticates with a
 * username and password behaves exactly as it did before — oslc-client
 * registers its provider interceptor only when `getAuthorization` is present.
 *
 * Pass the process-wide {@link TokenStore} so that servers sharing an identity
 * share a token. Omitting it gives this server a private store, which is only
 * what a test wants.
 *
 * Lives here rather than in index.ts because index.ts calls `main()` at module
 * scope: importing it from a test would start the MCP server.
 */
export function buildClientOptions(
  oauth: ResolvedOAuth | null,
  store?: TokenStore,
  deps?: { request?: TokenRequest }
): OSLCClientOptions {
  if (!oauth) return {};
  return { getAuthorization: createCredentialProvider(oauth, { store, request: deps?.request }) };
}
