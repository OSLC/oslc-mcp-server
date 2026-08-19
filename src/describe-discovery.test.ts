import { describe, it, expect } from '@jest/globals';
import { describeDiscovery } from './describe-discovery.js';
import type { DiscoveryResult } from 'oslc-service/mcp';

const SP = 'https://elm.example.com/rm/sp/1';

function discoveryWith(overrides: Partial<any> = {}): DiscoveryResult {
  return {
    catalogURI: 'https://elm.example.com/rm/catalog',
    supportsJsonLd: false,
    serviceProviders: [
      {
        title: 'Stub Provider',
        uri: SP,
        factories: [
          {
            title: 'Requirement',
            creationURI: `${SP}/requirements`,
            resourceType: 'http://open-services.net/ns/rm#Requirement',
            shape: { description: '', properties: [] } as any,
          },
        ],
        queries: [
          {
            title: 'Requirement Query',
            queryBase: `${SP}/views`,
            resourceType: 'http://open-services.net/ns/rm#Requirement',
          },
        ],
        domains: ['http://open-services.net/ns/rm#'],
        ...overrides,
      },
    ],
    shapes: new Map(),
    vocabularyContent: '',
    catalogContent: '',
    shapesContent: '',
  } as unknown as DiscoveryResult;
}

const base = {
  alias: 'rm',
  prefix: 'rm_',
  catalog: {
    url: 'https://elm.example.com/rm/catalog',
    source: { kind: 'rootservices' as const, predicate: 'http://open-services.net/xmlns/rm/1.0/rmServiceProviders' },
  },
};

describe('describeDiscovery', () => {
  it('says how the catalog was resolved, naming the predicate', () => {
    const text = describeDiscovery({ ...base, discovery: discoveryWith() });
    expect(text).toContain('https://elm.example.com/rm/catalog');
    expect(text).toContain('rootservices');
    expect(text).toContain('rmServiceProviders');
  });

  it('distinguishes the fallback convention from a server-advertised catalog', () => {
    const text = describeDiscovery({
      ...base,
      catalog: {
        url: 'https://elm.example.com/rm/oslc/catalog',
        source: { kind: 'convention', reason: 'rootservices-unreachable' },
      },
      discovery: discoveryWith(),
    });
    expect(text).toContain('convention');
    expect(text).toContain('rootservices-unreachable');
  });

  it('maps each generated tool name to the URL it will actually hit', () => {
    const text = describeDiscovery({ ...base, discovery: discoveryWith() });
    // Prefixed exactly as startServer prefixes it, and pointed at the factory.
    expect(text).toContain('rm_create_requirement');
    expect(text).toContain(`${SP}/requirements`);
  });

  it('lists query capabilities with their query base', () => {
    const text = describeDiscovery({ ...base, discovery: discoveryWith() });
    expect(text).toContain(`${SP}/views`);
  });

  it('reports a factory whose shape is missing as generating no tool', () => {
    const noShape = discoveryWith({
      factories: [
        {
          title: 'Requirement',
          creationURI: `${SP}/requirements`,
          resourceType: 'http://open-services.net/ns/rm#Requirement',
          shape: null,
        },
      ],
    });
    const text = describeDiscovery({ ...base, discovery: noShape });
    expect(text).toContain('no tool generated');
    expect(text).not.toContain('rm_create_requirement');
  });

  it('lists shapes that failed to fetch, with the reason', () => {
    const failed = discoveryWith({
      failedShapes: [
        {
          shapeURI: 'https://elm.example.com/rm/shapes/req#Shape',
          documentURI: 'https://elm.example.com/rm/shapes/req',
          reason: '403 Forbidden',
        },
      ],
    });
    const text = describeDiscovery({ ...base, discovery: failed });
    expect(text).toContain('https://elm.example.com/rm/shapes/req');
    expect(text).toContain('403 Forbidden');
  });

  it('says so plainly when no service providers were discovered', () => {
    const empty = { ...discoveryWith(), serviceProviders: [] } as DiscoveryResult;
    expect(describeDiscovery({ ...base, discovery: empty })).toContain('No service providers');
  });
});
