import { describe, it, expect, jest } from '@jest/globals';
import {
  WHERE_CONSTRUCTS,
  caseOrderBy,
  casePaging,
  caseWhereIdentity,
  caseNegationPair,
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
  return { http, queryBase: QUERY_BASE, truth, usePost: true };
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
});
