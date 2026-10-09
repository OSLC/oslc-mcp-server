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

## Revision, 2026-10-09: substitute rather than enrich

The first draft kept the OSLC call and filled its gaps from the SysML API, with a commit-keyed
snapshot cache to avoid reading everything twice. **That is overkill, and the better design is to
stop making the OSLC call at all.** Discovery stays OSLC-shaped, so tool generation is unchanged
and the assistant never learns that RSE is different; behind the generated tools, the RSE
implementations talk to the SysML v2 API directly.

This is only possible if the JSON API carries everything the OSLC surface does — **including the
links**, which was the open question. It does.

### Measured: links are first-class SysML elements

The 256-element model at the AEB-200 run-2 head contains **44 `OSLCLink` elements**:

```json
{ "@id": "01150f03-…", "@type": "OSLCLink",
  "linkType":  { "@id": "aa97e14e-…" },
  "linkURL":   "https://trs-filter.smartfacts.com/rm/resources/TX_stN40KLlEfGZYrwx-mJhfA",
  "owningRelationship": { "@id": "8001641f-…" } }
```

All three parts of a link are there:

| | |
|---|---|
| **target** | `linkURL`, a full URI |
| **type** | `linkType`, an element reference |
| **source** | `owningRelationship` → `OwningMembership.owningRelatedElement` — resolved for the example above to `PartDefinition CMP-BAC` |

**Two distinct link types across the 44, split 24 / 20** — which matches run-1's record of staging
24 `jazz_am:satisfy` on the RSE side exactly, leaving 20 `jazz_am:trace`. The link-type elements
are **not** in the branch snapshot; they are project- or library-level, so they need one additional
read. They are immutable, so that read is cached once for the process, not per commit.

**So the precondition holds.** No enrichment, no snapshot cache, no per-property provenance: one
source of truth, read directly.

### Internal and external links, and where RSE left the standard

The SysML v2 API distinguishes **internal** references — between elements in one repository, by
GUID — from **external** ones, to things outside it, by URL. Every structural relationship
(`OwningMembership`, `FeatureMembership`, `FeatureTyping`) is internal: `owningRelatedElement` and
friends carry `{"@id": "<guid>"}`. OSLC links are the external case by definition, since their
targets live in DOORS Next, ETM and EWM.

**The OMG API has a standard mechanism for this, and RSE does not implement it.** From the
reference implementation's own OpenAPI:

```
ExternalData          { @id, @type, resourceIdentifier }
ExternalRelationship  { @id, @type, elementEnd, externalDataEnd, language, specification }
```

Two elements: the external thing, and a relationship joining a SysML element to it. RSE refuses
both — *`Unable to create commit: Type not recognized ExternalData`* — and uses its own pair
instead, which appears nowhere in the OMG vocabulary or reference implementation:

```
OSLCLink      { @id, @type, linkType -> OSLCLinkType, linkURL, owningRelationship }
OSLCLinkType  { @id, @type, declaredName, linkLabel, linkTypeURI }
```

So RSE **collapses** `ExternalData` and `ExternalRelationship` into one element with the URL
inline, reaches its source through containment rather than an `elementEnd`, and adds something the
standard shape has no place for: a **typed** link, whose `linkTypeURI` is a real predicate
(`http://jazz.net/ns/dm/linktypes#satisfy`). `ExternalRelationship` would have to smuggle that
through `language`/`specification` as prose.

**The divergence is defensible, and the adapter has no choice anyway** — `OSLCLink` is what exists.
What follows for the design is narrower: link handling is the one part most likely to be wrong on a
different SysML v2 server, so it stays isolated behind `indexLinks` and the link half of the write
path. A server that implements the standard shape should be a module to add, not a design to
revisit.

### Two conversions the adapter owns

**1. `Configuration-Context` → commit.** SysML reads are commit-scoped and OSLC callers speak
configurations. The context has one shape, `…/api/oslc_config/{projectId}/stream/{branchId}`, so:

```
branchId  ──GET /projects/{p}/branches/{b}──>  head commit   (a stream: moves)
                                               fixed commit  (a baseline: does not)
```

Reads resolve against that commit; writes go to the branch. **This also removes a whole class of
error silently**: today a request with no context reaches RSE's default branch and the AM query
base answers `500`, which reads as a server fault.

**2. Global configuration → the RSE contribution.** The single most persistent defect in the
example is that RSE cannot resolve a foreign global configuration — it matches on a component URL,
not a configuration URI, so it serves its default branch or fails. The adapter can simply do what
`run-setup.md` step 7 tells a human to do: fetch the global configuration, walk
`oslc_config:contribution`, and take the one whose configuration is an RSE stream.

**Known limitation, and it is not small: one level, one candidate.** A global configuration is in
general a **hierarchy** — a contribution may itself be a global configuration — and such a
hierarchy can contain **several** RSE configurations. Which one applies is the **version skew**
problem, and it has an established answer:

> GCM and CDCM each expose a **non-standard** REST API returning a **depth-first traversal** of the
> hierarchy as a flat, ordered list. The consumer takes the **first matching** contribution. That
> ordering *is* the convention for resolving skew, and Rhapsody SE follows it.

The adapter does not use that traversal yet. Until it does it walks one level and **refuses** when
it finds more than one candidate, or when a contribution is itself a global configuration, rather
than choosing — picking arbitrarily would mean reading a configuration the caller did not ask for
and could not distinguish from the right one.

Measured on AEB-200, 2026-10-09: that configuration is **flat** — four contributions, all leaves,
exactly one RSE. So this costs nothing in the example and everything on a real programme.
`?depth=all` is ignored by CDCM (byte-identical response), so the traversal route still has to be
found. **This is the next piece of work on the adapter.**

**That is worth more than the gap-filling.** It removes the pinned `configurationContext` in the
yaml, the only per-run file edit in the whole setup, the `allServers: false` discipline that exists
solely because of it, and RSE's standing as *the one real exception*. `set_configuration_context`
with a global configuration would simply work on all five servers.

### What each operation becomes

| Tool | Implementation |
|---|---|
| `get_resource` | `GET /projects/{p}/commits/{c}/elements/{id}`; project `declaredName`→`dcterms:title`, `declaredShortName`→`oslc:shortTitle`, the metaclass→an `rdf:type` URI (below), the owned `Documentation` body→`dcterms:description`, and owned `OSLCLink`s→link predicates |
| `query_resources` | the commit's elements, filtered — one call, where the OSLC path needed one plus N |
| `update_resource` | a commit carrying only the properties being set (quirk 28); link changes are `OSLCLink` elements |
| `create_*` | the two-commit recipe, already measured |

**The derived-property problem disappears** rather than being filtered: nothing is round-tripped,
because the adapter composes the payload from the request rather than from a prior read.

### The `rdf:type` mapping is not ours to invent

**`SysML-vocab.ttl` from the OMG reference implementation is the authority** — 182 `rdfs:Class`
declarations under `oslc_sysml: <https://www.omg.org/spec/sysml/vocabulary#>`, each with an
`rdfs:label` that is exactly the metaclass name, and a full `rdfs:subClassOf` hierarchy. The
mapping is therefore mechanical rather than a judgement, which removes the risk this document
previously listed.

It also supplies the tie to OSLC:

```turtle
oslc_sysml:Element a rdfs:Class ;
    rdfs:subClassOf oslc_am:Resource .
```

So every element is an `oslc_am:Resource` by inference, and the adapter emits

```
rdf:type   oslc_am:Resource , oslc_sysml:<Metaclass>
```

which is what RSE's `["am#Resource", "InterfaceDefinition"]` already *means*. It simply fails to
make the second one a URI.

**Coverage, checked against the AEB-200 model's fourteen metaclasses: thirteen are in the
vocabulary.** The missing one is **`OSLCLink`**, and its absence is correct — it is an RSE
extension, not OMG, and it must never be projected as a resource in the first place. An `OSLCLink`
becomes a **link predicate on its source element**, which is exactly what the AM surface already
does with it. Its `linkType` resolves against the Jazz `dmlinktypes` vocabulary
(`http://jazz.net/ns/dm/linktypes#`), not this one — a separate, tiny, permanently cacheable
lookup.

The property URIs come from the same file: `declaredName`, `declaredShortName`, `body`,
`ownedRelationship` and `owningRelatedElement` are all declared `rdf:Property`, so SysML-native
properties can be exposed with authoritative URIs alongside the Dublin Core projections rather than
invented ones.

**The deployment does not serve it** — `…/api/oslc/SysML-vocab.ttl` is a 404 on this RSE — so the
adapter vendors a copy. It is a specification artifact and changes with the spec, not with the
deployment.

## Provenance, revised

Substitution makes this simpler and stronger than per-property declaration. **The server declares
once, at startup and in every RSE tool result, that it is served from the SysML v2 API rather than
from OSLC AM** — one fact rather than a per-field audit.

The removability requirement is unchanged and now matters more: with the adapter disabled the RSE
tools behave exactly as today. That is not only an escape hatch, it is the **comparison harness** —
a test that runs both paths against the same model and diffs the results is the only way to know
the substitution is faithful, and it is worth building first.

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

- **The blast radius is now the whole RSE surface, not the gaps.** Enrichment could only be wrong
  about one property; substitution can be wrong about everything. This is the price of the simpler
  design and it is why the comparison harness comes first, not last.
- ~~The metaclass→`rdf:type` mapping is ours to get right.~~ **Resolved**: `SysML-vocab.ttl` is the
  authority and the mapping is mechanical. What remains is keeping the vendored copy current with
  the spec, and handling RSE's own extensions — `OSLCLink`, `linkType`, `linkURL` — which are
  deliberately outside it.

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
