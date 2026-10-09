# RSE adapter — implementation plan

Design: [`rse-sysml-adapter-design.md`](rse-sysml-adapter-design.md). Progress:
[`rse-adapter-worklog.md`](rse-adapter-worklog.md).

**Ordering principle: the comparison harness comes before the thing it tests.** Substitution can be
wrong about everything, not just one property, and the only way to know it is faithful is to run
both paths over the same model and diff them. That is phase 3 of five, not phase 5 of five.

**Scope rule, restated because it is the one that erodes:** driven by the tool calls the beats
actually make, never by OSLC AM completeness.

---

## Phase 0 — measure what the design rests on  ✅ done

| | Result |
|---|---|
| Are links in the JSON API? | **Yes.** 44 `OSLCLink` elements: `linkType`, `linkURL`, source via `owningRelationship` → `OwningMembership.owningRelatedElement`. Two types, 24/20, matching run-1's 24 `satisfy` |
| Is there an authority for `rdf:type`? | **Yes.** `vocab/SysML-vocab.ttl`, 182 classes, and `oslc_sysml:Element rdfs:subClassOf oslc_am:Resource` |
| Can writes be exercised? | **Yes.** The void run-2 branch accepts commits; `201`, no sandbox refusal |
| Is `owningRelationship` derived? | **No, stored.** Owned Elements always carry it; Relationships never do; root-level ones don't |
| Does an update replace? | **No, merges.** Omitted properties survive, so no read-before-write is ever needed |

**Still to measure, folded into the phases that need them:** whether an RSE *baseline* configuration
exists and maps to a fixed commit (phase 1), and the global configuration → contribution walk
(phase 5).

## Phase 1 — skeleton, vocabulary map, configuration→commit

- `src/adapters/rse-sysml/`, returning `AdapterHooks | null`; **disabled by default**, enabled by
  `adapter: rse-sysml` on the server entry. Never auto-detected.
- A generator that parses `vocab/SysML-vocab.ttl` once at build time into a committed
  `metaclass-types.ts`. **No runtime TTL parse and no runtime file read** — and the committed map
  is reviewable in a diff, which a parsed file is not.
- `Configuration-Context` → commit: `…/oslc_config/{p}/stream/{b}` → `GET /projects/{p}/branches/{b}`
  → head. Measure the baseline form here and handle it or fail loudly; never silently fall back to
  a default branch, which is how RSE produces a `500` that reads as an outage.

**Done when:** the adapter loads, resolves a context to a commit, and the disabled path is proven
byte-identical to today by test.

## Phase 2 — read substitution  *(rewritten 2026-10-09 after measuring the query route)*

The first version of this phase assumed element-by-element reads and a walk to find each
element's `Documentation`. **`POST /projects/{p}/query-results?commitId={c}` makes that
unnecessary**, and the measurements below are what the implementation is built on rather than
inferred from.

### What the query route gives us

- **`select` projects server-side**, and a selected `owningRelationship` comes back **expanded**,
  carrying `owningRelatedElement`. So one query returns every `Documentation` with its `body`
  *and* the element it belongs to. No walking, no snapshot cache.
- **`where` takes exactly one `PrimitiveConstraint`.** `CompositeConstraint` is rejected, so an
  `and` is two queries intersected by the caller.
- **Paging is a trap** (quirk 37b): unpaged silently returns 25 of 44, `page[size]=1000` returns
  44, and `pageSize`/`limit` return **3** rather than falling back. No headers signal any of it.

### The exposure rule, measured exactly

RSE's AM surface exposes **97 of 263** elements, and the difference is an exclusion of three
metaclasses rather than a rule about relationships:

| | |
|---|---|
| **excluded** | `OwningMembership` (107), `OSLCLink` (44), `FeatureMembership` (15) — containment, and the link carrier |
| **exposed** | everything else, *including* `FeatureTyping` (17), `NamespaceImport`/`NamespaceExpose` (6 each) |

`263 − 166 = 97`. The adapter reproduces that exclusion exactly; a resource set that differs by one
is a defect the harness must fail on.

### Implementation

**Four queries per tool call, independent of model size**, joined in memory:

| | `where` | `select` |
|---|---|---|
| Q1 elements | per exposed metaclass, or `@id` for a single read | `@id`, `@type`, `declaredName`, `declaredShortName`, `ownedRelationship`, `owningRelationship` |
| Q2 documentation | `@type = Documentation` | `@id`, `body`, `owningRelationship` |
| Q3 links | `@type = OSLCLink` | `@id`, `linkType`, `linkURL`, `owningRelationship` |
| Q4 link types | once, cached for the process — they are immutable | resolve `linkType` → a `jazz_am:` predicate |

A single `get_resource` narrows Q1 to `@id` and filters Q2/Q3 by owner after the fact.

**Every query sends `page[size]` explicitly and treats `length === pageSize` as truncation**, since
nothing in the response will say so. A truncated read is reported as an error, never returned as a
result — an assistant reasoning from absence cannot tell a short answer from a complete one, and
that is the failure mode this whole project keeps paying for.

### The projection

| From | To |
|---|---|
| metaclass | `rdf:type` = `oslc_am:Resource`, `oslc_sysml:<Metaclass>` (unknown metaclass reported, never minted) |
| `declaredName` / `declaredShortName` | `dcterms:title` / `oslc:shortTitle` |
| `@id` | `dcterms:identifier` |
| owned `Documentation.body` | `dcterms:description` — **the gap that blocked two runs** |
| owned `OSLCLink` | a link predicate on the owner: `linkType` → the predicate, `linkURL` → the object |

## Phase 3 — the comparison harness

A test that reads the same elements both ways and diffs, over the whole 93-resource AM projection.
Three outcome classes, and each needs a verdict in the output rather than a pass/fail:

- **identical** — the substitution is faithful;
- **adapter adds** — `dcterms:description` and a URI-shaped `rdf:type`. Expected, and the point;
- **adapter differs or loses** — a defect, every time, until explained.

**This is also the removability proof**, since it runs the disabled path as its control.

## Phase 4 — writes

`update_resource` and `create_*` as commits, against the void run-2 branch. The discipline is
already measured: send identity plus exactly the properties being changed; create the subgraph in
one commit, wire in a second, three directions on the wiring.

**Verify every write by reading the graph back**, not by the `201`. Beat 3's failure returned a
`500` naming a value rather than a field; the symmetric risk is a `201` that wrote less than it
claimed.

## Phase 5 — global configuration → RSE contribution

Fetch the CDCM global configuration, walk `oslc_config:contribution`, take the one whose
configuration is an RSE stream — what `run-setup.md` step 7 currently tells a human to do.

Independent of phases 2–4 and the highest-value piece: it removes the pinned `configurationContext`
in the yaml, **the only per-run file edit in the whole setup**, the `allServers: false` discipline
that exists solely because of it, and RSE's standing as the one real exception.

## Not doing

`dcterms:created`/`modified` (an element carries no time; the honest derivation walks commits and
means something other servers do not), `dcterms:creator`, any AM capability the beats do not call,
any other provider, and any generalisation into a declarative gap profile until a second provider
needs one.
