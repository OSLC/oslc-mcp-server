# Using `oslc-mcp-server` with IBM ELM

Findings from running `oslc-mcp-server` against an **IBM ELM 7.x** deployment — DOORS Next (`/rm`), ETM (`/qm`) and EWM (`/ccm`) — in August 2026.

Most of what follows is not specific to this MCP server. It is how ELM behaves as an OSLC provider, and several of the quirks below cost real time to diagnose because **they fail silently rather than with an error**. Published in the hope it saves someone else that time.

---

## What works

| | |
|---|---|
| **Authentication** | **Basic** against the Jazz Authorization Server (JAS). The server answers `WWW-Authenticate: Basic realm="JSA"` and `Bearer realm="JSA"` with an `x-jsa-authorization-url` header; Basic is sufficient and no bearer-token flow is needed. This is *not* the older JEE forms (`j_security_check`) flow |
| **Catalog discovery** | `GET ${baseUrl}/rootservices`, then the domain's service-providers predicate |
| **Scoped discovery** | Listing specific service providers and skipping the catalog walk — essential at real scale, see quirk 2 |
| **Several applications, one MCP instance** | `/rm`, `/qm` and `/ccm` from one process, tools namespaced per application |

---

## Quirks, and how they present

### 1. `OSLC-Core-Version: 3.0` does not exist — and sending it silently breaks EWM

**There is no `3.0` value for this header.** OSLC Core 3.0 retains `2.0`. Sending `3.0` is not a version choice, it is a malformed request — and ELM applications do not agree on how to treat it.

Against EWM's work-item service provider, `3.0` returns **a different document**:

| Header sent | Response | Creation factories |
|---|---|---|
| `OSLC-Core-Version: 2.0` | `application/rdf+xml`, ~29 KB | **20** |
| `OSLC-Core-Version: 3.0` | `application/x-oslc-cm-service-description+xml`, ~12 KB | **0** |

The `3.0` response is a legacy CM service description, not an OSLC `ServiceProvider`. It parses cleanly into a graph that simply has no `oslc:service` on the subject — so a client sees **zero creation factories, zero shapes, zero tools, and no error**. It looks exactly like an application with no capabilities.

DOORS Next returns byte-identical documents for both values, which is what makes this so hard to spot: only one application of three exhibits it.

**Always send `OSLC-Core-Version: 2.0`.**

### 2. The catalog is not at `${baseUrl}/oslc/catalog`

That convention matches **no** ELM application. Read `${baseUrl}/rootservices` and take the domain's service-providers predicate:

| Application | Predicate | Catalog |
|---|---|---|
| DOORS Next | `oslc_rm:rmServiceProviders` | `/rm/oslc_rm/catalog` |
| ETM | `oslc_qm:qmServiceProviders` | `/qm/oslc_qm/catalog` |
| EWM | `oslc_cm:cmServiceProviders` | `/ccm/oslc/workitems/catalog` |

**Select by domain predicate, not by taking the first catalog you find.** ETM's `rootservices` advertises four catalogs — `oslc_qm`, `oslc_auto`, `oslc_cm` and `oslc_config` — and only one is the quality-management catalog.

### 3. One service provider is one project area — and there may be hundreds

On the deployment tested, **each of the three catalogs listed 306 service providers**. A client that walks the catalog at startup fetches 306 service provider documents plus every shape each references, per application.

This is why scoping matters: name the few project areas you actually use and skip the catalog entirely. It is the difference between a startup measured in seconds and one that may not finish usefully at all.

### 4. Service provider URI shapes differ between applications of the same product

There is no single pattern to construct these from a project-area id. Read them from the catalog:

```
DOORS Next   /rm/oslc_rm/<id>/services.xml
ETM          /qm/oslc_qm/contexts/<id>/services.xml          ← note /contexts/
EWM          /ccm/oslc/contexts/<id>/workitems/services.xml
```

### 5. Configuration-management APIs are not uniformly reachable

- `/rm/oslc_config/components` returns a **service provider catalog** of creation factories per project area — not a list of components, despite the path.
- `/rm/configurationQuery` rejects an `oslc.where` on `dcterms:title` with `400`, with no indication which part was unsupported.
- `/gc/oslc/configurations` is `404` on a deployment whose `/gc` application is otherwise up.

Resolving a stream or baseline URI to use as a `Configuration-Context` was not achieved by API alone; the component picker in the web UI remains the practical route.

### 6. Query capability is advertised, but its actual behaviour is not

An `oslc:QueryCapability` declares `oslc:queryBase` and `oslc:resourceType`, and sometimes `oslc:resourceShape`. It declares nothing about which `oslc.where` operators work, whether `oslc.select` supports nesting, whether `oslc.orderBy` is honoured, whether `oslc.searchTerms` exists, or how paging behaves.

**The failure mode to fear is a parameter that is accepted and ignored.** A `400` is recoverable — a client sees the error and adapts. A server that ignores `oslc.where` and returns the entire collection looks like a successful query, and any consumer reasoning over the result is confidently wrong.

Tracked as [#1](https://github.com/OSLC/oslc-mcp-server/issues/1): probe each query capability, record `supported` / `unsupported` / **`ignored`**, and surface the answer where the caller will see it.

### 7. A `rootservices` document may not parse

One OSLC server encountered serves `rootservices` as SPARQL-style Turtle (`PREFIX` rather than `@prefix`), which a standards-compliant Turtle parser rejects. If your client swallows parse errors and returns an empty graph — many do — this presents as a document with no predicates rather than as an error.

Falling back to the `${baseUrl}/oslc/catalog` convention when no catalog predicate is found handles this gracefully.

---

## Still unknown

- **DOORS Next generates far fewer tools than it has creation factories** — 12 factories yielded 2 shapes and 2 tools in testing. Undiagnosed. Most DNG types consequently have no `create_*` tool.
- **Configuration-context behaviour** — whether a request against a configuration-enabled project area fails without a `Configuration-Context`, or silently resolves against a default. The second would be worse.
- **Whether creation factories enforce their advertised shapes**, and which properties are genuinely writable. A factory advertises a shape; it does not advertise whether it means it.

---

*Corrections and additions welcome — particularly from anyone who has diagnosed the DOORS Next tool-generation gap, or mapped ELM's configuration-management APIs more successfully.*
