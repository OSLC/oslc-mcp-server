/**
 * Projecting SysML v2 elements onto the OSLC AM shape the tools already speak.
 *
 * The assistant never learns that this server is different: it asks for OSLC
 * resources and gets them. What changes is where they come from.
 */
import { rdfTypes } from './metaclass-types.js';

/**
 * Metaclasses RSE's own AM surface does NOT expose as resources.
 *
 * Measured, not reasoned: 263 elements, 97 AM resources, and the difference is
 * exactly these three — containment, and the carrier for links. It is not a rule
 * about relationships, because `FeatureTyping` (17) and the two `Namespace*`
 * kinds (6 each) ARE exposed. A resource set that differs from RSE's by one is a
 * defect, so this list is measured rather than derived from the metamodel.
 */
export const NOT_EXPOSED: ReadonlySet<string> = new Set([
  'OwningMembership',
  'FeatureMembership',
  'OSLCLink',
]);

export interface SysmlElement {
  '@id': string;
  /** Present on a Relationship: the element it belongs to. */
  owningRelatedElement?: { '@id'?: string } | null;
  /** The forward containment list, which is the one that counts. */
  ownedRelationship?: { '@id': string }[] | null;
  '@type'?: string;
  declaredName?: string | null;
  declaredShortName?: string | null;
  body?: string | null;
  linkTypeURI?: string | null;
  linkURL?: string | null;
  owningRelationship?: { '@id'?: string; owningRelatedElement?: { '@id'?: string } } | null;
}

/**
 * The element that owns this one.
 *
 * Two shapes have to be handled, and only one of them is obvious. The ad-hoc
 * query route EXPANDS a selected `owningRelationship` and hands back its
 * `owningRelatedElement` inline; the commit-scoped elements route — the only
 * route that respects a configuration, and therefore the one actually used —
 * returns a bare `{"@id": ...}` reference to the membership. Resolving it needs
 * the membership, which `byId` supplies from the same single read. No request.
 */
export function ownerOf(
  e: SysmlElement, byId?: ReadonlyMap<string, SysmlElement>
): string | undefined {
  const rel = e.owningRelationship;
  if (!rel) return undefined;
  const inline = rel.owningRelatedElement?.['@id'];
  if (inline) return inline;
  const ref = (rel as { '@id'?: string })['@id'];
  if (!ref || !byId) return undefined;
  const membership = byId.get(ref);
  const owner = membership?.owningRelatedElement?.['@id'];
  if (!owner) return undefined;

  // **Containment must hold in BOTH directions**, and this is not pedantry.
  // Detaching a link means removing its membership from the owner's forward
  // `ownedRelationship` — a plain update, where deleting the element is not
  // (quirk 38: treat API-created content as append-only). The membership goes
  // on pointing back at its owner afterwards, so trusting that direction alone
  // reports links the OSLC AM surface has already dropped. Measured: after one
  // detach, this returned six targets where the AM surface served five.
  const forward = byId.get(owner)?.ownedRelationship;
  if (forward && !forward.some((r) => r['@id'] === ref)) return undefined;
  return owner;
}

export interface ProjectionContext {
  /** `{base}/oslc_am/{projectId}` — how an element id becomes a resource URI. */
  amBase: string;
  /** element id → documentation body, from the `@type = Documentation` query. */
  descriptions: ReadonlyMap<string, string>;
  /** element id → its outgoing links, from the `@type = OSLCLink` query. */
  links: ReadonlyMap<string, { predicate: string; target: string }[]>;
}

export interface ProjectedResource {
  uri: string;
  types: string[];
  identifier: string;
  title?: string;
  shortTitle?: string;
  description?: string;
  links: Record<string, string[]>;
  /** Set when the vocabulary does not define the metaclass. Reported rather than
   *  minted: an invented vocabulary URI is indistinguishable from a real one to
   *  an assistant filtering on type. */
  unknownMetaclass?: string;
}

export function resourceUri(amBase: string, id: string): string {
  return `${amBase}/resource/${id}`;
}

/** Project one element. Callers must not pass an excluded metaclass. */
export function projectResource(e: SysmlElement, ctx: ProjectionContext): ProjectedResource {
  const { types, unknownMetaclass } = rdfTypes(e['@type']);
  const links: Record<string, string[]> = {};
  for (const l of ctx.links.get(e['@id']) ?? []) {
    (links[l.predicate] ??= []).push(l.target);
  }
  return {
    uri: resourceUri(ctx.amBase, e['@id']),
    types,
    identifier: e['@id'],
    // `?? undefined` rather than `||`: RSE returns '' for an unset
    // declaredShortName, and an empty string is not a title.
    title: e.declaredName || undefined,
    shortTitle: e.declaredShortName || undefined,
    description: ctx.descriptions.get(e['@id']),
    links,
    ...(unknownMetaclass ? { unknownMetaclass } : {}),
  };
}

/** Index the `Documentation` rows by the element each documents. */
export function indexDescriptions(
  docs: SysmlElement[], byId?: ReadonlyMap<string, SysmlElement>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of docs) {
    const owner = ownerOf(d, byId);
    if (owner && typeof d.body === 'string' && d.body) m.set(owner, d.body);
  }
  return m;
}

/**
 * Index the `OSLCLink` rows by their source element.
 *
 * The predicate comes from the link type's own `linkTypeURI`
 * (`http://jazz.net/ns/dm/linktypes#satisfy`), so nothing is mapped by name.
 * A link whose type did not resolve is DROPPED and counted — emitting it under a
 * guessed predicate would assert a relationship the model does not make.
 */
export function indexLinks(
  linkRows: (SysmlElement & { linkType?: { '@id'?: string } | null })[],
  linkTypeUris: ReadonlyMap<string, string>,
  byId?: ReadonlyMap<string, SysmlElement>
): { links: Map<string, { predicate: string; target: string }[]>; unresolved: number } {
  const links = new Map<string, { predicate: string; target: string }[]>();
  let unresolved = 0;
  for (const l of linkRows) {
    const source = ownerOf(l, byId);
    const predicate = l.linkType?.['@id'] ? linkTypeUris.get(l.linkType['@id']) : undefined;
    if (!source || !predicate || !l.linkURL) { unresolved++; continue; }
    (links.get(source) ?? links.set(source, []).get(source)!).push(
      { predicate, target: l.linkURL }
    );
  }
  return { links, unresolved };
}
