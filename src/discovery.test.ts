import { describe, it, expect, jest } from '@jest/globals';
// rdflib is CommonJS; jest's ESM linker will not destructure its named
// exports, so take the default and destructure here.
import rdflib from 'rdflib';
import { discoverFromServiceProviders } from './discovery.js';

const { graph, sym, lit, st, Namespace } = rdflib as any;
const dcterms = Namespace('http://purl.org/dc/terms/');

/**
 * Minimal stub standing in for OSLCClient. Records every URI fetched so a
 * test can assert the catalog was not among them.
 */
function stubClient(fetched: string[], failFor?: (uri: string) => boolean) {
  return {
    getResource: jest.fn(async (uri: string) => {
      if (failFor?.(uri)) throw new Error('403');
      fetched.push(uri);
      const store = graph();
      store.add(st(sym(uri), dcterms('title'), lit('Stub Provider'), sym(uri)));
      return { store, getURI: () => uri, etag: '' };
    }),
  } as any;
}

const CATALOG = 'https://elm.example.com/rm/oslc_rm/catalog';
const SP1 = 'https://elm.example.com/rm/sp/1';
const SP2 = 'https://elm.example.com/rm/sp/2';

describe('discoverFromServiceProviders', () => {
  it('fetches only the listed service providers', async () => {
    const fetched: string[] = [];
    await discoverFromServiceProviders(stubClient(fetched), [SP1, SP2], CATALOG);
    expect(fetched).toEqual([SP1, SP2]);
  });

  it('never fetches the catalog', async () => {
    const fetched: string[] = [];
    await discoverFromServiceProviders(stubClient(fetched), [SP1], CATALOG);
    expect(fetched).not.toContain(CATALOG);
  });

  it('reports the catalog URI in the result without having fetched it', async () => {
    const fetched: string[] = [];
    const result = await discoverFromServiceProviders(stubClient(fetched), [SP1], CATALOG);
    expect(result.catalogURI).toBe(CATALOG);
    expect(result.serviceProviders).toHaveLength(1);
  });

  it('skips a service provider that fails to fetch rather than aborting', async () => {
    const fetched: string[] = [];
    const client = stubClient(fetched, (uri) => uri.endsWith('/2'));
    const result = await discoverFromServiceProviders(client, [SP1, SP2], CATALOG);
    expect(result.serviceProviders).toHaveLength(1);
  });
});
