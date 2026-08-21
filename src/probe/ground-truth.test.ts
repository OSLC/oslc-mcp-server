import { describe, it, expect, jest } from '@jest/globals';
import {
  distinguishingValue,
  canOrderBy,
  enoughForPaging,
  termForSearch,
  sampleGroundTruth,
  type GroundTruth,
} from './ground-truth.js';

const TITLE = 'http://purl.org/dc/terms/title';
const IDENT = 'http://purl.org/dc/terms/identifier';

function gt(resources: Array<[string, Record<string, string[]>]>): GroundTruth {
  return {
    kind: 'sampled',
    resources: resources.map(([uri, props]) => ({
      uri,
      properties: new Map(Object.entries(props)),
    })),
    baseline: resources.map(([uri]) => uri),
  };
}

describe('distinguishingValue', () => {
  it('finds a value only one resource carries', () => {
    const found = distinguishingValue(
      gt([['r/1', { [IDENT]: ['A'] }], ['r/2', { [IDENT]: ['B'] }], ['r/3', { [IDENT]: ['B'] }]]),
      IDENT
    );
    expect(found).toEqual({ uri: 'r/1', value: 'A' });
  });

  it('returns null when every resource shares the value — nothing to distinguish', () => {
    expect(distinguishingValue(gt([['r/1', { [IDENT]: ['X'] }], ['r/2', { [IDENT]: ['X'] }]]), IDENT))
      .toBeNull();
  });

  it('returns null when the predicate is absent', () => {
    expect(distinguishingValue(gt([['r/1', { [TITLE]: ['a'] }]]), IDENT)).toBeNull();
  });
});

describe('canOrderBy', () => {
  it('is adequate when values differ', () => {
    expect(canOrderBy(gt([['r/1', { [TITLE]: ['a'] }], ['r/2', { [TITLE]: ['b'] }]]), TITLE).ok).toBe(true);
  });

  it('is inadequate, with a reason, when every value is equal', () => {
    const verdict = canOrderBy(gt([['r/1', { [TITLE]: ['a'] }], ['r/2', { [TITLE]: ['a'] }]]), TITLE);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/identical|same/i);
  });

  it('is inadequate with a single resource — order cannot be observed', () => {
    expect(canOrderBy(gt([['r/1', { [TITLE]: ['a'] }]]), TITLE).ok).toBe(false);
  });
});

describe('enoughForPaging', () => {
  it('needs more resources than the page size', () => {
    const three = gt([['r/1', {}], ['r/2', {}], ['r/3', {}]]);
    expect(enoughForPaging(three, 2).ok).toBe(true);
    expect(enoughForPaging(three, 3).ok).toBe(false);
    expect(enoughForPaging(three, 3).reason).toContain('3');
  });
});

describe('termForSearch', () => {
  it('picks a word present in one resource and absent from the others', () => {
    const found = termForSearch(
      gt([['r/1', { [TITLE]: ['Antelope report'] }], ['r/2', { [TITLE]: ['Badger report'] }]]),
      TITLE
    );
    expect(found?.term.toLowerCase()).toBe('antelope');
    expect(found?.uri).toBe('r/1');
  });

  it('returns null when no word distinguishes anything', () => {
    expect(termForSearch(gt([['r/1', { [TITLE]: ['report'] }], ['r/2', { [TITLE]: ['report'] }]]), TITLE))
      .toBeNull();
  });
});

describe('sampleGroundTruth', () => {
  const RDFXML = (uri: string, title: string) =>
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dcterms="http://purl.org/dc/terms/">` +
    `<rdf:Description rdf:about="${uri}"><dcterms:title>${title}</dcterms:title></rdf:Description></rdf:RDF>`;

  function stubHttp(bodies: Record<string, string>) {
    return {
      request: jest.fn(async (config: any) => ({
        status: 200,
        headers: { 'content-type': 'application/rdf+xml' },
        data: bodies[config.url] ?? '',
      })),
    } as any;
  }

  it('reads each member by URI and records its actual property values', async () => {
    const a = 'https://elm.example.com/rm/r/1';
    const b = 'https://elm.example.com/rm/r/2';
    const truth = await sampleGroundTruth(
      stubHttp({ [a]: RDFXML(a, 'Alpha'), [b]: RDFXML(b, 'Beta') }), [a, b]
    );
    expect(truth.kind).toBe('sampled');
    expect(truth.resources.map((r) => r.uri)).toEqual([a, b]);
    expect(truth.resources[0].properties.get(TITLE)).toEqual(['Alpha']);
  });

  it('keeps the full baseline even when it samples fewer resources', async () => {
    const uris = Array.from({ length: 10 }, (_, i) => `https://elm.example.com/rm/r/${i}`);
    const bodies = Object.fromEntries(uris.map((u, i) => [u, RDFXML(u, `T${i}`)]));
    const truth = await sampleGroundTruth(stubHttp(bodies), uris, 3);
    expect(truth.resources).toHaveLength(3);
    expect(truth.baseline).toHaveLength(10);
  });

  it('skips a member it cannot read rather than failing the whole sample', async () => {
    const a = 'https://elm.example.com/rm/r/1';
    const truth = await sampleGroundTruth(stubHttp({ [a]: RDFXML(a, 'Alpha') }), [a, 'https://elm.example.com/rm/r/2']);
    expect(truth.resources).toHaveLength(1);
    expect(truth.baseline).toHaveLength(2);
  });
});
