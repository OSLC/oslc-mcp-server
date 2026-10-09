# RSE adapter — unattended worklog

Started 2026-10-09 ~15:00 local, on the engineer's "go", working unassisted while they are away.
**Nothing is pushed.** Both repositories carry local commits only.

Design: [`rse-sysml-adapter-design.md`](rse-sysml-adapter-design.md). Plan:
[`rse-adapter-plan.md`](rse-adapter-plan.md).

Newest entry last. Each entry says what was done, what it showed, and what it changed in the plan.

---

## 15:00 — vendored the vocabulary

`vocab/SysML-vocab.ttl`, 182 classes / 341 properties, with provenance in `vocab/README.md`.
Counts verified against the file rather than assumed.

## 14:50 — the write boundary is open

A corrected wiring commit against the **void run-2 branch** returned **201**, with no sandbox
refusal. Verified from the server: `FeatureMembership` owner is `CMP-SF`, CMP-SF's relationships
20 → 21, `UNIT-SF-ILLUM` owns its documentation membership and typing, AM query base still 200.

Two consequences: the write path can be exercised unattended, and the two-commit recipe now in
`elm-oslc-tools` is validated live — 25 fields across 5 entries where the beat-3 attempt sent 21
on one element.

**Open:** the element's own `owningRelationship` still reads `NONE`. Expected to be quirk 31
(derived and inverse properties do not recompute in the element `GET`), but that is an assumption
and is the first thing measured in phase 0.

## 15:10 — `owningRelationship` is stored, and the recipe was wrong

Probed it on the void branch: setting it is **accepted** and reads back, so it is not derived.
Then measured the rule across the 256 native elements rather than inferring it:

| | `owningRelationship` |
|---|---|
| owned **Elements** — `PartUsage` 10/10, `Documentation` 22/22, `OSLCLink` 44/44, `InterfaceDefinition` 4/4 | always set |
| **Relationships** — `OwningMembership` 0/105, `FeatureMembership` 0/14, `FeatureTyping` 0/16 | never set |
| **root-level** — `Package` 0/2, 11 of 19 `PartDefinition` | not set |

So the recipe needs **three** directions, not two, and the one I committed this morning produced
elements that differ from every native one. Corrected in the skill and in `elm-compatibility.md`,
and the two beat-3 elements that were missing it are now fixed on the branch.

**Also measured: an update MERGES.** A payload with only `@type`, `@id` and one property left
`declaredName` and `body` intact. So a read-before-write is never needed, and with the
derived-property rule the whole discipline is *send exactly what you are changing*.

## 15:25 — phase 1 done

`scripts/gen-sysml-types.mjs` → `metaclass-types.ts`, 182 classes, generated at authoring time and
gated by `npm run build`. An unknown metaclass is **reported, not minted** — an invented vocabulary
URI is indistinguishable from a real one to an assistant filtering on type.
`adapter: rse-sysml` on a server entry, explicit, with a misspelt value refused rather than
ignored. `context.ts` converts a configuration context to a commit; a baseline fails loudly while
unimplemented rather than guessing a route. 377 tests pass, 7 new.

## 15:40 — the query route exists, and its paging is a trap

Checked the reference implementation's `conf/routes` rather than guessing what RSE serves.
`/elements/{id}/relationships` is a **404** here, but `POST /query-results` **works** — and it is
much better than bulk reads: `select` projects server-side, and **a selected `owningRelationship`
comes back expanded**, so one query returns every `Documentation` with its `body` and its owning
element. No walking, and no snapshot cache needed.

Then the trap. Against a branch holding **44** `OSLCLink` elements:

```
no paging parameter   25        page[size]=1000   44 ✓
pageSize=1000          3        limit=1000         3
```

No `Link` header, no total, nothing to distinguish truncation from completeness — and an
unrecognised parameter name answers a *third* wrong number rather than falling back. Recorded as
quirk 37b. The adapter will always send `page[size]` and treat `length === pageSize` as a
truncation signal, because nothing else will say so.

`where` takes one `PrimitiveConstraint`; `CompositeConstraint` is rejected.

**This changes phase 2 for the better** and the plan needs rewriting before the code is written:
reads become a handful of server-side queries joined in memory, not element walks.

## 16:10 — the query route is configuration-blind, and that nearly became the design

Phase 2 was rewritten around `POST /query-results` because it projects server-side and expands
`owningRelationship`. Then the harness refused a result that had filled its page — 1000
`Documentation` rows from a commit holding 23 — and the reason turned out to be much worse than
paging:

| `commitId` | `PartUsage` |
|---|---|
| run-2 head / run-1 head / main head | **20 each** |
| omitted | **20** |
| a commit that does not exist | **20**, not rejected |

The commit-scoped route answers 11 and 10 on those same branches. So `query-results` returns the
union across the project's history and **says nothing about it** — the rows are real, correctly
typed, correctly filtered, and from the wrong configuration. Quirk 37c.

**It would have been invisible.** Every read would have been configuration-blind, in the direction
that looks *more* complete. The only reason it surfaced is the guard written an hour earlier for a
different reason — a client that refuses to return a page-filling result. That guard was written
because of quirk 37b's silent truncation; it caught something else entirely.

So reads go through `GET /commits/{c}/elements`, which is genuinely commit-scoped and pages
honestly with a `Link … rel="next"` cursor. The ad-hoc route is kept for `OSLCLinkType` only —
project-level, so being unscoped costs nothing there.

**A second difference the rewrite exposed:** the two routes return `owningRelationship` in
different shapes — expanded by the query route, a bare reference by the elements route. Owners now
resolve through the element index from the same single read, which needs no extra request and
works for both.

## 16:25 — phases 2 and 3 done, and the substitution is proven

```
OSLC path   97 resources
adapter     97 resources   (links 44, unresolved 0, docs 23)
identical   74 | adapter adds 23 | DIFFERS 0 | only-one-side 0
```

Resource sets identical, so the measured exclusion reproduces RSE exactly. The 23 additions are
the `Documentation` bodies — `dcterms:description`, the gap that blocked beat 3 in both runs.

401 tests pass, 31 of them new. **Nothing pushed.**

**Next:** phase 4, the write path, against the void run-2 branch; then phase 5, resolving a global
configuration to the RSE contribution.
