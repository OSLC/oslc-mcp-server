/**
 * Reading the members out of an OSLC query response.
 *
 * Shared by the generic `query_resources` tool and by `probe_oslc`, which found
 * the hard part: a query response does not reliably use a standard membership
 * predicate, and reading only the standard ones reports a populated project area
 * as empty.
 */
import type { IndexedFormula, NamedNode } from 'rdflib';

const RDFS_MEMBER = 'http://www.w3.org/2000/01/rdf-schema#member';
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OSLC_RESPONSE_INFO = 'http://open-services.net/ns/core#ResponseInfo';

/**
 * Predicates a container uses to describe *itself* rather than its members.
 *
 * Needed because membership is inferred structurally when no standard predicate
 * is present, and a container also says things about itself. Kept deliberately
 * short: anything not listed is treated as membership, so a domain predicate
 * nobody anticipated still counts — which is the whole point.
 */
const NOT_MEMBERSHIP = new Set([
  RDF_TYPE,
  'http://open-services.net/ns/core#nextPage',
  'http://open-services.net/ns/core#responseInfo',
  'http://open-services.net/ns/core#totalCount',
  'http://open-services.net/ns/core#serviceProvider',
  'http://open-services.net/ns/core#instanceShape',
  'http://open-services.net/ns/basicProfile#containerSortPredicates',
  'http://purl.org/dc/terms/title',
  'http://purl.org/dc/terms/description',
  'http://purl.org/dc/terms/publisher',
]);

/**
 * Member URIs of a query response, from a parsed store.
 *
 * Standard predicates first. Failing those, membership is taken **structurally**
 * — whatever the container points at — because OSLC's domain specifications give
 * query responses their own membership predicate and ELM's QM server uses one: a
 * Test Case query answers 200 with `oslc:totalCount 30` and links each result by
 * `oslc_qm:testCase`, never `rdfs:member`. Reading only the standard predicates
 * reported thirty test cases as zero.
 *
 * The container is the query base, or an `oslc:ResponseInfo` node — ELM
 * publishes that under a paged URI of its own rather than the query base, so
 * `oslc:totalCount` and the paging links hang off a different subject than the
 * members do.
 */
export function membersFromStore(store: IndexedFormula, queryBase: string): string[] {
  const uris: string[] = [];

  for (const predicate of [RDFS_MEMBER, LDP_CONTAINS]) {
    for (const statement of store.statementsMatching(null, store.sym(predicate), null)) {
      if (statement.object.termType === 'NamedNode') uris.push(statement.object.value);
    }
  }
  if (uris.length > 0) return [...new Set(uris)];

  const containers: NamedNode[] = [
    store.sym(queryBase),
    ...(store.each(null, store.sym(RDF_TYPE), store.sym(OSLC_RESPONSE_INFO)) as NamedNode[]),
  ];

  for (const container of containers) {
    for (const statement of store.statementsMatching(container, null, null)) {
      if (statement.object.termType !== 'NamedNode') continue;
      if (NOT_MEMBERSHIP.has(statement.predicate.value)) continue;
      if (statement.object.value === container.value) continue;
      uris.push(statement.object.value);
    }
  }

  return [...new Set(uris)];
}

/**
 * The server's own count of the whole result set, where it published one.
 *
 * Worth reporting alongside the members: they differ legitimately when a
 * response is paged, and they differ *informatively* when membership was read
 * wrongly. A caller comparing a verification count against an expected total
 * needs to know which it is looking at.
 */
export function totalCountFromStore(store: IndexedFormula): number | undefined {
  // statementsMatching, not any(): rdflib's any() returns whichever term
  // position is left wildcard, and with both subject and object wildcard it
  // returns the *subject*. That yielded a URI where a count was wanted.
  const [statement] = store.statementsMatching(
    null, store.sym('http://open-services.net/ns/core#totalCount'), null
  );
  if (!statement) return undefined;
  const value = Number(statement.object.value);
  return Number.isFinite(value) ? value : undefined;
}
