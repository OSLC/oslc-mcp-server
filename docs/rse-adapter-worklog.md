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

## 17:05 — phase 4, the write path, and two wrong turns

Builders for the four measured rules, exercised six times against the void run-2 branch. Every
link landed and read back; the read harness is still faithful afterwards.

**I was wrong twice, and the second time is the finding.** A written link was missing from the
OSLC AM surface; I diffed it against a native one, found `projectId` null on mine, set it, and the
link appeared. I concluded `projectId` was required and changed the builder. Wrong twice over: the
value does not persist through a create, and the same link was later visible with it still null.
That is retrospective entry 1 — overgeneralising from one observation — committed a few hours
after writing the entry down.

The real behaviour, from writing the same link three more times: visible at **t+0** once, absent
for ten seconds then present a minute later, and absent through **sixty-two seconds** of polling
then present about thirty seconds after that. **The AM projection is asynchronous by up to two
minutes.** Quirk 37e. The `projectId` change is reverted.

The design consequence is the useful part: **verify on the path you wrote through.** The SysML side
is authoritative and immediate; the AM projection matters to other clients, so it is reported and
waited for, never gated on. A verification that fails for a minute after a correct write invites
writing it again.

## 17:20 — internal and external links, and where RSE left the standard

The engineer's framing, checked against the reference implementation and confirmed with a
refinement: the OMG API **does** have a standard external-link pair — `ExternalData` with a
`resourceIdentifier`, and `ExternalRelationship` joining it to an element — and **RSE refuses
both**: *Type not recognized*. `OSLCLink`/`OSLCLinkType` appear nowhere in OMG's vocabulary or
reference implementation.

RSE collapses the two into one element with the URL inline and adds a **typed** link, whose
`linkTypeURI` is a real predicate. The standard shape has no place for that except as prose. So the
divergence is defensible, the adapter has no choice, and link handling stays isolated.

## 17:40 — phase 5, and the end of RSE's exception

Given only the CDCM global configuration, the adapter walks its four contributions, selects
*AEB-200 Design Models*, and produces the identical projection — **97 vs 97, 0 differs**.

A contribution qualifies on two counts: its URI must parse as an RSE context **and** share an
origin with the configured RSE server. Shape alone is not enough, because ETM's contribution URI
also contains `/oslc_config/`.

This removes the pinned `configurationContext`, the only per-run file edit in setup, the
`allServers: false` rule that exists solely because of it, and RSE's standing as the one real
exception.

## Where this stands

**All five phases are done and measured.** 434 tests pass; the harness and the write exercise both
run green against the live estate. **Nothing is pushed.**

**What is NOT done, and it matters:** the adapter's modules are built and proven, but they are
**not wired into the MCP tool handlers**. `AdapterHooks` is described in the design and not yet
implemented, so `rse_get_resource` still goes through raw OSLC. The remaining work is integration
plus a test that the disabled path is byte-identical to today — which is also the removability
proof the design promises.

## 18:10 — wired into the handlers, and beat 3 redone

**Wiring.** `adapter: rse-sysml` on a server entry now puts the adapter in front of `get_resource`;
without it every handler is what it was. The configuration is read per call rather than captured,
so `set_configuration_context` still works, and every projected resource carries `_servedBy`
naming the adapter, the source and the commit. Exercised with both kinds of context — the global
configuration (97 members) and a branch at run-2's start commit (93, the R1.0 count).

**The branch question, answered the hard way.** A branch cannot be reverted over the API.
`POST /branches` answers 201 and the branch **reads** correctly, but its head is its own id rather
than the commit asked for, and **every write to it fails** with a generic 500 — including a payload
that commits fine to a UI-made branch. `isPrivate: false` is rejected outright, so the server forces
a private branch and that is what is unusable. There is no route to move a head either. Quirk 37f.

So cutting a stream stays a Rhapsody SE UI operation, which is what `run-setup.md` step 5 already
assumes. Beat 3 was therefore redone on the void run-2 branch with distinct names, which proves the
mechanism rather than the starting state.

**Beat 3, redone through the adapter:**

```
commit 1  7 elements in one commit        (the original used three commits for five)
commit 2  wired, three directions         (the original's fourth commit was rejected)

ok  UNIT-SF-ILLUM is a resource          ok  it points up at its membership
ok  its documentation is dcterms:description   ok  it owns its documentation and typing
ok  its rdf:type is a vocabulary URI     ok  CMP-SF owns the feature membership
ok  the resource set grew by four
```

**Two commits against five, nothing orphaned, and the description readable over OSLC** — which is
the thing neither run could do. The original beat 3 landed three of five commits, had the fourth
rejected for echoing derived properties, left seven unwired elements, and was abandoned.

**Artifacts left on the void run-2 branch**, deliberately: six test links, a `PROBE` part
definition, and the redo's seven elements. The branch is void and run-3 cuts fresh streams from
R1.0, so none of it survives into a run.

## 19:30 — query and writes wired, and the acme config switched over

`query_resources`, `update_resource` and the generated `create_*` tools now go through the adapter
when the entry enables one. Exercised live:

```
update: documentation body        1 commit,  reads back
update: trace = {A, B}            4 commits, reads back as both
update: trace = {A}               B detaches, A remains
update: trace = {}                empty
update: an unmapped property      refused, with the known names listed
create: no parent                 refused
create: documented unit           2 commits, reads back with its description
```

**Removal detaches rather than deletes**, because API-created RSE content is append-only
(quirk 38): the membership comes out of the owner's forward list, which is what the AM surface
honours, and the `OSLCLink` element is left alone.

**Two defects the exercise found, neither visible from reading the code.**

*The read was wrong about detached links.* `ownerOf` resolved a link's source through the
membership's back-pointer, which survives detaching — so the adapter reported six targets where
the AM surface served five. Containment is now required in **both** directions.

*Two links in one call shared a membership.* The add loop diffed against the state captured at
entry, so the second create adopted the first link's membership; detaching either then removed
both. The id set is now re-snapshotted before each create.

**And the harness itself was truncating.** RSE's AM query base pages — `oslc:totalCount`,
`oslc:nextPage`, size 100 — and the control path read page one. It matched perfectly for exactly
as long as the model fitted on a page. Worse, there is no page two: the same URL returns a
different unstable sample of 100 each time, and `nextPage` advertises `pageNum=1` forever. Reading
to `totalCount` is the only correct method. Quirk 37g — and a caution about proof by comparison,
since this is the check that certifies the adapter.

**`oslc-mcp-server-acme.yaml`** now carries `adapter: rse-sysml` on the rse entry, and its pinned
`configurationContext` is commented out with the reason. **No server in the file is pinned any
more.** The file is git-ignored, so this is a local change; a backup of the previous version is at
`~/.config/oslc/acme-yaml.bak`.

Final state: **436 tests**, harness **104 vs 104, 0 differs** with a global configuration as the
context.
