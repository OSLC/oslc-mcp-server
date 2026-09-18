import { describe, it, expect } from '@jest/globals';
import { unresolvedCatalog } from './catalog-resolution.js';
import { describeDiscovery } from './describe-discovery.js';

const emptyDiscovery = {
  catalogURI: '', supportsJsonLd: false, serviceProviders: [],
  shapes: new Map(), vocabularyContent: '', catalogContent: '', shapesContent: '',
} as any;

describe('a server with no catalog', () => {
  it('records why there is none rather than inventing a URL', () => {
    const catalog = unresolvedCatalog('scoped discovery does not fetch a catalog');
    expect(catalog.url).toBe('');
    expect(catalog.source).toEqual({
      kind: 'unresolved', reason: 'scoped discovery does not fetch a catalog',
    });
  });

  it('says so in the discovery report instead of printing a blank URL', () => {
    const text = describeDiscovery({
      alias: 'cdcm', prefix: 'cdcm_',
      catalog: unresolvedCatalog('scoped discovery does not fetch a catalog'),
      discovery: emptyDiscovery,
    });
    expect(text).toMatch(/no catalog/i);
    expect(text).toMatch(/scoped discovery does not fetch a catalog/);
  });
});
