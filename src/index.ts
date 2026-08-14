#!/usr/bin/env node

import { OSLCClient } from 'oslc-client';
import { discover, discoverFromServiceProviders } from './discovery.js';
import { startServer, type StartedServer } from './server.js';
import { loadConfigFile } from './config-file.js';
import { resolveCredentials } from './credentials.js';
import { resolveCatalogUrl } from './catalog-resolution.js';
import type { ResolvedServer } from './server-config.js';

interface CliArgs {
  config?: string;
  serverURL?: string;
  catalogURL?: string;
  username?: string;
  password?: string;
  configurationContext?: string;
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
    }
  }
  return args;
}

/**
 * Resolve the servers to serve, from the configuration file if one is given,
 * otherwise from CLI args and environment variables exactly as before.
 */
function resolveServers(args: CliArgs): ResolvedServer[] {
  const configPath = args.config ?? process.env.OSLC_CONFIG_FILE;

  if (configPath) {
    const file = loadConfigFile(configPath);
    return file.servers.map((entry) => {
      const { username, password } = resolveCredentials(entry, process.env);
      return {
        alias: entry.alias,
        config: {
          serverURL: entry.baseUrl,
          // Resolved at startup, once a client exists — see main().
          catalogURL: entry.catalogUrl ?? '',
          username,
          password,
          configurationContext: entry.configurationContext,
        },
        serviceProviderURIs: (entry.serviceProviders ?? []).map((sp) => sp.uri),
      };
    });
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

  return [{
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
  }];
}

async function main(): Promise<void> {
  const servers = resolveServers(parseArgs(process.argv.slice(2)));
  const prefixTools = servers.length > 1;

  const started: StartedServer[] = [];
  for (const server of servers) {
    const { config, alias, serviceProviderURIs } = server;
    console.error(`[startup] ${alias}: connecting to ${config.serverURL}`);
    if (config.configurationContext) {
      console.error(`[startup] ${alias}: configuration context ${config.configurationContext}`);
    }

    const client = new OSLCClient(
      config.username || undefined,
      config.password || undefined,
      config.configurationContext ?? null
    );

    // Explicit value, else rootservices, else the convention.
    config.catalogURL = await resolveCatalogUrl(
      client, config.serverURL, config.catalogURL || undefined
    );
    console.error(`[startup] ${alias}: catalog ${config.catalogURL}`);

    const discovery = serviceProviderURIs.length > 0
      ? await discoverFromServiceProviders(client, serviceProviderURIs, config.catalogURL)
      : await discover(client, config);

    started.push({
      alias,
      client,
      discovery,
      config,
      prefix: prefixTools ? `${alias}_` : '',
    });
  }

  await startServer(started);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
