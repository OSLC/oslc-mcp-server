import type { DiscoveryResult, DiscoveredServiceProvider, DiscoveredFactory } from 'oslc-service/mcp';
import type { CatalogResolution } from './catalog-resolution.js';
import type { ProbeRun } from './probe/orchestrate.js';
import type { CaseResult, Verdict } from './probe/verdicts.js';
import { createToolName } from 'oslc-service/mcp';

/**
 * Everything `describe_discovery` reports on for one server (design §4).
 */
export interface DescribeDiscoveryInput {
  alias: string;

  /**
   * What probing measured, keyed by the query base it measured. Absent unless
   * the server was started with `--probe-oslc`: OSLC advertises no query-feature
   * support, so nothing here can be discovered — a query capability names a
   * queryBase and its resource types and says nothing about which of
   * `oslc.where`, `oslc.select`, `oslc.orderBy`, paging or the optional where
   * constructs the server actually implements. Only issuing queries answers it.
   */
  probes?: ReadonlyMap<string, ProbeRun>;
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

function describeCatalogSource(catalog: CatalogResolution): string {
  switch (catalog.source.kind) {
    case 'explicit':
      return 'explicit configuration';
    case 'rootservices':
      return `rootservices predicate ${catalog.source.predicate}`;
  }
}

function describeProvider(sp: DiscoveredServiceProvider, prefix: string, probes?: ReadonlyMap<string, ProbeRun>): string[] {
  const lines = [`### ${sp.title}`, '', `- URI: ${sp.uri}`];

  lines.push('', '**Creation factories**', '');
  if (sp.factories.length === 0) {
    lines.push('- none advertised');
  } else {
    for (const factory of sp.factories as DiscoveredFactory[]) {
      // generateTools emits a create tool only when a shape is present, so a
      // shapeless factory is a tool that silently does not exist.
      // the SAME function the tool factory uses, so this report cannot name a
      // tool the server does not generate.
      const tool = factory.shape
        ? `${prefix}${createToolName(factory.title, factory.resourceType)}`
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
      lines.push(...queryFeatureLines(query.queryBase, probes));
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
/**
 * What probing measured about one query base, as a compact matrix.
 *
 * Says "not probed" rather than nothing at all when there is no run for it. An
 * absent section reads as "this server has no query features", and a report that
 * is silent about what it did not look at is a report that misleads.
 *
 * Renders EVERY case in the run rather than a hand-listed set: a probe case added
 * later would otherwise be measured and then silently dropped here, which is the
 * same failure this section exists to fix. Cases whose names share a `family:`
 * prefix (`where:equality`, `prefix-discovery:oslc.select`) collapse onto one
 * line, so a 15-capability report stays readable.
 */
function queryFeatureLines(queryBase: string, probes?: ReadonlyMap<string, ProbeRun>): string[] {
  if (!probes) {
    return ['  - query features: not probed (start with `--probe-oslc` to measure them)'];
  }
  const run = probes.get(queryBase);
  if (!run) {
    return ['  - query features: not probed'];
  }

  const mark = (v: Verdict): string => (v === 'supported' ? 'yes' : v === 'unsupported' ? 'NO' : v);
  const lines = [`  - query features (probed, ${run.mode}: ${run.modeReason || 'fixture established'})`];

  const families = new Map<string, CaseResult[]>();
  const singles: CaseResult[] = [];
  for (const c of run.cases) {
    const at = c.name.indexOf(':');
    if (at < 0) { singles.push(c); continue; }
    const family = c.name.slice(0, at);
    (families.get(family) ?? families.set(family, []).get(family)!).push(c);
  }

  for (const [family, cases] of families) {
    lines.push(`    ${family}: ` +
      cases.map((c) => `${c.name.slice(family.length + 1)} ${mark(c.verdict)}`).join(', '));
    // The reason for anything that is not plain support, one per line. Without it
    // a family line cannot be acted on: "inequality NO" reads the same whether the
    // server refused the clause with a 400 or answered it correctly and the probe
    // expected the wrong result set.
    for (const c of cases) {
      if (c.verdict !== 'supported') {
        lines.push(`      ${c.name.slice(family.length + 1)}: ${c.reason}`);
      }
    }
  }
  for (const c of singles) {
    // The reason is what makes a non-support verdict actionable — "ignored" alone
    // does not say whether the server chose its own page size or dropped the filter.
    lines.push(`    ${c.name}: ${mark(c.verdict)}` +
      (c.verdict === 'supported' ? '' : ` — ${c.reason}`));
  }
  // Say which ground truth the verdicts actually rest on. This once asserted
  // sampling while the verdicts beneath it read "inconclusive — fixture not
  // visible": a note describing behaviour that was not happening, which is
  // worse than no note.
  if (run.fixtureVisibleToQuery === false) {
    lines.push(run.groundTruthUsed === 'sampled'
      ? '    NOTE: the fixture is not visible to this capability, so verdicts rest on sampled existing content'
      : '    NOTE: the fixture is not visible to this capability and its members could not be sampled, so nothing could be judged');
  }
  if (run.needingCleanup.length > 0) {
    lines.push(`    LEFT BEHIND, needs manual cleanup: ${run.needingCleanup.join(', ')}`);
  }
  return lines;
}

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
    lines.push('', ...describeProvider(sp, prefix, input.probes));
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
