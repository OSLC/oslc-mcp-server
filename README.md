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
| `--probe-oslc` | — | Probe every query capability at startup and report what each supports. **Off by default; nothing is probed without it.** Writes a fixture — see *What `--probe-oslc` measures* |

### Configuration file

Copy [`oslc-mcp-server.example.yaml`](oslc-mcp-server.example.yaml) to `oslc-mcp-server.yaml` and edit. **The real file is git-ignored** — it names a specific deployment and may carry credentials; only the example is committed.

```yaml
reportPath: ./oslc-discovery.md                  # optional — top level, not per server

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
| `reportPath` | no | `./oslc-discovery.md`. **Top level**, not per server — see [the discovery report](#the-discovery-report) |
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

### Before probing a Jazz/ELM server

`probe_oslc` writes, so the account it runs as needs to be able to write. Two things are worth
settling first, because neither is visible to discovery — every creation factory advertises, every
shape fetches, every `create_*` tool generates, and the POST still fails:

- **A licence for each application you will probe.** Read access and write access are licensed
  separately. Without one, a create answers `403` / `CRJAZ1848E` naming the licences that would
  satisfy it.
- **Delete permission**, if you want the probe to clean up after itself. Without it, delete answers
  `403` / `CRJAZ6053E` and the fixture is left behind and reported as needing manual cleanup.

The probe classifies both and reports them under **Refusals — administrative, not capability**,
separately from the query cases, because neither is a finding about the server's OSLC support. It
sends `X-Jazz-CSRF-Prevent` on mutations where it can obtain a `JSESSIONID`; Jazz requires that
header on some operations and not others.

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

### Measuring what a server actually implements — `probe_oslc`

`probe_oslc` answers "what does this server's OSLC Query actually do?". A capability is advertised
without saying which of it works: an `oslc:QueryCapability` publishes a `queryBase` and nothing about
which `oslc.where` operators exist, whether `oslc.select` nests, whether `oslc.orderBy` is honoured,
or how paging behaves. The probe creates a small fixture, queries it, updates it and removes it, and
records what the server did — with every HTTP exchange kept as evidence.

Read the verdicts carefully. **`ignored` is the one that matters**: a `200` means the parameter
parsed, not that it did anything, and a server that accepts `oslc.where` and returns the unfiltered
set is the failure a status code cannot show you. `inconclusive` is not a failure either — it is the
run saying what it could not settle, with what a correct result would have looked like so you can
check it against the server's own UI.

**What it writes.** Only resources it creates and marks `PROBE-`, only in the service provider you
name, and it deletes them again — anything it cannot delete is reported with its URI rather than left
silently behind. It never modifies pre-existing content. If the server does not support DELETE it
stops and asks, because leaving a permanently populated project area and accepting weaker
verification are both defensible and neither should be chosen for you (`onDeleteUnsupported`).

**A read-only run measures materially less.** Where a service provider advertises no creation
factory, or refuses a create, the probe samples ground truth from existing content instead. Filters
are still measured by identity, but three things cannot be: properties dropped on create, whether an
update is visible to query, and whether a created resource is visible to query at all. The report
names them as not measured rather than omitting them.

**Triage is yours.** The probe records mechanical facts and leaves six empty categories for a person
to sort them into. Whether a missing capability is a conformant choice or something to raise is a
judgement about the specification — and conflating the two wastes a vendor's time while costing the
reports that *are* worth raising their credibility. A server that does not implement `oslc.orderBy`
has done nothing wrong.

### What `--probe-oslc` measures

`--probe-oslc` runs the same probe at startup, against **every** query capability of every discovered
service provider, and writes what each one supports into the discovery report. Without the flag
nothing is probed at all: startup discovers, generates tools and serves them.

```bash
node dist/index.js --config ./oslc-mcp-server.yaml --probe-oslc
```

It is for a test environment. Each capability probed means a fixture created, read back and deleted,
plus roughly thirty queries — 25 capabilities across three ELM servers is a few hundred requests and
25 create/delete cycles.

#### The cases, and what each verdict means

`Q` below is the capability's `queryBase`. Requests go by POST-form where case 2 showed POST works,
otherwise as `GET Q?…`. `R-7` stands for a `dcterms:identifier` value the run established identifies
exactly one resource — the *known* resource; the *baseline* is every member the unparameterised query
returned. No request declares `oslc.prefix`: the run is measuring which prefixes a server
**predefines**, which is what a client can rely on without declaring anything.

| Case | Request | `supported` means | Other verdicts |
|---|---|---|---|
| `bare-query` | `GET Q` | members came back with no parameters | `unsupported`: 4xx, or zero members. The specification does not say what a bare query returns, so this is not a defect |
| `post-versus-get` | `POST Q` (form) and `GET Q`, both carrying `oslc.pageSize=1` | both accepted | `unsupported`: only GET works, so queries are capped by URL length — which bites on a long `oslc.where`/`oslc.select`. **The request must carry a real query**: an empty form body is not an OSLC query, and a server answering 415 to one says nothing about POST-query support |
| `where-identity` | `oslc.where=dcterms:identifier="R-7"` | exactly the known resource came back, **by identity** | `ignored`: the whole baseline came back, so the filter did nothing. `unsupported`: 4xx, zero, or the wrong resources |
| `where:equality` | `dcterms:identifier="R-7"` | as above | as above |
| `where:inequality` | `dcterms:identifier!="R-7"` | *see the limitation below* | |
| `where:comparison` | `dcterms:identifier>"R-7"` | *see the limitation below* | |
| `where:set-membership` | `dcterms:identifier in ["R-7"]` | exactly the known resource | `unsupported`: 4xx, or a different set |
| `where:conjunction` | `dcterms:identifier="R-7" and dcterms:identifier="R-7"` | exactly the known resource | as above |
| `where:scoped-terms` | `dcterms:creator{foaf:name="R-7"}` | *see the limitation below* | |
| `where:disjunction` | `dcterms:identifier="R-7" or dcterms:identifier="R-7"` | exactly the known resource | `unsupported` is **conformant**: `or` is not in the OSLC query syntax. The reason text says so |
| `where:wildcard` | `dcterms:identifier="R-7*"` | exactly the known resource | `unsupported` is **conformant**: wildcards are not in the syntax either |
| `negation-pair` | `…="R-7"` then `…!="R-7"`, two requests | the two results partition the baseline: together exactly it, neither alone | `ignored`: both returned the whole baseline. `unsupported`: they overlap — which proves the filter was not applied *even though both answered 200* |
| `select` | `oslc.select=dcterms:title`, then `dcterms:creator{foaf:name}` | the flat projection narrowed what came back; the reason says whether the nested property actually appeared | `ignored`: accepted and the properties did not narrow. `unsupported`: the flat form 4xx'd |
| `order-by` | `oslc.orderBy=+dcterms:title`, then `-dcterms:title` | the leading member differs between the two | `ignored`: both orders lead with the same member, so ordering was not applied — **your EWM case**. `unsupported`: either direction 4xx'd |
| `paging` | `oslc.pageSize=2` | a page of exactly 2 **and** an `oslc:nextPage` | `ignored` twice over: the whole baseline came back, *or* a page of the server's own size with `nextPage` (administrator-configured paging, which OSLC permits — paging works, you just cannot size it). `unsupported` only when the collection is truncated with **no** `nextPage`, so the rest is unreachable |
| `search-terms` | `oslc.searchTerms=<word unique to one resource>` | that resource, by identity | `unsupported`: 4xx — **your EWM case**, full-text search is not implemented. Optional in OSLC |
| `prefix-discovery:oslc.where` | `oslc.where=dcterms:identifier="R-7"` with **no `oslc.prefix` declaration** | the server predefines `dcterms`: the undeclared prefix was accepted *and took effect* | `unsupported`: 4xx, so `dcterms` is not predefined for filtering. `inconclusive` when the clause was accepted but **ignored** — acceptance then says nothing about the prefix. A server that ignores `oslc.where` accepts every prefix, and reading that as "all prefixes predefined" is exactly backwards |
| `prefix-discovery:oslc.select` | `oslc.select=dcterms:title`, likewise undeclared | `dcterms` is predefined for projection too | `unsupported`: 4xx. Probed separately from the above because a server may resolve prefixes when filtering but not when projecting |

The five verdicts:

- **`supported`** — the effect was observed, by identity where a filter is involved. Never inferred
  from a `200`.
- **`ignored`** — accepted and did nothing. **The one that matters.** A `200` means the parameter
  parsed, not that it acted, and a server returning the unfiltered set for a valid `oslc.where` is
  the failure no status code shows.
- **`unsupported`** — refused (4xx), or answered with something other than the expected effect. For
  `disjunction` and `wildcard` this is *conformant*, and the reason text says so.
- **`inconclusive`** — could not be settled, usually because the data could not distinguish anything:
  a baseline under two members cannot tell a filter from no filter. Carries what a correct result
  would look like, so you can check it in the server's own UI.
- **`error`** — the exchange itself failed.

#### Read-only mode weakens the run

`read-only: the creation factory refused a create with 403` in the report means no fixture was
established, so ground truth was **sampled from existing content**. Filters are still judged by
identity, but three things cannot be measured at all: properties silently dropped on create, whether
an update becomes visible to query, and whether a created resource becomes visible to query. A `403`
there is an authorization outcome, not a capability one — the probe reports what the server said and
does not guess which.

#### Each construct is judged against its own correct answer

A construct's clause decides what a correct response is, and three of the eight do not mean "exactly
the one known resource":

| Construct | A conformant server returns | Judged by |
|---|---|---|
| `inequality` — `…!="R-7"` | the baseline **without** R-7 | exclusion: R-7 absent and others present. A *paged* complement still counts, since the baseline is only page one — demanding the exact complement reported a working `!=` as broken |
| `comparison` — `…>"R-7"` | a **range**, boundary excluded | two collation-independent invariants: a strict `>` never returns R-7 itself, and a clause that was applied does not return the whole baseline. An **empty** result is `inconclusive`, because a boundary at the greatest value and a dropped clause look identical |
| `scoped-terms` — `dcterms:creator{foaf:name="R-7"}` | **nothing** — no creator is *named* like an identifier value | a refusal is the only sound signal, so a 4xx is `unsupported` and acceptance is `inconclusive`. It is not evidence either way |

The other five (`equality`, `set-membership`, `conjunction`, `disjunction`, `wildcard`) are judged by
identity, because as templated here each names a single value that one resource carries.

Reading a `NO` on the first three before this was fixed: it was only real when the reason said
`answered <4xx>`. `negation-pair` was unaffected throughout — it checks that a filter and its
negation *partition* the baseline rather than comparing against a fixed expected set, which is why a
server could report `inequality NO` and `negation-pair yes` at the same time. That contradiction was
the symptom.

### The discovery report

Every start writes the same content `describe_discovery` returns to a file — `reportPath`, default
`./oslc-discovery.md`, one section per configured server, rewritten each run so it always describes
the live tool set.

A file rather than only a tool, because **a tool cannot answer the question it is most needed for**:
a server that started and generated the wrong tools, or none at all. Nothing is there to call.

```
[discovery] Scoped discovery complete: 1/1 providers, 13 factories, 13 shapes from 13 document(s)
[rebuild] etm: 13 per-type tools, 1 resources
[report] wrote ./oslc-discovery.md (79 lines, 1 server)
```

It carries **no timestamp**, so an unchanged deployment produces a byte-identical file and a diff
shows only what actually changed — which is what makes it usable as committed context describing
what the tools can do. A scoped server costs a few hundred tokens; beyond 25 service providers the
report says how many it left out rather than growing without bound.

The default path is git-ignored as a runtime artifact. To keep one under version control, point
`reportPath` at a deliberate location such as `docs/discovery-<deployment>.md`.

### Alongside IBM Engineering AI Hub

IBM ships an MCP endpoint for ELM too, and the two are more complementary than competing. AI Hub's
tools are **written per application**; these are **derived from what a server advertises over OSLC**.
That produces opposite strengths:

| | AI Hub **1.3** (tool inventory dated 2026-06-18) | `oslc-mcp-server` |
|---|---|---|
| Reach | ELM only, including Rhapsody SysML v2 models | any conformant OSLC provider |
| Writes | read-mostly — 8 of 42 tools write; one creates an artifact, none updates or deletes | a `create_*` per advertised creation factory, plus generic update and delete |
| Beyond artifacts | folders, categories, releases, iterations, users, and configuration/stream resolution | none of these — OSLC advertises no such capability |
| Cost | separate entitlement | ELM licences only; self-hosted |

**An assistant can be configured with both**, and there is a reason to: AI Hub answers the questions
OSLC does not advertise — which stream is current, what the folder structure is, who a user is,
what a SysML v2 model contains — while this server creates and updates artifacts in ETM and EWM,
where AI Hub has no create tool at all, and reaches governed domains outside ELM entirely. Tool names
are namespaced per server on both sides, so the surfaces do not collide.

The AI Hub column counts a **specific release**. A later one may add creates, updates or deletes and
invalidate the middle rows — check IBM's *MCP tools for Engineering AI Hub* before relying on them.

[Full comparison](docs/comparison-ibm-engineering-ai-hub.md), including what neither inventory tells
you: what its search filters actually do.

### Further reading

- [Using `oslc-mcp-server` with IBM ELM](docs/elm-compatibility.md) — how ELM behaves as an OSLC
  provider, and the quirks that fail silently rather than with an error.
- [`oslc-mcp-server` and IBM Engineering AI Hub 1.3](docs/comparison-ibm-engineering-ai-hub.md) — the
  capability comparison summarised above, with the measured figures behind it.

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
