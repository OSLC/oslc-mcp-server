#!/usr/bin/env node
/**
 * The comparison harness: read the same model both ways and diff.
 *
 * Substitution can be wrong about everything, not just one property, so this is
 * the only evidence that the adapter is faithful. It is also the removability
 * proof — the OSLC path it compares against is what runs with the adapter off.
 *
 * Three outcome classes, and each needs a verdict rather than a pass/fail:
 *   identical  — faithful
 *   adds       — dcterms:description, and a URI-shaped rdf:type. The point
 *   differs    — a defect, every time, until explained
 *
 *   RSE_TOKEN=$(node dist/print-access-token.js --config <cfg> --server rse) \
 *     node scripts/compare-rse-paths.mjs --config <cfg>
 */
import { readFileSync } from 'node:fs';
import rdflib from 'rdflib';
import { parseRseContext, resolveCommit } from '../dist/adapters/rse-sysml/context.js';
import { resolveAnyContext, describeContributions, GC_ACCEPT } from '../dist/adapters/rse-sysml/global-config.js';
import { runQuery, fetchCommitElements, linkNext } from '../dist/adapters/rse-sysml/query.js';
import {
  NOT_EXPOSED, projectResource, indexDescriptions, indexLinks, resourceUri,
} from '../dist/adapters/rse-sysml/project.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap(
  (a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : [])));
const TOKEN = process.env.RSE_TOKEN;
if (!TOKEN) { console.error('RSE_TOKEN is not set.'); process.exit(2); }

// The configuration context is the single input; everything else derives.
const cfg = readFileSync(args.config ?? 'oslc-mcp-server-acme.yaml', 'utf8');
const ctxUri = /configurationContext:\s*(\S+)/.exec(
  cfg.slice(cfg.indexOf('alias: rse')))?.[1]
  ?? /(https:\/\/\S*oslc_config\/\S+)/.exec(cfg.slice(cfg.indexOf('alias: rse')))?.[1];
// --context accepts EITHER an RSE stream or a CDCM global configuration. The
// second is the point: it is what every other server in the estate is given,
// and what RSE has needed pinning to avoid.
const given = args.context ?? ctxUri;
const BASE = (args['rse-base'] ?? 'https://trs-filter-light.smartfacts.com') + '/api';
const H = { Authorization: `Bearer ${TOKEN}` };
const ELM = process.env.ELM_TOKEN ?? TOKEN;   // same identity; the estate shares one
const http = {
  get: async (url) => { const r = await fetch(url, { headers: H }); return { status: r.status, data: await r.json() }; },
  post: async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  },
  // The elements route states completeness through a Link cursor; the client has
  // to be able to see it or paging stops at page one and looks like a small model.
  getWithHeaders: async (url) => {
    const r = await fetch(url, { headers: H });
    return { data: await r.json(), linkNext: linkNext(r.headers.get('link')) };
  },
  // CDCM serves RDF/XML and nothing else: turtle and JSON both answer 500.
  getRdf: async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${ELM}`, Accept: GC_ACCEPT } });
    if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
    return r.text();
  },
};

if (!parseRseContext(given)) {
  console.log('context is not an RSE stream — resolving it as a global configuration:');
  for (const c of await describeContributions(http, given)) {
    console.log(`  ${(c.title ?? '').padEnd(32)} ${c.configuration ?? ''}`);
  }
}
const rse = await resolveAnyContext(http, BASE, given);
const commit = await resolveCommit(http, BASE, rse);
const AM = `${BASE}/oslc_am/${rse.projectId}`;
const ctxUriForAm = `${BASE}/oslc_config/${rse.projectId}/stream/${rse.branchId}`;
console.log(`project ${rse.projectId}\nbranch  ${rse.branchId}\ncommit  ${commit}\n`);

// ---- path A: OSLC AM, which is what runs with the adapter disabled ----------
// No oslc.select: ask for everything RSE will give, so the comparison is against
// its fullest answer rather than against what we thought to request.
//
// AND FOLLOW oslc:next. This query base pages — ResponseInfo, oslc:next,
// totalCount — unlike the SysML routes, which say nothing. Reading page one
// only matched for as long as the model fitted on it, which is exactly how a
// truncated answer passes for a complete one.
const store = rdflib.graph();
const RES = /\/resource\/[0-9a-f-]{36}$/;
const seen = new Set();
let page = `${AM}/resource`, pages = 0;
while (page && pages < 50) {
  const res = await fetch(page, { headers: { ...H, Accept: 'text/turtle', 'Configuration-Context': ctxUriForAm } });
  const g = rdflib.graph();
  rdflib.parse(await res.text(), g, AM, 'text/turtle');
  const before = seen.size;
  for (const st of g.statements) { store.add(st); const u = String(st.subject.value); if (RES.test(u)) seen.add(u); }
  pages++;
  // There is no page two (quirk 37g): the same URL returns a different unstable
  // sample of 100 each time, and `nextPage` advertises `pageNum=1` forever. So
  // read until the accumulated DISTINCT count reaches oslc:totalCount, which is
  // the only field here that tells the truth, and give up rather than loop.
  const tc = g.statementsMatching(null, rdflib.sym('http://open-services.net/ns/core#totalCount'), null)
    .map((st) => Number(st.object.value)).find((n) => Number.isFinite(n));
  if (tc && seen.size >= tc) break;
  if (!tc && seen.size === before) break;
  const next = g.any(null, rdflib.sym('http://open-services.net/ns/core#nextPage'), null);
  page = next ? String(next.value) : `${AM}/resource`;
}
console.log(`OSLC path read in ${pages} page${pages === 1 ? '' : 's'}`);
const DC = (p) => rdflib.sym(`http://purl.org/dc/terms/${p}`);
const lit = (s, p) => { const v = store.any(rdflib.sym(s), p); return v ? String(v.value) : undefined; };

const oslc = new Map();
const RESOURCE = new RegExp(`^${AM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/resource/[0-9a-f-]{36}$`);
for (const uri of new Set(store.statements.map((st) => String(st.subject.value)).filter((u) => RESOURCE.test(u)))) {
  oslc.set(uri, {
    title: lit(uri, DC('title')),
    shortTitle: lit(uri, rdflib.sym('http://open-services.net/ns/core#shortTitle')),
    description: lit(uri, DC('description')),
  });
}

// ---- path B: the adapter -----------------------------------------------------
const Q = (property, value, select) => runQuery(http, BASE, rse.projectId, commit, { property, value, select });
// ONE commit-scoped read. query-results cannot be used here: it ignores
// commitId and answers the union across the project's history (quirk 37c).
const all = await fetchCommitElements(http, BASE, rse.projectId, commit);
const exposed = all.filter((e) => !NOT_EXPOSED.has(e['@type']));
const docs = all.filter((e) => e['@type'] === 'Documentation');
const linkRows = all.filter((e) => e['@type'] === 'OSLCLink');
// Link types ARE project-level, so the configuration-blind route is correct for them.
const ltRows = await Q('@type', 'OSLCLinkType', ['@id', 'linkTypeURI']);
const linkTypeUris = new Map(ltRows.map((r) => [r['@id'], r.linkTypeURI]));
const { links, unresolved } = indexLinks(linkRows, linkTypeUris, new Map(all.map((e) => [e['@id'], e])));
const byId = new Map(all.map((e) => [e['@id'], e]));
const pctx = { amBase: AM, descriptions: indexDescriptions(docs, byId), links };
const adapted = new Map(exposed.map((e) => [resourceUri(AM, e['@id']), projectResource(e, pctx)]));

// ---- diff --------------------------------------------------------------------
console.log(`OSLC path   ${oslc.size} resources`);
console.log(`adapter     ${adapted.size} resources   (links ${linkRows.length}, unresolved ${unresolved}, docs ${docs.length})\n`);

const onlyOslc = [...oslc.keys()].filter((u) => !adapted.has(u));
const onlyAdapter = [...adapted.keys()].filter((u) => !oslc.has(u));
let identical = 0, adds = 0; const differs = [];
for (const [uri, a] of oslc) {
  const b = adapted.get(uri); if (!b) continue;
  const d = [];
  if ((a.title ?? '') !== (b.title ?? '')) d.push(`title ${JSON.stringify(a.title)} vs ${JSON.stringify(b.title)}`);
  if ((a.shortTitle ?? '') !== (b.shortTitle ?? '')) d.push(`shortTitle ${JSON.stringify(a.shortTitle)} vs ${JSON.stringify(b.shortTitle)}`);
  if (d.length) differs.push(`${uri.slice(-12)}  ${d.join('; ')}`);
  else if (b.description && !a.description) adds++;
  else identical++;
}
console.log(`  identical            ${identical}`);
console.log(`  adapter adds         ${adds}   (dcterms:description the OSLC path cannot serve)`);
console.log(`  DIFFERS              ${differs.length}`);
differs.slice(0, 10).forEach((l) => console.log(`      ${l}`));
console.log(`  only via OSLC        ${onlyOslc.length}`);
onlyOslc.slice(0, 5).forEach((u) => console.log(`      ${u.slice(-36)}`));
console.log(`  only via the adapter ${onlyAdapter.length}`);
onlyAdapter.slice(0, 5).forEach((u) => console.log(`      ${u.slice(-36)}  ${adapted.get(u).types.at(-1)?.split('#').pop()}`));

process.exit(differs.length || onlyOslc.length || onlyAdapter.length ? 1 : 0);
