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
  /**
   * Enumerate at most this many service providers, then say how many were
   * omitted. A scoped run names a handful and is never affected. A catalog-wide
   * crawl of a large deployment is: 306 providers at ~10 factories each is a
   * six-figure token count, and this report is meant to be readable — and to be
   * usable as context describing what the tools can do. Truncation is stated,
   * never silent.
   */
  maxProviders?: number;
}

/** Providers enumerated before the report summarises the remainder. */
export const DEFAULT_MAX_PROVIDERS = 25;

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
  const maxProviders = input.maxProviders ?? DEFAULT_MAX_PROVIDERS;
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

  const shown = discovery.serviceProviders.slice(0, maxProviders);
  for (const sp of shown) {
    lines.push('', ...describeProvider(sp, prefix));
  }

  const omitted = discovery.serviceProviders.length - shown.length;
  if (omitted > 0) {
    lines.push('', `_${omitted} further service provider(s) not enumerated ` +
      `(limit ${maxProviders}). Scope discovery to the providers you use to see them all._`);
  }

  return lines.join('\n');
}

/**
 * One document covering every configured server, for `reportPath`.
 *
 * Deliberately carries no timestamp: the file is rewritten on every start, and
 * a timestamp would make it churn in a diff. Anyone who wants the capture time
 * has the file's own mtime — and a report kept under version control as context
 * should change only when what it describes changes.
 */
export function describeDiscoveryDocument(inputs: DescribeDiscoveryInput[]): string {
  const header = [
    '# OSLC MCP server — discovery',
    '',
    'What discovery found, and which URL each generated tool will hit.',
    'Rewritten on every server start.',
  ].join('\n');

  return [header, ...inputs.map((i) => describeDiscovery(i))].join('\n\n') + '\n';
}
