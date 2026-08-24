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
| EWM | 3 | Returns work items | `400` — `oslc:Error … "Cannot reconstruct value"` |
| DOORS Next | 8, of which **1** queries RM resources (quirk 15) | 582 members | `200`, and the filter *is* applied once prefixes are declared |
| ETM | **15** | 30 test cases on the TestCase base | `200`, filter applied |

Re-measured 2026-08-24 with the probe's own defects corrected — undeclared prefixes (quirk 15), an
empty POST body (quirk 16), a `rdfs:member`-only reading of results (quirk 13), and a distinguishing
value trusted from a five-member sample. Each of those produced a *false* negative, and between them
they accounted for most of what an earlier run reported as missing query support. **Where a probe and
a server disagree, suspect the probe first.** All three applications support `oslc.where` on
`dcterms:identifier` and `dcterms:title`, `oslc.select`, and paging; none supports `oslc.searchTerms`;
`oslc.orderBy` is honoured by DOORS Next and **ignored** by EWM and ETM.

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

### 9. No per-type `query_<type>` tools are generated for any application

Discovery finds query capabilities — 8 in DOORS Next, 2 in EWM — but tool generation produces only `create_*` tools from creation factories. Querying is therefore possible only through the generic `query_resources` tool, which requires the caller to supply a `queryBase` URI it has no way to discover from the tool schema alone.

Generated tool names also derive from factory *titles* rather than resource types, which produces names like `create_location_for_creation_of_defect_change_requests_` — hard for a language model to select correctly.

---

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

### 12. EWM answers **403** for an unmet save precondition, and only some work-item types can be created blind

Observed 2026-08-24 against EWM at `trs-filter.smartfacts.com/ccm`, project area `JKE Banking (Change Management)`.

A POST of a minimal change request to the **Defect** creation factory answers:

```
403 Forbidden
oslc:message  'Save Work Item' failed. Preconditions have not been met:
              The 'Filed Against' attribute needs to be set
```

**The status is wrong for the cause.** `403` reads as authorization. It is not: the same credentials
read the project area and its shapes, a malformed body answers `400` with a Jena parse error, and an
anonymous request answers `401`. A precondition failure is `400`-shaped, `409` at worst. Treat a
`403` from an EWM creation factory as "read the `oslc:message`", never as "check the user's roles" —
that misreading cost us an afternoon.

**The shape does declare the requirement**, and this is worth stating because it is easy to conclude
otherwise: `rtc_cm:filedAgainst` is `oslc:occurs oslc:Exactly-one` with **13 `oslc:allowedValue`
categories**, and the generated create tool's schema correctly reports
`required: ["title","filedAgainst"]` with the URIs as an enum. A client that reads the shape properly
has everything it needs.

**But one allowed value is a trap.** The thirteenth category is **`Unassigned`** — EWM's placeholder
for *not filed*. It is offered as a legal `oslc:allowedValue` and rejected with the same 403 as
sending nothing. A client that picks an arbitrary allowed value has a 1-in-13 chance of picking the
one that cannot work, and nothing in the shape distinguishes it.

**Requirements vary by work-item type.** Of the ten factories in this project area:

| Required properties | Types |
|---|---|
| `title` only | **Task** |
| `title` + `filedAgainst` | Defect, Story, Epic, Impediment, Retrospective, Adoption Item, Track Build Item, and the generic change-request factory |

So `Task` is the only type creatable from shape knowledge alone. `dcterms:identifier` is ignored on
create (correctly — Core makes it server-assigned) and `dcterms:type` is unnecessary because the
factory URL carries the subtype.

`probe_oslc` now reads required properties from the shape, supplies a required reference from its
first allowed value, and carries the server's `oslc:message` into its report.

### 13. ETM links query results by a per-type domain predicate, and declares none of them

Observed 2026-08-24 against ETM at `trs-filter.smartfacts.com/qm`, project area
`JKE Banking (Quality Management)`.

A Test Case query answers `200` with a 204 KB document, `oslc:totalCount 30`, and thirty results —
and **no `rdfs:member` and no `ldp:contains` anywhere in it**. Each result is linked from the query
base by `oslc_qm:testCase` (`http://open-services.net/ns/qm#testCase`). EWM's work-item query, on
the same deployment, uses `rdfs:member` for its 95 results. So the membership predicate varies by
application, and a client that reads only the standard ones reports a populated project area as
empty.

The `oslc:ResponseInfo` node is also published under a **paged URI of its own** —
`…/VersionedTestCase?rqm_qm.pageNum=0` — not the query base, so `oslc:totalCount` and the paging
links hang off a different subject than the members do.

**A different predicate per capability.** Each of the fifteen query capabilities links its results
with the predicate for its own type. Measured across the project area:

| Capability | Members | Container predicate |
|---|---|---|
| TestCase | 30 | `oslc_qm:testCase` |
| TestScriptStep | 71 | `oslc_qm:testScriptStep` |
| TestExecutionRecord | 52 | `oslc_qm:testExecutionRecord` |
| TestResult | 52 | `oslc_qm:testResult` |
| TestScript | 27 | `oslc_qm:testScript` |
| TestPhase | 16 | `oslc_qm:testPhase` |
| TestEnvironment | 14 | `oslc_qm:testEnvironment` |
| TestPlan | 4 | `oslc_qm:testPlan` |
| TestSuite | 3 | `oslc_qm:testSuite` |
| Keyword | 2 | `oslc_qm:keyword` |
| BuildRecord, TestData, TestSuiteResult, BuildDefinition, TestSuiteExecutionRecord | 0 | — (empty) |

271 resources, all of which a `rdfs:member`-only client reads as zero. Ten distinct predicates, so an
allow-list needs one entry per OSLC QM type and a new type breaks it again.

**Where this sits against the specification — no normative statement is broken.**
[OSLC Query 3.0][query30] binds membership in two branches, and ETM satisfies the precondition of
neither:

> **QUERY-13** — If the query capability that declared the base URI does **not** declare a
> `oslc:resourceShape` then the container MUST include an `rdfs:member` reference to each of the
> result members.
>
> **QUERY-14** — If the query capability … declares a `oslc:resourceShape` **and that resource shape
> defines a container property with `oslc:isMemberProperty "true"^^xsd:boolean`** then the query result
> container MUST include the specified member property…

- All **15 of 15** capabilities declare `oslc:resourceShape`, so QUERY-13's condition is false.
- The declared shape defines **no** property with `oslc:isMemberProperty "true"` — it declares
  `oslc:isMemberProperty` on **117 properties, every one `false`** — and has no property for
  `oslc_qm:testCase` at all. So QUERY-14's condition is false too.

Neither MUST applies. **ETM is not provably non-conformant here**; it occupies a gap between the two
clauses. `QUERY-12` ("the container SHOULD be a Linked Data Platform Container") is unmet — no `ldp:`
terms, no container type, no `Link` header — but that is a SHOULD.

What is genuinely wrong is subtler than a violation: `oslc:isMemberProperty` exists precisely so a
client can *learn* the membership predicate, ETM ships that vocabulary on 117 properties set to
`false`, and never sets it `true` on the property that is one. The mechanism is implemented and
unused, and the real predicate appears nowhere in the shape. A client following QUERY-13/14 to the
letter finds no declaration and no `rdfs:member`, and has nothing left to go on.

In fairness: ETM is a 2.0-era implementation — it requires `OSLC-Core-Version: 2.0` and its own
namespaces are `open-services.net/xmlns/qm/1.0/`. Query 3.0 postdates it, and [QM 2.0][qm20] says
nothing about membership predicates, delegating to Core; its only normative statement on query
responses concerns representations ("QM Providers MUST provide RDF/XML, XML, and Atom Syndication
Format XML"). Raise this as a discoverability gap, not as a conformance defect.

**A rule to hold our own servers to:** a reflective owned domain that emits a domain membership
predicate must declare it — `oslc:isMemberProperty "true"` on a property of the query capability's
declared `oslc:resourceShape` — or clients are left in the same gap.

**Consequence for a client.** Membership cannot be assumed from a predicate list, and cannot be
discovered from the shape either. Take it structurally: whatever
the container — the query base, or an `oslc:ResponseInfo` node — points at, minus the predicates that
describe the container itself (`rdf:type`, `oslc:totalCount`, `oslc:nextPage`, `oslc:serviceProvider`,
`oslc:instanceShape`, `dcterms:title`, …). A short exclusion list beats a membership allow-list,
because a domain predicate nobody anticipated still counts.

This was diagnosed from a probe report that read *"0 member(s) returned with no parameters"* for all
fifteen ETM query capabilities, which then made every filter case `inconclusive` for want of a
baseline. The project area was never empty. `probe_oslc` now reads membership structurally.

The MCP `query_resources` tool is unaffected: it returns the response document as it came, so a
client sees all thirty results whatever predicate links them.

### 14. ETM refuses a query with trailing whitespace, and says nothing useful about why

Observed 2026-08-24 against ETM at `trs-filter.smartfacts.com/qm`, project area
`JKE Banking (Quality Management)`.

A clause with one trailing space is rejected outright:

| Request | Result |
|---|---|
| `?oslc.where=dcterms:title="Verify dividend transfer frequency"` | **200**, 1 member |
| `?oslc.where=dcterms:title="Verify dividend transfer frequency" ` (trailing space, sent as `%20`) | **400** `AQXCM5002E` |

This is stricter than the OSLC query grammar requires, and it is the kind of input a client produces
by accident: a filter concatenated from parts, read from a configuration file or a text box, or
emitted by a model that ends a clause with a space. A **browser hides it** — pasting into the address
bar trims trailing whitespace — so the same URL "works in the browser and fails in Postman", which
sends the URL byte for byte.

**The error is no help.** `AQXCM5002E The query was not run for this query URL: <url>` gives no
position, no offending token, and no distinction between causes. The identical code and wording
answers a whitespace problem *and* a missing-filter one:

- `…/com.ibm.rqm.planning.TestCase` with **no** `oslc.where` → **400 `AQXCM5002E`**. That base
  requires a filter.
- `…/com.ibm.rqm.planning.VersionedTestCase` with no filter → **200**, all 30 members.

So two query bases for the same concept differ in whether an unfiltered query is legal, and the error
that tells you so is the same one you get for a stray space. Diagnose by comparing against a
known-good request rather than by reading the message.

**For a client:** trim a filter before sending it, and treat `AQXCM5002E` as "compare with something
that works", not as "the filter is wrong".

### 15. DOORS Next predefines no prefixes — a query must declare every one it uses

Observed 2026-08-24 against DOORS Next at `trs-filter.smartfacts.com/rm`, project area
`__NJbYJvgEfG3vp8mqSmZVg`.

`oslc.select=dcterms:title` on the requirement query base answers:

```
400 Bad Request
err:detailedMessage  Error when converting: oslc.query=true&oslc.select=dcterms:title
                     java.lang.RuntimeException: Undefined namespace prefix: dcterms
```

Not even `dcterms` is predefined. Declare the prefixes and everything works — measured on the same
base:

| Query | Result |
|---|---|
| bare | **582** members |
| `oslc.prefix=dcterms=<…>&oslc.select=dcterms:title` | **582** |
| `…&oslc.where=rdf:type=<oslc_rm:Requirement>` | **570** |
| `…&oslc.where=rdf:type=<oslc_rm:RequirementCollection>` | **12** |
| `oslc.pageSize=3` | 3, titles returned |

570 + 12 = 582, so the type filter is genuinely applied rather than accepted and ignored.

**Only one of its eight query capabilities is OSLC RM domain data.** The other seven query DOORS
Next's own metadata and several answer `403`:

| Capability | `oslc:resourceType` | |
|---|---|---|
| Query Capability | `Requirement`, `RequirementCollection` | the domain query — 582 artifacts |
| View, ReqIFDefinition, AttributeDefinition, AttributeType, LinkType, folder, ArtifactType | DNG-internal | administration/metadata, not RM resources |

So a `403` from most DOORS Next query capabilities is not a query defect — those capabilities are not
querying requirements at all. Note also that **no** DNG capability declares an `oslc:resourceShape`,
so unlike ETM (quirk 13) `QUERY-13` applies and `rdfs:member` is required — DNG uses it, and is
conformant on the point ETM sits in a gap on.

**For a client:** never assume a prefix is predefined. Declare every prefix a clause uses, on every
request. `probe_oslc` now does: prefix discovery runs first and undeclared, and where the server
predefines nothing the remaining cases declare prefixes explicitly. Before that, DOORS Next recorded
`select: NO` and `where: NO` for a missing declaration rather than for missing support — the probe had
already discovered the fact and then failed to act on it.

### 16. POST-query support varies by application, and an empty POST body proves nothing

Measured 2026-08-24 across the three applications of one deployment, sending `oslc.pageSize=1` by
both methods:

| Application | POST-form query | |
|---|---|---|
| **ETM** (`/qm`) | **accepted** | 200, results returned |
| **DOORS Next** (`/rm`) | **accepted** | 200, results returned |
| **EWM** (`/ccm`) | **refused** | 415 — `Content type 'application/x-www-form-urlencoded' is not supported.` on every body tried |

So POST-query cannot be assumed from the product, only from the application. On EWM, `oslc.where` and
`oslc.select` are bounded by URL length; on ETM and DOORS Next they are not.

**The measurement trap, which cost us a wrong answer for two of the three.** An empty form body is
not an OSLC query. ETM answers **415** to `POST` with no parameters and **200** to the same POST
carrying `oslc.where`/`oslc.select`; DOORS Next answers **403** to the empty one and **200** to a real
one. A method comparison that posts an empty body therefore reports POST-query as unsupported on
servers that support it — and worse, a client that then falls back to GET tells its user that queries
are capped by URL length when they are not.

The converse also matters: an **unparameterised** query must go as GET even where POST works. There
is nothing to put in the body, and the servers refuse an empty one — so requesting the unfiltered
baseline by POST because POST is supported returns 415 and an empty baseline.

## Still unknown

- **DOORS Next generates far fewer create tools than it has creation factories** — 12 factories yielded 2 shapes and 2 tools in testing. Undiagnosed. Most DNG types consequently have no `create_*` tool.
- **Whether create, update and delete actually work.** `list_resource_types` and unfiltered query are confirmed against all applications that support them; the write path has not been exercised.
- **Whether the query results in quirk 6 survive a clean test** — non-configuration-enabled project areas, a supplied `Configuration-Context` where one applies, and `oslc.prefix` declared. Until then that section records symptoms, not causes.
- **Configuration-context behavior** — whether a request against a configuration-enabled project area fails without a `Configuration-Context`, or silently resolves against a default. The second would be worse.
- ~~**Whether creation factories enforce their advertised shapes**~~ — **answered: yes, and more strictly than the shape reads.** EWM enforces exactly what its shape declares required (`title`, `filedAgainst`), and additionally rejects one of that property's own advertised allowed values (`Unassigned`). See quirk 12. Which properties are genuinely *writable* remains open.

---

## Specifications cited

- **OSLC Query 3.0** — [docs.oasis-open-projects.org/oslc-op/query/v3.0/os/oslc-query.html][query30].
  `QUERY-12` (container SHOULD be an LDPC), `QUERY-13` (`rdfs:member` required absent a declared
  query shape), `QUERY-14` (a declared `oslc:isMemberProperty` may replace it) — quirk 13.
- **OSLC Quality Management 2.0** — [archive.open-services.net/bin/view/Main/QmSpecificationV2][qm20].
  Silent on membership predicates; normative only on representations — quirk 13.
- **OSLC Core 2.0 / 3.0** — `dcterms:identifier` and the other server-assigned properties are
  read-only and provider-assigned, which is why a client-supplied identifier is correctly discarded
  (quirk 12), and why Turtle is optional where RDF/XML is not.

[query30]: https://docs.oasis-open-projects.org/oslc-op/query/v3.0/os/oslc-query.html
[qm20]: https://archive.open-services.net/bin/view/Main/QmSpecificationV2.html

---

*Corrections and additions welcome — particularly from anyone who has diagnosed the DOORS Next tool-generation gap, or mapped ELM's configuration-management APIs more successfully.*
