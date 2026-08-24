import { describe, it, expect } from '@jest/globals';
import { judgeFilter, judgePartition, judgeOrdering, memberURIs, judgeComplement, judgeRange } from './verdicts.js';

const BASE = ['r/1', 'r/2', 'r/3', 'r/4', 'r/5'];

describe('judgeFilter', () => {
  it('is supported when exactly the expected resource comes back, by identity', () => {
    const v = judgeFilter({ returned: ['r/1'], expectedURI: 'r/1', baseline: BASE });
    expect(v.verdict).toBe('supported');
  });

  it('is ignored when the whole baseline comes back', () => {
    const v = judgeFilter({ returned: BASE, expectedURI: 'r/1', baseline: BASE });
    expect(v.verdict).toBe('ignored');
    expect(v.reason).toMatch(/every|whole|all/i);
  });

  it('is unsupported when the right count comes back but the wrong resource', () => {
    // One result that is not the one asked for is not a filter that worked.
    const v = judgeFilter({ returned: ['r/2'], expectedURI: 'r/1', baseline: BASE });
    expect(v.verdict).toBe('unsupported');
  });

  it('is unsupported when nothing comes back', () => {
    expect(judgeFilter({ returned: [], expectedURI: 'r/1', baseline: BASE }).verdict).toBe('unsupported');
  });

  it('is inconclusive when the baseline is a single resource', () => {
    // Filtering cannot be told from not filtering when there is one resource.
    const v = judgeFilter({ returned: ['r/1'], expectedURI: 'r/1', baseline: ['r/1'] });
    expect(v.verdict).toBe('inconclusive');
  });
});

describe('judgePartition', () => {
  it('is supported when the two sets partition the baseline exactly', () => {
    const v = judgePartition({ matching: ['r/1'], notMatching: ['r/2', 'r/3', 'r/4', 'r/5'], baseline: BASE });
    expect(v.verdict).toBe('supported');
  });

  it('is ignored when both sides return the whole baseline', () => {
    const v = judgePartition({ matching: BASE, notMatching: BASE, baseline: BASE });
    expect(v.verdict).toBe('ignored');
  });

  it('is unsupported when the sets overlap', () => {
    const v = judgePartition({ matching: ['r/1', 'r/2'], notMatching: ['r/2', 'r/3'], baseline: BASE });
    expect(v.verdict).toBe('unsupported');
    expect(v.reason).toMatch(/overlap/i);
  });

  it('is unsupported when the sets do not account for the baseline', () => {
    const v = judgePartition({ matching: ['r/1'], notMatching: ['r/2'], baseline: BASE });
    expect(v.verdict).toBe('unsupported');
  });
});

describe('judgeOrdering', () => {
  it('is supported when the first member differs between directions', () => {
    expect(judgeOrdering(['r/1', 'r/2'], ['r/2', 'r/1']).verdict).toBe('supported');
  });

  it('is ignored when both directions lead with the same member', () => {
    expect(judgeOrdering(['r/1', 'r/2'], ['r/1', 'r/2']).verdict).toBe('ignored');
  });

  it('is inconclusive when either direction returned nothing', () => {
    expect(judgeOrdering([], ['r/1']).verdict).toBe('inconclusive');
  });
});

describe('memberURIs', () => {
  it('extracts rdfs:member entries from a query response', () => {
    const body =
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ` +
      `xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">` +
      `<rdf:Description rdf:about="https://elm.example.com/rm/views">` +
      `<rdfs:member rdf:resource="https://elm.example.com/rm/r/1"/>` +
      `<rdfs:member rdf:resource="https://elm.example.com/rm/r/2"/>` +
      `</rdf:Description></rdf:RDF>`;
    expect(memberURIs(body, 'https://elm.example.com/rm/views')).toEqual([
      'https://elm.example.com/rm/r/1',
      'https://elm.example.com/rm/r/2',
    ]);
  });

  it('returns an empty list for an unparseable body rather than throwing', () => {
    expect(memberURIs('not rdf at all', 'https://elm.example.com/rm/views')).toEqual([]);
  });
});

describe('judgeComplement — a clause whose answer is everything but one', () => {
  const baseline = ['a', 'b', 'c'];

  it('accepts the exact complement', () => {
    expect(judgeComplement({ returned: ['b', 'c'], excludedURI: 'a', baseline }).verdict)
      .toBe('supported');
  });

  it('accepts a paged complement, since the baseline is only page one', () => {
    // Demanding the exact complement reported a working `!=` as broken on any
    // server that pages.
    const judged = judgeComplement({ returned: ['b'], excludedURI: 'a', baseline });
    expect(judged.verdict).toBe('supported');
    expect(judged.reason).toContain('paged');
  });

  it('calls the whole baseline ignored, not unsupported', () => {
    expect(judgeComplement({ returned: ['a', 'b', 'c'], excludedURI: 'a', baseline }).verdict)
      .toBe('ignored');
  });

  it('rejects a result that includes the excluded resource', () => {
    expect(judgeComplement({ returned: ['a', 'b'], excludedURI: 'a', baseline }).verdict)
      .toBe('unsupported');
  });

  it('rejects an empty result when others were expected', () => {
    expect(judgeComplement({ returned: [], excludedURI: 'a', baseline }).verdict)
      .toBe('unsupported');
  });
});

describe('judgeRange — a clause whose answer is a range', () => {
  const baseline = ['a', 'b', 'c'];

  it('accepts a narrowed set that excludes the boundary', () => {
    expect(judgeRange({ returned: ['b'], boundaryURI: 'a', baseline }).verdict).toBe('supported');
  });

  it('calls the whole baseline ignored', () => {
    expect(judgeRange({ returned: ['a', 'b', 'c'], boundaryURI: 'a', baseline }).verdict)
      .toBe('ignored');
  });

  it('rejects a result containing the boundary, which a strict > excludes', () => {
    expect(judgeRange({ returned: ['a', 'b'], boundaryURI: 'a', baseline }).verdict)
      .toBe('unsupported');
  });

  it('will not read an empty result either way, and says what it wanted', () => {
    // A boundary at the greatest value and a dropped clause look identical.
    const judged = judgeRange({ returned: [], boundaryURI: 'a', baseline });
    expect(judged.verdict).toBe('inconclusive');
    expect(judged.expected).toBeDefined();
  });
});

describe('the identity expectation is not applied to every construct', () => {
  it('would have called a correct != unsupported', () => {
    // The bug this fixes, stated as the test: a conformant `!=` returns the
    // complement, and judgeFilter demands exactly the one named resource.
    const baseline = ['a', 'b', 'c'];
    expect(judgeFilter({ returned: ['b', 'c'], expectedURI: 'a', baseline }).verdict)
      .toBe('unsupported');
    expect(judgeComplement({ returned: ['b', 'c'], excludedURI: 'a', baseline }).verdict)
      .toBe('supported');
  });
});
