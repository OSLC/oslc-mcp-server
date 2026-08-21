# Using `oslc-mcp-server` with IBM ELM

Findings from running `oslc-mcp-server` against an **IBM ELM 7.1 SR1** deployment — DOORS Next (`/rm`), ETM (`/qm`) and EWM (`/ccm`) — in August 2026.

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

### 1. `OSLC-Core-Version: 2.0` is a required header, EWM will default to OSLC 1.0 if the header is not present or does not have value 2.0.

Note: **There is no `3.0` value for this header.** OSLC Core 3.0 retains `2.0`. 

Against EWM's work-item service provider, `3.0` returns **a different document**:

| Header sent | Response | Creation factories |
|---|---|---|
| `OSLC-Core-Version: 2.0` | `application/rdf+xml`, ~29 KB | **20** |
| `OSLC-Core-Version: 3.0` | `application/x-oslc-cm-service-description+xml`, ~12 KB | **0** |

The `3.0` response is a legacy CM service description, not an OSLC `ServiceProvider`. It parses cleanly into a graph that simply has no `oslc:service` on the subject — so a client sees **zero creation factories, zero shapes, zero tools, and no error**. It looks exactly like an application with no capabilities.

DOORS Next returns byte-identical documents for both values, which is what makes this so hard to spot: only one application of three exhibits it.

**Always send `OSLC-Core-Version: 2.0`.**

### 2. There is no single rootservices property for the service provider catalog 

Each ELM server uses specific namespaces and properties to define the OSLC service provider catalog, there is no single property that can be relied upon. 

| Application | Predicate | Catalog |
|---|---|---|
| DOORS Next | `oslc_rm:rmServiceProviders` | `/rm/oslc_rm/catalog` |
| ETM | `oslc_qm:qmServiceProviders` | `/qm/oslc_qm/catalog` |
| EWM | `oslc_cm:cmServiceProviders` | `/ccm/oslc/workitems/catalog` |

**Select by domain predicate, not by taking the first catalog you find.** ETM's `rootservices` advertises four catalogs — `oslc_qm`, `oslc_auto`, `oslc_cm` and `oslc_config` — and only one is the quality-management catalog.

### 3. One service provider is one project area — and there may be hundreds

On the deployment tested, **each of the three catalogs listed 306 service providers**. A client that walks the catalog at startup fetches 306 service provider documents plus every shape each references, per application.

This is why scoping matters: name the few project areas you actually use and skip the catalog entirely. It is the difference between a startup measured in seconds and one that may not finish usefully at all.

Applications need to be prepared to read a lot of service providers, or scope thier discovery to a set of service providers.

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

An `oslc:QueryCapability` declares `oslc:queryBase` and `oslc:resourceType`, and sometimes `oslc:resourceShape`. It declares nothing about which `oslc.where` operators work, whether `oslc.select` supports nesting, whether `oslc.orderBy` is honored, whether `oslc.searchTerms` exists, or how paging behaves.

Measured on one deployment, with an `oslc.where` chosen to match **nothing**:

| Application | Query capabilities advertised | Unfiltered query | `oslc.where` that matches nothing |
|---|---|---|---|
| EWM | 2 | Returns work items | `400` — `oslc:Error … "Cannot reconstruct value"` |
| DOORS Next | 8 | Returns members | `200`, **and the same members as unfiltered** |
| ETM | **15** (was 0 — see below) | not re-probed | not re-probed |

> **Read these as observations, not as established product behaviour.** They were taken against **configuration-enabled** project areas, on a deployment whose configuration management was known to be misbehaving at the time, and **without supplying a `Configuration-Context`**. The requests also declared no **`oslc.prefix`** for the prefixes used in the filter. DOORS Next is expected to support `oslc.where`, so the most likely explanations are the missing configuration context or the undeclared prefix rather than the product. **The cause is not established.** This section will be revised once the same probes run against non-configuration-enabled project areas with prefixes declared.

What is worth recording regardless is the **shape** of the DOORS Next result: a filter that did not take effect, returned with a `200` and nothing to indicate it had been discarded. Whether the cause is the product, the absent configuration context, or an undeclared prefix, **a client cannot tell from the response** — and a consumer reasoning over the result would be confidently wrong. An assistant asking "which requirements have no test coverage?" would get every requirement back and report accordingly.

**So do not trust a filter's status code.** Establish an unfiltered baseline count, issue a filter that cannot match, and compare. If the counts are equal the filter did not take effect — and the check does not depend on knowing why, which is exactly why it is worth doing.

**Declare your prefixes.** OSLC query expects prefixes used in `oslc.where` and `oslc.select` to be declared with `oslc.prefix` unless the server supplies built-in defaults, and servers differ on which they supply. A server that cannot resolve a prefix may reject the query — or may discard the clause. *(This MCP server does not currently send `oslc.prefix` at all. That is a gap here, not a finding about ELM.)*

**ETM advertised no query capabilities — resolved: the service provider URI was stale.** The original run named a project area from a previous installation of the deployment. The server was rebuilt and every project-area id changed, so discovery was reading a URI that no longer identified anything.

Re-run against the current JKE Banking quality-management project area, ETM advertises **15 query capabilities**, one per resource type:

`TestCaseQuery`, `TestPlanQuery`, `TestExecutionRecordQuery`, `TestResultQuery`, `TestScriptQuery`, `TestSuiteQuery`, `TestSuiteResultQuery`, `TestScriptStepQuery`, `TestPhaseQuery`, `TestEnvironmentQuery`, `TestDataQuery`, `KeywordQuery`, `BuildRecordQuery`, `BuildDefinitionQuery`, and a default for `TestCase`.

Note what this means for the question that prompted the re-test: **the artifacts a test engineer wants — execution records and results — are advertised as queryable over OSLC**, so `TestExecutionRecordQuery` and `TestResultQuery` are discoverable, not privileged. Whether the *filters* work is a separate question, and the point of the probe.

Two lessons worth more than the finding:

1. **A stale service-provider URI presents as an absent capability, not as an error.** Nothing in the run failed. Discovery fetched, parsed, found no capabilities, and reported zero — which reads exactly like a server that cannot be queried. Any scoped configuration naming project areas by id is one rebuild away from this, and the report will state it as fact.
2. **We nearly published it as a product characteristic.** The zero was on its way into a comparison with another vendor's tool before it was checked against [IBM's own client documentation](https://github.com/IBM/ELM-Python-Client/blob/master/elmclient/examples/OSLCQUERY.md), which documents ETM query capabilities plainly. Verify a negative discovery result against the vendor's own documentation before drawing a conclusion from it.

For reference, the same run's factory counts: DOORS Next 12 factories but **2** create tools, ETM 13 factories / 13 tools, EWM 10 factories / 9 tools. The DOORS Next shortfall is correct behaviour, not a defect: ten of its factories are administrative — ReqIF import/export, `AttributeDefinition`, `AttributeType`, `ArtifactType`, `LinkType`, delivery and type-system-copy sessions — and create no shaped OSLC resource, so they advertise no `oslc:resourceShape` and no `create_*` tool is generated.

Tracked as [#1](https://github.com/OSLC/oslc-mcp-server/issues/1): probe each query capability, record `supported` / `unsupported` / **`ignored`**, and surface the answer where the caller will see it.

### 7. A query base may already carry query parameters

DOORS Next advertises query bases such as `…/views_oslc/query?componentURI=…`. A client that appends `?oslc.where=…` produces a URL with two `?`, which the server **accepts and silently mishandles** rather than rejecting. Append with `&` when the base already contains a `?`.

(This was a bug in this MCP server, fixed — but it is worth knowing generally, because the symptom is a query that appears to succeed.)

### 8. A `rootservices` document may not parse

One OSLC server encountered serves `rootservices` as SPARQL-style Turtle (`PREFIX` rather than `@prefix`), which a standards-compliant Turtle parser rejects. If your client swallows parse errors and returns an empty graph — many do — this presents as a document with no predicates rather than as an error.

Falling back to the `${baseUrl}/oslc/catalog` convention when no catalog predicate is found handles this gracefully.

This is a generic-framework error in how it produces the Turtle representation of its rootservices document. For ELM applications, it's best to use Accept=application/rdf+xml, many do not support Turtle at all. 

### 10. EWM types a change request with `dcterms:type`, not `rdf:type`

**A `oslc_cm:ChangeRequest` in EWM does not carry its specific type — Defect, Story, Task, Epic, Feature — as an `rdf:type`.** It carries it as **`dcterms:type`**, a plain literal. Every work item is `rdf:type oslc_cm:ChangeRequest` and nothing narrower.

This is not conformant with OSLC 2.0 or 3.0, and it is not an accident. It is how **OSLC 1.0** modelled resource types — the pre-OASIS specifications IBM had already implemented and shipped — and it was kept for backward compatibility when the work moved to OASIS. A standard for tool integration could not credibly ask its implementors to break every existing client three times, at 1.0, 2.0 and 3.0. So the older shape survives where changing it would have broken deployed integrations, and this is one of those places.

Consequences for a client, all of them silent:

- **`oslc.where=rdf:type=oslc_cm:Defect` matches nothing**, and returns `200` with an empty result rather than an error. The filter is well-formed and the property genuinely absent. Filter on `dcterms:type` instead — and note it is a *literal*, so the comparison is `dcterms:type="Defect"`, not a URI.
- **Discovery cannot tell you the work-item types.** They are not in the type system as classes, so a client that enumerates types from `rdf:type` sees one type where the project area has a dozen.
- **A resource created without `dcterms:type`** may land as whatever the project area defaults to. A `create_*` tool whose input schema came from an `oslc:ResourceShape` will not necessarily prompt for it, because the shape describes `ChangeRequest` and the discriminator is a value rather than a class.

Worth knowing generally: where an ELM behaviour looks like a plain standards violation, check the 1.0 specifications before treating it as a fault. Several are deliberate compatibility decisions, and reporting them as defects wastes everyone's time.

### 11. Paging parameters may be ignored in favour of a server-configured page size

**`oslc.pageSize` is a request, not an instruction.** A server may page at a size its administrator configured and disregard the one asked for — returning, say, 50 members for `oslc.pageSize=2`, with a perfectly good `oslc:nextPage`.

Nothing is broken there. The collection *is* paged and every member *is* reachable; only the size is not the client's to choose. But it is easy to measure wrongly, in both directions:

- Reading "50 returned, 2 requested" as **broken paging** reports a capability as missing when it is present and working.
- Reading it as **paging supported** hides the fact that a client cannot control the page size, which matters to anything sizing its own batches or estimating a fetch.

The honest verdict is that the parameter was **ignored**: accepted, and something other than what was asked for happened. That is the distinction OSLC's own permissiveness forces — the specification lets a server decline `oslc.pageSize` — and it is why `probe_oslc` treats `ignored` as a first-class outcome rather than a shade of failure.

`probe_oslc` reports it that way: `ignored` where the page came back at a size the server chose *and* `oslc:nextPage` was offered, and `unsupported` only where fewer members came back than the baseline with **no** `oslc:nextPage` — the one case in which the rest genuinely cannot be reached.

### 9. No per-type `query_<type>` tools are generated for any application

Discovery finds query capabilities — 8 in DOORS Next, 2 in EWM — but tool generation produces only `create_*` tools from creation factories. Querying is therefore possible only through the generic `query_resources` tool, which requires the caller to supply a `queryBase` URI it has no way to discover from the tool schema alone.

Generated tool names also derive from factory *titles* rather than resource types, which produces names like `create_location_for_creation_of_defect_change_requests_` — hard for a language model to select correctly.

---

## Still unknown

- **DOORS Next generates far fewer create tools than it has creation factories** — 12 factories yielded 2 shapes and 2 tools in testing. Undiagnosed. Most DNG types consequently have no `create_*` tool.
- **Whether create, update and delete actually work.** `list_resource_types` and unfiltered query are confirmed against all applications that support them; the write path has not been exercised.
- **Whether the query results in quirk 6 survive a clean test** — non-configuration-enabled project areas, a supplied `Configuration-Context` where one applies, and `oslc.prefix` declared. Until then that section records symptoms, not causes.
- **Configuration-context behavior** — whether a request against a configuration-enabled project area fails without a `Configuration-Context`, or silently resolves against a default. The second would be worse.
- **Whether creation factories enforce their advertised shapes**, and which properties are genuinely writable. A factory advertises a shape; it does not advertise whether it means it.

---

*Corrections and additions welcome — particularly from anyone who has diagnosed the DOORS Next tool-generation gap, or mapped ELM's configuration-management APIs more successfully.*
