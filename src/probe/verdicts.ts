import rdflib from 'rdflib';
import { membersFromStore } from '../oslc-members.js';

const { graph, parse } = rdflib as any;

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
 * The reading itself is shared with the generic `query_resources` tool — see
 * `membersFromStore` for why standard predicates alone are not enough. Here it
 * takes the response as text, because the probe records what came off the wire
 * rather than a parsed resource.
 *
 * An unparseable body yields an empty list rather than an exception — a body
 * that does not parse is a result to record, not a crash.
 */
export function memberURIs(rdfXml: string, queryBase: string): string[] {
  const store = graph();
  try {
    parse(rdfXml, store, queryBase, 'application/rdf+xml');
  } catch {
    return [];
  }
  return membersFromStore(store, queryBase);
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
 * A clause whose correct answer is the baseline MINUS one resource — `a!="v"`.
 *
 * Judged by exclusion rather than by an exact expected set, because the baseline
 * is page one of the unparameterised query: a server that pages returns a subset
 * of the complement, and demanding the exact complement would report a working
 * `!=` as broken. What a working `!=` must do is leave the named resource out
 * while returning others; what a dropped clause does is return it anyway.
 */
export function judgeComplement(args: {
  returned: string[];
  excludedURI: string;
  baseline: string[];
}): { verdict: Verdict; reason: string } {
  const { returned, excludedURI, baseline } = args;

  if (baseline.length < 2) {
    return {
      verdict: 'inconclusive',
      reason: `the baseline holds ${baseline.length} resource(s), so a complement cannot be told from no filter`,
    };
  }
  if (returned.includes(excludedURI)) {
    return sameSet(returned, baseline)
      ? { verdict: 'ignored', reason: 'the whole baseline came back, so the clause was not applied' }
      : {
          verdict: 'unsupported',
          reason: `${excludedURI} was returned, though the clause excludes it`,
        };
  }
  if (returned.length === 0) {
    return {
      verdict: 'unsupported',
      reason: `nothing was returned, though the baseline holds ${baseline.length - 1} other resource(s)`,
    };
  }
  const expected = baseline.filter((uri) => uri !== excludedURI);
  return sameSet(returned, expected)
    ? { verdict: 'supported', reason: 'exactly the baseline without the excluded resource' }
    : {
        verdict: 'supported',
        reason: `the excluded resource was left out and ${returned.length} of ${expected.length} other(s) ` +
          'came back — consistent with the clause applied and the result paged',
      };
}

/**
 * A clause whose correct answer is a RANGE — `a>"v"`. Zero or many, and which
 * resources depends on a collation the server chooses and does not publish, so
 * there is no expected set to compare against.
 *
 * Two invariants hold whatever the collation: a strict `>` never returns the
 * boundary value itself, and a clause that was applied does not return the whole
 * baseline. An empty result satisfies both and proves nothing — it is what a
 * boundary at the maximum and a silently dropped clause both look like.
 */
export function judgeRange(args: {
  returned: string[];
  boundaryURI: string;
  baseline: string[];
}): { verdict: Verdict; reason: string; expected?: string } {
  const { returned, boundaryURI, baseline } = args;

  if (baseline.length < 2) {
    return {
      verdict: 'inconclusive',
      reason: `the baseline holds ${baseline.length} resource(s), so a range cannot be told from no filter`,
    };
  }
  if (sameSet(returned, baseline)) {
    return { verdict: 'ignored', reason: 'the whole baseline came back, so the clause was not applied' };
  }
  if (returned.includes(boundaryURI)) {
    return {
      verdict: 'unsupported',
      reason: `${boundaryURI} was returned, though a strict comparison excludes the boundary value`,
    };
  }
  if (returned.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: 'nothing was returned, which is what both a boundary at the greatest value and a ' +
        'dropped clause look like',
      expected: 'a subset of the baseline, excluding the boundary resource',
    };
  }
  return {
    verdict: 'supported',
    reason: `${returned.length} of ${baseline.length} returned, with the boundary resource excluded`,
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
  // A resource NOT in either half is not a failure. A property filter can only
  // match resources that carry the property, so anything lacking it falls outside
  // both `a="v"` and `a!="v"` — correctly. DOORS Next's unfiltered requirement
  // query returns four `materializedviews/VW_…` objects alongside its 578
  // artifacts; they are internal, they 403 on GET, and both halves rightly leave
  // them out. Demanding that the two halves exhaust the baseline reported that as
  // a broken negation.
  //
  // What must hold is that the halves do not overlap, that each is a proper part,
  // and that neither strays outside the baseline.
  const strays = [...matching, ...notMatching].filter((uri) => !baseline.includes(uri));
  if (strays.length > 0) {
    return {
      verdict: 'unsupported',
      reason: `${strays.length} resource(s) were returned that the unfiltered query did not`,
    };
  }
  if (matching.length === 0 && notMatching.length === 0) {
    return { verdict: 'unsupported', reason: 'neither the filter nor its negation returned anything' };
  }

  const accounted = matching.length + notMatching.length;
  return accounted === baseline.length
    ? { verdict: 'supported', reason: 'the filter and its negation partition the baseline exactly' }
    : {
        verdict: 'supported',
        reason:
          `the filter and its negation partition ${accounted} of ${baseline.length} without overlap; ` +
          `${baseline.length - accounted} carry no value for the property and fall outside both, as they should`,
      };
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
