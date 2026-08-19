import { describe, it, expect, jest } from '@jest/globals';
import rdflib from 'rdflib';
import { resolveCatalogUrl } from './catalog-resolution.js';

const { graph, sym, st } = rdflib as any;

const BASE = 'https://elm.example.com/rm';
const ROOTSERVICES = `${BASE}/rootservices`;
const RM_PREDICATE = 'http://open-services.net/xmlns/rm/1.0/rmServiceProviders';
const CATALOG = 'https://elm.example.com/rm/oslc_rm/catalog';

/** Stub client whose rootservices advertises the given predicate, or fails. */
function stubClient(predicate?: string) {
  return {
    getResource: jest.fn(async (uri: string) => {
      if (!predicate) throw new Error('404');
      const store = graph();
      store.add(st(sym(uri), sym(predicate), sym(CATALOG), sym(uri)));
      return { store, getURI: () => uri, etag: '' };
    }),
  } as any;
}

describe('resolveCatalogUrl', () => {
  it('reports an explicit value as explicit, and never fetches rootservices', async () => {
    const client = stubClient(RM_PREDICATE);
    const resolved = await resolveCatalogUrl(client, BASE, CATALOG);
    expect(resolved).toEqual({ url: CATALOG, source: { kind: 'explicit' } });
    expect(client.getResource).not.toHaveBeenCalled();
  });

  it('names the rootservices predicate it resolved through', async () => {
    const resolved = await resolveCatalogUrl(stubClient(RM_PREDICATE), BASE, undefined);
    expect(resolved).toEqual({
      url: CATALOG,
      source: { kind: 'rootservices', predicate: RM_PREDICATE },
    });
  });

  it('falls back to the convention when rootservices advertises no catalog', async () => {
    const resolved = await resolveCatalogUrl(stubClient('http://example.com/unrelated'), BASE, undefined);
    expect(resolved).toEqual({
      url: `${BASE}/oslc/catalog`,
      source: { kind: 'convention', reason: 'no-catalog-predicate' },
    });
  });

  it('distinguishes an unreachable rootservices from one that advertised nothing', async () => {
    const resolved = await resolveCatalogUrl(stubClient(undefined), BASE, undefined);
    expect(resolved).toEqual({
      url: `${BASE}/oslc/catalog`,
      source: { kind: 'convention', reason: 'rootservices-unreachable' },
    });
  });

  it('does not double a trailing slash on the base URL', async () => {
    const resolved = await resolveCatalogUrl(stubClient(undefined), `${BASE}/`, undefined);
    expect(resolved.url).toBe(`${BASE}/oslc/catalog`);
  });

  it('fetches rootservices at the conventional path', async () => {
    const client = stubClient(RM_PREDICATE);
    await resolveCatalogUrl(client, BASE, undefined);
    expect(client.getResource).toHaveBeenCalledWith(ROOTSERVICES, '2.0', expect.any(String));
  });
});
