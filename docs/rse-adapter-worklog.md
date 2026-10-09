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
