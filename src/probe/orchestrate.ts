import type { DiscoveredServiceProvider } from 'oslc-service/mcp';
import { probeGet, probeQueryGet, probeQueryPost, type ProbeHttp } from './request.js';
import {
  chooseFixtureType,
  createManifest,
  fixtureSpecs,
  fixtureRdfXml,
  requiredExtras,
  type FixtureSpec,
} from './fixture.js';
import { sampleGroundTruth, type GroundTruth, type KnownResource } from './ground-truth.js';
import { memberURIs, type CaseResult } from './verdicts.js';
import {
  caseBareGet,
  caseNegationPair,
  caseOrderBy,
  casePaging,
  casePostVersusGet,
  casePrefixDiscovery,
  caseSearchTerms,
  caseSelect,
  caseWhereConstructs,
  caseWhereIdentity,
  PROBE_PREFIXES,
  resolveDistinguishing,
  type CaseContext,
} from './query-cases.js';

/**
 * Which method the remaining cases must use.
 *
 * POST-form query is the primary form (§6.3), but whether it works is itself a
 * case — and a server that refuses it would otherwise fail every later case with
 * the same 405, burying one finding under ten false ones. So case 2 runs first
 * and its answer configures the rest.
 */
async function detectUsePost(
  http: ProbeHttp,
  queryBase: string
): Promise<{ usePost: boolean; caseResult: CaseResult }> {
  const caseResult = await casePostVersusGet({ http, queryBase, usePost: true, truth: emptyTruth() });
  const postRefused = /POST answered \d+ while GET answered/.test(caseResult.reason);
  return { usePost: !postRefused, caseResult };
}

export type ProbeMode = 'fixture' | 'read-only';

export interface ProbeRun {
  mode: ProbeMode;
  /** Why this mode, in the server's terms — a capability outcome, never a permission one. */
  modeReason: string;
  serviceProvidersWritten: string[];
  cases: CaseResult[];
  /** Absent in read-only mode, where there is no fixture to be visible. */
  fixtureVisibleToQuery?: boolean;
  needingCleanup: string[];
  /** `null` when it was never established, because nothing was created. */
  deleteSupported: boolean | null;
}

const DCTERMS_IDENTIFIER = 'http://purl.org/dc/terms/identifier';
const DCTERMS_TITLE = 'http://purl.org/dc/terms/title';

/** Create one resource, returning its URI when the server said where it put it. */
async function create(
  http: ProbeHttp,
  creationURI: string,
  body: string
): Promise<{ ok: boolean; uri: string | null; status: number; message: string | null }> {
  const response = await http.request({
    method: 'POST',
    url: creationURI,
    // RDF/XML both ways: it is the representation OSLC Core requires every
    // server to support, so a refusal is a finding rather than an artefact of
    // having asked in an optional format.
    headers: { 'Content-Type': 'application/rdf+xml', 'OSLC-Core-Version': '2.0', 'Accept': 'application/rdf+xml' },
    data: body,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(b: unknown) => b],
  });
  const location = response.headers?.location ?? response.headers?.Location ?? null;
  return {
    ok: response.status < 400,
    uri: location,
    status: response.status,
    message: oslcMessage(response.data),
  };
}

async function remove(http: ProbeHttp, uri: string): Promise<boolean> {
  const response = await http.request({
    method: 'DELETE',
    url: uri,
    headers: { 'OSLC-Core-Version': '2.0' },
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(b: unknown) => b],
  });
  return response.status < 400;
}

/** Literal values of a predicate, read out of an RDF/XML body without a full parse. */
function literalValues(body: string, predicateLocalName: string): string[] {
  const pattern = new RegExp(`<[^>]*:${predicateLocalName}[^>]*>([^<]*)<`, 'g');
  return [...body.matchAll(pattern)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * The `oslc:Error` message a server sent with a refusal.
 *
 * Reported rather than discarded, because the status alone sends the reader to
 * the wrong place: EWM answers a **403** when a work item fails a save
 * precondition ("The 'Filed Against' attribute needs to be set"), which reads as
 * an authorization problem and is not one. The server almost always says exactly
 * what is wrong; a probe that drops it makes the caller rediscover it by hand.
 */
function oslcMessage(body: unknown): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  const match = /<oslc:message[^>]*>([\s\S]*?)<\/oslc:message>/.exec(body);
  if (!match) return null;
  const text = match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Ground truth from a fixture the probe created, read back by URI.
 *
 * Read back rather than assumed: a server may normalise or drop what was sent,
 * and a case comparing against what was *sent* would then measure the probe's
 * intent instead of the server's state.
 */
async function readBackGroundTruth(
  http: ProbeHttp,
  created: Array<{ uri: string; spec: FixtureSpec }>
): Promise<{ truth: GroundTruth; dropped: Array<{ uri: string; property: string }> }> {
  const resources: KnownResource[] = [];
  const dropped: Array<{ uri: string; property: string }> = [];

  for (const { uri, spec } of created) {
    const response = await probeGet(http, uri);
    const identifiers = literalValues(response.body, 'identifier');
    const titles = literalValues(response.body, 'title');

    // Phase 3 compares in ONE direction: a property sent that did not come
    // back is a finding; a property returned that was never sent is a server
    // annotation (oslc:serviceProvider, dcterms:created, …) and conformant.
    // Only properties the fixture actually SENT can be reported as dropped.
    // dcterms:identifier is not sent (Core makes it server-assigned), so its
    // absence is not a finding — reporting it was five false findings per run
    // against any server that assigns its own ids.
    if (!titles.includes(spec.title)) dropped.push({ uri, property: DCTERMS_TITLE });

    resources.push({
      uri,
      properties: new Map([
        [DCTERMS_IDENTIFIER, identifiers],
        [DCTERMS_TITLE, titles],
      ]),
    });
  }
  return { truth: { kind: 'fixture', resources, baseline: created.map((c) => c.uri) }, dropped };
}

/** Every case, in order, flattened — the ones returning lists included. */
async function runCases(ctx: CaseContext): Promise<CaseResult[]> {
  // casePostVersusGet is run by detectUsePost before this, so it is not repeated.
  //
  // Prefix discovery goes FIRST, and undeclared — it is the case that measures
  // whether a prefix has to be declared, so declaring one would answer its own
  // question. Every later case then takes the answer: where the server
  // predefines nothing, they declare prefixes explicitly instead of failing for
  // a reason already established. DOORS Next predefines none, and without this
  // its select, where and construct cases all recorded 400s that said nothing
  // about its query support.
  const results: CaseResult[] = [...(await casePrefixDiscovery(ctx))];
  const predefined = results.some((r) => r.verdict === 'supported');
  const declared: CaseContext = predefined ? ctx : { ...ctx, prefixes: PROBE_PREFIXES };
  if (!predefined) {
    results.push({
      name: 'prefix-declaration',
      verdict: 'supported',
      reason: `no prefix was predefined, so the remaining cases declare them: ${PROBE_PREFIXES}`,
      transcripts: [],
    });
  }

  // Confirm, by query, a value that identifies exactly one resource — once, so
  // every filter case builds on the same confirmed value instead of each trusting
  // a sample of five that may not be unique across the collection.
  const resolved = await resolveDistinguishing(declared);
  const withKnown: CaseContext = { ...declared, known: resolved.known, knownReason: resolved.reason };
  results.push({
    name: 'distinguishing-value',
    verdict: resolved.known ? 'supported' : 'inconclusive',
    reason: resolved.reason,
    ...(resolved.known ? {} : {
      expected: 'a filter on one sampled value returns exactly the resource that carries it, ' +
        'which the identity, negation, construct and prefix cases all build on',
    }),
    transcripts: [],
  });

  const single = [caseBareGet, caseWhereIdentity, caseNegationPair,
                  caseSelect, caseOrderBy, casePaging, caseSearchTerms];
  for (const one of single) results.push(await one(withKnown));
  results.push(...(await caseWhereConstructs(withKnown)));
  return results;
}

/** Every case marked inconclusive for one reason, without sending anything. */
function allInconclusive(reason: string, expected: string): CaseResult[] {
  const names = ['bare-query', 'post-versus-get', 'where-identity', 'negation-pair', 'select',
                 'order-by', 'paging', 'search-terms', 'prefix-discovery', 'where-constructs'];
  return names.map((name) => ({ name, verdict: 'inconclusive' as const, reason, expected, transcripts: [] }));
}

/**
 * The seven phases (§5.2), degrading rather than stopping.
 *
 * Read-only is a fallback the server's capabilities determine (D3), never a
 * separate mode the caller picks: a provider advertising no creation factory,
 * or refusing a create, yields weaker verification — and the report says so
 * rather than quietly measuring less.
 */
export async function runProbe(args: {
  http: ProbeHttp;
  sp: DiscoveredServiceProvider;
  queryBase: string;
  onDeleteUnsupported: 'stop' | 'proceed' | 'read-only';
  manifestWrite: (line: string) => void;
}): Promise<ProbeRun> {
  const { http, sp, queryBase, onDeleteUnsupported, manifestWrite } = args;
  const manifest = createManifest(manifestWrite);
  const serviceProvidersWritten: string[] = [];
  const needingCleanup: string[] = [];

  const readOnly = async (modeReason: string, deleteSupported: boolean | null): Promise<ProbeRun> => {
    // Phases 4 and 7 only, with ground truth sampled from what is already there.
    const { usePost, caseResult: methodCase } = await detectUsePost(http, queryBase);
    const baseline = memberURIs(await bodyOf(http, queryBase), queryBase);
    const truth = await sampleGroundTruth(http, baseline);
    const cases = [methodCase, ...(await runCases({ http, queryBase, truth, usePost }))];
    return { mode: 'read-only', modeReason, serviceProvidersWritten, cases, needingCleanup, deleteSupported };
  };

  // ── Phase 1: can this server be written to, and can what it writes be removed? ──
  const factory = chooseFixtureType(sp);
  if (!factory || !factory.creationURI) {
    return readOnly('no creation factory advertised', null);
  }

  const specs = fixtureSpecs();
  const probeSpec = specs[0];
  manifest.record('probe-artifact (pending)');
  const probe = await create(http, factory.creationURI,
    fixtureRdfXml(probeSpec, factory.resourceType, requiredExtras(factory.shape, probeSpec.title)));
  if (!probe.ok) {
    return readOnly(
      `the creation factory refused a create with ${probe.status}` +
      (probe.message ? ` — ${probe.message}` : ''),
      null
    );
  }
  serviceProvidersWritten.push(sp.uri);

  // A create that succeeds without saying where it put the resource leaves
  // residue that cannot be named, deleted, or recorded in the manifest — worse
  // than a delete that fails, because nothing can be handed to a person to
  // clean up. Stop building on it and say so.
  if (!probe.uri) {
    return readOnly(
      `the creation factory answered ${probe.status} without a Location header, ` +
      'so the resource it created cannot be identified or removed',
      null
    );
  }

  const deleteSupported: boolean | null = await remove(http, probe.uri);
  if (!deleteSupported) needingCleanup.push(probe.uri);

  if (deleteSupported === false) {
    if (onDeleteUnsupported === 'stop') {
      return {
        mode: 'read-only',
        modeReason: 'delete is unsupported and the caller chose to stop rather than leave residue',
        serviceProvidersWritten, cases: [], needingCleanup, deleteSupported,
      };
    }
    if (onDeleteUnsupported === 'read-only') {
      return readOnly('delete is unsupported and the caller chose read-only', deleteSupported);
    }
    // 'proceed' — the caller accepted a permanently populated target.
  }

  // ── Phase 2: the fixture, each URI recorded BEFORE its create ──
  const created: Array<{ uri: string; spec: FixtureSpec }> = [];
  for (const spec of specs) {
    manifest.record(`${spec.identifier} (pending)`);
    const made = await create(http, factory.creationURI,
      fixtureRdfXml(spec, factory.resourceType, requiredExtras(factory.shape, spec.title)));
    if (made.ok && made.uri) {
      manifest.record(made.uri);
      created.push({ uri: made.uri, spec });
    }
  }
  if (created.length === 0) {
    return readOnly('the fixture could not be created, though a single artifact could', deleteSupported);
  }

  // ── Phase 3: read back; report only what was sent and did not return ──
  const { truth, dropped } = await readBackGroundTruth(http, created);

  // ── Phase 4: is the fixture visible to query at all, before judging filters? ──
  const { usePost, caseResult: methodCase } = await detectUsePost(http, queryBase);
  const unfiltered = usePost
    ? await probeQueryPost(http, queryBase, [])
    : await probeQueryGet(http, queryBase, []);
  const visibleMembers = memberURIs(unfiltered.body, queryBase);
  const fixtureVisibleToQuery = created.some((c) => visibleMembers.includes(c.uri));

  const cases: CaseResult[] = fixtureVisibleToQuery
    ? [methodCase, ...(await runCases({ http, queryBase, truth, usePost }))]
    : [methodCase, ...allInconclusive(
        'fixture not visible to query',
        'the resources just created appear among the query base members'
      )];

  for (const drop of dropped) {
    cases.push({
      name: `property-dropped:${drop.property}`,
      verdict: 'unsupported',
      reason: `${drop.property} was sent on create and did not come back on read`,
      transcripts: [],
    });
  }

  // ── Phases 6 and 7: remove the fixture, then confirm removal is visible ──
  for (const { uri } of created) {
    if (!(await remove(http, uri))) needingCleanup.push(uri);
  }

  return {
    mode: 'fixture',
    modeReason: 'a creation factory was advertised and the fixture was created',
    serviceProvidersWritten,
    cases,
    fixtureVisibleToQuery,
    needingCleanup,
    deleteSupported,
  };
}

function emptyTruth(): GroundTruth {
  return { kind: 'sampled', resources: [], baseline: [] };
}

/**
 * The unparameterised query, for the baseline.
 *
 * Always GET, whatever `post-versus-get` concluded: a form POST with an empty
 * body is not an OSLC query — ETM and DOORS Next answer 415 and 403 to one — and
 * POST-query exists for parameter lists too long for a URL, which an
 * unparameterised query does not have. Sending it as POST because POST *works*
 * emptied the baseline and took every filter case with it.
 */
async function bodyOf(http: ProbeHttp, queryBase: string): Promise<string> {
  return (await probeQueryGet(http, queryBase, [])).body;
}
