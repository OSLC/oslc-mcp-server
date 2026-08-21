import rdflib from 'rdflib';

const { graph, parse, sym } = rdflib as any;

const RDFS_MEMBER = 'http://www.w3.org/2000/01/rdf-schema#member';
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

/**
 * The outcome of one probe case (§8).
 *
 * `ignored` is the verdict this whole design exists to produce: the request
 * was accepted and did nothing. `inconclusive` means the measurement could
 * not be made — never a pass, and never omitted from the report.
 */
export type Verdict = 'supported' | 'unsupported' | 'ignored' | 'error' | 'inconclusive';

export interface CaseResult {
  name: string;
  verdict: Verdict;
  reason: string;
  /** What a correct result would have looked like. Required for `inconclusive`. */
  expected?: string;
  transcripts: string[];
}

/**
 * Member URIs of a query response.
 *
 * Servers vary in how they express membership, so both rdfs:member and
 * ldp:contains are accepted. An unparseable body yields an empty list rather
 * than an exception — a body that does not parse is a result to record, not a
 * crash.
 */
export function memberURIs(rdfXml: string, queryBase: string): string[] {
  const store = graph();
  try {
    parse(rdfXml, store, queryBase, 'application/rdf+xml');
  } catch {
    return [];
  }
  const uris: string[] = [];
  for (const predicate of [RDFS_MEMBER, LDP_CONTAINS]) {
    for (const statement of store.statementsMatching(null, sym(predicate), null)) {
      if (statement.object.termType === 'NamedNode') uris.push(statement.object.value);
    }
  }
  return [...new Set(uris)];
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

/**
 * Did a filter that should match exactly one known resource do so?
 *
 * By identity, not by count (§8.3): one result that is the wrong resource is
 * not a filter that worked.
 */
export function judgeFilter(args: {
  returned: string[];
  expectedURI: string;
  baseline: string[];
}): { verdict: Verdict; reason: string } {
  const { returned, expectedURI, baseline } = args;

  if (baseline.length < 2) {
    return {
      verdict: 'inconclusive',
      reason: `the baseline holds ${baseline.length} resource(s), so a filter cannot be told from no filter`,
    };
  }
  if (returned.length === 1 && returned[0] === expectedURI) {
    return { verdict: 'supported', reason: 'exactly the expected resource was returned, by identity' };
  }
  if (sameSet(returned, baseline)) {
    return { verdict: 'ignored', reason: 'every resource in the baseline was returned, so the filter did nothing' };
  }
  if (returned.length === 0) {
    return { verdict: 'unsupported', reason: 'no resources were returned, though one was expected' };
  }
  return {
    verdict: 'unsupported',
    reason: `${returned.length} resource(s) returned, and ${expectedURI} was ${returned.includes(expectedURI) ? 'among them' : 'not among them'}`,
  };
}

/**
 * The negation pair (§8.3). `a="v"` and `a!="v"` should partition the
 * baseline: together they account for it exactly, and neither alone equals
 * it. Needs nothing known in advance, so it works in every mode.
 */
export function judgePartition(args: {
  matching: string[];
  notMatching: string[];
  baseline: string[];
}): { verdict: Verdict; reason: string } {
  const { matching, notMatching, baseline } = args;

  if (baseline.length < 2) {
    return { verdict: 'inconclusive', reason: 'the baseline is too small to partition' };
  }
  if (sameSet(matching, baseline) && sameSet(notMatching, baseline)) {
    return {
      verdict: 'ignored',
      reason: 'both a filter and its negation returned the whole baseline, so neither was applied',
    };
  }

  const overlap = matching.filter((uri) => notMatching.includes(uri));
  if (overlap.length > 0) {
    return {
      verdict: 'unsupported',
      reason: `${overlap.length} resource(s) overlap: they matched both a filter and its negation, which cannot both be true`,
    };
  }
  if (!sameSet([...matching, ...notMatching], baseline)) {
    return {
      verdict: 'unsupported',
      reason:
        `a filter and its negation returned ${matching.length + notMatching.length} resources between them, ` +
        `against a baseline of ${baseline.length} — they do not account for it`,
    };
  }
  return { verdict: 'supported', reason: 'the filter and its negation partition the baseline exactly' };
}

/** Ordering took effect when the leading member differs between directions. */
export function judgeOrdering(
  ascending: string[],
  descending: string[]
): { verdict: Verdict; reason: string } {
  if (ascending.length === 0 || descending.length === 0) {
    return { verdict: 'inconclusive', reason: 'one or both orderings returned no resources' };
  }
  if (ascending[0] === descending[0]) {
    return {
      verdict: 'ignored',
      reason: `both directions lead with ${ascending[0]}, so the ordering was not applied`,
    };
  }
  return { verdict: 'supported', reason: 'the leading member differs between ascending and descending' };
}
