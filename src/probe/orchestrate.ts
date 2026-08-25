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
import { classifyRefusal, refusalAdvice, type Refusal } from './refusal.js';
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
  /**
   * Which ground truth the verdicts actually rest on.
   *
   * Reported because the run's *mode* does not settle it: a fixture run whose
   * fixture is invisible to a particular capability falls back to sampling, and
   * a report that claims one while doing the other is worse than either.
   */
  groundTruthUsed?: 'fixture' | 'sampled';
  needingCleanup: string[];
  /** `null` when it was never established, because nothing was created. */
  deleteSupported: boolean | null;
  /**
   * Why a refusal happened, where one did. Reported so the caller is sent to
   * the right place: a licence and a permission are different administrative
   * queues, a CSRF failure is the client's, and only an unclassified refusal is
   * evidence that an operation is genuinely unsupported.
   */
  refusals?: Array<{ operation: string; status: number; kind: Refusal['kind']; message: string | null; advice: string | null }>;
}

/**
 * Fetch allowed values a shape referenced rather than inlined.
 *
 * `oslc:allowedValues` may point at a **separate document**, and EWM's does:
 * the Defect shape carries `oslc:allowedValues rdf:resource="…/property/category/allowedValues"`
 * and not one `oslc:allowedValue` for it. A client that reads only the shape
 * document sees an empty list for a property that is `Exactly-one`, skips it,
 * and gets a 403 precondition it has no way to explain.
 *
 * Failure is not fatal: an empty list leaves the property unset, which is the
 * behaviour before this existed.
 */
async function dereferenceAllowedValues(http: ProbeHttp, documentURI: string): Promise<string[]> {
  try {
    const body = await bodyOf(http, documentURI);
    return [...body.matchAll(/<oslc:allowedValue rdf:resource="([^"]+)"/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

const DCTERMS_IDENTIFIER = 'http://purl.org/dc/terms/identifier';
const DCTERMS_TITLE = 'http://purl.org/dc/terms/title';

/** Create one resource, returning its URI when the server said where it put it. */
/**
 * Headers every mutating request carries.
 *
 * `X-Jazz-CSRF-Prevent` is required by some Jazz operations and not others —
 * measured, EWM accepted a `POST` to a creation factory without it and refused
 * the `DELETE` of the resource it had just created. So it is sent on every
 * mutation rather than inferred from a successful one. Its value is the current
 * `JSESSIONID`; it is a credential, and `redactHeaders` keeps it out of
 * transcripts.
 */
function mutationHeaders(base: Record<string, string>, csrfToken?: string): Record<string, string> {
  return csrfToken ? { ...base, 'X-Jazz-CSRF-Prevent': csrfToken } : base;
}

async function create(
  http: ProbeHttp,
  creationURI: string,
  body: string,
  csrfToken?: string
): Promise<{ ok: boolean; uri: string | null; status: number; refusal: Refusal }> {
  const response = await http.request({
    method: 'POST',
    url: creationURI,
    // RDF/XML both ways: it is the representation OSLC Core requires every
    // server to support, so a refusal is a finding rather than an artefact of
    // having asked in an optional format.
    headers: mutationHeaders(
      { 'Content-Type': 'application/rdf+xml', 'OSLC-Core-Version': '2.0', 'Accept': 'application/rdf+xml' },
      csrfToken
    ),
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
    refusal: classifyRefusal(response.data),
  };
}

async function remove(
  http: ProbeHttp,
  uri: string,
  csrfToken?: string
): Promise<{ ok: boolean; status: number; refusal: Refusal }> {
  const response = await http.request({
    method: 'DELETE',
    url: uri,
    headers: mutationHeaders({ 'OSLC-Core-Version': '2.0', 'Accept': 'application/rdf+xml' }, csrfToken),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(b: unknown) => b],
  });
  // Any 2xx is success: measured, EWM answers 204 and DOORS Next and ETM answer
  // 200 to the same verb.
  return { ok: response.status < 400, status: response.status, refusal: classifyRefusal(response.data) };
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
  /**
   * The `oslc:resourceType` the query capability under test queries, so the
   * fixture is created from a factory that makes something it can see.
   */
  resourceType?: string;
  /**
   * Current `JSESSIONID`, sent as `X-Jazz-CSRF-Prevent` on every mutation.
   * Without it, Jazz servers refuse some mutations with a `403` that reads as a
   * permission problem — and a probe would record "delete unsupported" for a
   * server that supports it perfectly well.
   */
  csrfToken?: string;
}): Promise<ProbeRun> {
  const { http, sp, queryBase, onDeleteUnsupported, manifestWrite, csrfToken, resourceType } = args;
  const manifest = createManifest(manifestWrite);
  const serviceProvidersWritten: string[] = [];
  const needingCleanup: string[] = [];
  const refusals: ProbeRun['refusals'] = [];

  const note = (operation: string, status: number, refusal: Refusal): void => {
    if (refusal.kind === 'unclassified' && !refusal.message) return;
    refusals.push({
      operation, status, kind: refusal.kind,
      message: refusal.message, advice: refusalAdvice(refusal.kind),
    });
  };

  const readOnly = async (modeReason: string, deleteSupported: boolean | null): Promise<ProbeRun> => {
    // Phases 4 and 7 only, with ground truth sampled from what is already there.
    const { usePost, caseResult: methodCase } = await detectUsePost(http, queryBase);
    const baseline = memberURIs(await bodyOf(http, queryBase), queryBase);
    const truth = await sampleGroundTruth(http, baseline);
    const cases = [methodCase, ...(await runCases({ http, queryBase, truth, usePost }))];
    return { mode: 'read-only', modeReason, serviceProvidersWritten, cases, needingCleanup, deleteSupported, refusals };
  };

  // ── Phase 1: can this server be written to, and can what it writes be removed? ──
  const factory = chooseFixtureType(sp, resourceType);
  if (!factory || !factory.creationURI) {
    return readOnly('no creation factory advertised', null);
  }

  const specs = fixtureSpecs();
  const probeSpec = specs[0];
  manifest.record('probe-artifact (pending)');
  const probe = await create(http, factory.creationURI,
    fixtureRdfXml(probeSpec, factory.resourceType,
      await requiredExtras(factory.shape, probeSpec.title, (uri) => dereferenceAllowedValues(http, uri))),
    csrfToken);
  if (!probe.ok) {
    note('create', probe.status, probe.refusal);
    return readOnly(
      `the creation factory refused a create with ${probe.status}` +
      (probe.refusal.message ? ` — ${probe.refusal.message}` : '') +
      (refusalAdvice(probe.refusal.kind) ? ` [${probe.refusal.kind}] ${refusalAdvice(probe.refusal.kind)}` : ''),
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

  const removal = await remove(http, probe.uri, csrfToken);
  const deleteSupported: boolean | null = removal.ok;
  if (!removal.ok) {
    needingCleanup.push(probe.uri);
    // Why delete failed decides what the caller should do: a permission is an
    // administrator's to grant, a CSRF failure is ours, and only an
    // unclassified refusal is evidence that delete is genuinely unsupported.
    note('delete', removal.status, removal.refusal);
  }

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
      fixtureRdfXml(spec, factory.resourceType, await requiredExtras(factory.shape, spec.title, (uri) => dereferenceAllowedValues(http, uri))));
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
  let groundTruthUsed: 'fixture' | 'sampled' = 'fixture';

  // ── Phase 4: is the fixture visible to query at all, before judging filters? ──
  const { usePost, caseResult: methodCase } = await detectUsePost(http, queryBase);
  const unfiltered = usePost
    ? await probeQueryPost(http, queryBase, [])
    : await probeQueryGet(http, queryBase, []);
  const visibleMembers = memberURIs(unfiltered.body, queryBase);
  const fixtureVisibleToQuery = created.some((c) => visibleMembers.includes(c.uri));

  // A fixture the capability cannot see is not a reason to answer nothing.
  // §5.5: where a fixture cannot supply ground truth, it is *sampled* from
  // existing content — reading members by URI, which does not go through the
  // query index. Reporting `inconclusive` instead threw away every measurable
  // case against project areas holding hundreds of resources.
  //
  // Only when sampling also finds nothing is the answer genuinely inconclusive,
  // and then the reason says so rather than blaming the fixture.
  let cases: CaseResult[];
  if (fixtureVisibleToQuery) {
    cases = [methodCase, ...(await runCases({ http, queryBase, truth, usePost }))];
  } else {
    const sampled = await sampleGroundTruth(http, visibleMembers);
    if (sampled.resources.length > 0) {
      groundTruthUsed = 'sampled';
      cases = [methodCase, ...(await runCases({ http, queryBase, truth: sampled, usePost }))];
    } else {
      cases = [methodCase, ...allInconclusive(
        'the fixture is not visible to this query capability and its members could not be sampled',
        'either the created resources appear among the query base members, or existing members can be read by URI'
      )];
    }
  }

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
    const removal = await remove(http, uri, csrfToken);
    if (!removal.ok) {
      needingCleanup.push(uri);
      note('cleanup', removal.status, removal.refusal);
    }
  }

  return {
    mode: 'fixture',
    modeReason: 'a creation factory was advertised and the fixture was created',
    serviceProvidersWritten,
    cases,
    fixtureVisibleToQuery,
    groundTruthUsed,
    needingCleanup,
    deleteSupported,
    refusals,
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
