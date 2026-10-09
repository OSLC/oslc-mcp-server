#!/usr/bin/env node
/**
 * Beat 3's structural change, redone on a branch cut from run-2's start commit.
 *
 * The original attempt took five commits, landed three, had the fourth rejected
 * for echoing derived properties, and left seven unwired elements. This is the
 * same change through the adapter: create the subgraph in ONE commit, learn the
 * ids, wire in a second with all three directions.
 */
import { resolveCommit, parseRseContext } from '../dist/adapters/rse-sysml/context.js';
import { fetchCommitElements, linkNext, runQuery } from '../dist/adapters/rse-sysml/query.js';
import { buildCreateCommit, buildUpdateCommit, postCommit } from '../dist/adapters/rse-sysml/write.js';
import { createRseAdapter } from '../dist/adapters/rse-sysml/index.js';
import { GC_ACCEPT } from '../dist/adapters/rse-sysml/global-config.js';

const T = process.env.RSE_TOKEN; if (!T) { console.error('RSE_TOKEN unset'); process.exit(2); }
const H = { Authorization: `Bearer ${T}` };
const BASE = 'https://trs-filter-light.smartfacts.com/api';
const P = '9931e482-aaac-4edd-b7e8-f67198987462';
const BRANCH = '7c6880e7-d529-4aae-a320-1fb3a4d2e3a9';     // the VOID run-2 branch (an API-made branch cannot be written to: quirk 37f)
const CTX = `${BASE}/oslc_config/${P}/stream/${BRANCH}`;
const UNIT_DEFS = '6a88b844-6694-4944-973f-35bfcefe7d98';  // package "Software Unit Definitions"
const CMP_SF = 'e56bcbfa-cf22-4e8d-a879-e31e8cc75739';
const DOC = 'Determines the ambient illumination from the camera frames, to the measurement ' +
            'uncertainty set by the illumination measurement requirement, and supplies it to the ' +
            'operating condition gate.';

const http = {
  get: async (u) => { const r = await fetch(u, { headers: H }); return { status: r.status, data: await r.json() }; },
  post: async (u, b) => { const r = await fetch(u, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json() }; },
  getWithHeaders: async (u) => { const r = await fetch(u, { headers: H }); return { data: await r.json(), linkNext: linkNext(r.headers.get('link')) }; },
  getRdf: async (u) => { const r = await fetch(u, { headers: { ...H, Accept: GC_ACCEPT } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); },
};
const ctx = parseRseContext(CTX);
const before = await resolveCommit(http, BASE, ctx);
const idsBefore = new Set((await fetchCommitElements(http, BASE, P, before)).map((e) => e['@id']));
console.log(`branch ${BRANCH.slice(0, 8)}  commit ${before.slice(0, 8)}  ${idsBefore.size} elements\n`);

// --- ONE commit creates the whole subgraph ----------------------------------
const c1 = await postCommit(http, BASE, P, BRANCH, buildCreateCommit(
  'beat 3: ambient illumination estimator', [
    { type: 'PartDefinition', props: { declaredName: 'Ambient Illumination Estimator (redo)', declaredShortName: 'UNIT-SF-ILLUM-DEF-R' } },
    { type: 'OwningMembership', props: { visibility: 'public' } },   // definition into UNIT-DEFS
    { type: 'PartUsage', props: { declaredName: 'Ambient illumination estimator (redo)', declaredShortName: 'UNIT-SF-ILLUM-R' } },
    { type: 'FeatureMembership', props: { visibility: 'public' } },  // unit as a feature of CMP-SF
    { type: 'FeatureTyping' },                                       // unit typed by the definition
    { type: 'Documentation', props: { declaredName: 'UNIT-SF-ILLUM documentation', body: DOC } },
    { type: 'OwningMembership', props: { visibility: 'public' } },   // documentation into the unit
  ]));
console.log(`commit 1  ${c1}   (7 elements in one commit; the original used three)`);

const mid = await fetchCommitElements(http, BASE, P, c1);
const added = mid.filter((e) => !idsBefore.has(e['@id']));
const pick = (t, n = 0) => added.filter((e) => e['@type'] === t)[n]['@id'];
const DEF = pick('PartDefinition'), UNIT = pick('PartUsage'), TYPING = pick('FeatureTyping');
const DOCEL = pick('Documentation'), FM = pick('FeatureMembership');
const [DEFMEM, DOCMEM] = added.filter((e) => e['@type'] === 'OwningMembership').map((e) => e['@id']);
const byId = new Map(mid.map((e) => [e['@id'], e]));
const rels = (id, extra = []) => [...((byId.get(id).ownedRelationship ?? []).map((r) => r['@id'])), ...extra].map((x) => ({ '@id': x }));

// --- ONE commit wires it, three directions throughout ------------------------
const c2 = await postCommit(http, BASE, P, BRANCH, buildUpdateCommit('beat 3: wire the estimator', [
  { id: DEFMEM, type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': UNIT_DEFS }, ownedRelatedElement: [{ '@id': DEF }] } },
  { id: DEF, type: 'PartDefinition', set: { owningRelationship: { '@id': DEFMEM } } },
  { id: UNIT_DEFS, type: 'Package', set: { ownedRelationship: rels(UNIT_DEFS, [DEFMEM]) } },
  { id: FM, type: 'FeatureMembership', set: { visibility: 'public', owningRelatedElement: { '@id': CMP_SF }, ownedRelatedElement: [{ '@id': UNIT }] } },
  { id: TYPING, type: 'FeatureTyping', set: { owningRelatedElement: { '@id': UNIT }, type: { '@id': DEF }, typedFeature: { '@id': UNIT } } },
  { id: DOCMEM, type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': UNIT }, ownedRelatedElement: [{ '@id': DOCEL }] } },
  { id: DOCEL, type: 'Documentation', set: { owningRelationship: { '@id': DOCMEM } } },
  { id: UNIT, type: 'PartUsage', set: { owningRelationship: { '@id': FM }, ownedRelationship: [{ '@id': DOCMEM }, { '@id': TYPING }] } },
  { id: CMP_SF, type: 'PartDefinition', set: { ownedRelationship: rels(CMP_SF, [FM]) } },
]));
console.log(`commit 2  ${c2}   (wired: three directions on every owned element)\n`);

// --- verify through the adapter, which is how a beat would see it ------------
const a = createRseAdapter({ baseUrl: BASE, currentContext: () => CTX, http });
const unit = JSON.parse(await a.getResource(`${BASE}/oslc_am/${P}/resource/${UNIT}`));
const after = await resolveCommit(http, BASE, ctx);
const els = await fetchCommitElements(http, BASE, P, after);
const u = els.find((e) => e['@id'] === UNIT);
const sf = els.find((e) => e['@id'] === CMP_SF);
const q = JSON.parse(await a.queryResources());

const checks = [
  ['UNIT-SF-ILLUM is a resource', unit.shortTitle === 'UNIT-SF-ILLUM-R'],
  ['its documentation is dcterms:description', (unit.description ?? '').startsWith('Determines the ambient')],
  ['its rdf:type is a vocabulary URI', unit.type.some((t) => t.uri.endsWith('#PartUsage'))],
  ['it points up at its membership', u.owningRelationship?.['@id'] === FM],
  ['it owns its documentation and typing', (u.ownedRelationship ?? []).length === 2],
  ['CMP-SF owns the feature membership', (sf.ownedRelationship ?? []).some((r) => r['@id'] === FM)],
  ['the resource set grew by the four exposed elements', q.count >= 97],
];
for (const [what, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
const allOk = checks.every(([, ok]) => ok);
console.log(`\n${allOk ? 'PASS' : 'FAIL'} — beat 3's structural change, two commits, nothing orphaned`);
process.exit(allOk ? 0 : 1);
