#!/usr/bin/env node

import { join } from 'node:path';
import { OSLCClient } from 'oslc-client';
import { discover, discoverFromServiceProviders } from './discovery.js';
import { startServer, type StartedServer } from './server.js';
import { loadConfigFile } from './config-file.js';
import { resolveCredentials, resolveOAuth } from './credentials.js';
import { buildClientOptions, TokenStore } from './oauth-credential.js';
import { createAuthorizationCodeRequester } from './oauth-authcode.js';
import { requestToken } from './oauth-token.js';
import { resolveCatalogUrl, unresolvedCatalog, type CatalogResolution } from './catalog-resolution.js';
import type { ResolvedServer } from './server-config.js';

interface CliArgs {
  config?: string;
  serverURL?: string;
  catalogURL?: string;
  username?: string;
  password?: string;
  configurationContext?: string;

  /**
   * Probe every discovered query capability at startup and report what each one
   * actually supports. Off unless asked for: a full probe writes a fixture,
   * reads it back and removes it, then issues the query cases — real load and
   * real side effects on the server being served. Nothing is probed without it.
   */
  probeOslc?: boolean;
}

/**
 * Parse CLI arguments. The original four flags are unchanged; --config and
 * --configuration-context are new.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config': args.config = argv[++i]; break;
      case '--server': args.serverURL = argv[++i]; break;
      case '--catalog': args.catalogURL = argv[++i]; break;
      case '--username': args.username = argv[++i]; break;
      case '--password': args.password = argv[++i]; break;
      case '--configuration-context': args.configurationContext = argv[++i]; break;
      case '--probe-oslc': args.probeOslc = true; break;
    }
  }
  return args;
}

/**
 * Resolve the servers to serve, from the configuration file if one is given,
 * otherwise from CLI args and environment variables exactly as before.
 */
function resolveServers(args: CliArgs):
    { servers: ResolvedServer[]; reportPath?: string; reportBaseDir?: string } {
  const configPath = args.config ?? process.env.OSLC_CONFIG_FILE;

  if (configPath) {
    const file = loadConfigFile(configPath);
    const servers = file.servers.map((entry) => {
      // A per-service-provider `configurationContext` is accepted by the
      // configuration parser but cannot be honoured: one OSLCClient serves the
      // whole server entry and carries a single Configuration-Context header.
      // Say so rather than ignoring it silently — a context that looks set and
      // is not is exactly the failure this header exists to prevent.
      const perSp = (entry.serviceProviders ?? []).filter((sp) => sp.configurationContext);
      if (perSp.length > 0) {
        console.error(
          `[config] Server \`${entry.alias}\`: ${perSp.length} serviceProvider entr` +
          `${perSp.length === 1 ? 'y sets' : 'ies set'} \`configurationContext\`, which is NOT applied — ` +
          `the context is per server, not per service provider. Set it at server level, or switch ` +
          `at runtime with set_configuration_context.`
        );
      }

      const { username, password } = resolveCredentials(entry, process.env);
      const oauth = resolveOAuth(entry, process.env);
      return {
        alias: entry.alias,
        config: {
          serverURL: entry.baseUrl,
          // Resolved at startup, once a client exists — see main().
          catalogURL: entry.catalogUrl ?? '',
          username,
          password,
          configurationContext: entry.configurationContext,
          oauth: oauth ?? undefined,
        },
        serviceProviderURIs: (entry.serviceProviders ?? []).map((sp) => sp.uri),
      };
    });
    // `file.reportPath` is already absolute — resolved against the configuration's
    // own directory, so where you invoke this from does not move the report.
    return { servers, reportPath: file.reportPath, reportBaseDir: file.baseDir };
  }

  const serverURL = args.serverURL ?? process.env.OSLC_SERVER_URL ?? '';
  if (!serverURL) {
    console.error(
      'Error: provide --config <file>, or --server <url> (or OSLC_SERVER_URL).'
    );
    console.error(
      'Usage: oslc-mcp-server --config <file>\n' +
      '       oslc-mcp-server --server <url> [--catalog <url>] [--username <user>] ' +
      '[--password <pass>] [--configuration-context <uri>]'
    );
    process.exit(1);
  }

  return { reportBaseDir: process.cwd(), servers: [{
    alias: 'oslc',
    config: {
      serverURL,
      catalogURL: args.catalogURL ?? process.env.OSLC_CATALOG_URL ?? '',
      username: args.username ?? process.env.OSLC_USERNAME ?? '',
      password: args.password ?? process.env.OSLC_PASSWORD ?? '',
      configurationContext:
        args.configurationContext ?? process.env.OSLC_CONFIGURATION_CONTEXT,
    },
    serviceProviderURIs: [],
  }] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { servers, reportPath, reportBaseDir } = resolveServers(args);
  const prefixTools = servers.length > 1;

  // Refresh tokens live beside the configuration that named the issuer, not in
  // the working directory — where the server is launched from must not decide
  // whether it has to ask you to sign in again.
  const tokenFile = join(reportBaseDir ?? process.cwd(), '.oslc-mcp-tokens.json');
  const signInInteractively = createAuthorizationCodeRequester({ tokenFile });

  // One store for the process, so servers sharing an identity share a token:
  // five entries behind one issuer exchange one token, not five, and a
  // rejection on any of them refreshes the credential all of them use. With the
  // authorization code grant that also means ONE browser sign-in for the whole
  // estate rather than one per server.
  const tokens = new TokenStore((oauth) =>
    oauth.grant === 'authorization_code' ? signInInteractively(oauth) : requestToken(oauth)
  );

  const started: StartedServer[] = [];
  for (const server of servers) {
    const { config, alias, serviceProviderURIs } = server;
    console.error(`[startup] ${alias}: connecting to ${config.serverURL}`);
    if (config.configurationContext) {
      console.error(`[startup] ${alias}: configuration context ${config.configurationContext}`);
    }

    if (config.oauth) {
      // Say whose identity the token carries. An operator should not have to
      // discover from an audit log who their changes were attributed to.
      const o = config.oauth;
      console.error(
        o.grant === 'password'
          ? `[startup] ${alias}: OAuth password grant as \`${o.username}\` via client ` +
            `\`${o.clientId}\` — changes are attributed to that user`
          : o.grant === 'authorization_code'
          ? `[startup] ${alias}: OAuth authorization code via client \`${o.clientId}\` — ` +
            `changes are attributed to whoever signs in at the browser`
          : `[startup] ${alias}: OAuth client credentials as \`${o.clientId}\` — changes ` +
            `will be attributed to this service account, not to a user, and it sees what ` +
            `that account can see`
      );
    }

    const client = new OSLCClient(
      config.username || undefined,
      config.password || undefined,
      config.configurationContext ?? null,
      buildClientOptions(config.oauth ?? null, tokens)
    );

    // An explicit value, else whatever rootservices advertises. Never a guess.
    //
    // A catalog is not always needed, and not having one is not always a fault:
    //   - Scoped discovery never fetches the catalog at all
    //     (discoverFromServiceProviders takes the URI for reporting only, and
    //     says "catalog not fetched"), so looking one up is wasted work — and
    //     failing startup over a lookup whose answer is never read is worse.
    //   - A rootservices document may legitimately advertise no catalog this
    //     client recognises. For a scoped server that is simply irrelevant.
    let catalog: CatalogResolution;
    if (serviceProviderURIs.length > 0 && !config.catalogURL) {
      catalog = unresolvedCatalog('scoped to serviceProviders, which does not fetch a catalog');
    } else {
      try {
        catalog = await resolveCatalogUrl(client, config.serverURL, config.catalogURL || undefined);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // One server's missing catalog must not take down the others. Without a
        // catalog an UNSCOPED server has nothing to enumerate, so it is left
        // out rather than started with no tools and no explanation.
        console.error(`[startup] ${alias}: ${reason}`);
        console.error(`[startup] ${alias}: skipped — the other servers still start.`);
        continue;
      }
    }
    config.catalogURL = catalog.url;
    console.error(
      catalog.url
        ? `[startup] ${alias}: catalog ${catalog.url} (${catalog.source.kind})`
        : `[startup] ${alias}: no catalog needed (scoped to ${serviceProviderURIs.length} service provider(s))`
    );

    const discovery = serviceProviderURIs.length > 0
      ? await discoverFromServiceProviders(client, serviceProviderURIs, config.catalogURL)
      : await discover(client, config);

    started.push({
      alias,
      client,
      discovery,
      config,
      catalog,
      prefix: prefixTools ? `${alias}_` : '',
    });
  }

  if (started.length === 0) {
    // Every server was skipped: there is nothing to serve, and starting an
    // empty MCP server would look like success.
    console.error('[fatal] No server could be started. See the [startup] lines above.');
    process.exit(1);
  }

  await startServer(started, { reportPath, reportBaseDir, probeOslc: args.probeOslc });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
