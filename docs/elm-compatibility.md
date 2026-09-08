# Using `oslc-mcp-server` with IBM ELM

Findings from running `oslc-mcp-server` against an **IBM ELM 7.1 SR1** deployment — DOORS Next (`/rm`), ETM (`/qm`) and EWM (`/ccm`) — in August 2026, and against **Rhapsody Systems Engineering** (`restapi 1.88.3-release18.4`) in September 2026, the latter through a staging run that created 22 model elements with documentation and a three-level containment hierarchy.

Quirks 1–22 cover DOORS Next, ETM and EWM. **RSE is a different shape of server** and has [its own section](#rhapsody-systems-engineering-rse) with quirks 23–38 — it presents two APIs over one model, authenticates with a pre-issued token, and hides its element-creation semantics behind two validation errors that both point the wrong way.

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
`oslc.orderBy` **varies by capability rather than by application** — see quirk 19, which measures it
per query base and supersedes the summary here.

> **Correction, 2026-08-25.** An earlier version of this caveat said these were taken against
> **configuration-enabled** project areas without supplying a `Configuration-Context`, and treated the
> missing context as a likely cause. That was wrong: **no project area on the deployment is
> configuration-enabled**. There was no context to supply and none missing, so the configuration
> confound never existed.
>
> What remained was the undeclared **`oslc.prefix`** (quirk 15), and that alone accounted for the
> DOORS Next results: with prefixes declared, `oslc.where` and `oslc.select` both work and the type
> filter is genuinely applied (570 + 12 = 582). So the measurements above are cleaner than they were
> recorded as being — the cause was ours, not the product's, and not the configuration.
>
> Worth keeping as a lesson in its own right: **an unverified assumption about the environment
> outlived the defect it was invented to explain.** It was recorded as a caveat, repeated, and would
> have sent the next reader looking for a configuration problem that was never there.

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

### 17. The write path: one status code, four causes, and only the body tells them apart

Measured 2026-08-25 across all three applications, as the first exercise of the write path.

**All three applications support the full cycle**, once the account is licensed and permitted:

| Application | create | read | update | delete | after delete |
|---|---|---|---|---|---|
| **EWM** (`/ccm`) | **201** — `filedAgainst` required | 200 | 200 | **204** | `404` |
| **DOORS Next** (`/rm`) | **201** | 200 | 200 | **200** | `410 Gone` |
| **ETM** (`/qm`) | **201** | 200 | 200 | **200** | `404` |

Note the delete responses differ in every detail — `204` versus `200`, and `410` versus `404` on the
subsequent read. All are defensible; none is predictable. **Treat any 2xx as success and any of
404/410 as gone**, rather than matching an exact code.

**Getting there took two rounds, and the first is the instructive one.** Before an administrator
assigned licences and a delete permission, the same requests produced **four different causes behind
one status code** in a single session, and nothing in the status distinguishes
them. Each was identifiable only by reading the response body:

| Attempt | Body says |
|---|---|
| EWM create, no `filedAgainst` | `'Save Work Item' failed. Preconditions have not been met: The 'Filed Against' attribute needs to be set` |
| EWM create, `filedAgainst` = **`Unassigned`** | the same message — an advertised allowed value that behaves as *not set* |
| EWM delete, no CSRF header | `The user has the roles required to perform this operation, but the permission has been denied because this request might have been forged… add a new HTTP header with the name 'X-Jazz-CSRF-Prevent'` |
| EWM delete, **with** CSRF header | `CRJAZ6053E … you need these permissions: 'Delete a work item (delete)'` |
| DOORS Next create | `CRJAZ1848E To perform the "com.ibm.rrs.team.saveArtifact" operation, the user must have one of the following licenses…` |
| ETM create | `CRJAZ1848E … "Save Test Case" operation … must have one of the following licenses…` |

**The CSRF failure masked the real one.** EWM delete answers `403`-CSRF first; only once the header is
supplied does it answer `403`-permissions. A client that stops at the first `403` concludes the wrong
thing, and a client that reads only the status concludes nothing at all.

**`X-Jazz-CSRF-Prevent` is required for some mutating requests and not others.** EWM `POST` to a
creation factory succeeded with **no** CSRF header and no session cookie. EWM `DELETE` on the resource
it had just created refused without one. So CSRF enforcement varies **by operation**, not by
application — do not infer it from a successful create.

To supply it: establish a session, take the `JSESSIONID` cookie value, and send it as the header
value. It is a credential; keep it out of logs and transcripts.

**The error vocabulary differs by application, which defeats a single extraction.** ETM and EWM report
under `oslc:message`; DOORS Next reports under **`err:detailedMessage`**
(`http://jazz.net/xmlns/prod/jazz/foundation/1.0/`) and emits no `oslc:message` at all. A client
looking only for `oslc:message` sees a `403` with an empty body from DOORS Next and has nothing to
report — which is exactly what happened here before the second vocabulary was tried. **Read both.**

**Licensing presents as `403`, wraps an upstream `400`, and names what is missing.** DOORS Next
returned `CRRRS6254E … Status=400. Message: CRJAZ1848E`, listing the licences that would satisfy it
(*ELM Base.Practitioner*, *ETM Quality Professional*, *DOORS Next Analyst*) and the user it checked.
This is not a defect and not a client problem: it is an administrative assignment, and it is
**invisible to discovery** — the creation factories are advertised, the shapes fetch, the `create_*`
tools generate, and every one of them fails at POST.

**What this means for anyone planning to write.** Read capability is no evidence of write capability:
against this deployment, every application could be read and browsed, every creation factory
advertised, every shape fetched and every `create_*` tool generated — while two of the three refused
every POST. The licences were assigned in minutes once asked for; the cost was the day spent assuming
the client was at fault.

So **establish the write path per application before planning work that depends on it**, with one
resource of each type rather than a batch, and read the whole error body rather than the status.

### 18. EWM accepts a work-item state on create and silently discards it

Measured 2026-08-25 against EWM, project area `JKE Banking (Change Management)`.

A `POST` to the Defect creation factory carrying `oslc_cm:status "Resolved"` answers **201 Created**.
Reading the resource back gives `oslc_cm:status "New"` and
`rtc_cm:state …defectWorkflow.state.s1` — the workflow's initial state. The same substitution by
`PUT` answers **200** and changes nothing. No error, no warning, in either direction.

**The shape does say so**, and this is the useful part: both state properties are declared
`oslc:readOnly true` —

| Property | `dcterms:title` | |
|---|---|---|
| `oslc_cm:status` | **State** | `Zero-or-one`, `readOnly true` |
| `rtc_cm:state` | **Status** | `Zero-or-one`, `readOnly true` |

So a client that reads `oslc:readOnly` knows not to send it. A client that does send it gets a `2xx`
and a resource that does not say what it asked for — **the create-side analogue of the ignored query
filter**, and just as invisible without reading back.

*(Note the titles: `oslc_cm:status` is titled "State" and `rtc_cm:state` is titled "Status". Match on
the property definition, never on the title.)*

**Writing the state property is not how it is done — but the state *is* reachable over OSLC**, by
naming a workflow transition with `?_action=` on the `PUT`. See quirk 22, which supersedes the
conclusion this paragraph originally drew. Anything planning to author work items in
a particular state should expect them all to land in the workflow's initial state, and decide whether
that matters before authoring rather than after.

**The general rule this argues for:** `oslc:readOnly` is worth honouring even though nothing enforces
it at the protocol level, because a server is free to accept the value and drop it. And a create
should be read back and compared against what was sent — for exactly the properties that were sent,
since the response is otherwise a legitimate superset (quirk 17).

**Open, and worth exploring — how the UI does it.** The EWM web UI *can* change a work item's
lifecycle state, so some route exists. The working hypothesis is that it writes `rtc_cm:state` and the
server derives `oslc_cm:status` from it, which fits what the two properties look like: `rtc_cm:state`
carries a workflow-state **resource** that identifies the state, while `oslc_cm:status` carries a
provider-defined **string** that reads as its label. `oslc_cm:status` is defined in OSLC CM 2.0, but
plausibly retained from 1.0 rather than introduced there — which would put it alongside the other
1.0-era shapes EWM keeps for backward compatibility (quirk 10).

Not yet investigated. The route is to change a state in the web UI with the browser's network
inspector open and see what is actually sent — the endpoint, the verb, and whether it is OSLC at all
or one of EWM's own workflow-action APIs. If it turns out to be reachable, setting lifecycle state
would be a **desirable** capability for an MCP client, though nothing currently depends on it.

### 19. Query support measured per capability, and it varies *within* an application

Measured 2026-08-25 across all 25 query capabilities of the three applications, with a type-matched
fixture where a creation factory made what the capability queries, and sampled ground truth otherwise.

| | ETM (15 capabilities) | DOORS Next (8) | EWM (2) |
|---|---|---|---|
| POST-query | **15 yes** | 1 yes, 7 no | **2 no** (415) |
| `oslc.select` | **15 yes** | 3 yes, 4 no | **2 yes** |
| `oslc.where` by identity | 10 yes, 5 inconclusive | 8 inconclusive | **2 yes** |
| negation pair | 10 yes, 5 inconclusive | 8 inconclusive | 1 yes |
| `oslc.paging` | 9 yes, 6 inconclusive | 1 ignored, 7 inconclusive | 1 yes |
| `oslc.orderBy` | 2 yes, 6 **ignored**, 2 no, 5 inconclusive | 8 inconclusive | 1 yes, 1 **ignored** |
| `oslc.searchTerms` | **9 no**, 6 inconclusive | 8 inconclusive | 1 no |

**The headline: `oslc.orderBy` is not an application-level property.** An earlier version of quirk 6
recorded it as "honoured by DOORS Next and ignored by EWM and ETM". Measured per capability that is
wrong in both directions: within ETM, two capabilities honour it, six accept and **ignore** it, and
two refuse it outright; within EWM, one capability honours it and the other ignores it. **Ask per
query base, not per product** — and treat `ignored` as the answer you are most likely to get, since it
is the one that returns `200`.

**ETM is the strongest OSLC query implementation of the three here**, which inverts the impression
left by the first probe run. It accepts POST-query on every capability, honours `oslc.select`
everywhere, and applies `oslc.where` wherever the sampled content could distinguish a value. The
earlier "ETM advertised no query capabilities" and the wall of `inconclusive` after it were both
artifacts on our side — a stale service-provider URI, then a probe that created one fixture and
measured every capability against it (quirk 13, and the note below).

**DOORS Next's numbers read worse than they are.** Seven of its eight capabilities are administrative
— ReqIF definitions, attribute definitions, link types, folders — and several answer `403` to a query
at all. Only `Query Capability` queries requirements, and it is the one that reports POST-query and
`oslc.select` working. Read the DNG row as "one domain capability, measured" plus seven that were
never RM data (quirk 15).

**`inconclusive` here means the ground truth could not distinguish anything**, not that the server
failed. Where a capability is sampled rather than fixtured, the probe reads the first few members by
URI; if they share every value there is nothing to filter on. Eleven capabilities reported
`no value identifies exactly one resource`, and that one shortage cascades into `where-identity`,
the negation pair, the `where` constructs and prefix discovery. A deeper or better-spread sample would
settle most of them.

> **One verdict in the run behind this table is known wrong and has been fixed since.** EWM's negation
> pair recorded `NO — 95 resource(s) were returned that the unfiltered query did not`. The unfiltered
> baseline was a single page of a larger collection, so the two halves legitimately returned resources
> it never listed, and the partition test read that as a failure. It now reports `inconclusive` and
> says the baseline was paged. **A working filter was one step from being published as a product
> defect** — which is why the probe's own results are worth suspecting before a server's.

### 20. `oslc:readOnly` is unreliable in both directions on EWM

Measured 2026-08-28 against EWM, project area `Acme AEB-200 (Change Management)`.

Two properties, both declared `oslc:readOnly true` on the same work-item shape, behave oppositely:

| Property | Declared | Write attempt | Effect |
|---|---|---|---|
| `oslc_cm:status` | `readOnly true` | `PUT` answers **200** | **Discarded.** The state does not change (quirk 18) |
| `oslc_cm:relatedArchitectureElement` | `readOnly true` | `PUT` answers **200** | **Applied.** The link is present on read-back |

So `readOnly` predicts nothing on its own here: honouring it loses a link that would have been
written, and ignoring it silently loses a state that would not. Both answer `200`.

**The only reliable test is the read-back.** Write it, read it, and compare — for the property you
sent. That is the same rule as for an ignored query parameter, applied to the write path: a `2xx` is
not evidence that anything happened, and neither is the shape's own declaration.

**Practically:** treat `oslc:readOnly` as a *hint that the write may not take*, not as a prohibition
and not as a guarantee. Where a property matters, verify it. Where a client generates a form or a
tool schema from a shape, `readOnly` is still the right thing to honour — but a client staging data
should check rather than assume.

**A second thing this exposed.** Writing `relatedArchitectureElement` causes EWM to **embed the target
resource** in the work item's own representation. A client reading `dcterms:title` from the first
matching element then reads the *target's* title, not the work item's. Match on the subject's
`rdf:about`, as with ETM's test plans (quirk 19's note on embedded sub-resources).

### 21. Enabling configuration management moves incoming links out of the resource

On a **non-configuration-enabled** project area, a cross-application link is stored in both
directions: writing `oslc_cm:implementsRequirement` from an EWM work item to a DOORS Next requirement
leaves a **backlink in DOORS Next**, readable straight off the requirement's own representation.

**Enable configuration management and those stored backlinks are dropped.** The forward link remains
on the EWM work item; the incoming direction is no longer in the DOORS Next resource at all, and is
reached instead by querying **LQE** (the Lifecycle Query Engine).

This is a sound design — under configuration management a backlink would have to be version- and
stream-scoped, and an incoming link is a *question about a configuration* rather than a fact about a
resource — but it has a sharp consequence for any client.

**A client that queries links is unaffected.** Ask for the incoming direction — through LQE or a link
index — and the answer is the same before and after; only where it is stored has changed. This is not
a capability being withdrawn.

**What breaks is reading an incoming link off the target's representation.** That works on a
non-configuration-enabled project area, because the backlink happens to be stored there, and returns
**nothing** on a configuration-enabled one. No error, no warning: the requirement simply appears to
have no incoming links. That is the same failure shape as an ignored query filter — a correct-looking
answer that is wrong.

**So do not read incoming links off the resource.** Ask LQE, or a link index, from the start. A client
that does this from the beginning behaves identically before and after configuration management is
enabled; one that reads the representation has a latent failure that surfaces on the day someone
turns configurations on — long after the code was written and tested.

**Verification that counts incoming links is affected too.** A check that passes today against a
non-configuration-enabled project area will pass for the wrong reason and then fail silently later.
Verify through the same query path the eventual client will use.

### 22. Work-item state *is* settable over OSLC — by naming the transition, not the state

Measured 2026-08-28 against EWM, project area `Acme AEB-200 (Change Management)`.

Quirk 18 records that writing `oslc_cm:status` is accepted and discarded, and concluded that reaching
a non-initial state means EWM's own APIs, outside OSLC. **The first half is right and the conclusion
is wrong.** State is reachable through the ordinary OSLC endpoint:

```
PUT  <workItemURI>?_action=<workflowActionId>
     Content-Type: application/rdf+xml
     If-Match: <etag>
     X-Jazz-CSRF-Prevent: <JSESSIONID>
     <the resource's own representation, unchanged>
```

**Name a transition, never a destination.** That is why writing `status` cannot work: a state is a
*destination*, and the workflow decides which are reachable from where. `?_action=` names an edge in
the state machine and lets the server compute the target. EWM does **not** validate that the item's
properties suit the new state — that is the caller's judgement, exactly as in the UI.

**This is not OSLC Actions.** The [Actions specification][actions] describes `oslc:action` on the
resource with `oslc:binding` per action; EWM advertises neither, on the resource or the service
provider. `?_action=` is a Jazz convention layered on the OSLC `PUT`.

#### Discovering the action ids

Three steps, all OSLC, no hard-coding:

1. Read the work item's `oslc:instanceShape`.
2. On that shape, find `rtc_cm:state` and follow its `oslc:allowedValues`. Each value URI has the form
   `…/oslc/workflows/{projectAreaId}/states/{workflowId}/{stateId}` — **the workflow id is in the
   path**.
3. `GET …/oslc/workflows/{projectAreaId}/actions/{workflowId}` for that workflow's actions.

Measured on one project area:

| Work-item type | Workflow | Actions | Closes with |
|---|---|---|---|
| Task | `taskWorkflow` | 6 | **`complete`** → `Done` |
| Defect | `defectWorkflow` | 8 | **`resolve`** → `Done` |
| Capability | `capabilityWorkflow` | 12 | **`accept`** → `Accepted`, and only from `Releasing` |

**A workflow may need several transitions to reach a closed state.** Capability took eight from
`Draft`: `analyze → ready → approve → implement → validate → deploy → release → accept`. There is no
shortcut; each is a separate `PUT`.

#### The trap: an unavailable transition answers 200 and does nothing

Sending `?_action=…accept` while the item is in `Approved` — where `accept` is not available —
returned **`200`** and left the state untouched. No error, no message. This is the same silent-success
shape as an ignored query parameter, and it is easy to build a "close all these items" loop that
reports success while changing nothing.

**So verify the transition took**, and verify it on **`oslc_cm:closed`**, not on the status string:
closure reads `Done` for Task and Defect but `Accepted` for Capability, and the Capability workflow has
no `Done` state at all. `oslc_cm:closed` is the boolean that means the same thing across every
workflow.

[actions]: https://docs.oasis-open-projects.org/oslc-op/actions/v1.0/

---

## Rhapsody Systems Engineering (RSE)

Findings from an **RSE `restapi 1.88.3-release18.4`** deployment (`GET ${rse}/api/about` reports the
version), September 2026. RSE replaces the Rhapsody Model Manager / Design Manager role in an ELM
lifecycle: it holds SysML v2 models in its own repository with its own configurations, rather than
storing model files in EWM SCM.

RSE is a **different shape of server** from DOORS Next, ETM and EWM, and the difference is the first
thing to internalise: it presents **two APIs over one model**.

| | SysML v2 services API | OSLC Architecture Management |
|---|---|---|
| Base | `${rse}/api/projects/…` | `${rse}/api/oslc_am/…` |
| Representation | plain JSON (OMG abstract syntax) | RDF — RDF/XML, Turtle, JSON-LD |
| Standard | OMG *Systems Modeling API and Services* | OSLC Core 2.0 + AM 2.0 |
| Read | full model graph, commit-scoped | thin OSLC resource view |
| **Create** | **yes** — `POST /commits`, no `identity`; any metaclass (quirk 28) | yes, creation factory, but a metaclass allow-list applies (quirk 30) |
| **Update** | yes, via `POST /commits`; produces a commit | yes, `PUT`, whole-resource only |
| Links | none | `jazz_am` link predicates |
| Documentation bodies | yes | no — see quirk 26 |

**Author through `POST /commits`.** It creates, updates and deletes any metaclass, produces real
version history, and its elements are OSLC AM resources anyway — so the AM factory is a convenience
with fewer capabilities, not a necessary half of the story. The recipe is at the end of this section.

> **This corrects an earlier reading of this section.** It first concluded that creation was
> impossible through the SysML v2 API and that authoring therefore required both APIs together. That
> was wrong: a create omits `identity`, and nothing about the metamodel's complexity was the obstacle
> — a validation message was mistaken for a capability limit. The AEB-200 dataset was staged the long
> way round before this was understood, which is why quirks 29–31 describe factory behaviour in such
> detail. That detail still applies to anyone using the factory; it is no longer the recommended path.

---

### What works

| | |
|---|---|
| **Authentication** | A **pre-issued API token** sent as `Authorization: Bearer <token>`. The raw token with no `Bearer` prefix is also accepted. See quirk 25 — the challenge cannot be negotiated |
| **Catalog discovery** | `GET ${rse}/api/rootservices` — **unauthenticated (200)**, so discovery bootstraps before credentials |
| **Domains advertised** | `oslc_am:amServiceProviders` → `/api/oslc_am/catalog`, and `oslc_config:cmServiceProviders` → `/api/oslc_config/catalog` |
| **Service providers** | One AM service provider per RSE project: `/api/oslc_am/{projectId}/services.xml` |
| **Creation factory** | `/api/oslc_am/{projectId}/resource`, shape at `…/shape/creation` |
| **Query capability** | Same base URI as the factory, shape at `…/shape/query`; `jp:supportOSLCSimpleQuery` is `true` |
| **Dialogs** | Both selection and creation dialogs are published — delegated-UI link creation works |
| **Configurations** | A full OSLC Config implementation — an RSE project is an `oslc_config:Component`, a branch is a `Stream`, a tag is a `Baseline`. `jp:globalConfigurationAware` is `yes` on the **AM** provider, so an RSE project can contribute to a global configuration and GCM/CDCM can resolve versioned links through it. See *The OSLC Configuration Management surface* |
| **Content negotiation on GET** | Genuine: RDF/XML, Turtle, JSON-LD and JSON each return 200 with the matching `Content-Type` |
| **Full CRUD on AM resources** | `POST` to the factory, `GET`, `PUT`, `DELETE` — all verified |
| **Element create/update/delete** | `POST /commits`, any metaclass, real version history — the recommended authoring path (quirk 28) |
| **Project create/delete** | `POST`/`DELETE` `/api/projects` — 201 and 200. Unlike element deletion, project deletion is reliable, which makes a throwaway project the safe place to iterate |
| **Branch operations** | `POST /api/projects/{p}/branches` → 201, `DELETE` → 200 |

Link predicates offered by the AM creation shape, all `Zero-or-many` with `oslc:Resource` values, in
`http://jazz.net/ns/dm/linktypes#`: `derives`, `satisfy`, `refine`, `trace`,
`tracksArchitectureElement`, `realizesArchitectureElement`, `allocatesArchitectureElement`.

---

### 23. Discovery lives under `/api`, and the conventional path 404s

`GET ${rse}/rootservices` returns **404** — and not a useful one: it serves the web application's
HTML shell, so a client that does not check the content type will try to parse a Next.js page as RDF.
The document is at **`${rse}/api/rootservices`**.

For `oslc-mcp-server`'s `${baseUrl}/rootservices` convention this means **`baseUrl` must include
`/api`**:

```yaml
  - alias: rse
    baseUrl: https://rse.example.com/api      # not …/ , not the web root
```

`catalog-resolution.ts` already lists `http://open-services.net/ns/am#amServiceProviders`, which is
the predicate RSE publishes, so no catalog changes are needed. `oslc_config#cmServiceProviders` is
deliberately excluded there and should stay excluded — it is a configuration catalog, not a domain
catalog.

### 24. The AM namespace ships with a placeholder prefix name

The service provider's own `oslc:prefixDefinition` binds `http://jazz.net/ns/am#` to the prefix
**`newProductAcronym`**, and every response uses it:

```turtle
newProductAcronym:type "PartDefinition" ;
```

It is an unfinished rename that shipped. It is only a label — the namespace URI is correct and
stable — but **do not key anything off the prefix string**. Bind `http://jazz.net/ns/am#` to your own
prefix and ignore what the server calls it.

Note also that the shape's link predicates are in a *different* namespace,
`http://jazz.net/ns/dm/linktypes#`, which the same document binds to `jazz_am`. So `jazz_am:trace` is
a linktype and `jazz_am:type` — as most code will write it — is not; the latter is
`newProductAcronym:type` in RSE's own vocabulary. Two namespaces, easily conflated.

### 25. Authentication is a pre-issued token, and the challenge cannot be negotiated

An unauthenticated request answers:

```
HTTP/1.1 401
www-authenticate: OAuth realm="SysML"
```

Bare OAuth 1.0a, **with no `token_uri` parameter**. That defeats every rung of a conventional auth
ladder: JEE forms never triggers (no `authrequired` message), a JAS bearer flow skips (it needs
`token_uri=` in the challenge), Basic auth answers 401 — confirmed with valid-username/wrong-password —
and interactive SSO has nowhere to go.

The working scheme is a token issued out of band and presented on every request:

```
Authorization: Bearer <token>
```

Two consequences for a client:

- **A token must be configured, not acquired.** There is no credential exchange to implement.
- **A 401 must be terminal when a token is configured.** Letting it fall into a negotiation ladder
  produces a misleading cascade of failures for what is really "the token expired". The tokens
  observed carry a **24-hour** lifetime (`exp` = `iat` + 86400), so expiry mid-session is a routine
  event, not an edge case.

`rootservices` is readable without any credential, so discovery can start before the token is checked.

### 26. The AM resource shape is thin, and everything outside it is discarded silently

The complete set of properties RSE will store on an AM resource, from `…/shape/creation` and
`…/shape/resource`:

| Property | Occurs | Notes |
|---|---|---|
| `dcterms:title` | `Exactly-one` | `rdf:XMLLiteral` |
| `newProductAcronym:type` (`ns/am#type`) | `Exactly-one` | plain string, **no enumerated allowed values** |
| `oslc:shortTitle` | `Zero-or-one` | persists — the one spare text slot |
| `ns/am#owningRelatedElementId` | `Zero-or-one` | set by the server, see quirk 30 |
| the seven `linktypes#` predicates | `Zero-or-many` | |
| `dcterms:identifier`, `dcterms:modified`, `oslc:instanceShape`, `oslc:serviceProvider`, `rdf:type` | | server-assigned, resource shape only |

**There is no `dcterms:description`, in either shape.** Sending one returns **201 / 200** and the
property is simply absent from the read-back. The same is true of `rdfs:comment` and of any custom
predicate. This is the ELM silent-failure pattern again, on a different product: *accepted, no error,
nothing there.*

So **read every AM resource back and check the properties you sent are present.** A `201` is not
evidence that anything but `dcterms:title` and the type survived.

Descriptions are not lost, though — they belong in a SysML `Documentation` element, which is the
semantically correct home and is reachable through the other API. See the recipe below. Ideally IBM would map dcterms:description to the SysML Documentation element. as part of the OSLC representation transformation.

### 27. Writes require RDF/XML or Turtle — JSON-LD is read-only

`GET` honours four representations. **Write does not.**

| | RDF/XML | Turtle | JSON-LD / JSON |
|---|---|---|---|
| `POST` to creation factory | **201** | **201** | **500** |
| `PUT` an existing resource | **200** | **200** | **500** |
| `GET` | 200 | 200 | 200 |

The JSON-LD failure is at least loud, and the message is worth recognising because it does not
mention content types at all:

```
error creating OSLC Architecture Management resource -
Invalid request content: Missing OSLC Architecture Management resource
```

That reads like a malformed body. It is a rejected serialization.

**`PUT` cannot create.** A `PUT` to a resource URI that does not exist returns 500 and the URI stays
404 — there is no PUT-to-create. Creation is the factory, and only the factory.

### 28. All element writes go through `POST /commits` — and a create omits `identity` entirely

There are no element write endpoints. These are all **404, not 405** — absent rather than disallowed,
which matches IBM documenting element access as read-only:

```
PUT  /api/projects/{p}/elements/{id}
POST /api/projects/{p}/elements
PUT  /api/projects/{p}/commits/{c}/elements/{id}
POST /api/projects/{p}/commits/{c}/elements
PUT  /api/projects/{p}/branches/{b}/elements/{id}
```

The one write door is `POST /api/projects/{p}/commits?branchId={b}`, and it does **create, update and
delete** — the standard `DataVersion` semantics of the OMG *Systems Modeling API and Services*, which
RSE implements faithfully. The three forms differ only in `identity`:

| Operation | `identity` | `payload` |
|---|---|---|
| **create** | **omitted entirely** | the new element |
| **update** | `{"@id": "<existing id>"}` | the changed properties, with `@id` |
| **delete** | `{"@id": "<existing id>"}` | `null` |

```json
{ "@type": "Commit",
  "change": [ { "@type": "DataVersion",
                "payload": { "@type": "PartDefinition",
                             "declaredName": "Sensor Fusion",
                             "declaredShortName": "CMP-SF" } } ] }
```

→ **201**, a new `Commit`, the branch head advances, and the element is real.

> **⚠ The trap, and it is a costly one.** Sending `identity` as an *empty object* is rejected with
> `"change[0].identity.@id" is required`, which reads like "identity is mandatory". Supplying a
> freshly generated UUID there is then treated as an **update** to an element that does not exist:
>
> ```
> error when merging commits - this commit contains an element in the "update" array that
> does not exist for this configuration. elementId: "<the id you just generated>"
> ```
>
> Both errors point away from the answer, which is to omit the key. Nine payload variants were tried
> before the OMG API Cookbook's
> [`Element_Create_Update_Delete.ipynb`][cookbook] settled it. **When this API's semantics are
> unclear, read the cookbook rather than inferring from error messages** — they describe what the
> validator wanted, not what the operation needs.

**Everything is creatable this way.** Unlike the OSLC AM creation factory, which enforces a
metaclass allow-list (quirk 30), `POST /commits` accepts any metaclass — including the specialised
memberships that a connected architecture requires and the factory refuses:
`FeatureMembership`, `EndFeatureMembership`, `PortUsage` with a `direction`. **A client that needs to
build real SysML structure should create through commits and ignore the factory entirely.**

**Commit-created elements are still OSLC AM resources.** They appear in the AM query base with the
right `newProductAcronym:type` and are linkable with the `linktypes#` predicates, so choosing the
commit route costs nothing on the OSLC side. Memberships are correctly *not* exposed as AM resources
— they are model mechanics rather than architecture resources.

Mechanics worth knowing:

- **`name` is accepted and silently ignored.** The cookbook's examples use `"name"`; RSE stores
  nothing and the element reads back with `declaredName: ""`. Use **`declaredName`**, and
  `declaredShortName` for a short name. This is a conformance gap against the cookbook and worth
  reporting.
- On an update, the `elementId` is taken from **`payload.@id`** (or `payload.elementId`), not from
  `identity.@id`. Both are validated; only the payload's is used.
- **`previousCommit` and `owningProject` are rejected** in the commit body —
  `"previousCommit" is not allowed` — even though the cookbook sends `previousCommit`. Use the
  `?branchId=` query parameter instead.
- **Derived properties are rejected**, not ignored. Setting `documentation` on an element, or
  `annotatedElement` on a `Documentation`, fails validation. Express them through containment
  (quirk 30).
- Batch aggressively: `change` takes many `DataVersion` entries, so a whole subgraph — element,
  its `Documentation`, and the membership joining them — commits atomically in one call.

[cookbook]: https://github.com/Systems-Modeling/SysML-v2-API-Cookbook

### 29. An AM-created element is real, but invisible to commit-scoped reads until a commit touches it

This one cost the most time to understand, and produced a wrong conclusion on the way.

Create an element through the AM factory, then `GET` it through the SysML v2 API at the branch head.
The response is **200** with:

```json
{ "@type": "UnknownElement",
  "declaredName": "UnknownElement_<id>",
  "reason": "ERROR in getObjectByID = Error: Unable to find element with id = <id>" }
```

The natural reading — that AM creates produce something other than model content — is **wrong**. The
element exists in the configuration's *live* state; it is simply in no commit yet, and the SysML v2
API reads are commit-scoped. Note the tell in quirk 28's error text: *"does not exist for this
**configuration**"*, not "for this commit".

Send any `POST /commits` update naming that element and it succeeds, the branch head advances, and
the element then reads back as a fully typed, committed SysML element:

```json
{ "@type": "PartDefinition", "declaredName": "…", "projectId": "…" }
```

Two things follow. **`newProductAcronym:type` genuinely sets the SysML metaclass** — the element came
back as a `PartDefinition`, not a generic resource. And **content authored this way does land inside
RSE configurations**, so it can be baselined; it just needs one commit to get there.

The practical trap: a 200 carrying `@type: "UnknownElement"` is a *failed* lookup wearing a success
code. Check `@type` and `reason`, never the status.

### 30. Containment: the factory auto-parents to root, and memberships are re-pointed, not created

Every AM factory create silently makes an `OwningMembership` from the project's **root package** to
the new element, and reports it as `ns/am#owningRelatedElementId`. You do not choose the parent.

Building a real hierarchy therefore means moving elements after the fact, and the only way to do that
is to update the auto-created membership:

- **The factory cannot create a membership** — but `POST /commits` can (quirk 28), which is the way
  out of everything below. `newProductAcronym:type "OwningMembership"` through the factory returns
  **500** with `Property 'newProductAcronym:type' value 'OwningMembership' is not supported`;
  `FeatureMembership`, `EndFeatureMembership`, `ParameterMembership` and `ViewRenderingMembership` are
  refused the same way, while plain `Membership` is accepted. **This allow-list constrains the factory
  only.**
  `Annotation` and `Comment`, despite also being relationship-ish, *are* accepted. **Check every
  metaclass you intend to use against the factory before planning around it.** Verified accepted:
  `PartDefinition`, `PartUsage`, `InterfaceDefinition`, `InterfaceUsage`, `PortUsage`, `Documentation`,
  `Comment`, `Annotation`.
- **You can re-point the one you were given** — `POST /commits` updates it.

**Re-parenting is four writes, not one**, and the last two are the ones that get missed:

1. the membership's `owningRelatedElement` → the new parent;
2. the membership's `ownedRelatedElement` → the child;
3. **add the membership to the new parent's `ownedRelationship`**;
4. **remove it from the old parent's `ownedRelationship`**.

Steps 3 and 4 are not derived (quirk 31), and the factory has *already* put every new membership in
the root package's list — so after a bulk re-parent the root still claims everything. In one staging
run of 22 elements the root package listed 57 relationships of which **36 were stale**, all pointing
at memberships that now belonged to other parents. Nothing errors; the model is simply wrong in a way
only a walk of both directions detects.

### 31. Derived and inverse properties do not recompute in the element `GET`

After re-pointing a membership so that element `X` owns element `D`, the membership reads correctly —
but `X` still reports:

```json
"ownedRelationship": [],
"documentation": null
```

The stored, authoritative direction is on the **relationship**, not on either end. This is the same
principle the OSLC side of a traceability graph obeys — the inverse is a query, not a stored triple —
but here it bites within a single API, on properties the OMG abstract syntax presents as if they were
plain fields.

**Write verification queries against the relationship elements**, not against an element's derived
lists, or they will report failures that are not real.

**And write the forward list anyway.** The consequence that cost the most time here: the *UI* reads the
forward `ownedRelationship`, so a membership whose two ends are correct but which no parent lists is
invisible on screen while reading back perfectly through the API. That is how 22 correct-looking
descriptions can be staged and none of them appear. Set both directions, always, and verify both.

### 32. Smaller sharp edges

- **No `ETag` is served** on AM resources, and `PUT` succeeds with an absent *or empty* `If-Match`.
  There is no optimistic concurrency control to rely on. A client that sets `If-Match` unconditionally
  from an empty string happens to work — by luck, not contract.
- **Validation errors arrive as `500`**, not `400`, on the SysML v2 side. The body is informative;
  the status is not.
- **A `PUT` carrying non-shape predicates can strand a resource permanently.** After one `PUT`
  including `rdfs:comment` and a custom predicate, `DELETE` returned
  `500 "A sysml-server internal error has occurred"` on every subsequent attempt, including after a
  repair `PUT` restoring shape-only properties. A resource created and left alone deletes cleanly
  (200, then 404). **Send only shape properties** — quirk 26 says they are dropped, and this says the
  dropping is not free.
- **A fresh RSE project is not empty.** A newly created project already carries a root `Package`, six
  `ViewUsage` elements, library `NamespaceImport`s and assorted stubs — 27 AM resources / 35 SysML
  elements in the one observed. Any "expect *N* resources" verification must account for the
  boilerplate or filter by title.
- **A branch is what the UI calls a configuration.** The `?configuration={uuid}` parameter in an RSE
  project URL is a branch id.
- **The OSLC Query API of the SysML v2 spec is absent.** `/api/projects/{p}/queries` is 404 on both
  `GET` and `POST`. Page `…/elements` or use the OSLC AM query capability instead.

---

### The OSLC Configuration Management surface

RSE implements OSLC Config properly, and this is the most encouraging part of the product's OSLC
story — it means **GCM and CDCM can consume RSE local configurations and use them to resolve versioned
links**, and a global baseline can be staged and committed by delegating to RSE as a contributor
rather than by any RSE-specific mechanism.

The mapping onto RSE's own vocabulary:

| RSE concept | OSLC Config resource | URI |
|---|---|---|
| project | `oslc_config:Component` | `/api/oslc_config/component/{projectId}` |
| branch (the `?configuration=` parameter) | `oslc_config:Stream` | `/api/oslc_config/{projectId}/stream/{branchId}` |
| tag | `oslc_config:Baseline` | `/api/oslc_config/{projectId}/baseline/{tagId}` |

A `Stream` reads back as both `oslc_config:Configuration` and `oslc_config:Stream`, and carries
`oslc_config:component`, `oslc_config:baselines`, `process:projectArea` and a title — everything a
global configuration needs from a contribution.

The service provider is **server-wide, not per project**: one `/api/oslc_config/services.xml` for the
whole deployment, publishing creation factories for `Component`, `Stream` and `Baseline`, a query
capability for each, and a **configuration selection dialog** typed for `Baseline`, `Stream` and
`Configuration` — which is the delegated UI a global configuration editor uses to pick a contribution.

The baseline creation shape is small and, notably, **does** allow a description where AM resources do
not (quirk 26):

| Property | Occurs |
|---|---|
| `dcterms:title` | `Zero-or-one` |
| `dcterms:description` | `Zero-or-one` |
| `oslc_config:component` | `Exactly-one` |
| `oslc_config:baselineOfStream` | `Zero-or-many` |

**Do not misread `jp:globalConfigurationAware`.** The *config* service provider declares `no`; the
*AM* service provider declares `yes`. That is the normal arrangement — the flag answers "does this
domain provider participate in global configurations", and the configuration provider is the thing
being contributed, not a contributor. A client that checks the wrong one concludes RSE cannot take
part.

### 33. The config query bases require `oslc.where`, and say so with a 500

`GET /api/oslc_config/component` works and lists every project. Its siblings do not:

| Query base | Bare `GET` |
|---|---|
| `…/oslc_config/component` | **200**, `oslc:totalCount` and members |
| `…/oslc_config/stream` | **500** `Input validation error: "oslc.where" is required` |
| `…/oslc_config/baseline` | **500** `Input validation error: "oslc.where" is required` |

Three query capabilities are advertised identically and one behaves differently — the same pattern as
quirks 6 and 19 on the ELM applications, where advertised query capability says nothing about actual
query behaviour. **Measure each capability separately.**

Reaching a project's configurations does not need the query bases at all, and is more reliable:
`GET` the component, follow `oslc_config:configurations` to an LDP `BasicContainer`, and read
`ldp:contains`.

### 34. A fresh project advertises a baseline that does not exist

The configurations container of a newly created project lists two members — its stream, and a baseline
whose id is the project's **initial commit**:

```turtle
n0:configurations a oslc_config:Configurations, ldp:BasicContainer ;
    ldp:contains
        bas:bcd3f3a2-…,      # the initial commit id
        str:48243351-… .     # the default branch
```

The stream resolves. **The baseline does not:**

```
GET /api/oslc_config/{projectId}/baseline/bcd3f3a2-…
→ 404   <oslc:message>Tag not found</oslc:message>
```

The stream's own `oslc_config:baselines` container repeats the same phantom member. Consistent with
it, `GET /api/projects/{p}/tags` returns `[]` — there is genuinely no tag. An RSE baseline **is a
tag**, and a commit is not one, but the container is populated as though every commit were.

So a client enumerating a component's configurations must **tolerate a dangling member**. Fetch each
one and skip what 404s, rather than trusting the container. Worth knowing before concluding that a
project's baseline has been deleted or that permissions are wrong: on a fresh project this phantom is
the expected state, not a symptom.

---

### 35. The web UI works on a private branch, and the API does not know

This is the one to internalise before comparing anything you wrote with anything you see.

Opening a project in the RSE web UI puts the user on a **private branch**, created on the spot and
named `Private-01`, `Private-02`, …:

```
GET /api/projects/{p}/branches
  48243351…  main        isDefault=true   isPrivate=false
  53d0868f…  Private-01  isDefault=false  isPrivate=true
```

Edits made in the UI land there, not on `main`, and are promoted only by the UI's **Commit to main**.
Meanwhile an API client writing to `main` is invisible to that session. The two views diverge silently
and *completely plausibly* — each side sees a coherent model that simply lacks the other's changes.

Three practical consequences:

- **A UI edit produces no commit on `main` and no new AM resource.** Searching every element at
  `main`'s head for text typed into the UI returns nothing. That looks exactly like a failed save.
- **Confirming API-written content in the UI requires the user to be on a branch that has it** — either
  `main` before their private branch was cut, or after an explicit switch.
- **A private branch left holding uncommitted edits is a trap for later.** Discard it, or it may
  promote stale content over the top of staged work.

The private branch is also why the AM factory needs no branch parameter: it writes to the default
branch. There is no way to aim an AM create at a specific branch.

### 36. `DELETE` cascades in live state, and live state diverges from committed state

Quirk 29 established that AM-created elements sit in live state until a commit promotes them. The
reverse is worse.

Deleting an AM resource **also destroys whatever that resource owns, in live state only**. Deleting an
`Annotation` that owned a `Documentation` removed the `Documentation` too — while the committed state
at the branch head still contained both, and still contained the commits that had re-owned the
`Documentation` elsewhere. From that point the two stores disagreed permanently:

| | live (OSLC AM) | committed (SysML v2 at head) |
|---|---|---|
| the `Documentation` | gone — `GET` → 404 | present, with its body |
| the memberships that referenced it | gone | present |

A `POST /commits` update naming an element that live state has lost fails with the same
`UNKNOWN_ELEMENT` as an attempted create (quirk 28) — so **once the stores diverge, the committed copy
can no longer be repaired through the commit API**. There is no reconciliation operation.

### 37. One dangling reference returns 500 for the *entire* AM query base

The consequence of quirk 36, and it is disproportionate. After a cascade delete left the root package
listing a membership that no longer existed in live state:

```
GET /api/oslc_am/{project}/resource
→ 500   <oslc:message>A sysml-server internal error has occurred</oslc:message>
```

Not the affected resource — **every** resource. Individual `GET`s on unrelated resources still
returned 200, and the SysML v2 side was entirely healthy, so the failure looks like an outage of the
AM domain rather than one bad row. The query base stayed 500 until the dangling entry was removed from
the root package's `ownedRelationship` by a `POST /commits` update; it then returned 200 immediately.

**Diagnosis path**, since the error says nothing useful: walk the root package's `ownedRelationship`
and `GET` each member at the branch head. A dangling one comes back as `@type: "UnknownElement"` with a
`reason` (quirk 29's trap, used here as a tool). Remove those entries and the query base recovers.

Before staging content in bulk, it is worth confirming the query base answers 200 — a staging run that
begins against a broken one will fail confusingly on its first read.

### 38. Deletion is a trap at both ends, and elements become permanently undeletable

`DELETE` on a cleanly created, untouched AM resource works: 200, then 404. Beyond that:

- **Deleting an element still referenced by its parent's `ownedRelationship` strands the reference** and
  triggers quirk 37.
- **Detaching it from its parent first makes the `DELETE` itself fail** with 500. There is no ordering
  that is safe by construction; detach-then-delete and delete-then-repair both leave work to do.
- **Elements that have been through several commits stop being deletable at all.** Repeated `DELETE`
  returns `500 A sysml-server internal error has occurred` indefinitely, and a repair `PUT` restoring
  shape-only properties does not help. Two separate elements reached this state in testing, one after a
  `PUT` carrying non-shape predicates (quirk 32) and one after roughly a dozen commits. Both had to be
  removed through the web UI, which succeeded where the API could not.

The practical rule: **treat API-created RSE content as append-only.** Stage into a throwaway project
until the script is proven, keep the staging script idempotent so a partial run can be re-run rather
than unwound, and expect the web UI to be the cleanup tool of last resort.

---

### Recipe: creating a typed, documented, correctly-parented element

**One commit.** `POST /api/projects/{p}/commits?branchId={b}` with three `DataVersion` entries, none
carrying `identity`:

```json
{ "@type": "Commit",
  "description": "AEB-200: the fused object list interface",
  "change": [
    { "@type": "DataVersion",
      "payload": { "@type": "InterfaceDefinition",
                   "declaredName": "Fused Object List Interface",
                   "declaredShortName": "IFC-SF-TA" } },
    { "@type": "DataVersion",
      "payload": { "@type": "Documentation",
                   "body": "Carries the fused object list — tracks with position, …" } },
    { "@type": "DataVersion",
      "payload": { "@type": "OwningMembership", "visibility": "public" } }
  ] }
```

Read the new head's elements once to learn the three assigned ids, then a second commit wires them —
the membership's two ends, and the element's forward `ownedRelationship`:

```json
{ "@type": "Commit",
  "change": [
    { "@type": "DataVersion", "identity": { "@id": "<membership>" },
      "payload": { "@type": "OwningMembership", "@id": "<membership>", "visibility": "public",
                   "owningRelatedElement": { "@id": "<element>" },
                   "ownedRelatedElement": [ { "@id": "<documentation>" } ] } },
    { "@type": "DataVersion", "identity": { "@id": "<element>" },
      "payload": { "@type": "InterfaceDefinition", "@id": "<element>",
                   "declaredName": "Fused Object List Interface",
                   "declaredShortName": "IFC-SF-TA",
                   "ownedRelationship": [ { "@id": "<membership>" } ] } }
  ] }
```

**The structure RSE itself builds** for a description — read back from an element the UI had described,
which is the only reliable way to learn it:

```
Element.ownedRelationship ──> OwningMembership (visibility: "public")
                                ├─ owningRelatedElement ──> Element
                                └─ ownedRelatedElement  ──> Documentation { body }
```

No `Annotation` is involved. `Documentation.annotatedElement` is derived and cannot be written — it is
rejected both as an array (`Expected type "ElementRef" to be an object`) and as an object
(`wrong format of property annotatedElement`).

**Both directions are required.** Set the membership's ends and *not* the element's
`ownedRelationship`, and the description exists in the API, reads back perfectly, and is **invisible in
the UI** — the UI trusts the forward list (quirk 31). That is how 22 correct-looking descriptions can be
staged and none appear.

**Batch, and order by dependency.** `change` takes many entries, so a whole hierarchy can be created in
one commit and wired in a second. Only two round trips are needed regardless of size: create
everything, read the head once to map ids, wire everything.

**Wider structure** — ports, connected interfaces, typed usages — needs metaclasses the AM factory
refuses and `POST /commits` accepts:

| To express | Create |
|---|---|
| a port on a definition | `PortUsage` (with `direction`), owned via a `FeatureMembership` |
| a usage typed by a definition | `FeatureTyping` with `type` + `typedFeature`, owned by the usage via `owningRelatedElement` |
| an interface joining two ports | `InterfaceUsage` owning two `EndFeatureMembership`s, plus a `FeatureTyping` to the `InterfaceDefinition` |

RSE's own models use exactly these, and reading one is the fastest way to get the shape right:
`GET` an `InterfaceUsage` the UI built and walk its `ownedRelationship`.

#### If you use the AM creation factory instead

It works and it is simpler for flat content, at the cost of two limitations: the **metaclass
allow-list** (quirk 30) and **auto-parenting to the root package**, which every re-parent then has to
undo. The AEB-200 dataset was staged this way before commit-create was understood, in five phases:
create each element and its `Documentation` via the factory; one commit for names and bodies; read the
head to resolve the auto-created memberships; one commit re-pointing them; one commit setting every
forward list *and recomputing the root package's* — because the factory has already added all 44
memberships there, and a union leaves 36 stale.

Never replace the root package's list wholesale either: it carries the project's own boilerplate, and a
fresh project has 13 relationships holding six library imports, six views, and the `action1`/`state1`
stubs that back two of those views.

**Verify all three, on the relationships and not the elements:** the metaclass on each element, exactly
one `Documentation` with a non-empty `body` reachable through an owned membership, and containment
matching in *both* directions.

Links between AM resources are written on the AM side, in RDF, using the `linktypes#` predicates listed
at the end of *What works* above. `PUT` the whole resource — there is no partial update, so a link write
means `GET`, add the link, `PUT` back, sending **only** shape properties (quirk 32).

---

## Still unknown

### RSE

- ~~**Whether the RSE web UI renders elements created through the AM factory**~~ — **answered: yes, fully.** Verified on a 22-element staging run viewed on `main`: elements appear in the model browser with the correct icons, the properties panel reports the right metaclass (`Display element type: Part definition` / `Interface definition`), `declaredName` and `declaredShortName` round-trip, nesting displays to three levels, and **the Description field is populated from the `Documentation` body**. Documentation was the hard part and is what produced quirks 30, 31 and 35 — the structure in the recipe is what the UI itself builds. **Placing such an element on a diagram is still untested.**
- **Whether the UI will edit, and not merely display, API-created elements.** Not the same question: a UI edit lands on a private branch (quirk 35), so the round trip back to `main` has not been exercised.
- **Whether RSE supports importing SysML v2 textual notation** at all, and if so through what surface. No API endpoint for it exists (`/imports`, `/import`, `/textual` are all 404), and `Accept: text/plain` and `text/x-sysml` are ignored on read — the SysML v2 API returns JSON regardless. If the UI can import text, it is the only route to it.
- **Whether an RSE baseline captures content created via the AM factory but never committed.** Quirk 29 shows one `POST /commits` puts an element into history; what a baseline does with a live-but-uncommitted element is untested.
- **Whether the `TextualRepresentation` metaclass is usable for model content.** The instances observed all carried RSE's own Harmony/view `__settings` JSON, not SysML notation.
- ~~**Whether element creation is genuinely unimplemented or a defect**~~ — **answered: neither. It works.** A create omits `identity` entirely, per the OMG cookbook. See quirk 28, and the correction note at the head of this section.
- **Why `name` is accepted and silently ignored** where the OMG cookbook uses it. A conformance gap worth raising with IBM; `declaredName` is the working property.
- **Whether the live/committed divergence of quirk 36 is recoverable at all**, by any operation other than deleting the project. Nothing found so far reconciles the two stores.
- ~~**Whether the stranded-resource failure in quirk 32 is recoverable**~~ — **answered: through the web UI.** The API cannot delete such an element by any route tried, but deleting it in the model browser works. See quirk 38.

### DOORS Next, ETM, EWM

- **DOORS Next generates far fewer create tools than it has creation factories** — 12 factories yielded 2 shapes and 2 tools in testing. Undiagnosed. Most DNG types consequently have no `create_*` tool.
- ~~**Whether create, update and delete actually work.**~~ — **answered: yes, on all three applications.** See quirk 17. The first attempt failed on all but EWM, for reasons that were entirely administrative (licences, a delete permission) and entirely invisible to discovery.
- ~~**Whether the query results in quirk 6 survive a clean test**~~ — **answered.** The deployment has no configuration-enabled project areas, so that confound never existed; declaring `oslc.prefix` accounted for the DOORS Next results on its own. See the correction in quirk 6.
- **Configuration-context behavior** — whether a request against a configuration-enabled project area fails without a `Configuration-Context`, or silently resolves against a default. The second would be worse. **Not testable on this deployment yet:** no project area is configuration-enabled. Check it before bulk-creating content in one that is, not after.
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
