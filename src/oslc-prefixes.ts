/**
 * `oslc.prefix` declarations for OSLC query parameters.
 *
 * OSLC Query expects a prefixed name used in `oslc.where`, `oslc.select` or
 * `oslc.orderBy` to be declared with `oslc.prefix` unless the server predefines
 * it — and servers differ sharply on what they predefine. DOORS Next predefines
 * **nothing**, not even `dcterms`, and answers a bare `oslc.select=dcterms:title`
 * with `400 … Undefined namespace prefix: dcterms`.
 *
 * So a client cannot rely on defaults. This derives the declaration from the
 * clauses themselves: a declaration is a claim about what a clause needs, and
 * padding it with prefixes nothing uses would test the server's tolerance for
 * unused declarations rather than answer the query.
 */

/**
 * Namespaces this client can declare on the caller's behalf.
 *
 * A prefix absent from here is left undeclared rather than guessed at. The
 * server then either predefines it or answers 400 naming it — both of which are
 * more useful than a wrong namespace silently matching nothing.
 */
export const WELL_KNOWN_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  // Core vocabularies
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  dcterms: 'http://purl.org/dc/terms/',
  dc: 'http://purl.org/dc/elements/1.1/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  ldp: 'http://www.w3.org/ns/ldp#',
  // OSLC Core and its domains
  oslc: 'http://open-services.net/ns/core#',
  oslc_rm: 'http://open-services.net/ns/rm#',
  oslc_qm: 'http://open-services.net/ns/qm#',
  oslc_cm: 'http://open-services.net/ns/cm#',
  oslc_am: 'http://open-services.net/ns/am#',
  oslc_auto: 'http://open-services.net/ns/auto#',
  oslc_config: 'http://open-services.net/ns/config#',
  // Jazz vocabularies met on ELM deployments
  jazz_am: 'http://jazz.net/ns/dm/linktypes#',
  rtc_cm: 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/',
  rqm_qm: 'http://jazz.net/ns/qm/rqm#',
});

/**
 * Prefixes appearing as `prefix:localName` in the given clauses.
 *
 * Full URIs and quoted literals are removed before scanning, because both
 * routinely contain a colon: `<http://…>` would otherwise yield a prefix
 * `http`, and `dcterms:title="a:b"` a prefix `a`.
 */
export function prefixesUsedIn(clauses: Array<string | undefined>): string[] {
  const found = new Set<string>();

  for (const clause of clauses) {
    if (!clause) continue;
    const scannable = clause
      .replace(/<[^>]*>/g, ' ')   // full URIs are not prefixed names
      .replace(/"[^"]*"/g, ' ');  // nor is anything inside a literal

    for (const match of scannable.matchAll(/([A-Za-z][A-Za-z0-9_.-]*):[A-Za-z_]/g)) {
      found.add(match[1]);
    }
  }

  return [...found].sort();
}

/**
 * An `oslc.prefix` value covering every known prefix the clauses use, or
 * `undefined` when they use none this client can declare.
 *
 * Format is OSLC Query's: `p=<namespace>` entries joined by commas.
 */
export function buildPrefixDeclaration(clauses: Array<string | undefined>): string | undefined {
  const declarations = prefixesUsedIn(clauses)
    .filter((prefix) => prefix in WELL_KNOWN_PREFIXES)
    .map((prefix) => `${prefix}=<${WELL_KNOWN_PREFIXES[prefix]}>`);

  return declarations.length > 0 ? declarations.join(',') : undefined;
}

/**
 * Prefixes the clauses use that this client cannot declare. The caller should
 * surface these: the query may still work if the server predefines them, but if
 * it does not, the 400 is easier to read alongside this list.
 */
export function undeclarablePrefixes(clauses: Array<string | undefined>): string[] {
  return prefixesUsedIn(clauses).filter((prefix) => !(prefix in WELL_KNOWN_PREFIXES));
}
