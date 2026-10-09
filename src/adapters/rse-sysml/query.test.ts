import { runQuery, PAGE_SIZE } from './query.js';

const http = (data: unknown, seen: { url?: string; body?: unknown } = {}) => ({
  get: async () => ({ status: 200, data: {} }),
  post: async (url: string, body: unknown) => { seen.url = url; seen.body = body; return { status: 200, data }; },
});

describe('runQuery', () => {
  it('sends page[size] spelled exactly, because pageSize and limit answer differently wrong', async () => {
    const seen: { url?: string } = {};
    await runQuery(http([], seen), 'https://h/api', 'P', 'C', { property: '@type', value: 'Documentation', select: ['@id'] });
    expect(seen.url).toContain(`page%5Bsize%5D=${PAGE_SIZE}`);
    expect(seen.url).not.toMatch(/[?&](pageSize|limit)=/);
  });

  it('sends one PrimitiveConstraint, since CompositeConstraint is rejected', async () => {
    const seen: { body?: any } = {};
    await runQuery(http([], seen), 'https://h/api', 'P', 'C', { property: 'declaredShortName', value: 'UNIT-G', select: ['@id'] });
    expect(seen.body.where).toMatchObject({ '@type': 'PrimitiveConstraint', operator: '=', property: 'declaredShortName', value: 'UNIT-G' });
  });

  it('returns the rows', async () => {
    await expect(runQuery(http([{ '@id': 'a' }]), 'https://h/api', 'P', 'C',
      { property: '@type', value: 'Documentation', select: ['@id'] })).resolves.toEqual([{ '@id': 'a' }]);
  });

  // A full page means the answer is probably short, and nothing in the response
  // says so. Returning it would make an absence indistinguishable from a fact.
  it('raises rather than returning a result that filled the page', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ '@id': String(i) }));
    await expect(runQuery(http(full), 'https://h/api', 'P', 'C',
      { property: '@type', value: 'OSLCLink', select: ['@id'] })).rejects.toThrow(/truncated/);
  });

  it('raises when the server answers with something that is not a list', async () => {
    await expect(runQuery(http({ '@type': 'Error', description: 'nope' }), 'https://h/api', 'P', 'C',
      { property: '@type', value: 'X', select: ['@id'] })).rejects.toThrow(/not a list/);
  });
});

import { fetchCommitElements, linkNext } from './query.js';

describe('linkNext', () => {
  it('extracts the cursor the elements route advertises', () => {
    expect(linkNext('<https://h/api/…/elements?page[after]=abc&page[size]=50>; rel="next"'))
      .toBe('https://h/api/…/elements?page[after]=abc&page[size]=50');
  });
  it('is undefined on the last page, which is how exhaustion is known', () => {
    expect(linkNext(undefined)).toBeUndefined();
    expect(linkNext('<https://h/prev>; rel="prev"')).toBeUndefined();
  });
});

describe('fetchCommitElements', () => {
  const base = { get: async () => ({ status: 200, data: {} }), post: async () => ({ status: 200, data: [] }) };

  it('follows the cursor to exhaustion and concatenates', async () => {
    const pages: Record<string, { data: unknown; linkNext?: string }> = {
      'p1': { data: [{ '@id': 'a' }], linkNext: 'p2' },
      'p2': { data: [{ '@id': 'b' }] },
    };
    const http = { ...base, getWithHeaders: async (u: string) => pages[u.includes('page') ? 'p1' : u] };
    const seq = ['p1', 'p2']; let i = 0;
    http.getWithHeaders = async () => pages[seq[i++]];
    await expect(fetchCommitElements(http, 'https://h/api', 'P', 'C'))
      .resolves.toEqual([{ '@id': 'a' }, { '@id': 'b' }]);
  });

  // Stopping at page one would look exactly like a small model.
  it('refuses a client that cannot read headers rather than reading one page', async () => {
    await expect(fetchCommitElements(base as never, 'https://h/api', 'P', 'C'))
      .rejects.toThrow(/cannot read response headers/);
  });

  it('raises when a page is not a list', async () => {
    const http = { ...base, getWithHeaders: async () => ({ data: { '@type': 'Error' } }) };
    await expect(fetchCommitElements(http, 'https://h/api', 'P', 'C')).rejects.toThrow(/not a list/);
  });
});
