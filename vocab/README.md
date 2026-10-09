# Vendored vocabularies

## `SysML-vocab.ttl`

The OSLC vocabulary for SysML v2, **copied from the OMG reference implementation**:

| | |
|---|---|
| source | `SysML-v2-API-Services/public/oslc/SysML-vocab.ttl` |
| file date | 2025-03-04 |
| vendored | 2026-10-09 |
| namespace | `https://www.omg.org/spec/sysml/vocabulary#` |
| contents | 182 classes, 341 properties |

**Why vendored rather than fetched.** No deployment serves it —
`…/api/oslc/SysML-vocab.ttl` is a 404 on the RSE this was measured against. And it is a
**specification** artifact: it changes with SysML v2, not with the server, so pinning a copy is
correct rather than merely convenient. A path into a sibling checkout would be a dangling
dependency of exactly the kind that fails silently.

**What reads it.** The RSE adapter, for the metaclass → `rdf:type` mapping
(`oslc_sysml:Element rdfs:subClassOf oslc_am:Resource`, so an element is
`oslc_am:Resource, oslc_sysml:<Metaclass>`). See
[`../docs/rse-sysml-adapter-design.md`](../docs/rse-sysml-adapter-design.md).

**Not in it, deliberately:** RSE's own extensions — `OSLCLink`, `linkType`, `linkURL`. They
are not OMG, and an `OSLCLink` is never projected as a resource anyway: it becomes a link
predicate on its source, typed from Jazz `dmlinktypes`.

**Updating.** Re-copy from the reference implementation and re-run the generator; the committed
map is derived from this file and should never be hand-edited.
