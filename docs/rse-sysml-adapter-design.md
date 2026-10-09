# Design: a removable RSE adapter that closes the OSLC AM gaps from SysML v2

**Status:** proposed, 2026-10-09. Not implemented.

## Why

Rhapsody SE presents two APIs over one model: an **OSLC AM** surface and the OMG **SysML v2
Systems Modeling API**. IBM invested in the second, on the view that SysML v2 users will want it.
The consequence for anything OSLC-shaped is that RSE's AM surface handles **links** well and is
incomplete everywhere else — and an assistant driving the estate through `oslc-mcp-server` meets
that incompleteness as a sequence of unexplained failures rather than as a missing feature.

Two runs of the AAKI thread have now paid for this. Run-1's beat 3: *"Blocked — this is content,
and RSE exposes no `dcterms:description` in either shape"* and *"the element never reached the
model"*. Run-2's beat 3 spent the entire beat rediscovering the same ground and left seven
half-wired elements on the branch.

**A full OSLC adapter over the SysML v2 services is a product, and not one worth building here.**
This proposes the opposite: a small, explicitly enabled, removable module inside
`oslc-mcp-server` that closes the specific gaps the tools actually hit. The scope is set by **the
operations the beats perform**, not by OSLC AM completeness. That distinction is the whole design
constraint — the moment this starts chasing specification coverage it has become the product it
was meant to avoid.

## The gaps, as measured

Measured against `trs-filter-light.smartfacts.com/api`, project `9931e482-…`, 2026-10-09. A
representative `GET` on the AM surface returns:

```json
{ "uri": ".../resource/06b00fe8-30df-4bc1-a25b-5345207e670c",
  "type": [ { "uri": "http://open-services.net/ns/am#Resource" }, "InterfaceDefinition" ],
  "owningRelatedElementId": "c7b63db7-c85f-4f82-b8e5-7bc3d09c6c50",
  "shortTitle": "IFC-SENSOR-SF",
  "identifier": "06b00fe8-30df-4bc1-a25b-5345207e670c",
  "title": "Sensor Input Interface" }
```

So `dcterms:title`, `dcterms:identifier`, `oslc:shortTitle` and the link properties **are** served —
the gap is narrower than "OSLC core is missing". Three things are wrong:

| # | Gap | Severity | Needs the SysML API? |
|---|---|---|---|
| **G1** | **`dcterms:description` is absent.** The `Documentation` body is unreachable over AM, so design content can be neither read nor written | **blocking.** It is the content of the model | yes |
| **G2** | `rdf:type` carries the SysML metaclass as a **bare string** (`"InterfaceDefinition"`), not a URI; `owningRelatedElementId` is an id string where a resource reference belongs | malformed RDF; breaks type filtering and traversal | **no** — pure normalisation |
| **G3** | A write echoing back a read is rejected, because **derived properties are rejected rather than ignored** (quirk 28). Every other ELM server ignores them | blocking for updates; the failure is a `500` naming the value and not the field | no |

**Explicitly not in scope: `dcterms:created` and `dcterms:modified`.** A SysML v2 element carries no
time. The only honest derivation is *the latest commit whose changeset contains this element*, which
means walking commits, and which means something materially different from what every other server
means by `dcterms:modified`. Omitting it is better than computing something expensive that invites
a cross-server comparison it cannot support. `aspice-assess` already tells an assistant to take RSE
change facts from the commit history; that stays true.

Also out of scope: `dcterms:creator`/`contributor`, any OSLC AM capability the beats do not use, and
any other provider.

## Scope: four operations

Taken from what runs 1 and 2 actually called, not from the domain.

| Operation | What the adapter adds |
|---|---|
| `rse_get_resource` | **G1** fill `dcterms:description`; **G2** normalise `rdf:type` and reference-shaped ids |
| `rse_query_resources` | the same enrichment across members |
| `rse_update_resource` | **G3** drop derived properties from the PUT body |
| `rse_create_architecture_management_resources` | author through the two-commit SysML recipe, so a created element is real, documented and parented |

Three of those four already half-work today. Only the last is new behaviour.

## Avoiding the double read

The naive implementation reads each resource twice — OSLC first, then the SysML API to fill the
blanks — which doubles the request count and triples it for a query. It is also unnecessary,
because of a property of the SysML side that the AM side does not have:

> **A commit is an immutable snapshot, and the whole of it can be read in one call.**
> `GET /projects/{p}/commits/{commitId}/elements?page[size]=1000` returned all 256 elements of the
> AEB-200 model in a single request.

So the adapter keeps a **snapshot cache keyed by `(projectId, commitId)`**, not a per-resource
cache:

1. The configuration context already names the branch — `…/oslc_config/{projectId}/stream/{branchId}`.
2. One cheap `GET /projects/{p}/branches/{b}` gives the head commit id.
3. On first need, one bulk read populates the snapshot for that commit.
4. Every enrichment in that tool call is then served from memory at **zero marginal requests**,
   including a query returning fifty members.
5. The entry is immutable: a commit never changes. It is evicted when a new head appears, and the
   adapter invalidates it directly after any commit it makes itself.

**Freshness:** re-validate the head **at most once per tool call**, never per resource. Within one
call the snapshot is consistent by construction, which is also the semantically correct answer — a
query and the resources it returns should describe one configuration, not a moving one.

Cost, steady state: **one small head check per tool call**, plus one bulk read per distinct commit.
Against a baseline rather than a stream, even the head check is unnecessary.

**Fallback.** If a model is large enough that the bulk read is not cheap, fall back to per-element
reads above a configurable element-count threshold, and say which mode is in use. Measure before
adding this; 256 elements is not a reason to build it.

**Open question.** Whether RSE's AM links are visible as SysML elements is unmeasured. If they are,
more could be served from the snapshot; if they are not, links stay AM-side and the split above
stands. Measure before designing further.

## The provenance contract

**This is the part that must not be compromised.** The moment `rse_get_resource` returns a
`dcterms:description` that the adapter fetched from somewhere else, an assistant can no longer tell
*RSE asserts this* from *our shim computed this*. That is exactly the misattribution failure this
estate already generates on its own, reintroduced in the one place we control.

Three rules:

1. **Every synthesised or normalised value is declared**, in a form that survives rendering to
   text — not a JSON key a renderer may drop. A result reports which properties came from the OSLC
   response, which were filled from the SysML snapshot and at which commit, and which were
   normalised in place.
2. **The adapter is off by default and enabled explicitly**, per server entry — never auto-detected.
   A server whose behaviour silently changes because something recognised it is the opposite of
   this contract.
3. **With the adapter disabled the code path is identical to today's**, and a test asserts it. The
   point of removability is that a claim can always be re-checked against raw OSLC.

## Module boundary

```
src/adapters/rse-sysml/
  index.ts        createRseAdapter(config) -> AdapterHooks | null
  snapshot.ts     the commit-keyed cache and the bulk read
  enrich.ts       G1 description, G2 normalisation
  write.ts        G3 derived-property filter, and the two-commit create
  derived.ts      the per-metaclass derived-property list, with its test
```

`AdapterHooks` is four optional functions — `enrichResource`, `enrichQueryResults`,
`filterUpdatePayload`, `createElement` — called from the existing handlers where they already have
the client and the configuration context. No handler learns anything about SysML; it either has
hooks or it does not.

**Adopt the two halves independently.** The read projection (G1, G2) is small and low risk. The
write path (G3, create) carries the value but also the state, since it reads the head between
commits. Ship them separately.

## Risks

- **Scope creep into the product.** Mitigated only by the rule above: driven by tool calls, not by
  the domain. Worth re-checking at every addition.
- **Provenance erosion**, the most likely way this goes wrong: a later change adds a synthesised
  value without declaring it, and the guarantee is silently gone. The test suite should assert the
  declaration, not just the value.
- **Someone else writes to the branch** between the head check and the bulk read. The window is one
  request and the failure is a stale description, not a wrong write. Acceptable; worth logging.
- **The derived-property list going stale** as RSE changes. It needs a test that fails loudly, and
  ideally a check against the SysML metamodel if the API exposes derived flags — measure whether it
  does before hard-coding the list.

## What this is worth

Everything the adapter does is already written down in `elm-compatibility.md`, quirks 23–47. Today
an assistant must read that, remember it and apply it correctly on every call — and run-2's beat 3
is the measurement of how that goes: the recipe existed, in detail, and the beat rebuilt it wrong.
**Code that cannot forget is worth more than a document that must be remembered**, and that is the
case for the adapter rather than another section in the skill.
