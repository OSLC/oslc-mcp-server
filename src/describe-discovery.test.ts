import { describe, it, expect } from '@jest/globals';
import { describeDiscovery, describeDiscoveryDocument } from './describe-discovery.js';
import { createToolName } from 'oslc-service/mcp';
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

  it('distinguishes a configured catalog from a discovered one', () => {
    // The two are very different situations: a configured URL is the
    // operator's assertion, a discovered one is the server's.
    const text = describeDiscovery({
      ...base,
      catalog: {
        url: 'https://elm.example.com/rm/configured-catalog',
        source: { kind: 'explicit' },
      },
      discovery: discoveryWith(),
    });
    expect(text).toContain('explicit configuration');
    expect(text).not.toContain('rootservices predicate');
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

describe('the provider cap', () => {
  function withProviders(n: number): DiscoveryResult {
    const base = discoveryWith();
    const one = (base as any).serviceProviders[0];
    (base as any).serviceProviders = Array.from({ length: n }, (_, i) => ({
      ...one, title: `Provider ${i}`, uri: `${SP}/${i}`,
    }));
    return base;
  }

  const input = (discovery: DiscoveryResult, maxProviders?: number) => ({
    alias: 'rm', prefix: '', discovery, maxProviders,
    catalog: { url: 'https://elm.example.com/rm/catalog',
               source: { kind: 'explicit' } } as any,
  });

  it('enumerates every provider when under the limit', () => {
    const out = describeDiscovery(input(withProviders(3), 25));
    expect(out).toContain('Provider 0');
    expect(out).toContain('Provider 2');
    expect(out).not.toContain('not enumerated');
  });

  it('states how many it left out, rather than truncating silently', () => {
    const out = describeDiscovery(input(withProviders(30), 25));
    expect(out).toContain('Provider 24');
    expect(out).not.toContain('Provider 25');
    // the count must be stated: a reader has to know the list is partial.
    expect(out).toContain('5 further service provider(s) not enumerated');
    expect(out).toContain('limit 25');
  });

  it('still reports the true total in the header', () => {
    const out = describeDiscovery(input(withProviders(30), 2));
    expect(out).toContain('Service providers: 30');
  });
});

describe('the report document', () => {
  const input = (alias: string) => ({
    alias, prefix: `${alias}_`, discovery: discoveryWith(),
    catalog: { url: 'https://elm.example.com/rm/catalog',
               source: { kind: 'explicit' } } as any,
  });

  it('covers every configured server in one document', () => {
    const out = describeDiscoveryDocument([input('rm'), input('qm')]);
    expect(out).toContain('# OSLC MCP server — discovery');
    expect(out).toContain('## Discovery — rm');
    expect(out).toContain('## Discovery — qm');
  });

  it('carries no timestamp, so an unchanged deployment produces an identical file', () => {
    // the file is rewritten every start; a timestamp would churn any diff, and
    // this report is meant to be usable as committed context.
    expect(describeDiscoveryDocument([input('rm')]))
      .toEqual(describeDiscoveryDocument([input('rm')]));
  });

  it('ends with exactly one newline', () => {
    const out = describeDiscoveryDocument([input('rm')]);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('generated tool names', () => {
  // every title below was observed on a real server: ELM 7.1 SR1 (DOORS Next,
  // ETM, EWM) and a genOSLC owned domain.
  const CASES: Array<[string, string | undefined, string]> = [
    ['Create Finding',                                  undefined, 'create_finding'],
    ['Create CapabilityLevelResult',                    undefined, 'create_capabilitylevelresult'],
    ['Default creation factory for TestCase',           undefined, 'create_testcase'],
    ['Default creation factory for TestSuiteExecutionRecord', undefined, 'create_testsuiteexecutionrecord'],
    ['Location for creation of Defect change requests ', undefined, 'create_defect'],
    ['Location for creation of Track Build Item change requests ', undefined, 'create_track_build_item'],
    ['Location for creation of draft change requests',   undefined, 'create_draft'],
    ['Requirement Creation Factory',                     undefined, 'create_requirement'],
    ['Collection Creation Factory',                      undefined, 'create_collection'],
    ['ReqIF Export Factory',                             undefined, 'create_reqif_export'],
    ['Delivery Session Factory',                          undefined, 'create_delivery_session'],
    ['Type System Copy Session Factory',                  undefined, 'create_type_system_copy_session'],
    ['AttributeDefinition Factory',                       undefined, 'create_attributedefinition'],
    // the suffix is stripped only when something precedes it, so a title that is
    // nothing but the suffix keeps its own words — a better name than the type's.
    ['Location for creation of change requests', 'http://open-services.net/ns/cm#ChangeRequest', 'create_change_requests'],
  ];

  it.each(CASES)('%s -> %s', (title, resourceType, expected) => {
    expect(createToolName(title, resourceType)).toBe(expected);
  });

  it('never yields create__ or a bare create_ for an unusable title', () => {
    // the resource type is the first fallback, the raw title the second, and
    // 'resource' the last — none of them may leave a dangling underscore.
    expect(createToolName('   ')).toBe('create_resource');
    expect(createToolName('   ', 'http://example.org/v#Widget')).toBe('create_widget');
    expect(createToolName('- / -')).toBe('create_resource');
    expect(createToolName('Factory')).toBe('create_factory');
  });

  it('is the function the report uses, so the report cannot name a phantom tool', () => {
    const out = describeDiscovery({
      alias: 'rm', prefix: 'rm_', discovery: discoveryWith(),
      catalog: { url: 'https://elm.example.com/rm/catalog', source: { kind: 'explicit' } } as any,
    });
    expect(out).toContain(`rm_${createToolName('Requirement')}`);
  });
});

