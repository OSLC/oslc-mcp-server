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
