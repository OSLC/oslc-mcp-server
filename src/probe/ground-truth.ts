// rdflib is CommonJS — take the default and destructure.
import rdflib from 'rdflib';
import { probeGet, type ProbeHttp } from './request.js';

const { graph, parse } = rdflib as any;

/** A resource whose property values are known. */
export interface KnownResource {
  uri: string;
  /** Predicate URI → its literal values, as actually present. */
  properties: Map<string, string[]>;
}

/**
 * Resources whose values are known, and the full set they were drawn from.
 *
 * `kind` records how the knowledge was obtained, because it changes what the
 * report may claim: a fixture is known by construction, a sample only by
 * having been read. Every query case works against this, so a case is written
 * once and runs whether or not the server could be written to (§5.5).
 */
export interface GroundTruth {
  kind: 'fixture' | 'sampled';
  resources: KnownResource[];
  /** Every member URI visible from the query base — the partition denominator. */
  baseline: string[];
}

/** Whether ground truth can support a given case, and why not when it cannot. */
export interface Adequacy {
  ok: boolean;
  reason: string;
}

/** Values of a predicate on a resource, or an empty array. */
function valuesOf(resource: KnownResource, predicate: string): string[] {
  return resource.properties.get(predicate) ?? [];
}

/**
 * A value carried by exactly one resource.
 *
 * This is what makes `ignored` exact: filter for it and one result means the
 * filter was honoured, the whole baseline means it was ignored.
 */
export function distinguishingValue(
  truth: GroundTruth,
  predicate: string
): { uri: string; value: string } | null {
  const counts = new Map<string, string[]>();
  for (const resource of truth.resources) {
    for (const value of valuesOf(resource, predicate)) {
      counts.set(value, [...(counts.get(value) ?? []), resource.uri]);
    }
  }
  for (const [value, uris] of counts) {
    if (uris.length === 1) return { uri: uris[0], value };
  }
  return null;
}

/** Ordering can only be observed when at least two values differ. */
export function canOrderBy(truth: GroundTruth, predicate: string): Adequacy {
  const values = truth.resources.flatMap((r) => valuesOf(r, predicate));
  if (values.length < 2) {
    return { ok: false, reason: `fewer than two resources carry ${predicate}` };
  }
  const distinct = new Set(values);
  if (distinct.size < 2) {
    return { ok: false, reason: `every sampled value of ${predicate} is identical, so order is unobservable` };
  }
  return { ok: true, reason: '' };
}

/** Paging is only observable when more resources exist than fit on a page. */
export function enoughForPaging(truth: GroundTruth, pageSize: number): Adequacy {
  if (truth.baseline.length <= pageSize) {
    return {
      ok: false,
      reason: `only ${truth.baseline.length} resources are visible, which fits in one page of ${pageSize}`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * A word present in one resource's value and absent from the rest, for
 * oslc.searchTerms. Words shorter than four characters are skipped: they
 * match too readily to distinguish anything.
 */
export function termForSearch(
  truth: GroundTruth,
  predicate: string
): { term: string; uri: string } | null {
  const wordsByResource = truth.resources.map((resource) => ({
    uri: resource.uri,
    words: new Set(
      valuesOf(resource, predicate)
        .join(' ')
        .split(/\W+/)
        .filter((w) => w.length >= 4)
        .map((w) => w.toLowerCase())
    ),
  }));

  for (const { uri, words } of wordsByResource) {
    for (const word of words) {
      const elsewhere = wordsByResource.some((o) => o.uri !== uri && o.words.has(word));
      if (!elsewhere) return { term: word, uri };
    }
  }
  return null;
}

/**
 * Learn ground truth by reading members **by URI**.
 *
 * Reading by URI does not go through the query index, so this measures what
 * the resources actually contain rather than what a query says they contain —
 * which is the whole point: the queries are what is under test.
 *
 * A member that cannot be read is skipped rather than failing the sample; the
 * baseline still counts it, because it is still a resource the query base
 * returned.
 */
export async function sampleGroundTruth(
  http: ProbeHttp,
  memberURIs: string[],
  limit = 5
): Promise<GroundTruth> {
  const resources: KnownResource[] = [];

  for (const uri of memberURIs.slice(0, limit)) {
    const response = await probeGet(http, uri);
    if (response.status >= 400 || !response.body) continue;

    const store = graph();
    try {
      parse(response.body, store, uri, 'application/rdf+xml');
    } catch {
      continue; // unreadable is not fatal — sample what can be read
    }

    const properties = new Map<string, string[]>();
    for (const statement of store.statementsMatching(store.sym(uri), null, null)) {
      // Literals only. An object reference is not a value a filter can match
      // on without knowing the server's URI minting, which is not known here.
      // (oslc:serviceProvider is the exception worth revisiting: where a server
      // sets it on every resource it would let the probe confirm a sampled
      // resource really belongs to the service provider under test.)
      if (statement.object.termType !== 'Literal') continue;
      const predicate = statement.predicate.value;
      properties.set(predicate, [...(properties.get(predicate) ?? []), statement.object.value]);
    }
    resources.push({ uri, properties });
  }

  return { kind: 'sampled', resources, baseline: memberURIs };
}
