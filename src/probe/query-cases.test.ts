import { describe, it, expect, jest } from '@jest/globals';
import {
  WHERE_CONSTRUCTS,
  caseOrderBy,
  casePaging,
  caseWhereIdentity,
  caseNegationPair,
  caseWhereConstructs,
  type CaseContext,
} from './query-cases.js';
import type { GroundTruth } from './ground-truth.js';

const QUERY_BASE = 'https://elm.example.com/rm/views';
const TITLE = 'http://purl.org/dc/terms/title';
const IDENT = 'http://purl.org/dc/terms/identifier';
const R = (n: number) => `https://elm.example.com/rm/r/${n}`;

function truthOf(n: number): GroundTruth {
  return {
    kind: 'fixture',
    resources: Array.from({ length: n }, (_, i) => ({
      uri: R(i + 1),
      properties: new Map([[TITLE, [`Probe 0${i + 1}`]], [IDENT, [`PROBE-0${i + 1}`]]]),
    })),
    baseline: Array.from({ length: n }, (_, i) => R(i + 1)),
  };
}

/** Response body listing the given member URIs. */
function membersBody(uris: string[]): string {
  return (
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ` +
    `xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">` +
    `<rdf:Description rdf:about="${QUERY_BASE}">` +
    uris.map((u) => `<rdfs:member rdf:resource="${u}"/>`).join('') +
    `</rdf:Description></rdf:RDF>`
  );
}

/** Replies with whatever the script returns for each successive call. */
function scriptedHttp(bodies: string[]) {
  let i = 0;
  return {
    request: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/rdf+xml' },
      data: bodies[Math.min(i++, bodies.length - 1)],
    })),
  } as any;
}

function ctx(http: any, truth: GroundTruth): CaseContext {
  // `known` is resolved by the orchestrator and confirmed by query before the
  // filter cases run; supplied here so a case can be exercised on its own.
  return {
    http, queryBase: QUERY_BASE, truth, usePost: true,
    known: truth.resources.length > 0
      ? { predicate: IDENT, term: 'dcterms:identifier', uri: R(1), value: 'PROBE-01' }
      : undefined,
  };
}

describe('WHERE_CONSTRUCTS', () => {
  it('marks disjunction and wildcard as outside the query syntax', () => {
    const outside = WHERE_CONSTRUCTS.filter((c) => !c.inSyntax).map((c) => c.name);
    expect(outside).toEqual(expect.arrayContaining(['disjunction', 'wildcard']));
  });

  it('marks equality, inequality, comparison, set membership, conjunction and scoped terms as in syntax', () => {
    const inside = WHERE_CONSTRUCTS.filter((c) => c.inSyntax).map((c) => c.name);
    expect(inside).toEqual(expect.arrayContaining([
      'equality', 'inequality', 'comparison', 'set-membership', 'conjunction', 'scoped-terms',
    ]));
  });
});

describe('caseWhereIdentity', () => {
  it('is supported when exactly the expected resource returns', async () => {
    const result = await caseWhereIdentity(ctx(scriptedHttp([membersBody([R(1)])]), truthOf(5)));
    expect(result.verdict).toBe('supported');
  });

  it('is ignored when the whole baseline returns', async () => {
    const all = [R(1), R(2), R(3), R(4), R(5)];
    const result = await caseWhereIdentity(ctx(scriptedHttp([membersBody(all)]), truthOf(5)));
    expect(result.verdict).toBe('ignored');
  });
});

describe('caseNegationPair', () => {
  it('is supported when a filter and its negation partition the baseline', async () => {
    const http = scriptedHttp([membersBody([R(1)]), membersBody([R(2), R(3), R(4), R(5)])]);
    expect((await caseNegationPair(ctx(http, truthOf(5)))).verdict).toBe('supported');
  });

  it('sends two separate requests', async () => {
    const http = scriptedHttp([membersBody([R(1)]), membersBody([R(2), R(3), R(4), R(5)])]);
    await caseNegationPair(ctx(http, truthOf(5)));
    expect(http.request).toHaveBeenCalledTimes(2);
  });
});

describe('caseOrderBy', () => {
  it('is inconclusive, with a reason, when every title is identical', async () => {
    const flat: GroundTruth = {
      kind: 'sampled',
      resources: [R(1), R(2)].map((uri) => ({ uri, properties: new Map([[TITLE, ['same']]]) })),
      baseline: [R(1), R(2)],
    };
    const result = await caseOrderBy(ctx(scriptedHttp([membersBody([R(1), R(2)])]), flat));
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toMatch(/identical/i);
    expect(result.expected).toBeDefined();
  });

  it('does not send a request it already knows cannot be judged', async () => {
    const flat: GroundTruth = {
      kind: 'sampled',
      resources: [{ uri: R(1), properties: new Map([[TITLE, ['same']]]) }],
      baseline: [R(1)],
    };
    const http = scriptedHttp([membersBody([R(1)])]);
    await caseOrderBy(ctx(http, flat));
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('casePaging', () => {
  it('is inconclusive when too few resources exist to page', async () => {
    const result = await casePaging(ctx(scriptedHttp([membersBody([R(1)])]), truthOf(1)));
    expect(result.verdict).toBe('inconclusive');
    expect(result.expected).toBeDefined();
  });

  /** A page of `n` members plus a next-page link. */
  function pageBody(uris: string[]): string {
    return membersBody(uris).replace(
      '</rdf:Description>',
      '<oslc:nextPage xmlns:oslc="http://open-services.net/ns/core#" ' +
      `rdf:resource="${QUERY_BASE}?oslc.pageNo=1"/></rdf:Description>`
    );
  }

  it('is supported when the page is the size asked for and offers a next page', async () => {
    const result = await casePaging(ctx(scriptedHttp([pageBody([R(1), R(2)])]), truthOf(5)));
    expect(result.verdict).toBe('supported');
  });

  it('is ignored, not unsupported, when the server pages at a size it chose', async () => {
    // an administrator-configured page size: paging works and every member is
    // reachable, but the parameter was disregarded. Reporting this unsupported
    // would call a working capability missing.
    const result = await casePaging(ctx(scriptedHttp([pageBody([R(1), R(2), R(3), R(4)])]), truthOf(9)));
    expect(result.verdict).toBe('ignored');
    expect(result.reason).toMatch(/size it chooses/);
    expect(result.reason).toContain('4 members');
  });

  it('is unsupported only when the result is truncated with no way to reach the rest', async () => {
    const result = await casePaging(ctx(scriptedHttp([membersBody([R(1), R(2)])]), truthOf(9)));
    expect(result.verdict).toBe('unsupported');
    expect(result.reason).toMatch(/cannot be reached/);
  });

  it('is ignored when the whole baseline comes back despite the parameter', async () => {
    const all = [R(1), R(2), R(3), R(4), R(5)];
    const result = await casePaging(ctx(scriptedHttp([membersBody(all)]), truthOf(5)));
    expect(result.verdict).toBe('ignored');
    expect(result.reason).toMatch(/whole baseline/);
  });
});

describe('caseWhereConstructs — each construct judged against its own correct answer', () => {
  // The order the cases are sent in, so a scripted reply lands on the right one.
  const order = WHERE_CONSTRUCTS.map((c) => c.name);
  const only = async (construct: string, body: string) => {
    const bodies = order.map((n) => (n === construct ? body : membersBody([R(1)])));
    const results = await caseWhereConstructs(ctx(scriptedHttp(bodies), truthOf(5)));
    return results.find((r) => r.name === `where:${construct}`)!;
  };

  it('declares an expectation for every construct', () => {
    expect(WHERE_CONSTRUCTS.every((c) => c.expectation)).toBe(true);
  });

  it('accepts an inequality that returns the complement', async () => {
    // Was reported unsupported: judged like equality, which demands exactly R(1).
    const r = await only('inequality', membersBody([R(2), R(3), R(4), R(5)]));
    expect(r.verdict).toBe('supported');
  });

  it('accepts a comparison that returns a range excluding the boundary', async () => {
    const r = await only('comparison', membersBody([R(3), R(4)]));
    expect(r.verdict).toBe('supported');
  });

  it('leaves an accepted scoped term unsettled rather than unsupported', async () => {
    // Nothing known can match `dcterms:creator{foaf:name="PROBE-01"}`, so an empty
    // result is what a conformant server returns.
    const r = await only('scoped-terms', membersBody([]));
    expect(r.verdict).toBe('inconclusive');
    expect(r.expected).toBeDefined();
  });

  it('still calls an unfiltered equality ignored', async () => {
    const all = membersBody([R(1), R(2), R(3), R(4), R(5)]);
    expect((await only('equality', all)).verdict).toBe('ignored');
  });

  it('still calls an inequality that returns the whole baseline ignored', async () => {
    const all = membersBody([R(1), R(2), R(3), R(4), R(5)]);
    expect((await only('inequality', all)).verdict).toBe('ignored');
  });
});
