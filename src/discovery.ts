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
 * Discover all capabilities from an OSLC service provider catalog.
 */
export async function discover(
  client: OSLCClient,
  config: ServerConfig
): Promise<DiscoveryResult> {
  const catalogURL = config.catalogURL;

  // Fetch catalog
  console.error(`[discovery] Fetching catalog: ${catalogURL}`);
  const catalogResource = await client.getResource(catalogURL, '3.0', 'text/turtle');
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

    let spResource: OSLCResource;
    try {
      spResource = await client.getResource(spURI, '3.0', 'text/turtle');
    } catch (err) {
      console.error(`[discovery] Failed to fetch SP ${spURI}:`, err);
      continue;
    }

    const spStore = spResource.store;
    const spSym = spStore.sym(spURI);
    const spTitle =
      spStore.anyValue(spSym, dctermsNS('title')) ?? spURI;

    // Collect services
    const serviceNodes = spStore.each(spSym, oslcNS('service'), null);

    const factories: DiscoveredFactory[] = [];
    const queries: DiscoveredQuery[] = [];

    for (const serviceNode of serviceNodes) {
      const sn = serviceNode as NamedNode;
      // Creation factories
      const factoryNodes = spStore.each(
        sn,
        oslcNS('creationFactory'),
        null
      );
      for (const factoryNode of factoryNodes) {
        const fn = factoryNode as NamedNode;
        const factoryTitle =
          spStore.anyValue(fn, dctermsNS('title')) ?? '';
        const creationNode = spStore.any(
          fn,
          oslcNS('creation'),
          null
        );
        const creationURI = creationNode?.value ?? '';
        const resourceTypeNode = spStore.any(
          fn,
          oslcNS('resourceType'),
          null
        );
        const resourceType = resourceTypeNode?.value ?? '';
        const shapeNode = spStore.any(
          fn,
          oslcNS('resourceShape'),
          null
        );

        let shape: DiscoveredShape | null = null;
        if (shapeNode) {
          const shapeURI = shapeNode.value;
          if (shapes.has(shapeURI)) {
            shape = shapes.get(shapeURI)!;
          } else {
            try {
              // Fetch the shape document (the shape URI may be a fragment)
              const shapeDocURI = shapeURI.split('#')[0];
              console.error(`[discovery] Fetching shape: ${shapeDocURI}`);
              const shapeResource = await client.getResource(shapeDocURI, '3.0', 'text/turtle');
              shape = parseShape(shapeResource, shapeURI !== shapeDocURI ? shapeURI : undefined);
              shapes.set(shapeURI, shape);
            } catch (err) {
              console.error(
                `[discovery] Failed to fetch shape ${shapeURI}:`,
                err
              );
            }
          }
        }

        if (creationURI) {
          factories.push({
            title: factoryTitle,
            creationURI,
            resourceType,
            shape,
          });
        }
      }

      // Query capabilities
      const queryNodes = spStore.each(
        sn,
        oslcNS('queryCapability'),
        null
      );
      for (const queryNode of queryNodes) {
        const qn = queryNode as NamedNode;
        const queryTitle =
          spStore.anyValue(qn, dctermsNS('title')) ?? '';
        const queryBaseNode = spStore.any(
          qn,
          oslcNS('queryBase'),
          null
        );
        const queryBase = queryBaseNode?.value ?? '';
        const resourceTypeNode = spStore.any(
          qn,
          oslcNS('resourceType'),
          null
        );
        const resourceType = resourceTypeNode?.value ?? '';

        if (queryBase) {
          queries.push({ title: queryTitle, queryBase, resourceType });
        }
      }
    }

    serviceProviders.push({
      title: spTitle,
      uri: spURI,
      factories,
      queries,
    });
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
