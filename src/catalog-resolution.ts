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
 *
 * Both namespace generations are listed. The `xmlns/<domain>/1.0/` forms are
 * what ELM emits; the `ns/<domain>#` forms are OSLC 3.0, and are what the
 * servers in this workspace emit. A server advertising only the newer form
 * would otherwise fall through to the convention, which is a different URL
 * and usually the wrong one.
 *
 * Deliberately absent: `http://open-services.net/ns/config#cmServiceProviders`.
 * There is no ambiguity in the RDF — change management is `ns/cm#` and
 * configuration management is `ns/config#`, conventionally prefixed
 * `oslc_cm:` and `oslc_config:`, and matching is on the full URI. It is
 * excluded because it is a different kind of catalog: configurations, not
 * artifact service providers. A server may well advertise both.
 */
const CATALOG_PREDICATES = [
  'http://open-services.net/xmlns/rm/1.0/rmServiceProviders',
  'http://open-services.net/xmlns/qm/1.0/qmServiceProviders',
  'http://open-services.net/xmlns/cm/1.0/cmServiceProviders',
  'http://open-services.net/xmlns/am/1.0/amServiceProviders',
  'http://open-services.net/ns/rm#rmServiceProviders',
  'http://open-services.net/ns/qm#qmServiceProviders',
  'http://open-services.net/ns/cm#cmServiceProviders',
  'http://open-services.net/ns/am#amServiceProviders',
  // Last: OSLC Core's generic catalog reference. It names no domain, so it is
  // only right when no domain-specific predicate answered.
  'http://open-services.net/ns/core#serviceProviderCatalog',
];

/**
 * How a catalog URL was arrived at. `describe_discovery` reports it, because
 * a catalog reached by the fallback convention and one advertised by the
 * server are very different situations that look identical downstream.
 */
export type CatalogSource =
  | { kind: 'explicit' }
  | { kind: 'rootservices'; predicate: string };

export interface CatalogResolution {
  url: string;
  source: CatalogSource;
}

/**
 * Resolve a server's catalog URL: an explicit value if configured, otherwise
 * whatever `${baseUrl}/rootservices` advertises.
 *
 * There is no third option, deliberately. A catalog URL is not something a
 * client may assume the shape of — that is the point of `rootservices`, which
 * is unauthenticated precisely so discovery can bootstrap from it and find the
 * URLs needed to authenticate. Guessing a conventional path instead is bad
 * REST practice, and it fails in the worst way: the guess is a URL that
 * exists, so the error surfaces later as a 401 or a 404 on something that was
 * never the catalog, with nothing to indicate the address was invented.
 *
 * So when rootservices advertises no catalog, this throws and says what to
 * configure, rather than proceeding on a fabricated URL.
 */
export async function resolveCatalogUrl(
  client: OSLCClient,
  baseUrl: string,
  explicit?: string
): Promise<CatalogResolution> {
  if (explicit) return { url: explicit, source: { kind: 'explicit' } };

  const base = baseUrl.replace(/\/$/, '');
  const rootservices = `${base}/rootservices`;

  let resource;
  try {
    resource = await client.getResource(rootservices, '2.0', ACCEPT_RDF);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read ${rootservices} (${reason}). It is the unauthenticated entry point for OSLC ` +
      `discovery, so it must be reachable — or set catalogUrl for this server explicitly.`
    );
  }

  const store = resource.store;
  const subject = store.sym(rootservices);
  for (const predicate of CATALOG_PREDICATES) {
    const value = store.any(subject, store.sym(predicate), null);
    if (value?.value) {
      console.error(`[startup] catalog from rootservices: ${value.value} (${predicate})`);
      return { url: value.value, source: { kind: 'rootservices', predicate } };
    }
  }

  throw new Error(
    `${rootservices} advertises no service provider catalog this client recognises. ` +
    `Set catalogUrl for this server explicitly, or have the server advertise one of: ` +
    `${CATALOG_PREDICATES.join(', ')}`
  );
}
