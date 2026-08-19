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

  it('resolves an OSLC 3.0 namespace predicate, not only the ELM 1.0 form', async () => {
    // genoslc servers advertise ns/am#amServiceProviders. Missing it sent
    // discovery to the fallback convention, which is a different URL.
    const AM3 = 'http://open-services.net/ns/am#amServiceProviders';
    const resolved = await resolveCatalogUrl(stubClient(AM3), BASE, undefined);
    expect(resolved).toEqual({ url: CATALOG, source: { kind: 'rootservices', predicate: AM3 } });
  });

  it("accepts OSLC Core's generic serviceProviderCatalog when no domain predicate answers", async () => {
    const CORE = 'http://open-services.net/ns/core#serviceProviderCatalog';
    const resolved = await resolveCatalogUrl(stubClient(CORE), BASE, undefined);
    expect(resolved.source).toEqual({ kind: 'rootservices', predicate: CORE });
  });

  it("never treats the configuration catalog as a domain catalog", async () => {
    // ns/config#cmServiceProviders shares a local name with change
    // management's, but points at configurations, not service providers.
    const CONFIG = 'http://open-services.net/ns/config#cmServiceProviders';
    const resolved = await resolveCatalogUrl(stubClient(CONFIG), BASE, undefined);
    expect(resolved.source.kind).toBe('convention');
  });

  it('prefers a domain predicate over the generic one when both are present', async () => {
    const AM3 = 'http://open-services.net/ns/am#amServiceProviders';
    const CORE = 'http://open-services.net/ns/core#serviceProviderCatalog';
    const client = {
      getResource: jest.fn(async (uri: string) => {
        const store = graph();
        store.add(st(sym(uri), sym(CORE), sym('https://elm.example.com/generic'), sym(uri)));
        store.add(st(sym(uri), sym(AM3), sym(CATALOG), sym(uri)));
        return { store, getURI: () => uri, etag: '' };
      }),
    } as any;
    const resolved = await resolveCatalogUrl(client, BASE, undefined);
    expect(resolved.url).toBe(CATALOG);
  });

  it('fetches rootservices at the conventional path', async () => {
    const client = stubClient(RM_PREDICATE);
    await resolveCatalogUrl(client, BASE, undefined);
    expect(client.getResource).toHaveBeenCalledWith(ROOTSERVICES, '2.0', expect.any(String));
  });
});
