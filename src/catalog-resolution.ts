import rdflib from 'rdflib';
import type { OSLCClient } from 'oslc-client';
import { ACCEPT_RDF } from './discovery.js';

const { Namespace } = rdflib;

/**
 * Predicates an OSLC server uses in rootservices to advertise its domain's
 * service provider catalog.
 *
 * An application may advertise several catalogs — an ELM quality-management
 * application advertises its own plus automation, change management and
 * configuration — so selection is by domain predicate, never by taking the
 * first catalog found.
 */
const CATALOG_PREDICATES = [
  'http://open-services.net/xmlns/rm/1.0/rmServiceProviders',
  'http://open-services.net/xmlns/qm/1.0/qmServiceProviders',
  'http://open-services.net/xmlns/cm/1.0/cmServiceProviders',
  'http://open-services.net/xmlns/am/1.0/amServiceProviders',
];

/**
 * How a catalog URL was arrived at. `describe_discovery` reports it, because
 * a catalog reached by the fallback convention and one advertised by the
 * server are very different situations that look identical downstream.
 */
export type CatalogSource =
  | { kind: 'explicit' }
  | { kind: 'rootservices'; predicate: string }
  | { kind: 'convention'; reason: 'no-catalog-predicate' | 'rootservices-unreachable' };

export interface CatalogResolution {
  url: string;
  source: CatalogSource;
}

/**
 * Resolve a server's catalog URL:
 *   1. an explicit value always wins;
 *   2. otherwise read ${baseUrl}/rootservices and take the first domain
 *      catalog predicate present;
 *   3. otherwise fall back to ${baseUrl}/oslc/catalog, which is this
 *      workspace's convention and preserves the previous behaviour.
 *
 * The `${baseUrl}/oslc/catalog` convention matches no ELM application, which
 * is why step 2 exists.
 */
export async function resolveCatalogUrl(
  client: OSLCClient,
  baseUrl: string,
  explicit?: string
): Promise<CatalogResolution> {
  if (explicit) return { url: explicit, source: { kind: 'explicit' } };

  const base = baseUrl.replace(/\/$/, '');
  const rootservices = `${base}/rootservices`;
  const convention = `${base}/oslc/catalog`;

  try {
    const resource = await client.getResource(rootservices, '2.0', ACCEPT_RDF);
    const store = resource.store;
    const subject = store.sym(rootservices);
    for (const predicate of CATALOG_PREDICATES) {
      const value = store.any(subject, store.sym(predicate), null);
      if (value?.value) {
        console.error(`[startup] catalog from rootservices: ${value.value}`);
        return { url: value.value, source: { kind: 'rootservices', predicate } };
      }
    }
    console.error(
      `[startup] ${rootservices} advertised no catalog predicate; using convention`
    );
    return { url: convention, source: { kind: 'convention', reason: 'no-catalog-predicate' } };
  } catch {
    console.error(`[startup] no rootservices at ${rootservices}; using convention`);
    return { url: convention, source: { kind: 'convention', reason: 'rootservices-unreachable' } };
  }
}
