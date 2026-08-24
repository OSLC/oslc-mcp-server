import type { DiscoveredServiceProvider, DiscoveredFactory } from 'oslc-service/mcp';
import type { ShapeAccess, ShapePropertyAccess } from 'oslc-service/mcp';

/**
 * Marks every resource the probe creates. Cleanup and the report both rely on
 * it, and it makes an abandoned fixture recognisable to a human later.
 */
export const FIXTURE_PREFIX = 'PROBE-';

/** What the fixture needs to know about a required property, from either source. */
interface RequiredProperty {
  propertyDefinition: string | null;
  allowedValues: string[];
  defaultValue: string | null;
  isReference: boolean;
}

/**
 * A shape's required properties, through the graph-backed accessors where the
 * shape was parsed from RDF, and from the flattened array where it was not.
 *
 * `DiscoveredShape.access` is optional — a shape assembled by hand has no store
 * behind it — so both paths are real. The accessors are preferred because they
 * compare against the OSLC URIs the server published; the fallback normalises the
 * local name itself rather than testing for a URI that the flattened form no
 * longer contains, which is the comparison that silently matched nothing and left
 * every factory looking unconstrained.
 */
function requiredProperties(shape: unknown): RequiredProperty[] {
  const access = (shape as { access?: ShapeAccess } | undefined)?.access;
  if (access) {
    return access.required.map((p: ShapePropertyAccess) => ({
      propertyDefinition: p.propertyDefinition,
      allowedValues: p.allowedValues,
      defaultValue: p.defaultValue,
      isReference: p.isReference,
    }));
  }

  const flattened = ((shape as { properties?: Array<Record<string, unknown>> } | undefined)?.properties ?? []);
  return flattened
    .filter((p) => {
      const occurs = p.occurs;
      return typeof occurs === 'string'
        && REQUIRED_OCCURS.has(occurs.replace(/^.*[#/]/, '').toLowerCase());
    })
    .map((p) => ({
      propertyDefinition: (p.propertyDefinition ?? p.predicateURI ?? null) as string | null,
      allowedValues: (p.allowedValues ?? []) as string[],
      defaultValue: (p.defaultValue ?? null) as string | null,
      isReference: REFERENCE_TYPES.has(String(p.valueType ?? '')),
    }));
}

const REQUIRED_OCCURS = new Set(['exactly-one', 'one-or-many']);
const REFERENCE_TYPES = new Set([
  'http://open-services.net/ns/core#Resource',
  'http://open-services.net/ns/core#AnyResource',
  'http://open-services.net/ns/core#LocalResource',
]);

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
 * - titles that are unique, sort predictably, and carry the `PROBE-` marker —
 *   equality and inequality filters, ascending versus descending ordering, and a
 *   human finding leftover resources in the server's own UI. The marker lives in
 *   the title because it cannot live in `dcterms:identifier`: OSLC Core makes
 *   that property server-assigned, so a client-supplied value is discarded by a
 *   conformant server (EWM does) and the fixture would be unrecognisable;
 * - a note on some and not others — oslc.select and set membership;
 * - five resources — enough for oslc.pageSize=2 to page and yield
 *   oslc:nextPage.
 */
export function fixtureSpecs(): FixtureSpec[] {
  return [
    { identifier: `${FIXTURE_PREFIX}01`, title: `${FIXTURE_PREFIX}01`, optionalNote: 'Aardvark note' },
    { identifier: `${FIXTURE_PREFIX}02`, title: `${FIXTURE_PREFIX}02` },
    { identifier: `${FIXTURE_PREFIX}03`, title: `${FIXTURE_PREFIX}03`, optionalNote: 'Capybara note' },
    { identifier: `${FIXTURE_PREFIX}04`, title: `${FIXTURE_PREFIX}04` },
    { identifier: `${FIXTURE_PREFIX}05`, title: `${FIXTURE_PREFIX}05` },
  ];
}

/** Escape a value for XML character data. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * One fixture resource as RDF/XML, for POSTing to a creation factory.
 *
 * RDF/XML rather than Turtle because OSLC Core makes it the **mandatory**
 * representation and Turtle optional: a probe that establishes its fixture over
 * an optional format can fail against a conformant server, and then measures
 * nothing at all. The format under test here is the one every server must
 * accept.
 *
 * `rdf:about=""` is the relative-URI form of Turtle's `<>` — the server assigns
 * the real URI and returns it in `Location`.
 *
 * `dcterms:identifier` is deliberately NOT sent. Core declares it server-assigned
 * and read-only, so sending one asks a conformant server to ignore it — which
 * then registered as a "property dropped on create" finding against a server that
 * did exactly the right thing. Ground truth reads identifiers back, so whatever
 * the server assigns is still available to filter on.
 */
export function fixtureRdfXml(
  spec: FixtureSpec,
  resourceType: string,
  extras: Array<{ predicate: string; value: string; isReference: boolean }> = []
): string {
  const typeMatch = /^(.*[#/])([^#/]+)$/.exec(resourceType);
  const [typeNs, typeName] = typeMatch ? [typeMatch[1], typeMatch[2]] : ['', resourceType];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
    '         xmlns:dcterms="http://purl.org/dc/terms/"',
    `         xmlns:t="${xml(typeNs)}">`,
    '  <t:' + typeName + ' rdf:about="">',
  ];
  if (spec.optionalNote !== undefined) {
    lines.push(`    <dcterms:description>${xml(spec.optionalNote)}</dcterms:description>`);
  }
  lines.push(`    <dcterms:title>${xml(spec.title)}</dcterms:title>`);

  // Whatever else the shape insists on, each on its own namespace prefix so the
  // element name cannot collide with dcterms or the resource type.
  extras.forEach((extra, i) => {
    const match = /^(.*[#/])([^#/]+)$/.exec(extra.predicate);
    if (!match) return;
    const [, ns, local] = match;
    lines.push(extra.isReference
      ? `    <e${i}:${local} xmlns:e${i}="${xml(ns)}" rdf:resource="${xml(extra.value)}"/>`
      : `    <e${i}:${local} xmlns:e${i}="${xml(ns)}">${xml(extra.value)}</e${i}:${local}>`);
  });

  lines.push('  </t:' + typeName + '>', '</rdf:RDF>');
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
  return requiredProperties(factory.shape).length;
}

/**
 * The properties a shape requires beyond the ones the fixture already carries,
 * with a value for each.
 *
 * Needed because a required property the fixture omits is not a capability
 * finding — the create simply fails and every case after it is lost. EWM's
 * Defect shape requires `rtc_cm:filedAgainst`, a reference to one of thirteen
 * categories, and refuses the create without it.
 *
 * For a reference, the chosen value is the first allowed value that is **not**
 * the shape's `oslc:defaultValue`. The reasoning: a required property whose
 * advertised default the server would accept need not have been required at all —
 * the server could have applied the default itself. Where a default is advertised
 * and the create is still refused, that default is not being applied, and EWM
 * shows what it can be instead: `filedAgainst` defaults to the `Unassigned`
 * category, which is rejected on save with the same 403 as sending nothing.
 * The default is used only when it is the sole allowed value.
 *
 * A required literal gets the `PROBE-` marker, so anything left behind stays
 * identifiable. A required reference with no allowed values is skipped rather
 * than invented: any URI would be a fabricated link, and the create then fails
 * with the server's own message, which names what is missing.
 */
export function requiredExtras(shape: unknown, marker: string): Array<{
  predicate: string;
  value: string;
  isReference: boolean;
}> {
  const extras: Array<{ predicate: string; value: string; isReference: boolean }> = [];

  for (const property of requiredProperties(shape)) {
    const predicate = property.propertyDefinition;
    if (!predicate || ALREADY_SENT.has(predicate)) continue;

    const allowed = property.allowedValues;
    if (allowed.length > 0) {
      const advertisedDefault = property.defaultValue;
      const preferred = allowed.find((value) => value !== advertisedDefault) ?? allowed[0];
      extras.push({ predicate, value: preferred, isReference: property.isReference });
      continue;
    }
    if (property.isReference) continue;
    extras.push({ predicate, value: marker, isReference: false });
  }
  return extras;
}

/** Properties `fixtureRdfXml` already writes, so an extra must not repeat them. */
const ALREADY_SENT = new Set([
  'http://purl.org/dc/terms/title',
  'http://purl.org/dc/terms/description',
]);

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
