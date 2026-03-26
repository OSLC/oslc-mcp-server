import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OSLCClient } from 'oslc-client';
import { serialize as rdfSerialize } from 'rdflib';
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
} from 'oslc-service/mcp';
import type { GeneratedTool } from 'oslc-service/mcp';

/**
 * HTTP-based MCP context adapter that wraps OSLCClient for the generic handlers.
 * The shared handlers expect an OslcMcpContext, but the standalone server uses
 * OSLCClient directly. This adapter bridges the gap for the generic tool handlers.
 */
class HttpToolContext {
  readonly serverName: string;
  readonly serverBase: string;
  private client: OSLCClient;

  constructor(client: OSLCClient, serverURL: string) {
    this.client = client;
    this.serverName = 'oslc-mcp-server';
    this.serverBase = serverURL;
  }

  async getResource(uri: string): Promise<{ turtle: string; etag: string }> {
    const resource = await this.client.getResource(uri, '3.0', 'text/turtle');
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
        'OSLC-Core-Version': '3.0',
      },
    });
    return response.headers?.location ?? '';
  }

  async updateResource(uri: string, turtle: string, etag: string): Promise<void> {
    await (this.client as any).client.put(uri, turtle, {
      headers: {
        'Content-Type': 'text/turtle',
        'OSLC-Core-Version': '3.0',
        'If-Match': etag,
      },
    });
  }

  async deleteResource(uri: string): Promise<void> {
    const resource = await this.client.getResource(uri, '3.0', 'text/turtle');
    await this.client.deleteResource(resource, '3.0');
  }

  async queryResources(queryURL: string, params: { filter?: string; select?: string; orderBy?: string }): Promise<string> {
    const parts: string[] = [];
    if (params.filter) parts.push(`oslc.where=${encodeURIComponent(params.filter)}`);
    if (params.select) parts.push(`oslc.select=${encodeURIComponent(params.select)}`);
    if (params.orderBy) parts.push(`oslc.orderBy=${encodeURIComponent(params.orderBy)}`);
    const fullURL = parts.length > 0 ? `${queryURL}?${parts.join('&')}` : queryURL;
    const resource = await this.client.getResource(fullURL, '3.0', 'text/turtle');

    // Extract member resources from the LDP container response.
    // The query response is an LDP BasicContainer with ldp:contains
    // or rdfs:member links to the result resources.
    // Note: the store's container subject uses the base URL without
    // query parameters, even though fullURL includes them.
    const store = resource.store;
    const containerBaseURL = fullURL.split('?')[0];
    const containerSym = store.sym(containerBaseURL);
    const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
    const RDFS_MEMBER = 'http://www.w3.org/2000/01/rdf-schema#member';

    const memberNodes = [
      ...store.each(containerSym, store.sym(LDP_CONTAINS), undefined),
      ...store.each(containerSym, store.sym(RDFS_MEMBER), undefined),
    ];

    if (memberNodes.length > 0) {
      // Return each member as a JSON object
      const members = memberNodes
        .filter(n => n.termType === 'NamedNode')
        .map(n => resourceToJson(store, n.value));
      return JSON.stringify(members, null, 2);
    }

    // Fallback: return the container itself
    return JSON.stringify(resourceToJson(store, fullURL));
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
    description: 'Query OSLC resources using a query capability URL.',
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
            'OSLC query filter (oslc.where). Example: dcterms:title="My Resource"',
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
];

/**
 * Build and start the MCP server with discovered tools and resources.
 */
export async function startServer(
  client: OSLCClient,
  discovery: DiscoveryResult,
  serverURL: string
): Promise<void> {
  const context = new HttpToolContext(client, serverURL);

  // Generate per-type tools using the shared tool factory
  const generatedTools = generateTools(context as any, discovery);
  console.error(`[startup] Generated ${generatedTools.length} per-type tools`);

  // Build MCP resources using the shared resource builder
  const mcpResources = buildMcpResources(
    discovery,
    context.serverName,
    context.serverBase
  );

  const server = new Server(
    { name: 'oslc-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  // Build handler lookup for generated tools
  const generatedHandlers = new Map<string, (args: any) => Promise<string>>();
  for (const tool of generatedTools) {
    generatedHandlers.set(tool.name, tool.handler);
  }

  const allTools: McpToolDefinition[] = [
    ...generatedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...GENERIC_TOOLS,
  ];

  // Register handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      const generatedHandler = generatedHandlers.get(name);
      if (generatedHandler) {
        result = await generatedHandler(args ?? {});
      } else {
        switch (name) {
          case 'get_resource':
            result = await handleGetResource(context as any, args as { uri: string });
            break;
          case 'update_resource':
            result = await handleUpdateResource(context as any, discovery, args as { uri: string; properties: Record<string, unknown> });
            break;
          case 'delete_resource':
            result = await handleDeleteResource(context as any, args as { uri: string });
            break;
          case 'list_resource_types':
            result = handleListResourceTypes(context as any, discovery);
            break;
          case 'query_resources':
            result = await handleQueryResources(context as any, args as { queryBase: string; filter?: string; select?: string; orderBy?: string });
            break;
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
    resources: mcpResources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = mcpResources.find((r) => r.uri === request.params.uri);
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
