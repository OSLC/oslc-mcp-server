import { describe, it, expect } from '@jest/globals';
import {
  prefixesUsedIn,
  buildPrefixDeclaration,
  undeclarablePrefixes,
  WELL_KNOWN_PREFIXES,
} from './oslc-prefixes.js';

describe('prefixesUsedIn', () => {
  it('finds a prefix in a filter', () => {
    expect(prefixesUsedIn(['dcterms:identifier="SWR-9"'])).toEqual(['dcterms']);
  });

  it('finds prefixes across all clauses, deduplicated', () => {
    expect(prefixesUsedIn([
      'dcterms:title="x"',
      'dcterms:title,oslc:shortId',
      'dcterms:modified',
    ])).toEqual(['dcterms', 'oslc']);
  });

  it('does not mistake a full URI for a prefixed name', () => {
    // <http://…> contains a colon; reading 'http' as a prefix would declare a
    // namespace for it and change the query's meaning.
    expect(prefixesUsedIn(['rdf:type=<http://open-services.net/ns/rm#Requirement>']))
      .toEqual(['rdf']);
  });

  it('does not mistake the contents of a literal for a prefixed name', () => {
    expect(prefixesUsedIn(['dcterms:title="scheme:value"'])).toEqual(['dcterms']);
  });

  it('ignores clauses that are undefined or empty', () => {
    expect(prefixesUsedIn([undefined, '', 'dcterms:title="x"'])).toEqual(['dcterms']);
  });

  it('accepts underscores in a prefix, as OSLC domain prefixes use', () => {
    expect(prefixesUsedIn(['oslc_qm:testCase=<urn:x>'])).toEqual(['oslc_qm']);
  });

  it('returns nothing when no prefixed name is present', () => {
    expect(prefixesUsedIn(['<http://x/1>=<http://x/2>'])).toEqual([]);
  });
});

describe('buildPrefixDeclaration', () => {
  it('declares a known prefix in the form OSLC query expects', () => {
    expect(buildPrefixDeclaration(['dcterms:identifier="SWR-9"']))
      .toBe('dcterms=<http://purl.org/dc/terms/>');
  });

  it('joins several declarations with commas', () => {
    const declaration = buildPrefixDeclaration(['rdf:type=<urn:x>', 'dcterms:title']);
    expect(declaration).toBe(
      'dcterms=<http://purl.org/dc/terms/>,rdf=<http://www.w3.org/1999/02/22-rdf-syntax-ns#>'
    );
  });

  it('declares nothing when the clauses use no prefixes', () => {
    expect(buildPrefixDeclaration([undefined, undefined, undefined])).toBeUndefined();
  });

  it('omits a prefix it does not know rather than guessing a namespace', () => {
    // A wrong namespace silently matches nothing; an undeclared one gets a 400
    // that names the prefix.
    expect(buildPrefixDeclaration(['acme:thing="x"'])).toBeUndefined();
  });

  it('declares the known prefixes even when an unknown one is also present', () => {
    expect(buildPrefixDeclaration(['acme:thing="x" and dcterms:title="y"']))
      .toBe('dcterms=<http://purl.org/dc/terms/>');
  });

  it('knows the vocabularies the ELM deployment uses', () => {
    for (const prefix of ['dcterms', 'oslc', 'rdf', 'oslc_rm', 'oslc_qm', 'oslc_cm', 'oslc_am', 'jazz_am', 'rtc_cm']) {
      expect(WELL_KNOWN_PREFIXES[prefix]).toMatch(/^https?:\/\//);
    }
  });
});

describe('undeclarablePrefixes', () => {
  it('reports a prefix this client cannot declare', () => {
    expect(undeclarablePrefixes(['acme:thing="x" and dcterms:title="y"'])).toEqual(['acme']);
  });

  it('reports nothing when every prefix is known', () => {
    expect(undeclarablePrefixes(['dcterms:title="y"'])).toEqual([]);
  });
});
