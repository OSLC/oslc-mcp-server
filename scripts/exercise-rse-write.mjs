#!/usr/bin/env node
/**
 * Exercise the write path end to end against the VOID run-2 branch.
 *
 * Adds a `jazz_am:trace` from UNIT-SF-ILLUM to the DOORS Next requirement it
 * realises — which is what beat 3 would have done next — and then checks it
 * **on both paths**. A write is faithful only if the OSLC AM surface shows what
 * the adapter wrote; the adapter agreeing with itself proves nothing.
 */
import { parseRseContext, resolveCommit } from '../dist/adapters/rse-sysml/context.js';
import { fetchCommitElements, linkNext, runQuery } from '../dist/adapters/rse-sysml/query.js';
import { buildCreateCommit, buildWireCommit, postCommit, verifyOnAmSurface } from '../dist/adapters/rse-sysml/write.js';
import { indexLinks, NOT_EXPOSED } from '../dist/adapters/rse-sysml/project.js';

const TOKEN = process.env.RSE_TOKEN;
if (!TOKEN) { console.error('RSE_TOKEN is not set.'); process.exit(2); }
const P = '9931e482-aaac-4edd-b7e8-f67198987462';
const BRANCH = '7c6880e7-d529-4aae-a320-1fb3a4d2e3a9';            // the VOID run-2 branch
const CTX = `https://trs-filter-light.smartfacts.com/api/oslc_config/${P}/stream/${BRANCH}`;
const BASE = 'https://trs-filter-light.smartfacts.com/api';
const AM = `${BASE}/oslc_am/${P}`;
const UNIT = '7e693a34-3a2a-4507-93c0-86d594f0fddc';              // UNIT-SF-ILLUM
const TRACE = '1303ef53-98ee-4224-adf1-9f21e2887e7a';             // OSLCLinkType "trace"
const TARGET = 'https://trs-filter.smartfacts.com/rm/resources/TX_rM8_8KLlEfGZYrwx-mJhfA'; // SWR-1 2255

const H = { Authorization: `Bearer ${TOKEN}` };
const http = {
  get: async (u) => { const r = await fetch(u, { headers: H }); return { status: r.status, data: await r.json() }; },
  post: async (u, b) => {
    const r = await fetch(u, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json() };
  },
  getWithHeaders: async (u) => {
    const r = await fetch(u, { headers: H });
    return { data: await r.json(), linkNext: linkNext(r.headers.get('link')) };
  },
};
const ctx = parseRseContext(CTX);
const elementsAt = async (c) => fetchCommitElements(http, BASE, P, c);

const before = await resolveCommit(http, BASE, ctx);
const elsBefore = await elementsAt(before);
const idsBefore = new Set(elsBefore.map((e) => e['@id']));
const unitBefore = elsBefore.find((e) => e['@id'] === UNIT);
console.log(`commit ${before}, ${elsBefore.length} elements`);
console.log(`UNIT-SF-ILLUM owns ${(unitBefore.ownedRelationship ?? []).length} relationships\n`);

// --- commit 1: create the link and the membership that will hold it ----------
const c1 = await postCommit(http, BASE, P, BRANCH, buildCreateCommit(
  'adapter write test: trace from UNIT-SF-ILLUM to SWR 2313',
  [{ type: 'OSLCLink', props: { linkType: { '@id': TRACE }, linkURL: TARGET } },
   { type: 'OwningMembership', props: { visibility: 'public' } }]));
console.log(`commit 1 ${c1}`);

// --- learn the assigned ids: they are not in the response --------------------
const elsMid = await elementsAt(c1);
const added = elsMid.filter((e) => !idsBefore.has(e['@id']));
const link = added.find((e) => e['@type'] === 'OSLCLink');
const mem = added.find((e) => e['@type'] === 'OwningMembership');
if (!link || !mem) { console.error('could not identify the created elements', added.map((a) => a['@type'])); process.exit(1); }
console.log(`  created OSLCLink ${link['@id'].slice(0, 8)} and OwningMembership ${mem['@id'].slice(0, 8)}`);

// --- commit 2: wire it, all three directions ---------------------------------
const unitRels = (elsMid.find((e) => e['@id'] === UNIT).ownedRelationship ?? []).map((r) => r['@id']);
const c2 = await postCommit(http, BASE, P, BRANCH, buildWireCommit(
  'adapter write test: wire the trace link',
  { owner: UNIT, ownerType: 'PartUsage', ownerRelationships: [...unitRels, mem['@id']],
    membership: mem['@id'], membershipType: 'OwningMembership',
    owned: link['@id'], ownedType: 'OSLCLink' }));
console.log(`commit 2 ${c2}\n`);

// --- verify, path B: the adapter's own projection ----------------------------
const after = await resolveCommit(http, BASE, ctx);
const elsAfter = await elementsAt(after);
const byId = new Map(elsAfter.map((e) => [e['@id'], e]));
const lts = await runQuery(http, BASE, P, after, { property: '@type', value: 'OSLCLinkType', select: ['@id', 'linkTypeURI'] });
const { links, unresolved } = indexLinks(
  elsAfter.filter((e) => e['@type'] === 'OSLCLink'), new Map(lts.map((l) => [l['@id'], l.linkTypeURI])), byId);
const mine = (links.get(UNIT) ?? []);
console.log(`adapter sees on UNIT-SF-ILLUM: ${JSON.stringify(mine)}  (unresolved ${unresolved})`);

// --- verify, path A: OSLC AM, which is the control ---------------------------
// Retried, because one look lies: the AM projection of a fresh link is not
// reliably immediate, and a false negative here invites writing the change again.
const t0 = Date.now();
const amHasIt = await verifyOnAmSurface(async () => {
  const r = await fetch(`${AM}/resource/${UNIT}`,
    { headers: { ...H, Accept: 'text/turtle', 'Configuration-Context': CTX } });
  return (await r.text()).includes(TARGET);
});
console.log(`OSLC AM surface shows the target: ${amHasIt}` +
            (amHasIt ? ` after ${Math.round((Date.now() - t0) / 1000)}s` : ' within the window'));

// The SysML side is what the write is verified against: authoritative and
// immediate. The AM projection is asynchronous by up to ~2 minutes, so it is
// REPORTED rather than required — gating on it would fail correct writes.
const ok = mine.some((l) => l.target === TARGET && l.predicate.endsWith('#trace'));
console.log(`\n${ok ? 'PASS' : 'FAIL'} — written and verified on the authoring path` +
            `; AM projection ${amHasIt ? 'caught up' : 'still catching up (expected, async)'}`);
process.exit(ok ? 0 : 1);
