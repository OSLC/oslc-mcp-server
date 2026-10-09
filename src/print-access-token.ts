#!/usr/bin/env node

/**
 * Print an access token for one configured server, on stdout and nothing else.
 *
 * WHY THIS EXISTS. The MCP tools cover OSLC, and only OSLC. Some work on the
 * same estate is not OSLC at all — Rhapsody SE's SysML v2 services are an OMG
 * API, deliberately outside this server's remit — and a script doing that work
 * still has to authenticate as the same person against the same issuer. Before
 * this, the only way to run one was to paste a token into the environment by
 * hand, which means a long-lived secret in a shell history and an identity that
 * may not be the one the MCP tools are writing as.
 *
 * It mints nothing new: the five configured servers already share ONE OAuth
 * identity and one token (see TokenStore.identityOf), and this prints that one.
 * So a script authenticates as whoever signed in at the browser, and the audit
 * trail stays single.
 *
 *     RSE_TOKEN=$(node dist/print-access-token.js --config <file> --server rse) \
 *       node some-script.mjs
 *
 * The token never becomes a literal in a command line, a history or a
 * transcript, which is the point. Diagnostics go to stderr so that stdout is
 * safe to capture.
 *
 * Rotation is handled by reusing the server's own requester, so a rotated
 * refresh token is written back to the same `.oslc-mcp-tokens.json` the server
 * reads. Running this while the MCP server happens to be refreshing is the one
 * race: the loser sees a single 401 and refreshes again.
 */

import { join } from 'node:path';
import { loadConfigFile } from './config-file.js';
import { resolveOAuth } from './credentials.js';
import { TokenStore } from './oauth-credential.js';
import { createAuthorizationCodeRequester } from './oauth-authcode.js';
import { requestToken } from './oauth-token.js';

function parse(argv: string[]): { config?: string; server?: string } {
  const out: { config?: string; server?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--server') out.server = argv[++i];
  }
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const configPath = args.config ?? process.env.OSLC_CONFIG_FILE;
  if (!configPath) {
    console.error('Give --config <file>, or set OSLC_CONFIG_FILE. This reads the same ' +
                  'configuration the MCP server does, so the token is the same one.');
    return 2;
  }

  const file = loadConfigFile(configPath);

  // `resolveOAuth` THROWS when a referenced environment variable is unset, so
  // surveying every server to list the OAuth ones must not propagate: a missing
  // secret on some other server is not a reason to refuse a token for the one
  // actually asked for. The named server's own failure is raised in full below.
  const tryOauth = (e: (typeof file.servers)[number]) => {
    try { return resolveOAuth(e, process.env); } catch { return null; }
  };
  const withOauth = file.servers.filter(tryOauth);

  // Naming a server that exists but authenticates some other way is a different
  // mistake from naming one that does not exist, and the fix differs too.
  const entry = args.server
    ? file.servers.find((e) => e.alias === args.server)
    : withOauth[0];

  if (!entry) {
    console.error(`No server \`${args.server}\` in ${configPath}. Configured: ` +
                  `${file.servers.map((e) => e.alias).join(', ') || '(none)'}`);
    return 2;
  }

  // Not `tryOauth` here: if the server asked for cannot be resolved, the reason
  // — usually a named environment variable that is unset — is the whole answer.
  const oauth = resolveOAuth(entry, process.env);
  if (!oauth) {
    console.error(`Server \`${entry.alias}\` does not use OAuth, so it has no access token. ` +
                  `Servers that do: ${withOauth.map((e) => e.alias).join(', ') || '(none)'}`);
    return 2;
  }

  // Beside the configuration that named the issuer, exactly as index.ts does —
  // a different base directory here would sign you in again and, worse, leave
  // two stores that rotate out from under each other.
  const tokenFile = join(file.baseDir ?? process.cwd(), '.oslc-mcp-tokens.json');
  const signInInteractively = createAuthorizationCodeRequester({ tokenFile });
  const store = new TokenStore((o) =>
    o.grant === 'authorization_code' ? signInInteractively(o) : requestToken(o)
  );

  console.error(`[token] ${entry.alias}: ${oauth.grant} via client \`${oauth.clientId}\` at ${oauth.issuer}`);
  const { accessToken } = await store.get(oauth, false);
  process.stdout.write(accessToken + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`[token] ${err?.message ?? err}`); process.exit(1); }
);
