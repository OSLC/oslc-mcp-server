import { describe, it, expect, jest } from '@jest/globals';
// rdflib is CommonJS; jest's ESM linker will not destructure its named
// exports, so take the default and destructure here.
import rdflib from 'rdflib';
import { discoverFromServiceProviders, ACCEPT_RDF } from './discovery.js';

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

describe('ACCEPT_RDF', () => {
  /** Media types in preference order, quality values stripped. */
  function mediaTypes(header: string): string[] {
    return header.split(',').map((part) => part.trim().split(';')[0]);
  }

  it('asks for application/rdf+xml first', () => {
    // Many ELM applications do not produce Turtle at all. Asking for it first
    // means a parse failure cannot be told apart from an unsupported format.
    expect(mediaTypes(ACCEPT_RDF)[0]).toBe('application/rdf+xml');
  });

  it('still offers turtle and json-ld, at lower quality', () => {
    const types = mediaTypes(ACCEPT_RDF);
    expect(types).toContain('text/turtle');
    expect(types).toContain('application/ld+json');
    expect(ACCEPT_RDF).toMatch(/text\/turtle;q=0\.9/);
    expect(ACCEPT_RDF).toMatch(/application\/ld\+json;q=0\.8/);
  });
});

describe('failed shape fetches', () => {
  const SP = 'https://elm.example.com/rm/sp/1';
  const SHAPE = 'https://elm.example.com/rm/shapes/requirement#Shape';

  /**
   * A client whose service provider advertises one factory with a shape, and
   * whose shape document fetch always fails. Mirrors the real failure: the
   * SP resource parses fine, the shape behind it does not resolve.
   */
  function clientWithUnfetchableShape() {
    const oslc = Namespace('http://open-services.net/ns/core#');
    return {
      getResource: jest.fn(async (uri: string) => {
        if (uri.startsWith('https://elm.example.com/rm/shapes/')) {
          throw new Error('403 Forbidden');
        }
        const store = graph();
        const service = sym(`${uri}#service`);
        const factory = sym(`${uri}#factory`);
        store.add(st(sym(uri), dcterms('title'), lit('Stub Provider'), sym(uri)));
        store.add(st(sym(uri), oslc('service'), service, sym(uri)));
        store.add(st(service, oslc('creationFactory'), factory, sym(uri)));
        store.add(st(factory, dcterms('title'), lit('Requirement'), sym(uri)));
        store.add(st(factory, oslc('creation'), sym(`${uri}/create`), sym(uri)));
        store.add(st(factory, oslc('resourceShape'), sym(SHAPE), sym(uri)));
        return { store, getURI: () => uri, etag: '' };
      }),
    } as any;
  }

  it('records the shape it could not fetch instead of swallowing it', async () => {
    const result = await discoverFromServiceProviders(
      clientWithUnfetchableShape(), [SP], 'https://elm.example.com/rm/catalog'
    );
    const failed = result.serviceProviders[0].failedShapes ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0].shapeURI).toBe(SHAPE);
    // The fragment is stripped before fetching — the document is what failed.
    expect(failed[0].documentURI).toBe('https://elm.example.com/rm/shapes/requirement');
    expect(failed[0].reason).toContain('403');
  });

  it('leaves the list empty when every shape resolved', async () => {
    const fetched: string[] = [];
    const result = await discoverFromServiceProviders(
      stubClient(fetched), [SP], 'https://elm.example.com/rm/catalog'
    );
    expect(result.serviceProviders[0].failedShapes ?? []).toEqual([]);
  });
});
