import {
  NOT_EXPOSED, ownerOf, projectResource, indexDescriptions, indexLinks, resourceUri,
} from './project.js';
import { rdfTypes, METACLASS_COUNT } from './metaclass-types.js';

const AM = 'https://h/api/oslc_am/P';
const owned = (owner: string) => ({ owningRelationship: { owningRelatedElement: { '@id': owner } } });

describe('the measured exposure rule', () => {
  // 263 elements - 107 OwningMembership - 44 OSLCLink - 15 FeatureMembership = 97,
  // which is exactly what RSE's AM surface returns.
  it('excludes containment and the link carrier, and nothing else', () => {
    expect([...NOT_EXPOSED].sort())
      .toEqual(['FeatureMembership', 'OSLCLink', 'OwningMembership']);
  });

  it('does NOT exclude FeatureTyping, which RSE does expose', () => {
    expect(NOT_EXPOSED.has('FeatureTyping')).toBe(false);
  });
});

describe('rdfTypes', () => {
  it('always asserts oslc_am:Resource, per oslc_sysml:Element rdfs:subClassOf', () => {
    expect(rdfTypes('PartUsage').types).toEqual([
      'http://open-services.net/ns/am#Resource',
      'https://www.omg.org/spec/sysml/vocabulary#PartUsage',
    ]);
  });

  // Minting a URI for a metaclass the vocabulary does not define would be
  // indistinguishable, to an assistant filtering on type, from a real one.
  it('reports an unknown metaclass instead of minting a URI for it', () => {
    const r = rdfTypes('OSLCLink');
    expect(r.types).toEqual(['http://open-services.net/ns/am#Resource']);
    expect(r.unknownMetaclass).toBe('OSLCLink');
  });

  it('carries the whole vocabulary', () => expect(METACLASS_COUNT).toBe(182));
});

describe('projectResource', () => {
  const ctx = { amBase: AM, descriptions: new Map([['e1', 'the body']]), links: new Map() };

  it('projects names, identifier and description', () => {
    const r = projectResource(
      { '@id': 'e1', '@type': 'PartUsage', declaredName: 'Gate', declaredShortName: 'UNIT-G' }, ctx);
    expect(r).toMatchObject({
      uri: `${AM}/resource/e1`, identifier: 'e1',
      title: 'Gate', shortTitle: 'UNIT-G', description: 'the body',
    });
  });

  // RSE returns '' for an unset declaredShortName, and an empty string is not a
  // title — emitting one would make an absent name look like a present blank.
  it('treats an empty declared name as absent, not as a blank title', () => {
    const r = projectResource({ '@id': 'e2', '@type': 'PartUsage', declaredName: '', declaredShortName: '' }, ctx);
    expect(r.title).toBeUndefined();
    expect(r.shortTitle).toBeUndefined();
  });

  it('omits description when the element has none', () => {
    expect(projectResource({ '@id': 'nope', '@type': 'Package' }, ctx).description).toBeUndefined();
  });
});

describe('indexDescriptions', () => {
  it('keys a documentation body by the element it documents', () => {
    const m = indexDescriptions([{ '@id': 'd1', body: 'text', ...owned('e1') }]);
    expect(m.get('e1')).toBe('text');
  });

  it('ignores an unowned or empty documentation', () => {
    expect(indexDescriptions([{ '@id': 'd1', body: 'text' }]).size).toBe(0);
    expect(indexDescriptions([{ '@id': 'd2', body: '', ...owned('e1') }]).size).toBe(0);
  });
});

describe('indexLinks', () => {
  const TYPES = new Map([['lt1', 'http://jazz.net/ns/dm/linktypes#satisfy']]);

  it('uses the link type\'s own URI as the predicate, and the source is the owner', () => {
    const { links, unresolved } = indexLinks(
      [{ '@id': 'l1', linkType: { '@id': 'lt1' }, linkURL: 'https://dng/2248', ...owned('cmp') }], TYPES);
    expect(links.get('cmp')).toEqual([
      { predicate: 'http://jazz.net/ns/dm/linktypes#satisfy', target: 'https://dng/2248' }]);
    expect(unresolved).toBe(0);
  });

  it('collects several links on one source', () => {
    const { links } = indexLinks([
      { '@id': 'l1', linkType: { '@id': 'lt1' }, linkURL: 'https://dng/1', ...owned('cmp') },
      { '@id': 'l2', linkType: { '@id': 'lt1' }, linkURL: 'https://dng/2', ...owned('cmp') },
    ], TYPES);
    expect(links.get('cmp')).toHaveLength(2);
  });

  // Emitting it under a guessed predicate would assert a relationship the model
  // does not make, which is worse than losing it and saying so.
  it('drops and counts a link whose type did not resolve, rather than guessing', () => {
    const { links, unresolved } = indexLinks(
      [{ '@id': 'l1', linkType: { '@id': 'unknown' }, linkURL: 'https://dng/1', ...owned('cmp') }], TYPES);
    expect(links.size).toBe(0);
    expect(unresolved).toBe(1);
  });
});

describe('resourceUri', () => {
  it('builds the AM resource URI RSE itself uses', () => {
    expect(resourceUri(AM, 'abc')).toBe(`${AM}/resource/abc`);
  });
});
