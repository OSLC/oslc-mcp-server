# `oslc-mcp-server` and IBM Engineering AI Hub 1.3

A capability comparison, written in August 2026. Both expose IBM ELM to MCP-speaking AI
assistants, and they arrive at it from opposite directions: **AI Hub ships tools built for
each ELM application; `oslc-mcp-server` derives its tools from what a server advertises
over OSLC.** That difference explains most of what follows, in both directions.

Written to be useful when choosing between them, so the gaps in this project are stated as
plainly as the gaps in the other.

## Sourcing, and what could not be verified

**`https://www.ibm.com/docs/en/engineering-ai-hub/1.3.0` returns HTTP 403 to automated
fetches**, as does the product announcement page. Everything about AI Hub below comes from
IBM's announcement summaries and the Jazz community articles listed at the end.

Consequently:

- **The AI Hub tool inventory — names, parameters, which are read-only — is not reflected
  here, because it was not reachable.** The Jazz articles describe capabilities without
  naming individual tools. Any comparison of *tool counts* would be unfounded, so none is
  made: the table below compares the shape of the capability, not its size.
- Whether "managed endpoint" implies IBM-operated components in the request path is
  unverified. It is the first question a regulated deployment will ask.
- Entitlement pricing and packaging are unknown.

**A conflation worth avoiding.** Searching for this turns up an "ELM MCP" exposing DNG,
EWM, ETM, GCM and SCM as 84 tools and 15 prompts. That is
[brettscharm/elm-mcp](https://github.com/brettscharm/elm-mcp), a third-party open-source
project, **not** IBM's product. The names are similar enough to mislead.

## What each provides

IBM Engineering AI Hub 1.3 offers a **managed MCP endpoint** over ELM, described as
grounded in requirements, work items, models, tests and traceability, across **DOORS Next**,
**EWM** and **ETM**. Named operations include finding requirements related to a change
request, summarising potential impact, creating requirements through governed change sets,
searching work items by attributes, and adding comments. Its published use cases emphasise
*analysis*: delivery status and planning risk, trends, blockers, dependencies; retrieving
failed execution records and tracing failures back to requirements and defects.

`oslc-mcp-server` generates its tools at startup from OSLC discovery. Measured against two
servers:

| Server | Tools |
|---|---|
| A genOSLC owned-domain server, 4 creation factories | 9 generic + 5 per-type |
| The same, 14 creation factories | 10 generic + 14 per-type |

Per-type tools are derived — one per advertised `oslc:CreationFactory` whose
`oslc:resourceShape` resolved. A factory whose shape fails to fetch produces no tool, which
is why `describe_discovery` lists failed shapes separately.

## Comparison

| | IBM Engineering AI Hub 1.3 | `oslc-mcp-server` |
|---|---|---|
| Licensing | Separate entitlement in addition to ELM licences | Open source; ELM licences only |
| Hosting | Managed endpoint | Self-hosted |
| Where tools come from | Built per ELM application | Derived from OSLC discovery |
| Servers supported | ELM (DOORS Next, EWM, ETM) | Any conformant OSLC provider, ELM included |
| A new domain | Ships when the vendor ships it | Appears as tools with no code change |
| Write path | Creation through governed change sets | `create_*` per factory, shape-validated; generic update and delete |
| Aggregate analysis | Planning risk, trends, blockers, dependencies | None — CRUD and query only |
| Configuration context | Global configuration management | A `configurationContext` per service provider — opaque, so any configuration including a global one whose DOORS Next contribution is a change set |
| Behaviour of a given tool | Not stated in the material reachable here | `describe_discovery` names each tool and the URL it will hit |

## The difference that matters: what a tool can reach

A vendor building tools for its own applications may use **any** interface those applications
expose — OSLC, a native REST API, or a lifecycle index. A discovery-driven client is limited to
**what the server advertises over OSLC**, and no more. Everything below follows from that.

### Aggregate analysis

Identifying trends, blockers and dependencies is reasoning over a corpus. **OSLC advertisements
describe no such capability, so no amount of discovery can produce it.** A server may of course
expose an equivalent — a reporting index, a metrics API — but a client cannot find it by
discovery, and nothing in the OSLC specifications requires one to exist. Closing this gap means
hand-writing tools against a specific interface, which is the approach AI Hub took.

### Where the advertisement is thinner than the application

This is the sharper case, and it cuts both ways.

An `oslc:QueryCapability` publishes `oslc:queryBase` and sometimes `oslc:resourceType`. It
publishes nothing about which `oslc.where` operators work, whether `oslc.select` nests, whether
`oslc.orderBy` is honoured, or how paging behaves — see
[`elm-compatibility.md`](elm-compatibility.md). A vendor writing tools for its own application
never faces this: it knows what its own server does. A discovery-driven client must either
assume or measure, which is why
[the capability probe](../../docs/superpowers/specs/2026-08-17-oslc-mcp-server-capability-probing-design.md)
measures.

**But a thin advertisement is not the same as a missing capability, and the two are easy to
confuse.** Worked example, from this project's own findings: discovery recorded **no query
capabilities for ETM**, which reads like an application that cannot be queried. It is not.
[IBM's ELM-Python-Client](https://github.com/IBM/ELM-Python-Client/blob/master/elmclient/examples/OSLCQUERY.md)
documents `oslc_qm:TestCaseQuery` as ETM's default project-level query capability, further
capabilities at application level, and that *"component and configuration context matter"* when
finding them. So the zero is very likely **this client's discovery gap, not an ETM limitation** —
tracked in [`elm-compatibility.md`](elm-compatibility.md).

The lesson generalises: **before concluding that a vendor's tools reach something OSLC discovery
cannot, check that discovery was looking in the right place.** An honest comparison of reach
requires the discovery side to be correct first.

## Where a discovery-driven server is ahead

1. **It already works against providers a vendor will not ship.** Any server advertising a
   catalog, creation factories and shapes gets tools. That is the point of the
   [AAKI](../../docs/AAKI.md) bridge: a governed domain you defined yourself is
   AI-addressable without a product release. Point it at
   [`oslc-server`](../../oslc-server) or a genOSLC owned domain and the tools follow from
   the vocabulary and shapes.
2. **No entitlement beyond the licences already held** for the servers being read.
3. **Self-hosted**, so requests do not traverse a managed service.
4. **The generated surface is inspectable.** `describe_discovery` — and the report written to
   `reportPath` on every start — states each tool, the URL it will hit, and every shape that
   failed to fetch. This exists because the transformation from advertisement to tool has
   several steps, and a missing tool is otherwise silent.

## Choosing

- **ELM only, and the aggregate-analysis capabilities matter** — AI Hub does things this project
  does not, and closing that gap means writing tools against a specific interface rather than
  discovering them.
- **Governed domains beyond ELM, or entitlement is the constraint, or the deployment must be
  self-hosted, or the tool surface has to be auditable** — that is what this project is for.

They are not mutually exclusive: both speak MCP, and an assistant can be configured with
both.

---

## Sources

- [IBM Engineering AI Hub 1.3 announcement](https://www.ibm.com/new/announcements/ibm-engineering-ai-hub-1-3-helps-engineering-teams-scale-governed-agentic-ai-across-the-lifecycle)
- [Introducing IBM Engineering AI Hub v1.0](https://www.ibm.com/new/announcements/introducing-ibm-engineering-ai-hub-v1-for-high-trust-engineering-domains)
- [Beyond queries: AI-assisted Work Item Management with Engineering AI Hub 1.3 MCP Tools](https://jazz.net/library/article/98823)
- [AI-assisted Test Management with IBM Engineering AI Hub 1.3 MCP Tools](https://jazz.net/library/article/98798)
- [DOORS Next 7.2 — AI and automation](https://www.ibm.com/docs/en/engineering-lifecycle-management-suite/doors-next/7.2.0?topic=overview-ai-automation)
- [brettscharm/elm-mcp](https://github.com/brettscharm/elm-mcp) — third-party, for the disambiguation above
