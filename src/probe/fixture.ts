import type { DiscoveredServiceProvider, DiscoveredFactory } from 'oslc-service/mcp';

/**
 * Marks every resource the probe creates. Cleanup and the report both rely on
 * it, and it makes an abandoned fixture recognisable to a human later.
 */
export const FIXTURE_PREFIX = 'PROBE-';

const EXACTLY_ONE = 'http://open-services.net/ns/core#Exactly-one';
const ONE_OR_MANY = 'http://open-services.net/ns/core#One-or-many';

export interface FixtureSpec {
  identifier: string;
  title: string;
  /** Set on some resources and not others, for oslc.select and set membership. */
  optionalNote?: string;
}

/**
 * The fixture (§5.3). Every value is chosen so its expected query result is
 * known before the query is sent:
 *
 * - a unique identifier per resource — equality, inequality, and the
 *   uniqueness that makes `ignored` exact;
 * - titles that sort predictably — ascending versus descending;
 * - a note on some and not others — oslc.select and set membership;
 * - five resources — enough for oslc.pageSize=2 to page and yield
 *   oslc:nextPage.
 */
export function fixtureSpecs(): FixtureSpec[] {
  return [
    { identifier: `${FIXTURE_PREFIX}01`, title: 'Probe 01', optionalNote: 'Aardvark note' },
    { identifier: `${FIXTURE_PREFIX}02`, title: 'Probe 02' },
    { identifier: `${FIXTURE_PREFIX}03`, title: 'Probe 03', optionalNote: 'Capybara note' },
    { identifier: `${FIXTURE_PREFIX}04`, title: 'Probe 04' },
    { identifier: `${FIXTURE_PREFIX}05`, title: 'Probe 05' },
  ];
}

/** Escape a value for a Turtle double-quoted literal. */
function literal(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** One fixture resource as Turtle, for POSTing to a creation factory. */
export function fixtureTurtle(spec: FixtureSpec, resourceType: string): string {
  const lines = [
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '',
    `<> a <${resourceType}> ;`,
    `   dcterms:identifier "${literal(spec.identifier)}" ;`,
  ];
  if (spec.optionalNote !== undefined) {
    lines.push(`   dcterms:description "${literal(spec.optionalNote)}" ;`);
  }
  lines.push(`   dcterms:title "${literal(spec.title)}" .`);
  return lines.join('\n');
}

/** Records created URIs, both to a sink and in memory. */
export interface Manifest {
  record(uri: string): void;
  created(): string[];
}

/**
 * Every created URI is written **before** the create, so an interruption
 * leaves a file naming exactly what exists (§5.4).
 *
 * A failing sink must not lose the in-memory list: that list is what the
 * report uses to name artifacts needing manual cleanup, and losing it is
 * strictly worse than losing the file.
 */
export function createManifest(write: (line: string) => void): Manifest {
  const uris: string[] = [];
  return {
    record(uri: string): void {
      uris.push(uri);
      try {
        write(uri);
      } catch {
        // The in-memory record is what cleanup needs; a sink failure is
        // reported by the caller, not thrown from here.
      }
    },
    created: () => [...uris],
  };
}

/** How many properties a shape requires. */
function requiredCount(factory: DiscoveredFactory): number {
  const properties = (factory.shape?.properties ?? []) as Array<{ occurs?: string }>;
  return properties.filter((p) => p.occurs === EXACTLY_ONE || p.occurs === ONE_OR_MANY).length;
}

/**
 * Pick a resource type to build the fixture from (§12's open question,
 * settled here by policy).
 *
 * Prefer the factory whose shape demands the fewest required properties: the
 * fixture only needs an identifier, a title and an optional note, so a shape
 * with many mandatory properties is likely to fail creation for reasons that
 * have nothing to do with the capability under test. A factory without a
 * shape is skipped — there is no schema to satisfy, and no tool is generated
 * for it either.
 */
export function chooseFixtureType(sp: DiscoveredServiceProvider): DiscoveredFactory | null {
  const usable = sp.factories.filter((f) => f.shape && f.creationURI);
  if (usable.length === 0) return null;
  return usable.reduce((best, f) => (requiredCount(f) < requiredCount(best) ? f : best));
}
