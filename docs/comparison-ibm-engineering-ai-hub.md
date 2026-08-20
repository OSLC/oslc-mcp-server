# `oslc-mcp-server` and IBM Engineering AI Hub 1.3

A capability comparison, August 2026. Both expose IBM ELM to MCP-speaking AI assistants and arrive
at it from opposite directions: **AI Hub ships tools written for each application; `oslc-mcp-server`
derives its tools from what a server advertises over OSLC.** That single difference explains almost
every gap below, in both directions — and the directions are not the ones you would guess.

## Sourcing

The AI Hub inventory below is from IBM's product documentation, *MCP tools for Engineering AI Hub*
(topics dated 2026-06-18). **Those pages could not be retrieved programmatically** — `ibm.com/docs`
answers automated clients with a 403 or a 503 error page — so the inventory was transcribed by hand
and the tool descriptions here are condensed rather than quoted. Verify against the product
documentation before relying on any single line.

The `oslc-mcp-server` figures are measured, not estimated: one run against an ELM 7.1 SR1 deployment
on 2026-08-20, scoped to one project area per application.

## What AI Hub provides — 42 tools

| Domain | Tools | Of which write |
|---|---|---|
| Common, cross-application | 9 | 3 |
| Requirements — DOORS Next | 9 | 3 |
| **Models — Rhapsody, SysML v2** | **14** | 0 |
| Work Items — EWM | 6 | 1 |
| Test — ETM | 4 | 1 |
| **Total** | **42** | **8** |

- **Common** — `get_user`, `get_project_area`, `list_project_areas`; `list_linked_requirements` /
  `list_linked_workitems` / `list_linked_testartifacts`; and three link creators,
  `link_workitem_and_requirement`, `link_workitem_and_testartifact`,
  `link_testartifact_and_requirement`.
- **Requirements** — component, type-system, folder and configuration introspection
  (`get_project_components`, `get_project_component_types`, `get_project_component_folders`,
  `get_project_component_configuration`); `get_requirement`, `search_requirement`,
  `create_requirement`; and a change-set workflow, `create_requirement_change_set` +
  `deliver_requirement_change_set`.
- **Models** — 14 tools over SysML v2 in Rhapsody: projects, diagrams (including graphical layout),
  element retrieval and traversal, four search variants, reverse-reference lookup for impact
  analysis, and version control — `list_branches`, `get_branch_history`, `list_branch_tags`.
- **Work Items** — `get_workitem`, `get_workitem_schema`, `list_workitem_categories`,
  `list_workitem_releases`, `search_workitems`, `add_comment_to_workitem`.
- **Test** — `get_testartifact`, `get_testartifact_schema`, `search_testartifact`,
  `add_comment_to_testartifact`.

## What `oslc-mcp-server` produced from discovery

Measured, one project area per application:

| Application | Creation factories | `create_*` tools | Query capabilities advertised |
|---|---|---|---|
| DOORS Next | 12 | 2 | 8 |
| ETM | 13 | 13 | 15 |
| EWM | 10 | 9 | 2 |

Plus nine generic tools per server: `get_resource`, `update_resource`, `delete_resource`,
`query_resources`, `list_resource_types`, `read_catalog`, `read_service_provider`,
`describe_discovery`, `check_turtle_support`.

DOORS Next yields only 2 create tools from 12 factories, and that is correct: ten of its factories
are administrative — ReqIF import/export, attribute, artifact and link types, delivery and
type-system-copy sessions — which create no shaped OSLC resource and so advertise no
`oslc:resourceShape`.

## The surprise: writes

**AI Hub is read-mostly.** Eight of its 42 tools write, and the shape of those eight matters more
than the count:

- exactly **one** tool creates an artifact — `create_requirement`;
- **no tool creates a work item or a test artifact**;
- **no tool updates any artifact**, in any application;
- **no tool deletes anything**.

The remaining writes are three OSLC link creators, two comment adders, and the two change-set
operations.

So on write coverage for ETM and EWM, **discovery is ahead**: 13 and 9 `create_*` tools respectively,
against none, plus generic `update_resource` and `delete_resource` wherever a server accepts them.
That is a direct consequence of the derivation — every advertised creation factory becomes a tool
whether or not anyone thought to write one, and shapes supply the write contract.

Whether that is an advantage depends on what is wanted. A read-mostly surface is a defensible
governance posture for an AI assistant, and *"the AI cannot delete a requirement"* is a property some
deployments will pay for. But it is a **policy** choice presented as a tool inventory, and a client
that needs to create a test case will not find a tool for it.

## Where AI Hub reaches what OSLC discovery cannot

Four gaps, all real, and none closable by better discovery.

**1. SysML v2 models — 14 tools, entirely outside OSLC.** Branches, commit history, tags, diagrams
with graphical positions. This is the SysML v2 API, not an OSLC service. Nothing in an OSLC catalog
advertises it, so no discovery-driven client can produce these tools. It is the largest single block
of AI Hub's inventory.

**2. Structure and process navigation.** Folders, work-item categories, releases, team areas,
timelines and iterations, component hierarchy. **An OSLC service provider advertises none of this** —
it advertises creation factories, query capabilities, dialogs and shapes. A client can query
artifacts and cannot browse the structure they live in.

**3. Configuration and versioning — `get_project_component_configuration`,** returning streams,
baselines, change sets and snapshots. This is the sharpest one, because this project hit exactly that
wall and documented it: `/rm/configurationQuery` cannot enumerate configurations (unfiltered it
answers `400 — "The oslc_config:baselineOfStream is not specified in the URL"`), and the only route
found from a project area to its stream URI was the **RM component picker, a human-driven selection
dialog**. AI Hub ships a tool for it. See the `configurationContext` notes in
`oslc-mcp-server.example.yaml`.

Related: `create_requirement_change_set` and `deliver_requirement_change_set` *create and deliver* a
change set. Working *inside* one is not a gap — `configurationContext` is opaque and accepts any
configuration URI, including a global configuration whose DOORS Next contribution is a change set,
which makes that a configuration decision rather than a capability. Creating and delivering one is a
workflow this project does not expose.

**4. Users — `get_user`.** No OSLC query capability advertises people.

There is also a softer difference. `get_workitem_schema` and `get_testartifact_schema` return
workflow states, priorities, category types and enum mappings; an `oslc:ResourceShape` describes
properties, occurrence and value types. The shape is the write contract and is genuinely equivalent
for validation, but it says less about process.

## Where derivation is ahead

1. **Any conformant OSLC provider, not five named applications.** A server advertising a catalog,
   creation factories and shapes gets tools — which is the point of the [AAKI](../../docs/AAKI.md)
   bridge: a governed domain defined outside any vendor's roadmap becomes AI-addressable without a
   product release. Point it at [`oslc-server`](../../oslc-server) or a genOSLC owned domain and the
   tools follow from the vocabulary and shapes.
2. **Write coverage on ETM and EWM**, as above.
3. **No entitlement** beyond the licences already held for the servers being read; **self-hosted**,
   so requests do not traverse a managed service.
4. **The generated surface is inspectable.** `describe_discovery` and the report written to
   `reportPath` on every start state each tool, the URL it will hit, and every shape that failed to
   fetch — because the transformation from advertisement to tool has several steps and a missing tool
   is otherwise silent.

## What this does not settle: whether the filters work

Both sides advertise search. AI Hub has `search_requirement` (text), `search_workitems` (described as
advanced query expressions), `search_testartifact` (advanced filtering over artifact schemas), and
four model searches. Discovery finds 8, 15 and 2 query capabilities in DOORS Next, ETM and EWM.

**Neither inventory says what a filter does.** An `oslc:QueryCapability` publishes `queryBase` and
sometimes `resourceType`, and nothing about which `oslc.where` operators work, whether `oslc.select`
nests, whether `oslc.orderBy` is honoured, or how paging behaves — see
[`elm-compatibility.md`](elm-compatibility.md). A tool description saying "advanced filtering" is not
more precise. Measuring it is what
[the capability probe](../../docs/superpowers/specs/2026-08-17-oslc-mcp-server-capability-probing-design.md)
is for, and the same probe would be worth pointing at AI Hub.

One correction on the record. This project previously reported **zero** ETM query capabilities, which
read as an application that could not be queried. That was wrong: the service provider URI was stale
after a deployment rebuild. ETM advertises **15**, `TestExecutionRecordQuery` and `TestResultQuery`
among them — so the artifacts AI Hub's test scenarios operate on are advertised over OSLC, not
reachable only through a vendor's tools. **A stale URI presents as an absent capability, not as an
error**, and it was one citation away from becoming a published claim about someone else's product.

## Choosing

- **Rhapsody SysML v2 models, or process and structure navigation, or resolving configurations
  programmatically** — AI Hub does things this project does not, and no amount of discovery will
  change that.
- **Governed domains beyond ELM; creating artifacts in ETM or EWM; updating or deleting; no
  entitlement; self-hosted; an auditable tool surface** — that is what this project is for.

Both speak MCP, and an assistant can be configured with both.

---

## Sources

- IBM product documentation, *MCP tools for Engineering AI Hub* — Common, Requirements, Models, Work
  Items and Test topics, dated 2026-06-18. Not retrievable programmatically; see **Sourcing**.
- [IBM Engineering AI Hub 1.3 announcement](https://www.ibm.com/new/announcements/ibm-engineering-ai-hub-1-3-helps-engineering-teams-scale-governed-agentic-ai-across-the-lifecycle)
- [Beyond queries: AI-assisted Work Item Management with Engineering AI Hub 1.3 MCP Tools](https://jazz.net/library/article/98823)
- [AI-assisted Test Management with Engineering AI Hub 1.3 MCP Tools](https://jazz.net/library/article/98798)
- [IBM ELM-Python-Client — OSLC query notes](https://github.com/IBM/ELM-Python-Client/blob/master/elmclient/examples/OSLCQUERY.md)
- [brettscharm/elm-mcp](https://github.com/brettscharm/elm-mcp) — an unrelated third-party MCP server for ELM, noted because search results conflate it with IBM's product
