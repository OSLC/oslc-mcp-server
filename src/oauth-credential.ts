import type { OSLCClientOptions } from 'oslc-client';
import type { ResolvedOAuth } from './credentials.js';
import { requestClientCredentialsToken, type TokenSet } from './oauth-token.js';

/** Refresh this long before expiry rather than waiting for a rejection. */
const REFRESH_MARGIN_MS = 60_000;

type TokenRequest = (oauth: ResolvedOAuth) => Promise<TokenSet>;

/**
 * Build the `getAuthorization` provider oslc-client calls before every request.
 *
 * oslc-client caches nothing — only the host knows a credential's lifetime and
 * how to renew it — so caching is ours. Single-flight matters because discovery
 * fetches many resources concurrently: without it, an expired token makes every
 * in-flight request start its own token exchange.
 *
 * A caller arriving with `forceRefresh` while a fetch is already in flight joins
 * it rather than starting another. That is safe because the in-flight fetch
 * always mints a NEW token at the endpoint; it can never hand back the one the
 * server just refused, which is the `cached` value it is about to replace.
 */
export function createCredentialProvider(
  oauth: ResolvedOAuth,
  deps: { request?: TokenRequest } = {}
): (ctx: { url: string; forceRefresh: boolean }) => Promise<string | null> {
  const request = deps.request ?? requestClientCredentialsToken;

  let cached: TokenSet | null = null;
  let inFlight: Promise<TokenSet> | null = null;

  return async ({ forceRefresh }) => {
    const stale = !cached || Date.now() >= cached.expiresAt - REFRESH_MARGIN_MS;
    if (cached && !stale && !forceRefresh) return `Bearer ${cached.accessToken}`;

    if (!inFlight) {
      inFlight = request(oauth)
        .then(tokens => { cached = tokens; return tokens; })
        // Cleared either way, so a failed exchange does not poison later
        // attempts with a permanently rejected promise.
        .finally(() => { inFlight = null; });
    }
    const tokens = await inFlight;
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
 * Lives here rather than in index.ts because index.ts calls `main()` at module
 * scope: importing it from a test would start the MCP server.
 */
export function buildClientOptions(
  oauth: ResolvedOAuth | null,
  deps?: { request?: TokenRequest }
): OSLCClientOptions {
  if (!oauth) return {};
  return { getAuthorization: createCredentialProvider(oauth, deps ?? {}) };
}
