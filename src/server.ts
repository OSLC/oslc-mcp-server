import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OSLCClient } from 'oslc-client';
// rdflib is CommonJS — default import, not named. See the note in discovery.ts.
import rdflib from 'rdflib';
import type {
  DiscoveryResult,
  McpToolDefinition,
  McpResourceDefinition,
} from 'oslc-service/mcp';
import {
  generateTools,
  buildMcpResources,
  handleGetResource,
  handleUpdateResource,
  handleDeleteResource,
  handleListResourceTypes,
  handleQueryResources,
  resourceToJson,
  formatCatalogContent,
} from 'oslc-service/mcp';
import type { GeneratedTool } from 'oslc-service/mcp';
import { discover, discoverServiceProvider, ACCEPT_RDF } from './discovery.js';
import type { ServerConfig } from './server-config.js';
import type { CatalogResolution } from './catalog-resolution.js';
import { describeDiscovery, describeDiscoveryDocument } from './describe-discovery.js';
import { DEFAULT_REPORT_PATH } from './config-file.js';
import { runProbe, type ProbeRun } from './probe/orchestrate.js';
import { formatProbeReport } from './probe/report.js';
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { checkTurtleSupport, formatTurtleCheck, type HttpGetter } from './representation.js';
import { buildPrefixDeclaration, undeclarablePrefixes } from './oslc-prefixes.js';
import { membersFromStore, totalCountFromStore } from './oslc-members.js';

const { serialize: rdfSerialize } = rdflib;

/**
 * HTTP-based MCP context adapter that wraps OSLCClient for the generic handlers.
 * The shared handlers expect an OslcMcpContext, but the standalone server uses
 * OSLCClient directly. This adapter bridges the gap for the generic tool handlers.
 */
class HttpToolContext {
  readonly serverName: string;
  readonly serverBase: string;
  private client: OSLCClient;
  private catalogURL: string;

  constructor(client: OSLCClient, serverURL: string, catalogURL: string, serverName?: string) {
    this.client = client;
    this.serverName = serverName ?? 'oslc-mcp-server';
    this.serverBase = serverURL;
    this.catalogURL = catalogURL;
  }

  /**
   * Create a new ServiceProvider by POSTing Turtle to the catalog URL.
   */
  async createServiceProvider(title: string, slug: string, description?: string): Promise<string> {
    const descLine = description ? `\n   dcterms:description "${description}" .` : ' .';
    const turtle = `@prefix dcterms: <http://purl.org/dc/terms/> .\n<> dcterms:title "${title}" ;${descLine}`;
    const response = await (this.client as any).client.post(this.catalogURL, turtle, {
      headers: {
        'Content-Type': 'text/turtle',
        'Accept': 'text/turtle',
        'OSLC-Core-Version': '2.0',
        'Slug': slug,
      },
    });
    return response.headers?.location ?? `${this.catalogURL}/${slug}`;
  }

  async getResource(uri: string): Promise<{ turtle: string; etag: string }> {
    const resource = await this.client.getResource(uri, '2.0', ACCEPT_RDF);
    let turtle = '';
    rdfSerialize(null, resource.store, uri, 'text/turtle', (err, content) => {
      if (!err && content) turtle = content;
    });
    const etag = resource.etag ?? '';
    return { turtle, etag };
  }

  async createResource(factoryURI: string, turtle: string): Promise<string> {
    const response = await (this.client as any).client.post(factoryURI, turtle, {
      headers: {
        'Content-Type': 'text/turtle',
        'Accept': 'text/turtle',
        'OSLC-Core-Version': '2.0',
      },
    });
    return response.headers?.location ?? '';
  }

  async updateResource(uri: string, turtle: string, etag: string): Promise<void> {
    await (this.client as any).client.put(uri, turtle, {
      headers: {
        'Content-Type': 'text/turtle',
        'OSLC-Core-Version': '2.0',
        'If-Match': etag,
      },
    });
  }

  async deleteResource(uri: string): Promise<void> {
    const resource = await this.client.getResource(uri, '2.0', ACCEPT_RDF);
    await this.client.deleteResource(resource, '2.0');
  }

  async queryResources(queryURL: string, params: { filter?: string; select?: string; orderBy?: string }): Promise<string> {
    const clauses = [params.filter, params.select, params.orderBy];
    const parts: string[] = [];

    // Declare the prefixes the clauses use. Servers differ on what they
    // predefine and DOORS Next predefines nothing, so an undeclared `dcterms:`
    // is a 400 there and works elsewhere. Declaring costs nothing where the
    // server already knows the prefix.
    const prefixDeclaration = buildPrefixDeclaration(clauses);
    if (prefixDeclaration) parts.push(`oslc.prefix=${encodeURIComponent(prefixDeclaration)}`);

    if (params.filter) parts.push(`oslc.where=${encodeURIComponent(params.filter)}`);
    if (params.select) parts.push(`oslc.select=${encodeURIComponent(params.select)}`);
    if (params.orderBy) parts.push(`oslc.orderBy=${encodeURIComponent(params.orderBy)}`);

    // A queryBase may already carry query parameters — DOORS Next advertises
    // bases like `.../query?componentURI=…`. Appending '?' unconditionally
    // produced a URL with two '?', which the server accepts and silently
    // mishandles rather than rejecting.
    const separator = queryURL.includes('?') ? '&' : '?';
    const fullURL = parts.length > 0 ? `${queryURL}${separator}${parts.join('&')}` : queryURL;
    const resource = await this.client.getResource(fullURL, '2.0', ACCEPT_RDF);

    const store = resource.store;
    // The store's container subject uses the base URL without query parameters,
    // even though fullURL includes them.
    const containerBaseURL = fullURL.split('?')[0];
    const memberURIs = membersFromStore(store, containerBaseURL);
    const totalCount = totalCountFromStore(store);
    const undeclared = undeclarablePrefixes(clauses);

    if (memberURIs.length === 0) {
      // No members found. Return the container itself rather than an empty
      // list: an empty list reads as "nothing matched", and the likelier causes
      // are an undeclared prefix or a membership predicate we failed to read.
      return JSON.stringify({
        members: [],
        totalCount,
        note:
          'No members were read from this response. If the server reported a totalCount above zero, ' +
          'the membership predicate was not recognised. Check the container representation below.',
        undeclaredPrefixes: undeclared.length > 0 ? undeclared : undefined,
        container: resourceToJson(store, fullURL),
      }, null, 2);
    }

    const members = memberURIs.map((uri) => resourceToJson(store, uri));

    // totalCount is reported alongside, not instead: they differ legitimately
    // when a response is paged, and informatively when membership was misread.
    return JSON.stringify({
      members,
      count: members.length,
      totalCount,
      undeclaredPrefixes: undeclared.length > 0 ? undeclared : undefined,
    }, null, 2);
  }

  getGeneratedHandler(_name: string): ((args: Record<string, unknown>) => Promise<string>) | undefined {
    return undefined; // Not used — the standalone server has its own handler map
  }

  getDiscoveryResult(): DiscoveryResult | undefined {
    return undefined; // Not used directly
  }
}

// Generic tool definitions (same as embedded middleware)
const GENERIC_TOOLS: McpToolDefinition[] = [
  {
    name: 'create_service_provider',
    description:
      'Create a new ServiceProvider in the catalog. A ServiceProvider is a container for OSLC resources — create one before creating domain resources. After creation, restart the MCP server to discover new create/query tools for this ServiceProvider.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Display name for the ServiceProvider (e.g., "EU-Rent")' },
        slug: { type: 'string', description: 'URL-safe identifier used in the ServiceProvider URI (e.g., "eu-rent" produces /oslc/eu-rent)' },
        description: { type: 'string', description: 'Optional description of the ServiceProvider' },
      },
      required: ['title', 'slug'],
    },
  },
  {
    name: 'describe_discovery',
    description:
      'Report what OSLC discovery found for this server and which URL each generated tool will actually hit: the catalog URL and how it was resolved, every service provider, every creation factory and query capability, and every resource shape that failed to fetch. Read-only — makes no requests. Use it when a tool is missing or appears to reach the wrong place.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'probe_oslc',
    description:
      'Measure what this server actually implements of OSLC Query, by creating a small fixture, querying it, and removing it again. Where the server cannot be written to, it queries existing content instead and reports which measurements it could not make. Records every HTTP exchange as evidence. Writes only resources it creates and marks PROBE-, and deletes them; it never modifies pre-existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceProviderURI: { type: 'string', description: 'Service provider to probe. Defaults to the first discovered.' },
        queryBase: { type: 'string', description: 'Query capability base to probe. Defaults to the first advertised by that service provider.' },
        onDeleteUnsupported: {
          type: 'string',
          enum: ['stop', 'proceed', 'read-only'],
          description: 'What to do if the server does not support DELETE: stop and report (default), proceed and accept a permanently populated target, or fall back to read-only.',
        },
        reportPath: { type: 'string', description: 'File path to write the full report, transcripts included.' },
      },
      required: [],
    },
  },
  {
    name: 'check_turtle_support',
    description:
      'Ask this server for Turtle and report what it returned: Turtle that parses, an error status, another representation, or a body typed as Turtle that does not parse. Records the full HTTP exchange as evidence. Defaults to the catalog URL. Note that a server may disregard the Accept header and still be conformant, so this reports what the server did, not what it can do.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: "Resource to request as Turtle. Defaults to this server's catalog URL.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_resource',
    description: 'Fetch an OSLC resource by URI and return all its properties.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The URI of the resource to fetch' },
      },
      required: ['uri'],
    },
  },
  {
    name: 'update_resource',
    description:
      'Update an OSLC resource. Provided properties replace existing values; omitted properties are unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The URI of the resource to update' },
        properties: {
          type: 'object',
          description: 'Properties to set (key-value pairs)',
        },
      },
      required: ['uri', 'properties'],
    },
  },
  {
    name: 'delete_resource',
    description: 'Delete an OSLC resource by URI.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The URI of the resource to delete' },
      },
      required: ['uri'],
    },
  },
  {
    name: 'list_resource_types',
    description:
      'List all discovered OSLC resource types with their creation factories, query capabilities, and property summaries.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query_resources',
    description:
      'Query OSLC resources using a query capability URL. With one consolidated QueryCapability per ServiceProvider, narrow by resource type by passing oslc.where=rdf:type=<...> in the filter argument. '
      + 'Prefixes used in filter/select/orderBy are declared automatically for well-known vocabularies (dcterms, oslc, rdf, the OSLC domains, and the Jazz vocabularies); a prefix that cannot be declared is reported back as undeclaredPrefixes. '
      + 'Returns { members, count, totalCount } — totalCount is the server\'s own count of the whole result set and may exceed count when the response is paged.',
    inputSchema: {
      type: 'object',
      properties: {
        queryBase: {
          type: 'string',
          description: 'The query capability URL',
        },
        filter: {
          type: 'string',
          description:
            'OSLC query filter (oslc.where). Example: rdf:type=<http://www.omg.org/spec/BMM#Vision> or dcterms:title="My Resource"',
        },
        select: {
          type: 'string',
          description: 'Property projection (oslc.select)',
        },
        orderBy: {
          type: 'string',
          description: 'Sort order (oslc.orderBy)',
        },
      },
      required: ['queryBase'],
    },
  },
  // Mirrors the oslc://catalog MCP resource. Some MCP host transports
  // (notably Claude Desktop's stdio chat-style mode) surface tools but
  // not generic resources to the assistant; this tool wrapper makes
  // catalog content reachable from any tool-only client.
  {
    name: 'read_catalog',
    description:
      'Return the OSLC ServiceProvider Catalog: every ServiceProvider on this server with its creation factories, query capabilities, resource types, vocabulary references (oslc:domain), and shape references (oslc:resourceShape). Mirrors the oslc://catalog MCP resource. Fetch the referenced vocabulary and shape URIs with get_resource for their full content.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_service_provider',
    description:
      'Return one ServiceProvider in the same format as read_catalog — its creation factories, query capabilities, resource types, vocabulary references (oslc:domain), and shape references — fetched on demand from the supplied ServiceProvider URL. Use this when read_catalog returns many ServiceProviders and you want to drill into one without forcing the server to crawl every SP at startup. The shape documents referenced by factories are fetched too; their content can be retrieved with get_resource.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceProviderURL: {
          type: 'string',
          description: 'The OSLC ServiceProvider resource URL (the URI listed under oslc:serviceProvider in the catalog).',
        },
      },
      required: ['serviceProviderURL'],
    },
  },
];

/** Names of the generic tools, for routing a prefixed call to its server. */
const GENERIC_TOOL_NAMES = new Set(GENERIC_TOOLS.map((t) => t.name));

/** One connected OSLC server, as prepared by `main()`. */
/**
 * The current `JSESSIONID`, which Jazz servers want echoed as
 * `X-Jazz-CSRF-Prevent` on a mutating request.
 *
 * Required by some operations and not others — measured, EWM accepted a `POST`
 * to a creation factory without it and refused the `DELETE` of the resource it
 * had just created, with a `403` that reads as a permission problem and is not
 * one. Worse, that refusal *masks* a genuine permission refusal underneath, so
 * a probe without the header can record "delete unsupported" for a server that
 * supports it.
 *
 * Returns undefined against a server that sets no such cookie, where the header
 * is simply not sent.
 */
async function jazzCsrfToken(client: OSLCClient, serverURL: string): Promise<string | undefined> {
  try {
    const jar = (client as any).jar;
    if (!jar?.getCookies) return undefined;
    const cookies = await jar.getCookies(serverURL);
    return cookies?.find((c: { key: string }) => c.key === 'JSESSIONID')?.value;
  } catch {
    return undefined;
  }
}

export interface StartedServer {
  alias: string;
  client: OSLCClient;
  discovery: DiscoveryResult;
  config: ServerConfig;
  /** How `config.catalogURL` was arrived at — reported by describe_discovery. */
  catalog: CatalogResolution;
  /** '' for a single server; `${alias}_` when several are configured. */
  prefix: string;
}

/**
 * Per-server mutable runtime: its context, current discovery, and the tools
 * and resources derived from them. Tool names and resource URIs are already
 * namespaced by the server's prefix, so the MCP surface is flat.
 */
interface ServerRuntime {
  spec: StartedServer;
  context: HttpToolContext;
  discovery: DiscoveryResult;
  handlers: Map<string, (args: any) => Promise<string>>;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  rebuild(): void;
}

/**
 * Build and start the MCP server over one or more OSLC servers.
 *
 * With a single server, tool names and the `oslc://catalog` resource URI are
 * exactly as before — existing configurations are unaffected. With several,
 * each is prefixed by its alias so a call is unambiguous about which server
 * it reaches.
 */
/**
 * Write what discovery found to a file, every start.
 *
 * The `describe_discovery` tool renders the same thing on demand, but a tool
 * cannot answer the question it is most needed for — a server that started and
 * generated the wrong tools, or none. A file is there either way, and is small
 * enough to hand to an assistant as context describing what the tools can do.
 *
 * A failure to write is reported and otherwise ignored: the report is
 * diagnostic, and losing it is no reason to refuse to serve.
 */
function writeDiscoveryReport(
  runtimes: ServerRuntime[], path: string, baseDir?: string,
  probes?: ReadonlyMap<string, ReadonlyMap<string, ProbeRun>>
): void {
  const target = resolveReportPath(path, baseDir);
  try {
    const document = describeDiscoveryDocument(runtimes.map((r) => ({
      alias: r.spec.alias,
      prefix: r.spec.prefix,
      catalog: r.spec.catalog,
      discovery: r.discovery,
      probes: probes?.get(r.spec.alias),
    })));
    writeFileSync(target, document, 'utf8');
    // The ABSOLUTE path, always. A relative one cannot be checked by the reader:
    // a report written elsewhere and a stale file beside the config print the
    // same line, which is how a stale report gets read as fresh output.
    console.error(
      `[report] wrote ${target} (${lineCount(document)} lines, ` +
      `${runtimes.length} server${runtimes.length === 1 ? '' : 's'})`
    );
  } catch (err) {
    console.error(`[report] could not write ${target}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Probe every query capability of every discovered service provider, keyed
 * `alias -> queryBase -> run`.
 *
 * Every capability, not one per provider: whether a server's query support is
 * uniform across its capabilities is itself a finding, and assuming it would put
 * a verdict in the report for a queryBase nobody measured. A deployment where the
 * cost matters should not pass `--probe-oslc` at all.
 *
 * A probe that throws costs that one capability, not the startup: the server's
 * job is to serve tools, and a measurement failure is not a reason to refuse.
 */
async function probeEveryQueryCapability(
  runtimes: ServerRuntime[]
): Promise<Map<string, Map<string, ProbeRun>>> {
  const all = new Map<string, Map<string, ProbeRun>>();
  const total = runtimes.reduce((n, r) => n + r.discovery.serviceProviders
    .reduce((m, sp) => m + sp.queries.length, 0), 0);
  let done = 0;
  console.error(`[probe] --probe-oslc: measuring ${total} query capabilit${total === 1 ? 'y' : 'ies'}`);

  for (const runtime of runtimes) {
    const byQueryBase = new Map<string, ProbeRun>();
    all.set(runtime.spec.alias, byQueryBase);
    for (const sp of runtime.discovery.serviceProviders) {
      for (const query of sp.queries) {
        done++;
        console.error(
          `[probe] ${done}/${total} ${runtime.spec.alias}: ${query.title || query.queryBase}`
        );
        try {
          byQueryBase.set(query.queryBase, await runProbe({
            http: (runtime.spec.client as any).client,
            sp,
            queryBase: query.queryBase,
            // Residue is worse than a weaker verdict here, because nobody asked
            // this run a question — it happens on the way to serving tools. Left
            // fixtures are named on stderr by the manifest either way.
            onDeleteUnsupported: 'read-only',
            manifestWrite: (line: string) => console.error(`[probe:manifest] ${line}`),
            // So the fixture is created from a factory this capability can see.
            resourceType: query.resourceType || undefined,
            csrfToken: await jazzCsrfToken(runtime.spec.client, runtime.spec.config.serverURL),
          }));
        } catch (err) {
          console.error(
            `[probe] ${runtime.spec.alias}: ${query.queryBase} could not be probed:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  }
  return all;
}

/** Lines as `wc -l` counts them: the trailing newline does not start a new one. */
function lineCount(document: string): number {
  const parts = document.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/**
 * Where a report actually goes. A relative path resolves against `baseDir` — the
 * configuration file's directory, or the working directory when the servers were
 * given as command-line flags. An absolute path is honoured as given.
 */
function resolveReportPath(path: string, baseDir?: string): string {
  return isAbsolute(path) ? path : resolve(baseDir ?? process.cwd(), path);
}

export interface StartOptions {
  /** Where to write the discovery report; `DEFAULT_REPORT_PATH` when absent. */
  reportPath?: string;

  /**
   * Directory a relative `reportPath` — and a relative `reportPath` argument to
   * the probe tool — resolves against. The configuration file's directory when
   * the servers came from one; the working directory otherwise. Without it a
   * report lands wherever the process happened to be started.
   */
  reportBaseDir?: string;

  /**
   * Probe every discovered query capability before serving, and put what each
   * one supports into the discovery report. Off by default, and nothing is
   * probed without it: a full probe creates a fixture, reads it back and deletes
   * it, then issues the query cases — side effects and load on the very server
   * this process exists to serve. Meant for a test environment.
   */
  probeOslc?: boolean;
}

export async function startServer(
  servers: StartedServer[],
  options: StartOptions = {}
): Promise<void> {
  const server = new Server(
    { name: 'oslc-mcp-server', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } }
  );

  const runtimes: ServerRuntime[] = servers.map((spec) => {
    const context = new HttpToolContext(
      spec.client, spec.config.serverURL, spec.config.catalogURL, spec.alias
    );

    const runtime: ServerRuntime = {
      spec,
      context,
      discovery: spec.discovery,
      handlers: new Map(),
      tools: [],
      resources: [],
      rebuild(): void {
        const generatedTools = generateTools(this.context as any, this.discovery);
        this.handlers = new Map<string, (args: any) => Promise<string>>();
        for (const tool of generatedTools) {
          this.handlers.set(tool.name, tool.handler);
        }
        this.tools = [
          ...generatedTools.map((t) => ({
            name: `${spec.prefix}${t.name}`,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          ...GENERIC_TOOLS.map((t) => ({ ...t, name: `${spec.prefix}${t.name}` })),
        ];
        // Exactly one resource per server (`oslc://catalog`), so namespace
        // it by alias when several servers are configured.
        this.resources = buildMcpResources(
          this.discovery, this.context.serverName, this.context.serverBase
        ).map((r) => ({
          ...r,
          uri: spec.prefix ? r.uri.replace('oslc://', `oslc://${spec.alias}/`) : r.uri,
        }));
        console.error(
          `[rebuild] ${spec.alias}: ${generatedTools.length} per-type tools, ` +
          `${this.resources.length} resources`
        );
      },
    };

    runtime.rebuild();
    return runtime;
  });

  // Probed BEFORE the report is written, so one artifact carries both what was
  // discovered and what was measured. Discovery cannot answer the query-feature
  // question: a query capability advertises a queryBase and its resource types
  // and says nothing about which of oslc.where/select/orderBy/paging, or which
  // where constructs, the server implements.
  const probes = options.probeOslc ? await probeEveryQueryCapability(runtimes) : undefined;

  writeDiscoveryReport(
    runtimes, options.reportPath ?? DEFAULT_REPORT_PATH, options.reportBaseDir, probes
  );

  /**
   * Route a tool call to the server that owns it. Longest prefix wins, so an
   * unprefixed single-server setup still matches everything.
   */
  function routeTool(name: string): { runtime: ServerRuntime; inner: string } | null {
    const candidates = runtimes
      .filter((r) => name.startsWith(r.spec.prefix))
      .sort((a, b) => b.spec.prefix.length - a.spec.prefix.length);
    for (const runtime of candidates) {
      const inner = name.slice(runtime.spec.prefix.length);
      if (runtime.handlers.has(inner) || GENERIC_TOOL_NAMES.has(inner)) {
        return { runtime, inner };
      }
    }
    return null;
  }

  // Register handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtimes.flatMap((r) => r.tools),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const route = routeTool(name);
    if (!route) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const { runtime, inner } = route;
    const { context, spec } = runtime;
    const { client, config } = spec;

    try {
      let result: string;

      const generatedHandler = runtime.handlers.get(inner);
      if (generatedHandler) {
        result = await generatedHandler(args ?? {});
      } else {
        switch (inner) {
          case 'create_service_provider': {
            const spArgs = args as { title: string; slug: string; description?: string };
            const spURI = await context.createServiceProvider(spArgs.title, spArgs.slug, spArgs.description);
            console.error(`[create_service_provider] Created ${spURI}`);

            // Rediscover catalog so the new SP's create/query tools become
            // available to the AI without restarting the MCP server.
            let rediscoverStatus = '';
            const beforeToolCount = runtime.tools.length;
            try {
              console.error('[create_service_provider] Rediscovering catalog...');
              runtime.discovery = await discover(client, config);
              console.error(`[create_service_provider] Discovery complete: ${runtime.discovery.serviceProviders.length} SPs, ${runtime.discovery.serviceProviders.reduce((n, sp) => n + sp.factories.length, 0)} factories`);
              runtime.rebuild();
              console.error(`[create_service_provider] Rebuilt tools: ${beforeToolCount} -> ${runtime.tools.length}`);
              try {
                await server.sendToolListChanged();
                await server.sendResourceListChanged();
                console.error('[create_service_provider] Sent list_changed notifications');
              } catch (notifErr) {
                const nmsg = notifErr instanceof Error ? notifErr.message : String(notifErr);
                console.error(`[create_service_provider] Notification failed: ${nmsg}`);
              }
              rediscoverStatus = `Server-side rediscovery complete (${runtime.tools.length} tools, was ${beforeToolCount}). IMPORTANT: Claude Desktop does not honor notifications/tools/list_changed, so the new per-type create_* and query_* tools will not appear in your tool palette until you quit Claude Desktop (Cmd+Q) and relaunch. After relaunching, retry the resource creation.`;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[create_service_provider] Rediscovery failed:`, err);
              rediscoverStatus = `Rediscovery failed (${msg}); restart the MCP server to pick up the new ServiceProvider.`;
            }

            result = JSON.stringify({
              uri: spURI,
              title: spArgs.title,
              slug: spArgs.slug,
              toolCount: runtime.tools.length,
              message: `ServiceProvider "${spArgs.title}" created at ${spURI}. ${rediscoverStatus}`,
            });
            break;
          }
          case 'get_resource':
            result = await handleGetResource(context as any, args as { uri: string });
            break;
          case 'update_resource':
            result = await handleUpdateResource(context as any, runtime.discovery, args as { uri: string; properties: Record<string, unknown> });
            break;
          case 'delete_resource':
            result = await handleDeleteResource(context as any, args as { uri: string });
            break;
          case 'describe_discovery':
            result = describeDiscovery({
              alias: runtime.spec.alias,
              prefix: runtime.spec.prefix,
              catalog: runtime.spec.catalog,
              discovery: runtime.discovery,
            });
            break;
          case 'probe_oslc': {
            const probeArgs = (args ?? {}) as {
              serviceProviderURI?: string; queryBase?: string;
              onDeleteUnsupported?: 'stop' | 'proceed' | 'read-only'; reportPath?: string;
            };
            const target = probeArgs.serviceProviderURI
              ? runtime.discovery.serviceProviders.find((p) => p.uri === probeArgs.serviceProviderURI)
              : runtime.discovery.serviceProviders[0];
            if (!target) {
              result = probeArgs.serviceProviderURI
                ? `No discovered service provider matches ${probeArgs.serviceProviderURI}. Call read_catalog to see what was found.`
                : 'No service provider was discovered, so there is nothing to probe.';
              break;
            }
            const probeBase = probeArgs.queryBase ?? target.queries[0]?.queryBase;
            if (!probeBase) {
              result = `${target.title} advertises no query capability, so there is no query to measure.`;
              break;
            }
            // Neither outcome of an unsupported delete is decided by default
            // (§5.7): stopping leaves the caller to choose between residue and
            // weaker verification, and that is their call rather than this tool's.
            const probeRun = await runProbe({
              http: (client as any).client,
              sp: target,
              queryBase: probeBase,
              onDeleteUnsupported: probeArgs.onDeleteUnsupported ?? 'stop',
              manifestWrite: (line: string) => console.error(`[probe:manifest] ${line}`),
              csrfToken: await jazzCsrfToken(client, config.serverURL),
            });
            // The file carries the transcripts; the tool result carries the
            // findings. A run over a provider with hundreds of members produces
            // megabytes of exchange, which is evidence on disk and noise here.
            if (probeArgs.reportPath) {
              // Resolved and reported like the discovery report: the caller is an
              // assistant that cannot know this process's working directory, so a
              // relative path has to mean something stable.
              const probeTarget = resolveReportPath(probeArgs.reportPath, options.reportBaseDir);
              try {
                writeFileSync(probeTarget, formatProbeReport(probeRun), 'utf8');
                console.error(`[probe] wrote ${probeTarget}`);
              } catch (err) {
                console.error(`[probe] could not write ${probeTarget}:`, err instanceof Error ? err.message : err);
              }
            }
            result = formatProbeReport(probeRun, { transcripts: false });
            break;
          }
          case 'check_turtle_support': {
            const turtleArgs = (args ?? {}) as { uri?: string };
            const target = turtleArgs.uri || config.catalogURL;
            const axiosClient = (client as any).client as HttpGetter;
            result = formatTurtleCheck(await checkTurtleSupport(axiosClient, target));
            break;
          }
          case 'list_resource_types':
            result = handleListResourceTypes(context as any, runtime.discovery);
            break;
          case 'query_resources':
            result = await handleQueryResources(context as any, args as { queryBase: string; filter?: string; select?: string; orderBy?: string });
            break;
          case 'read_catalog': {
            const catalogHeader = `**Server:** ${context.serverName}\n**Base URL:** ${context.serverBase}\n\n`;
            result = catalogHeader + runtime.discovery.catalogContent;
            break;
          }
          case 'read_service_provider': {
            const spArgs = args as { serviceProviderURL: string };
            if (!spArgs?.serviceProviderURL) {
              throw new Error("read_service_provider requires 'serviceProviderURL'");
            }
            console.error(`[read_service_provider] Fetching ${spArgs.serviceProviderURL}`);
            const sp = await discoverServiceProvider(client, spArgs.serviceProviderURL);
            if (!sp) {
              throw new Error(`Could not fetch or parse ServiceProvider at ${spArgs.serviceProviderURL}`);
            }
            // Reuse the shared formatter for a single SP so the output
            // matches the format of read_catalog.
            const header = `**Server:** ${context.serverName}\n**Base URL:** ${context.serverBase}\n\n`;
            result = header + formatCatalogContent([sp]);
            break;
          }
          default:
            return {
              content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      }

      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err: any) {
      const message = err?.response?.data
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err?.message ?? String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: runtimes.flatMap((rt) => rt.resources).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = runtimes
      .flatMap((rt) => rt.resources)
      .find((r) => r.uri === request.params.uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.content,
        },
      ],
    };
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[server] OSLC MCP server running on stdio');
}
