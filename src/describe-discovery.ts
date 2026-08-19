import type { DiscoveryResult, DiscoveredServiceProvider, DiscoveredFactory } from 'oslc-service/mcp';
import type { CatalogResolution } from './catalog-resolution.js';

/**
 * Everything `describe_discovery` reports on for one server (design §4).
 */
export interface DescribeDiscoveryInput {
  alias: string;
  /** '' for a single server; `${alias}_` when several are configured. */
  prefix: string;
  catalog: CatalogResolution;
  discovery: DiscoveryResult;
}

/**
 * Mirror of tool-factory.ts's sanitizeName. Duplicated deliberately: this
 * report must state the name the tool factory *will* produce, so if the two
 * ever diverge the report should show the divergence rather than hide it by
 * sharing an implementation.
 */
function sanitizeName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function describeCatalogSource(catalog: CatalogResolution): string {
  switch (catalog.source.kind) {
    case 'explicit':
      return 'explicit configuration';
    case 'rootservices':
      return `rootservices predicate ${catalog.source.predicate}`;
    case 'convention':
      return `fallback convention (${catalog.source.reason})`;
  }
}

function describeProvider(sp: DiscoveredServiceProvider, prefix: string): string[] {
  const lines = [`### ${sp.title}`, '', `- URI: ${sp.uri}`];

  lines.push('', '**Creation factories**', '');
  if (sp.factories.length === 0) {
    lines.push('- none advertised');
  } else {
    for (const factory of sp.factories as DiscoveredFactory[]) {
      // generateTools emits a create tool only when a shape is present, so a
      // shapeless factory is a tool that silently does not exist.
      const tool = factory.shape
        ? `${prefix}create_${sanitizeName(factory.title)}`
        : 'no tool generated (no shape)';
      lines.push(`- ${factory.title} — \`${tool}\` → ${factory.creationURI || '(no creation URI)'}`);
      lines.push(`  - resource type: ${factory.resourceType || '(none)'}`);
    }
  }

  lines.push('', '**Query capabilities**', '');
  if (sp.queries.length === 0) {
    lines.push('- none advertised');
  } else {
    for (const query of sp.queries) {
      lines.push(`- ${query.title} → ${query.queryBase}`);
      lines.push(`  - resource type: ${query.resourceType || '(none)'}`);
    }
  }

  const failed = sp.failedShapes ?? [];
  if (failed.length > 0) {
    // Listed after the factories on purpose: this is the list that explains
    // why a tool above is missing.
    lines.push('', '**Shapes that failed to fetch**', '');
    for (const f of failed) {
      lines.push(`- ${f.documentURI} — ${f.reason}`);
      if (f.shapeURI !== f.documentURI) lines.push(`  - advertised as: ${f.shapeURI}`);
    }
  }

  return lines;
}

/**
 * Render what discovery found and which URL each generated tool will hit.
 *
 * Read-only and instant — no requests are made. That is why it is a separate
 * tool from the probe: it can be called freely, against anything.
 */
export function describeDiscovery(input: DescribeDiscoveryInput): string {
  const { alias, prefix, catalog, discovery } = input;
  const lines: string[] = [
    `## Discovery — ${alias}`,
    '',
    `- Catalog: ${catalog.url}`,
    `- Resolved by: ${describeCatalogSource(catalog)}`,
    `- Service providers: ${discovery.serviceProviders.length}`,
    `- Shapes fetched: ${discovery.shapes.size}`,
  ];

  const totalFailed = discovery.serviceProviders.reduce(
    (n, sp) => n + (sp.failedShapes?.length ?? 0), 0
  );
  lines.push(`- Shapes that failed to fetch: ${totalFailed}`);

  if (discovery.serviceProviders.length === 0) {
    lines.push('', 'No service providers were discovered, so no tools were generated.');
    return lines.join('\n');
  }

  for (const sp of discovery.serviceProviders) {
    lines.push('', ...describeProvider(sp, prefix));
  }

  return lines.join('\n');
}
