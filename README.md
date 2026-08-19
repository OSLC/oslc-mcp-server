# oslc-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that connects to any OSLC 3.0 server, discovers its capabilities, and exposes them as MCP tools and resources for LLM-driven CRUD operations.

This module is the **AAKI bridge for third-party OSLC servers** — exposing them as AI-addressable knowledge stores when they don't embed MCP themselves. See the [AAKI framework](../docs/AAKI.md) for the architectural context.

## The Problem

AI assistants can't interact with OSLC servers directly. This module bridges that gap by dynamically discovering an OSLC server's service providers, creation factories, query capabilities, and resource shapes at startup, then exposing them as typed MCP tools that any MCP-compatible AI assistant can call.

## Prerequisites

- [Node.js](http://nodejs.org) v22 or later
- An OSLC 3.0 server running (e.g., oslc-server or mrm-server from this workspace)

## Build

```bash
cd oslc-mcp-server
npm install
npm run build
```

## Configuration

Two ways: a **configuration file** (needed for more than one server, for scoping to specific project areas, and for an OSLC configuration context), or **CLI arguments** for a single unscoped server.

### CLI arguments

CLI overrides environment variables.

| CLI Argument | Environment Variable | Description |
|-------------|---------------------|-------------|
| `--config <path>` | `OSLC_CONFIG_FILE` | Configuration file (see below). Supersedes the flags below |
| `--server <url>` | `OSLC_SERVER_URL` | **Required unless `--config` is given.** Base URL of the OSLC server |
| `--catalog <url>` | `OSLC_CATALOG_URL` | Catalog URL. Discovered when omitted (see *Catalog resolution*) |
| `--username <user>` | `OSLC_USERNAME` | Username for authenticated servers |
| `--password <pass>` | `OSLC_PASSWORD` | Password for authenticated servers |
| `--configuration-context <uri>` | `OSLC_CONFIGURATION_CONTEXT` | OSLC `Configuration-Context` URI |

### Configuration file

Copy [`oslc-mcp-server.example.yaml`](oslc-mcp-server.example.yaml) to `oslc-mcp-server.yaml` and edit. **The real file is git-ignored** — it names a specific deployment and may carry credentials; only the example is committed.

```yaml
servers:
  - alias: dng                                   # required, unique
    baseUrl: https://elm.example.com/rm          # required
    catalogUrl: https://…/oslc_rm/catalog        # optional — discovered when omitted
    configurationContext: https://…/gc/configuration/17   # optional
    credentials:                                 # optional
      usernameEnv: ELM_USER
      passwordEnv: ELM_PASSWORD
    serviceProviders:                            # optional — omit to walk the catalog
      - uri: https://…/oslc_rm/_ID/services.xml  # required within the list
        alias: requirements                      # optional
        configurationContext: https://…/gc/configuration/17   # optional
```

| Field | Required | Default |
|---|---|---|
| `alias` | yes | — must be unique across servers |
| `baseUrl` | yes | — |
| `catalogUrl` | no | discovered from `rootservices` |
| `configurationContext` | no | none. Fallback for the server's service providers |
| `credentials` | no | unauthenticated |
| `serviceProviders` | no | absent means walk the whole catalog |
| `serviceProviders[].uri` | yes, within the list | — |
| `serviceProviders[].alias` | no | — |
| `serviceProviders[].configurationContext` | no | the server's value |

**Credentials.** Prefer `usernameEnv` / `passwordEnv`, which name environment variables:

```yaml
    credentials:
      usernameEnv: ELM_USER
      passwordEnv: ELM_PASSWORD
```

Literal `username` / `password` also work, and emit one warning at load naming the server. The file is git-ignored, but it still travels in pastes, backups and screen shares — so environment references remain the better default. When both forms are present the environment references win, so an operator can override without editing the file. A half-specified `credentials` block (say `username` with no `password`) is an error rather than a warning, since that is a typo rather than a choice.

**Scoping discovery.** `serviceProviders` restricts startup to the listed providers and **the catalog is never fetched**. This matters because on an ELM application **one service provider is one project area**, and a production server may have thousands — an unscoped startup would crawl every one. Omit the list and the catalog is walked as before.

**Catalog resolution**: an explicit `catalogUrl` wins; otherwise `${baseUrl}/rootservices` is read and the domain's service-providers predicate used. Both namespace generations are recognised — the ELM `oslc_rm:`/`oslc_qm:`/`oslc_cm:`/`oslc_am:` forms under `open-services.net/xmlns/<domain>/1.0/`, and the OSLC 3.0 forms under `open-services.net/ns/<domain>#` — with OSLC Core's generic `oslc:serviceProviderCatalog` as a last resort. An application may advertise several catalogs, so selection is by domain predicate rather than by taking the first found. `oslc_config:cmServiceProviders` is never matched: it is a catalog of configurations, not of service providers.

If neither route yields a catalog, startup fails with an error naming `catalogUrl`. It does **not** guess a URL. A client may not assume the shape of a catalog URL — that is what `rootservices` is for, and why `rootservices` itself is unauthenticated: discovery boots from it, and it carries the URLs a client needs in order to authenticate.

**Configuration context.** Required against configuration-enabled ELM project areas, where a request without one cannot say which stream or baseline it applies to. A service provider's value overrides its server's.

**Tool naming.** With one server, tool names are unprefixed (`create_requirement`) exactly as before. With several, each is prefixed by its server alias (`dng_create_requirement`, `etm_create_testcase`), and the `oslc://catalog` MCP resource becomes `oslc://<alias>/catalog`.

## Running

Start your OSLC server first, then either:

```bash
# Configuration file — several servers, scoped to specific project areas
node dist/index.js --config ./oslc-mcp-server.yaml

# Or a single unscoped server
node dist/index.js --server http://localhost:3002 --catalog http://localhost:3002/oslc
```

The server communicates via stdio using the MCP protocol. To use it with Claude Code, add it to your MCP server configuration:

```json
{
  "mcpServers": {
    "oslc": {
      "command": "node",
      "args": ["path/to/oslc-mcp-server/dist/index.js", "--server", "http://localhost:3002", "--catalog", "http://localhost:3002/oslc"]
    }
  }
}
```

## What It Does

At startup, the server:

1. Connects to the OSLC server's service provider catalog
2. Walks all service providers, collecting creation factories, query capabilities, and resource shapes
3. Generates per-type MCP tools from each creation factory and query capability (e.g., `create_programs`, `query_services`)
4. Registers generic CRUD tools (`get_resource`, `update_resource`, `delete_resource`, `list_resource_types`, `query_resources`)
5. Exposes catalog, vocabulary, and resource shapes as MCP resources for LLM context

### MCP Tools

**Per-type tools** (dynamically generated from discovery):
- `create_<type>` -- Creates a resource of that type. Input schema is derived from the OSLC resource shape, with proper types, descriptions, required fields, and allowed values.
- `query_<type>` -- Queries resources of that type using `oslc.where`, `oslc.select`, and `oslc.orderBy` parameters.

**Generic tools** (always available):
- `get_resource` -- Fetch any OSLC resource by URI
- `update_resource` -- Update properties on an existing resource (uses ETag for concurrency)
- `delete_resource` -- Delete a resource by URI
- `list_resource_types` -- List all discovered resource types with their factories and properties
- `query_resources` -- Query any resource type using a query capability URL
- `describe_discovery` -- Report what discovery found and which URL each generated tool will actually hit: the catalog URL and how it was resolved, every service provider, every creation factory and query capability, and every resource shape that failed to fetch. Makes no requests.
- `check_turtle_support` -- Ask the server for Turtle and report what came back, with the HTTP exchange as evidence. Defaults to the catalog URL.

### MCP Resources

- `oslc://catalog` -- Service provider catalog summary (providers, factories, query capabilities)
- `oslc://vocabulary` -- Resource types and their relationships
- `oslc://shapes` -- Property definitions for each resource type (names, types, cardinalities)

### Diagnosing a server

OSLC leaves a great deal to the implementor, and provides no way for a client to discover which
choices a server made. These two tools measure what asking cannot establish.

`describe_discovery` answers "why is this tool missing, or why does it reach the wrong place?".
Discovery turns advertisements into tools through several transformations, and a resource shape that
fails to fetch silently removes a `create_<type>` tool -- so the list of failed shapes is usually
where a missing tool is explained.

`check_turtle_support` answers "will this server give me Turtle?". OSLC 3.0 promotes Turtle as the
preferred representation; many ELM applications do not produce it, which is why this server asks for
`application/rdf+xml` first.

Note what this second tool can and cannot tell you. A server is permitted to disregard the `Accept`
header and return whatever representation it chooses, so the result records only what the server did
on that request -- never what it is able to produce. An `application/rdf+xml` response to a Turtle
request is conformant behaviour, not a fault.

## Architecture

```
oslc-mcp-server/src/
├── index.ts           CLI entry point, arg parsing, startup orchestration
├── server.ts          MCP Server setup, tool/resource registration, stdio transport
├── discovery.ts       Walks OSLC catalog, collects shapes/factories/queries
├── schema.ts          Converts OSLC resource shapes to JSON Schema
├── resources.ts       MCP resource definitions (catalog/vocabulary/shapes)
├── types.ts           Shared TypeScript interfaces
├── oslc-client.d.ts   Type declarations for oslc-client
└── tools/
    ├── generic.ts     Handlers for generic CRUD tools
    └── factory.ts     Generates per-type tool definitions from discovery
```

**Dependencies:** Uses [oslc-client](../oslc-client) for all OSLC operations (HTTP, RDF parsing via rdflib, authentication) and [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for the MCP server framework.

## License

Licensed under the Apache License, Version 2.0. See the workspace root LICENSE for details.
