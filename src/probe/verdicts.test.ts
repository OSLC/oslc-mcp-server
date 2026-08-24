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

  it('accepts halves that do not exhaust the baseline, and says why', () => {
    // Changed deliberately. A property filter matches only resources carrying the
    // property, so anything without it falls outside both `a="v"` and `a!="v"`.
    // DOORS Next's unfiltered requirement query returns internal materialized
    // views alongside its artifacts, and requiring the halves to account for the
    // whole baseline reported that working negation as broken.
    const v = judgePartition({ matching: ['r/1'], notMatching: ['r/2'], baseline: BASE });
    expect(v.verdict).toBe('supported');
    expect(v.reason).toContain('fall outside both');
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

describe('memberURIs — membership predicates other than rdfs:member', () => {
  const QB = 'https://elm.example.com/qm/resources/TestCase';
  const wrap = (inner: string) =>
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
              xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
              xmlns:oslc="http://open-services.net/ns/core#"
              xmlns:dcterms="http://purl.org/dc/terms/"
              xmlns:oslc_qm="http://open-services.net/ns/qm#">${inner}</rdf:RDF>`;

  it('still prefers rdfs:member where a server uses it', () => {
    const body = wrap(`<rdf:Description rdf:about="${QB}">
      <rdfs:member rdf:resource="${QB}/1"/><rdfs:member rdf:resource="${QB}/2"/>
    </rdf:Description>`);
    expect(memberURIs(body, QB)).toEqual([`${QB}/1`, `${QB}/2`]);
  });

  it('finds members linked by a domain predicate — ELM QM uses oslc_qm:testCase', () => {
    // Reported 30 test cases as zero, which then made every filter case
    // inconclusive for want of a baseline. A 200 with results is not empty.
    const body = wrap(`<rdf:Description rdf:about="${QB}">
      <oslc_qm:testCase rdf:resource="${QB}/1"/>
      <oslc_qm:testCase rdf:resource="${QB}/2"/>
    </rdf:Description>`);
    expect(memberURIs(body, QB)).toEqual([`${QB}/1`, `${QB}/2`]);
  });

  it('reads members off an oslc:ResponseInfo published under its own paged URI', () => {
    const body = wrap(`<rdf:Description rdf:about="${QB}?pageNum=0">
      <rdf:type rdf:resource="http://open-services.net/ns/core#ResponseInfo"/>
      <oslc:totalCount>2</oslc:totalCount>
      <dcterms:title>Results</dcterms:title>
      <oslc_qm:testCase rdf:resource="${QB}/1"/>
    </rdf:Description>`);
    expect(memberURIs(body, QB)).toEqual([`${QB}/1`]);
  });

  it('does not mistake a container’s own description for membership', () => {
    const body = wrap(`<rdf:Description rdf:about="${QB}">
      <rdf:type rdf:resource="http://open-services.net/ns/core#ResponseInfo"/>
      <dcterms:title>Results</dcterms:title>
      <oslc:serviceProvider rdf:resource="https://elm.example.com/qm/sp"/>
      <oslc:nextPage rdf:resource="${QB}?page=2"/>
      <oslc:instanceShape rdf:resource="https://elm.example.com/qm/shape"/>
    </rdf:Description>`);
    expect(memberURIs(body, QB)).toEqual([]);
  });
});

describe('judgePartition — resources that carry no value for the property', () => {
  it('accepts a partition that leaves out resources lacking the property', () => {
    // DOORS Next returns four internal materialized views alongside its artifacts.
    // A filter on dcterms:identifier can only match resources that have one, so
    // both halves leave them out — correctly. Demanding they be accounted for
    // reported a working negation as broken.
    const baseline = ['a', 'b', 'c', 'view1', 'view2'];
    const judged = judgePartition({ matching: ['a'], notMatching: ['b', 'c'], baseline });
    expect(judged.verdict).toBe('supported');
    expect(judged.reason).toContain('fall outside both');
  });

  it('still reports an overlap, which no filter can produce', () => {
    expect(judgePartition({ matching: ['a', 'b'], notMatching: ['b', 'c'], baseline: ['a', 'b', 'c'] }).verdict)
      .toBe('unsupported');
  });

  it('still calls it ignored when both halves return everything', () => {
    const baseline = ['a', 'b', 'c'];
    expect(judgePartition({ matching: baseline, notMatching: baseline, baseline }).verdict).toBe('ignored');
  });

  it('rejects a result carrying resources the unfiltered query never returned', () => {
    expect(judgePartition({ matching: ['a'], notMatching: ['b', 'z'], baseline: ['a', 'b', 'c'] }).verdict)
      .toBe('unsupported');
  });

  it('rejects two empty halves', () => {
    expect(judgePartition({ matching: [], notMatching: [], baseline: ['a', 'b', 'c'] }).verdict)
      .toBe('unsupported');
  });
});
