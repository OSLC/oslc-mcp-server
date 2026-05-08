import { OSLCClient, OSLCResource } from 'oslc-client';
import { Namespace, type NamedNode } from 'rdflib';
import type {
  DiscoveryResult,
  DiscoveredServiceProvider,
  DiscoveredFactory,
  DiscoveredQuery,
  DiscoveredShape,
} from 'oslc-service/mcp';
import {
  parseShape as parseShapeFromStore,
  formatCatalogContent,
  formatShapesContent,
  formatVocabularyContent,
} from 'oslc-service/mcp';
import type { ServerConfig } from './server-config.js';

const oslcNS = Namespace('http://open-services.net/ns/core#');
const dctermsNS = Namespace('http://purl.org/dc/terms/');

/**
 * Multi-format Accept header for OSLC GETs. Servers vary in which RDF
 * serializations they support; some only emit application/rdf+xml. Send
 * a quality-weighted list and let `OSLCClient.getResource` parse whatever
 * the server returns. (rdflib handles all three formats.)
 */
export const ACCEPT_RDF =
  'text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8';

/**
 * Parse a shape from an OSLCResource (HTTP-fetched) into a DiscoveredShape.
 * Delegates to the shared parseShape() from oslc-service/mcp which operates
 * on an rdflib IndexedFormula.
 */
function parseShape(shapeResource: OSLCResource, overrideURI?: string): DiscoveredShape {
  const store = shapeResource.store;
  const shapeURI = overrideURI ?? shapeResource.getURI();
  return parseShapeFromStore(store, shapeURI);
}

/**
 * Discover capabilities of a single ServiceProvider — fetch the SP
 * resource, parse its services / factories / queries, and (optionally)
 * fetch each referenced shape document. Returns null on fetch failure.
 *
 * Used by the catalog-wide `discover()` and by the on-demand
 * `read_service_provider` MCP tool, so the AI can drill into a specific
 * SP without forcing the server to crawl every SP at startup (an issue
 * for catalogs with thousands of SPs).
 *
 * `sharedShapes` is mutated as new shapes are encountered so callers
 * scanning multiple SPs can dedupe shape fetches.
 */
export async function discoverServiceProvider(
  client: OSLCClient,
  spURI: string,
  sharedShapes: Map<string, DiscoveredShape> = new Map()
): Promise<DiscoveredServiceProvider | null> {
  let spResource: OSLCResource;
  try {
    spResource = await client.getResource(spURI, '3.0', ACCEPT_RDF);
  } catch (err) {
    console.error(`[discovery] Failed to fetch SP ${spURI}:`, err);
    return null;
  }

  const spStore = spResource.store;
  const spSym = spStore.sym(spURI);
  const spTitle = spStore.anyValue(spSym, dctermsNS('title')) ?? spURI;

  const factories: DiscoveredFactory[] = [];
  const queries: DiscoveredQuery[] = [];
  const domainSet = new Set<string>();

  const serviceNodes = spStore.each(spSym, oslcNS('service'), null);

  for (const serviceNode of serviceNodes) {
    const sn = serviceNode as NamedNode;

    // oslc:domain — vocabulary namespace URIs declared by this service.
    const domainNodes = spStore.each(sn, oslcNS('domain'), null);
    for (const dn of domainNodes) {
      if (dn.termType === 'NamedNode') domainSet.add(dn.value);
    }

    // Creation factories
    const factoryNodes = spStore.each(sn, oslcNS('creationFactory'), null);
    for (const factoryNode of factoryNodes) {
      const fn = factoryNode as NamedNode;
      const factoryTitle = spStore.anyValue(fn, dctermsNS('title')) ?? '';
      const creationNode = spStore.any(fn, oslcNS('creation'), null);
      const creationURI = creationNode?.value ?? '';
      const resourceTypeNode = spStore.any(fn, oslcNS('resourceType'), null);
      const resourceType = resourceTypeNode?.value ?? '';
      const shapeNode = spStore.any(fn, oslcNS('resourceShape'), null);

      let shape: DiscoveredShape | null = null;
      if (shapeNode) {
        const shapeURI = shapeNode.value;
        if (sharedShapes.has(shapeURI)) {
          shape = sharedShapes.get(shapeURI)!;
        } else {
          try {
            const shapeDocURI = shapeURI.split('#')[0];
            console.error(`[discovery] Fetching shape: ${shapeDocURI}`);
            const shapeResource = await client.getResource(shapeDocURI, '3.0', ACCEPT_RDF);
            shape = parseShape(shapeResource, shapeURI !== shapeDocURI ? shapeURI : undefined);
            sharedShapes.set(shapeURI, shape);
          } catch (err) {
            console.error(`[discovery] Failed to fetch shape ${shapeURI}:`, err);
          }
        }
      }

      if (creationURI) {
        factories.push({ title: factoryTitle, creationURI, resourceType, shape });
      }
    }

    // Query capabilities
    const queryNodes = spStore.each(sn, oslcNS('queryCapability'), null);
    for (const queryNode of queryNodes) {
      const qn = queryNode as NamedNode;
      const queryTitle = spStore.anyValue(qn, dctermsNS('title')) ?? '';
      const queryBaseNode = spStore.any(qn, oslcNS('queryBase'), null);
      const queryBase = queryBaseNode?.value ?? '';
      const resourceTypeNode = spStore.any(qn, oslcNS('resourceType'), null);
      const resourceType = resourceTypeNode?.value ?? '';

      if (queryBase) {
        queries.push({ title: queryTitle, queryBase, resourceType });
      }
    }
  }

  return {
    title: spTitle,
    uri: spURI,
    factories,
    queries,
    domains: [...domainSet],
  };
}

/**
 * Discover all capabilities from an OSLC service provider catalog.
 */
export async function discover(
  client: OSLCClient,
  config: ServerConfig
): Promise<DiscoveryResult> {
  const catalogURL = config.catalogURL;

  // Fetch catalog
  console.error(`[discovery] Fetching catalog: ${catalogURL}`);
  const catalogResource = await client.getResource(catalogURL, '3.0', ACCEPT_RDF);
  const catalogStore = catalogResource.store;
  const catalogSym = catalogStore.sym(catalogURL);

  // Find service providers (try oslc:serviceProvider first, fall back to ldp:contains)
  const ldpNS = Namespace('http://www.w3.org/ns/ldp#');
  let spNodes = catalogStore.each(
    catalogSym,
    oslcNS('serviceProvider'),
    null
  );
  if (spNodes.length === 0) {
    spNodes = catalogStore.each(
      catalogSym,
      ldpNS('contains'),
      null
    );
  }

  const serviceProviders: DiscoveredServiceProvider[] = [];
  const shapes = new Map<string, DiscoveredShape>();

  for (const spNode of spNodes) {
    const spURI = spNode.value;
    console.error(`[discovery] Fetching service provider: ${spURI}`);
    const sp = await discoverServiceProvider(client, spURI, shapes);
    if (sp) serviceProviders.push(sp);
  }

  // Build readable content for MCP resources
  const catalogContent = formatCatalogContent(serviceProviders);
  const shapesContent = formatShapesContent(shapes);
  const vocabularyContent = formatVocabularyContent(serviceProviders, shapes);

  console.error(
    `[discovery] Complete: ${serviceProviders.length} providers, ` +
    `${serviceProviders.reduce((n, sp) => n + sp.factories.length, 0)} factories, ` +
    `${shapes.size} shapes`
  );

  return {
    catalogURI: catalogURL,
    supportsJsonLd: false,
    serviceProviders,
    shapes,
    vocabularyContent,
    catalogContent,
    shapesContent,
  };
}
