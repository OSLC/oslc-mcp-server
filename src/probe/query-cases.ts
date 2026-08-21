import { probeQueryGet, probeQueryPost, type ProbeHttp, type ProbeResponse } from './request.js';
import {
  canOrderBy,
  distinguishingValue,
  enoughForPaging,
  termForSearch,
  type GroundTruth,
} from './ground-truth.js';
import {
  judgeFilter,
  judgeOrdering,
  judgePartition,
  memberURIs,
  type CaseResult,
} from './verdicts.js';

const DCTERMS_TITLE = 'http://purl.org/dc/terms/title';
const DCTERMS_IDENTIFIER = 'http://purl.org/dc/terms/identifier';

/** What every case needs: how to send, where to send it, and what is known. */
export interface CaseContext {
  http: ProbeHttp;
  queryBase: string;
  truth: GroundTruth;
  /** POST-form query by default (§6.3); GET where case 2 showed POST does not work. */
  usePost: boolean;
}

export const WHERE_CONSTRUCTS: Array<{
  name: string;
  template: (p: string, v: string) => string;
  inSyntax: boolean;
}> = [
  { name: 'equality',       template: (p, v) => `${p}="${v}"`,                        inSyntax: true },
  { name: 'inequality',     template: (p, v) => `${p}!="${v}"`,                       inSyntax: true },
  { name: 'comparison',     template: (p, v) => `${p}>"${v}"`,                        inSyntax: true },
  { name: 'set-membership', template: (p, v) => `${p} in ["${v}"]`,                   inSyntax: true },
  { name: 'conjunction',    template: (p, v) => `${p}="${v}" and ${p}="${v}"`,        inSyntax: true },
  { name: 'scoped-terms',   template: (_p, v) => `dcterms:creator{foaf:name="${v}"}`, inSyntax: true },
  // Not in the OSLC query syntax. A server rejecting these is entirely
  // correct and must never be triaged as a defect. They are probed because a
  // server that *does* support them offers capability worth knowing about —
  // and worth deciding, deliberately, whether to depend on.
  { name: 'disjunction',    template: (p, v) => `${p}="${v}" or ${p}="${v}"`,         inSyntax: false },
  { name: 'wildcard',       template: (p, v) => `${p}="${v}*"`,                       inSyntax: false },
];

/** Send by whichever method the context selected, recording the exchange. */
function send(ctx: CaseContext, params: Array<[string, string]>): Promise<ProbeResponse> {
  return ctx.usePost
    ? probeQueryPost(ctx.http, ctx.queryBase, params)
    : probeQueryGet(ctx.http, ctx.queryBase, params);
}

/**
 * A case that cannot be judged, declared without sending anything.
 *
 * `expected` is mandatory here (§10): the run's handover of what it could not
 * settle is only actionable if it says what a correct result looks like, so the
 * caller can check it against the server's own UI.
 */
function inconclusive(name: string, reason: string, expected: string): CaseResult {
  return { name, verdict: 'inconclusive', reason, expected, transcripts: [] };
}

/** An error status is the answer, recorded as such rather than thrown. */
function statusFailure(name: string, response: ProbeResponse, what: string): CaseResult | null {
  if (response.status < 400) return null;
  return {
    name,
    verdict: 'unsupported',
    reason: `${what} answered ${response.status}`,
    transcripts: [response.transcript],
  };
}

/**
 * Case 1 — a bare request on the query base, no parameters.
 *
 * The specification does not say what this returns, so `unsupported` is a
 * legitimate outcome rather than a defect. In read-only mode this is what
 * supplies the baseline.
 */
export async function caseBareGet(ctx: CaseContext): Promise<CaseResult> {
  const response = await send(ctx, []);
  const failed = statusFailure('bare-query', response, 'an unparameterised query');
  if (failed) return failed;
  const members = memberURIs(response.body, ctx.queryBase);
  return {
    name: 'bare-query',
    verdict: members.length > 0 ? 'supported' : 'unsupported',
    reason: `${members.length} member(s) returned with no parameters`,
    transcripts: [response.transcript],
  };
}

/**
 * Case 2 — the same trivial query as POST and as GET.
 *
 * Establishes whether POST-query works, and therefore whether long queries are
 * possible at all: a server accepting only GET caps oslc.where and oslc.select
 * at the URL length limit.
 */
export async function casePostVersusGet(ctx: CaseContext): Promise<CaseResult> {
  const asPost = await probeQueryPost(ctx.http, ctx.queryBase, []);
  const asGet = await probeQueryGet(ctx.http, ctx.queryBase, []);
  const transcripts = [asPost.transcript, asGet.transcript];
  const postOk = asPost.status < 400;
  const getOk = asGet.status < 400;

  if (postOk && getOk) {
    return { name: 'post-versus-get', verdict: 'supported', reason: 'both POST and GET are accepted', transcripts };
  }
  if (getOk) {
    return {
      name: 'post-versus-get',
      verdict: 'unsupported',
      reason: `POST answered ${asPost.status} while GET answered ${asGet.status}: queries are limited to URL length`,
      transcripts,
    };
  }
  if (postOk) {
    return { name: 'post-versus-get', verdict: 'supported', reason: `POST is accepted; GET answered ${asGet.status}`, transcripts };
  }
  return {
    name: 'post-versus-get',
    verdict: 'unsupported',
    reason: `neither method was accepted (POST ${asPost.status}, GET ${asGet.status})`,
    transcripts,
  };
}

/** Case 3 — filter on a value known to identify exactly one resource. */
export async function caseWhereIdentity(ctx: CaseContext): Promise<CaseResult> {
  const known = distinguishingValue(ctx.truth, DCTERMS_IDENTIFIER);
  if (!known) {
    return inconclusive(
      'where-identity',
      `no value of ${DCTERMS_IDENTIFIER} identifies exactly one resource`,
      'a filter on a unique identifier returns exactly that one resource'
    );
  }
  const response = await send(ctx, [['oslc.where', `dcterms:identifier="${known.value}"`]]);
  const failed = statusFailure('where-identity', response, 'a filter on dcterms:identifier');
  if (failed) return failed;
  const judged = judgeFilter({
    returned: memberURIs(response.body, ctx.queryBase),
    expectedURI: known.uri,
    baseline: ctx.truth.baseline,
  });
  return { name: 'where-identity', ...judged, transcripts: [response.transcript] };
}

/**
 * Case 4 — a filter and its negation, as two requests.
 *
 * The sharpest test available, because it needs nothing known in advance: the
 * two results must partition the baseline exactly, and an overlap proves the
 * filter was not applied even where both requests answered 200.
 */
export async function caseNegationPair(ctx: CaseContext): Promise<CaseResult> {
  const known = distinguishingValue(ctx.truth, DCTERMS_IDENTIFIER);
  if (!known) {
    return inconclusive(
      'negation-pair',
      `no value of ${DCTERMS_IDENTIFIER} identifies exactly one resource`,
      'a filter and its negation together return the baseline exactly, and neither alone'
    );
  }
  const matching = await send(ctx, [['oslc.where', `dcterms:identifier="${known.value}"`]]);
  const notMatching = await send(ctx, [['oslc.where', `dcterms:identifier!="${known.value}"`]]);
  const transcripts = [matching.transcript, notMatching.transcript];

  for (const [response, label] of [[matching, 'the filter'], [notMatching, 'its negation']] as const) {
    if (response.status >= 400) {
      return { name: 'negation-pair', verdict: 'unsupported', reason: `${label} answered ${response.status}`, transcripts };
    }
  }
  const judged = judgePartition({
    matching: memberURIs(matching.body, ctx.queryBase),
    notMatching: memberURIs(notMatching.body, ctx.queryBase),
    baseline: ctx.truth.baseline,
  });
  return { name: 'negation-pair', ...judged, transcripts };
}

/**
 * Case 5 — `oslc.select`, flat and nested.
 *
 * Evidence is that the returned properties narrow. For the nested form the
 * nested property must genuinely appear, since a server may accept `a{b}` and
 * return `a` alone.
 */
export async function caseSelect(ctx: CaseContext): Promise<CaseResult> {
  const flat = await send(ctx, [['oslc.select', 'dcterms:title']]);
  const nested = await send(ctx, [['oslc.select', 'dcterms:creator{foaf:name}']]);
  const transcripts = [flat.transcript, nested.transcript];

  if (flat.status >= 400) {
    return { name: 'select', verdict: 'unsupported', reason: `a flat oslc.select answered ${flat.status}`, transcripts };
  }
  const narrowed = !flat.body.includes('dcterms:identifier') && flat.body.includes('title');
  const nestedOk = nested.status < 400 && /foaf:name|<name/.test(nested.body);
  if (!narrowed) {
    return {
      name: 'select',
      verdict: 'ignored',
      reason: 'the projection did not narrow the properties returned',
      transcripts,
    };
  }
  return {
    name: 'select',
    verdict: 'supported',
    reason: nestedOk
      ? 'a flat projection narrowed the result and the nested property was present'
      : `a flat projection narrowed the result; the nested form answered ${nested.status} without the nested property`,
    transcripts,
  };
}

/** Case 8 — `oslc.orderBy` ascending against descending. */
export async function caseOrderBy(ctx: CaseContext): Promise<CaseResult> {
  const adequate = canOrderBy(ctx.truth, DCTERMS_TITLE);
  if (!adequate.ok) {
    return inconclusive(
      'order-by',
      adequate.reason,
      'the leading member differs between ascending and descending order'
    );
  }
  const ascending = await send(ctx, [['oslc.orderBy', '+dcterms:title']]);
  const descending = await send(ctx, [['oslc.orderBy', '-dcterms:title']]);
  const transcripts = [ascending.transcript, descending.transcript];

  for (const [response, label] of [[ascending, 'ascending'], [descending, 'descending']] as const) {
    if (response.status >= 400) {
      return { name: 'order-by', verdict: 'unsupported', reason: `${label} ordering answered ${response.status}`, transcripts };
    }
  }
  const judged = judgeOrdering(
    memberURIs(ascending.body, ctx.queryBase),
    memberURIs(descending.body, ctx.queryBase)
  );
  return { name: 'order-by', ...judged, transcripts };
}

/** Case 9 — paging: the page size honoured, and `oslc:nextPage` offered. */
export async function casePaging(ctx: CaseContext): Promise<CaseResult> {
  const pageSize = 2;
  const adequate = enoughForPaging(ctx.truth, pageSize);
  if (!adequate.ok) {
    return inconclusive(
      'paging',
      adequate.reason,
      `a page of ${pageSize} members and an oslc:nextPage pointing at the rest`
    );
  }
  const response = await send(ctx, [['oslc.pageSize', String(pageSize)]]);
  const failed = statusFailure('paging', response, 'a paged query');
  if (failed) return failed;

  const members = memberURIs(response.body, ctx.queryBase);
  const hasNextPage = /nextPage/.test(response.body);
  if (members.length === ctx.truth.baseline.length) {
    return {
      name: 'paging',
      verdict: 'ignored',
      reason: `the whole baseline of ${members.length} was returned despite oslc.pageSize=${pageSize}`,
      transcripts: [response.transcript],
    };
  }
  if (members.length !== pageSize) {
    return {
      name: 'paging',
      verdict: 'unsupported',
      reason: `${members.length} member(s) returned for a page size of ${pageSize}`,
      transcripts: [response.transcript],
    };
  }
  return {
    name: 'paging',
    verdict: hasNextPage ? 'supported' : 'unsupported',
    reason: hasNextPage
      ? `the page held ${pageSize} members and offered oslc:nextPage`
      : `the page held ${pageSize} members but offered no oslc:nextPage, so the rest cannot be reached`,
    transcripts: [response.transcript],
  };
}

/** Case 10 — `oslc.searchTerms`: is full-text search implemented at all? */
export async function caseSearchTerms(ctx: CaseContext): Promise<CaseResult> {
  const found = termForSearch(ctx.truth, DCTERMS_TITLE);
  if (!found) {
    return inconclusive(
      'search-terms',
      `no word in ${DCTERMS_TITLE} is present in one resource and absent from the rest`,
      'a search for a term unique to one resource returns a set smaller than the baseline'
    );
  }
  const response = await send(ctx, [['oslc.searchTerms', found.term]]);
  const failed = statusFailure('search-terms', response, 'a full-text search');
  if (failed) return failed;

  const members = memberURIs(response.body, ctx.queryBase);
  const judged = judgeFilter({ returned: members, expectedURI: found.uri, baseline: ctx.truth.baseline });
  return {
    name: 'search-terms',
    ...judged,
    reason: `searching for "${found.term}": ${judged.reason}`,
    transcripts: [response.transcript],
  };
}

/**
 * Case 3's companion — which prefixes a server predefines (§8.2).
 *
 * One prefix per request, with the rest of the term otherwise valid, so a
 * rejection is attributable to the prefix and nothing else. `oslc.where` and
 * `oslc.select` are probed separately because a server may resolve prefixes
 * when filtering but not when projecting.
 *
 * The trap: a clause accepted but IGNORED is recorded `inconclusive`, never
 * "predefined". A server that ignores oslc.where accepts every prefix, and
 * reading that as "all prefixes predefined" would be exactly backwards.
 */
export async function casePrefixDiscovery(ctx: CaseContext): Promise<CaseResult[]> {
  const known = distinguishingValue(ctx.truth, DCTERMS_IDENTIFIER);
  if (!known) {
    return [inconclusive(
      'prefix-discovery',
      `no value of ${DCTERMS_IDENTIFIER} identifies exactly one resource, so a prefix cannot be tested on a valid term`,
      'an undeclared but predefined prefix is accepted; an unknown one is refused naming the prefix'
    )];
  }

  const results: CaseResult[] = [];
  for (const [param, clause] of [
    ['oslc.where', `dcterms:identifier="${known.value}"`],
    ['oslc.select', 'dcterms:title'],
  ] as const) {
    const name = `prefix-discovery:${param}`;
    const response = await send(ctx, [[param, clause]]);
    const transcripts = [response.transcript];

    if (response.status >= 400) {
      results.push({
        name,
        verdict: 'unsupported',
        reason: `dcterms was not predefined for ${param}: the server answered ${response.status}`,
        transcripts,
      });
      continue;
    }
    if (param === 'oslc.where') {
      const judged = judgeFilter({
        returned: memberURIs(response.body, ctx.queryBase),
        expectedURI: known.uri,
        baseline: ctx.truth.baseline,
      });
      if (judged.verdict === 'ignored') {
        results.push({
          name,
          verdict: 'inconclusive',
          reason: 'the clause was accepted but ignored, so acceptance says nothing about the prefix',
          expected: 'a filter using a predefined prefix returns exactly the matching resource',
          transcripts,
        });
        continue;
      }
    }
    results.push({
      name,
      verdict: 'supported',
      reason: `dcterms is predefined for ${param}: an undeclared prefix was accepted and took effect`,
      transcripts,
    });
  }
  return results;
}

/**
 * §8.1 — each `oslc.where` construct as its own request and its own verdict.
 *
 * Not combined: an unsupported construct usually fails the whole filter, so one
 * request carrying several would attribute a single rejection to all of them.
 */
export async function caseWhereConstructs(ctx: CaseContext): Promise<CaseResult[]> {
  const known = distinguishingValue(ctx.truth, DCTERMS_IDENTIFIER);
  if (!known) {
    return [inconclusive(
      'where-constructs',
      `no value of ${DCTERMS_IDENTIFIER} identifies exactly one resource`,
      'each construct either filters, is refused, or is accepted and ignored'
    )];
  }

  const results: CaseResult[] = [];
  for (const construct of WHERE_CONSTRUCTS) {
    const name = `where:${construct.name}`;
    const clause = construct.template('dcterms:identifier', known.value);
    const response = await send(ctx, [['oslc.where', clause]]);
    const transcripts = [response.transcript];

    if (response.status >= 400) {
      results.push({
        name,
        verdict: 'unsupported',
        reason: construct.inSyntax
          ? `answered ${response.status}`
          : `answered ${response.status}, which is conformant: this construct is not in the OSLC query syntax`,
        transcripts,
      });
      continue;
    }
    const judged = judgeFilter({
      returned: memberURIs(response.body, ctx.queryBase),
      expectedURI: known.uri,
      baseline: ctx.truth.baseline,
    });
    results.push({ name, ...judged, transcripts });
  }
  return results;
}
