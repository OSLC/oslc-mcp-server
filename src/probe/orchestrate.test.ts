import { describe, it, expect, jest } from '@jest/globals';
import { runProbe } from './orchestrate.js';
import type { DiscoveredServiceProvider } from 'oslc-service/mcp';

const QUERY_BASE = 'https://elm.example.com/rm/views';
const R = (n: number) => `https://elm.example.com/rm/r/${n}`;

function membersBody(uris: string[]): string {
  return (
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ` +
    `xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">` +
    `<rdf:Description rdf:about="${QUERY_BASE}">` +
    uris.map((u) => `<rdfs:member rdf:resource="${u}"/>`).join('') +
    `</rdf:Description></rdf:RDF>`
  );
}

/** A resource graph carrying the identifier and title the fixture sent. */
function resourceBody(uri: string, identifier: string, title: string): string {
  return (
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ` +
    `xmlns:dcterms="http://purl.org/dc/terms/">` +
    `<rdf:Description rdf:about="${uri}">` +
    `<dcterms:identifier>${identifier}</dcterms:identifier>` +
    `<dcterms:title>${title}</dcterms:title>` +
    `</rdf:Description></rdf:RDF>`
  );
}

function sp(overrides: Partial<DiscoveredServiceProvider> = {}): DiscoveredServiceProvider {
  return {
    title: 'JKE Banking',
    uri: 'https://elm.example.com/rm/sp/1',
    factories: [
      {
        title: 'Requirement Creation Factory',
        creationURI: 'https://elm.example.com/rm/requirementFactory',
        resourceType: 'http://open-services.net/ns/rm#Requirement',
        shape: { description: '', properties: [] } as any,
      },
    ],
    queries: [{ title: 'Query', queryBase: QUERY_BASE, resourceType: '' }],
    domains: [],
    ...overrides,
  } as unknown as DiscoveredServiceProvider;
}

/**
 * Replies by matching the request against a list of [predicate, response]
 * rules, so a phase can be scripted without depending on call ordering.
 */
function ruledHttp(rules: Array<[(c: any) => boolean, { status: number; data: string; headers?: Record<string, string> }]>) {
  const calls: any[] = [];
  return {
    calls,
    request: jest.fn(async (config: any) => {
      calls.push(config);
      for (const [matches, response] of rules) {
        if (matches(config)) {
          return {
            status: response.status,
            headers: { 'content-type': 'application/rdf+xml', ...(response.headers ?? {}) },
            data: response.data,
          };
        }
      }
      return { status: 200, headers: {}, data: membersBody([]) };
    }),
  } as any;
}

const isCreate = (c: any) => c.method === 'POST' && String(c.url).includes('requirementFactory');
const isDelete = (c: any) => c.method === 'DELETE';
const isQuery = (c: any) => String(c.url).includes('/views');
const isResourceGet = (c: any) => c.method === 'GET' && /\/r\/\d+$/.test(String(c.url));

/** A server that creates, deletes and queries normally. */
function healthyHttp() {
  let created = 0;
  const http = ruledHttp([
    [isCreate, { status: 201, data: '', headers: { location: R(1) } }],
    [isDelete, { status: 204, data: '' }],
    [isResourceGet, { status: 200, data: '' }],
    [isQuery, { status: 200, data: membersBody([R(1), R(2), R(3), R(4), R(5)]) }],
  ]);
  const original = http.request;
  http.request = jest.fn(async (config: any) => {
    if (isCreate(config)) {
      created += 1;
      return { status: 201, headers: { location: R(created) }, data: '' };
    }
    if (isResourceGet(config)) {
      const n = Number(String(config.url).match(/\/r\/(\d+)$/)![1]);
      return {
        status: 200,
        headers: {},
        data: resourceBody(R(n), `PROBE-0${n}`, `Probe 0${n}`),
      };
    }
    return original(config);
  }) as any;
  return http;
}

const noop = () => {};

describe('runProbe', () => {
  it('runs read-only when the service provider advertises no creation factory', async () => {
    const run = await runProbe({
      http: ruledHttp([[isQuery, { status: 200, data: membersBody([R(1), R(2)]) }]]),
      sp: sp({ factories: [] } as any),
      queryBase: QUERY_BASE,
      onDeleteUnsupported: 'stop',
      manifestWrite: noop,
    });
    expect(run.mode).toBe('read-only');
  });

  it('names read-only as a capability outcome, not a permission one', async () => {
    const run = await runProbe({
      http: ruledHttp([[isQuery, { status: 200, data: membersBody([R(1), R(2)]) }]]),
      sp: sp({ factories: [] } as any),
      queryBase: QUERY_BASE,
      onDeleteUnsupported: 'stop',
      manifestWrite: noop,
    });
    expect(run.modeReason).toMatch(/no creation factory advertised/i);
    expect(run.modeReason).not.toMatch(/permission|forbidden|denied/i);
  });

  it('stops before building a fixture when delete is unsupported and onDeleteUnsupported is stop', async () => {
    const http = ruledHttp([
      [isCreate, { status: 201, data: '', headers: { location: R(1) } }],
      [isDelete, { status: 405, data: 'Method Not Allowed' }],
      [isQuery, { status: 200, data: membersBody([R(1)]) }],
    ]);
    const run = await runProbe({
      http, sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'stop', manifestWrite: noop,
    });
    expect(run.deleteSupported).toBe(false);
    // one probe artifact only — the fixture was never built
    expect(http.calls.filter(isCreate)).toHaveLength(1);
  });

  it('continues in read-only when delete is unsupported and read-only was chosen', async () => {
    const http = ruledHttp([
      [isCreate, { status: 201, data: '', headers: { location: R(1) } }],
      [isDelete, { status: 405, data: '' }],
      [isQuery, { status: 200, data: membersBody([R(1), R(2)]) }],
    ]);
    const run = await runProbe({
      http, sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'read-only', manifestWrite: noop,
    });
    expect(run.mode).toBe('read-only');
    expect(run.deleteSupported).toBe(false);
  });

  it('reports artifacts it could not delete as needing cleanup, with their URIs', async () => {
    let deletes = 0;
    const http = healthyHttp();
    const inner = http.request;
    http.request = jest.fn(async (config: any) => {
      if (isDelete(config)) {
        deletes += 1;
        // the first delete (phase 1's probe artifact) succeeds; fixture deletes fail
        if (deletes > 1) return { status: 500, headers: {}, data: 'nope' };
      }
      return inner(config);
    }) as any;

    const run = await runProbe({
      http, sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'stop', manifestWrite: noop,
    });
    expect(run.needingCleanup.length).toBeGreaterThan(0);
    expect(run.needingCleanup.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('records the service providers it wrote to', async () => {
    const run = await runProbe({
      http: healthyHttp(), sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'stop', manifestWrite: noop,
    });
    expect(run.serviceProvidersWritten).toEqual(['https://elm.example.com/rm/sp/1']);
  });

  it('never reports a case as supported when its ground truth was inadequate', async () => {
    // one member only: filters cannot be distinguished from no filter
    const run = await runProbe({
      http: ruledHttp([[isQuery, { status: 200, data: membersBody([R(1)]) }]]),
      sp: sp({ factories: [] } as any),
      queryBase: QUERY_BASE,
      onDeleteUnsupported: 'stop',
      manifestWrite: noop,
    });
    const inadequate = run.cases.filter((c) => c.verdict === 'inconclusive');
    expect(inadequate.length).toBeGreaterThan(0);
    for (const c of inadequate) expect(c.expected).toBeDefined();
  });

  it('leaves the target as it found it when every delete succeeds', async () => {
    const run = await runProbe({
      http: healthyHttp(), sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'stop', manifestWrite: noop,
    });
    expect(run.needingCleanup).toEqual([]);
  });

  it('will not build on a create that succeeded without saying where it put the resource', async () => {
    // residue that cannot be named cannot be cleaned up or handed to anyone,
    // which is worse than a delete that fails.
    const http = ruledHttp([
      [isCreate, { status: 201, data: '' }],            // 201, no Location
      [isQuery, { status: 200, data: membersBody([R(1), R(2)]) }],
    ]);
    const run = await runProbe({
      http, sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'proceed', manifestWrite: noop,
    });
    expect(run.mode).toBe('read-only');
    expect(run.modeReason).toMatch(/Location/);
    expect(http.calls.filter(isCreate)).toHaveLength(1);
  });

  it('falls back to GET for every case once POST-query is refused', async () => {
    // otherwise a server refusing POST fails every later case with the same 405,
    // burying one finding under ten false ones.
    const isPostQuery = (c: any) => c.method === 'POST' && String(c.url).includes('/views');
    const http = ruledHttp([
      [isPostQuery, { status: 405, data: 'Method Not Allowed' }],
      [isQuery, { status: 200, data: membersBody([R(1), R(2), R(3)]) }],
    ]);
    const run = await runProbe({
      http, sp: sp({ factories: [] } as any), queryBase: QUERY_BASE,
      onDeleteUnsupported: 'stop', manifestWrite: noop,
    });

    const method = run.cases.find((c) => c.name === 'post-versus-get')!;
    expect(method.reason).toMatch(/POST answered 405 while GET answered 200/);

    // the baseline was still established, so the later cases are not all 405
    const bare = run.cases.find((c) => c.name === 'bare-query')!;
    expect(bare.verdict).toBe('supported');
    expect(run.cases.filter((c) => /405/.test(c.reason))).toHaveLength(1);
  });

  it('records every fixture URI in the manifest before creating it', async () => {
    const lines: string[] = [];
    await runProbe({
      http: healthyHttp(), sp: sp(), queryBase: QUERY_BASE, onDeleteUnsupported: 'stop',
      manifestWrite: (l) => lines.push(l),
    });
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('a refusal carries the server’s own explanation', () => {
  const ERROR_BODY =
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
    'xmlns:oslc="http://open-services.net/ns/core#"><rdf:Description>' +
    "<oslc:message>'Save Work Item' failed. Preconditions have not been met: " +
    "The 'Filed Against' attribute needs to be set</oslc:message>" +
    '<oslc:statusCode>403</oslc:statusCode></rdf:Description></rdf:RDF>';

  it('puts it in modeReason, so a 403 is not read as an authorization problem', async () => {
    // The bug this covers: the probe reported "refused a create with 403" and
    // discarded the sentence that says the create was missing a required
    // attribute. Readers then went looking at roles and permissions.
    const http = {
      request: jest.fn(async (config: any) =>
        config.method === 'POST'
          ? { status: 403, headers: {}, data: ERROR_BODY }
          : { status: 200, headers: { 'content-type': 'application/rdf+xml' }, data: membersBody([]) }
      ),
    } as any;

    const run = await runProbe({
      http,
      sp: sp(),
      queryBase: QUERY_BASE,
      onDeleteUnsupported: 'stop',
      manifestWrite: () => {},
    });

    expect(run.mode).toBe('read-only');
    expect(run.modeReason).toContain('403');
    expect(run.modeReason).toContain("'Filed Against' attribute needs to be set");
  });
});

describe('prefixes are declared once discovery shows they are not predefined', () => {
  const MEMBERS = [R(1), R(2), R(3), R(4), R(5)];
  const clauseOf = (params: Record<string, string>) =>
    `${params['oslc.where'] ?? ''} ${params['oslc.select'] ?? ''} ${params['oslc.orderBy'] ?? ''}`;

  /** Requests recorded as parameter maps, whichever method carried them. */
  function recorder(predefinesPrefixes: boolean) {
    const sent: Array<Record<string, string>> = [];
    const request = jest.fn(async (config: any) => {
      const url = String(config.url);
      if (config.method === 'GET' && /\/r\/\d+$/.test(url)) {
        // Ground truth: each member carries a distinct title and identifier.
        const n = url.slice(-1);
        return { status: 200, headers: { 'content-type': 'application/rdf+xml' },
                 data: resourceBody(url, `PROBE-0${n}`, `Probe 0${n}`) };
      }
      const params = Object.fromEntries(new URLSearchParams(
        config.method === 'POST' ? String(config.data ?? '') : (url.split('?')[1] ?? '')
      ).entries());
      sent.push(params);
      if (!predefinesPrefixes && /(?:^|[^\w])(dcterms|foaf):/.test(clauseOf(params)) && !params['oslc.prefix']) {
        // What DOORS Next answers: 400 Undefined namespace prefix: dcterms
        return { status: 400, headers: {}, data: 'Undefined namespace prefix: dcterms' };
      }
      return { status: 200, headers: { 'content-type': 'application/rdf+xml' }, data: membersBody(MEMBERS) };
    });
    return { sent, http: { request } as any };
  }

  const runWith = (predefines: boolean, sent: Array<Record<string, string>>, http: any) =>
    runProbe({ http, sp: sp({ factories: [] }), queryBase: QUERY_BASE,
               onDeleteUnsupported: 'read-only', manifestWrite: () => {} });

  it('declares them for later cases, and records that it did', async () => {
    const { sent, http } = recorder(false);
    const run = await runWith(false, sent, http);

    expect(run.cases.find((c) => c.name === 'prefix-declaration')?.reason).toContain('dcterms=');

    const prefixed = sent.filter((p) => /(dcterms|foaf):/.test(clauseOf(p)));
    const undeclared = prefixed.filter((p) => p['oslc.prefix'] === undefined);
    // Exactly the two prefix-discovery probes go without a declaration — one for
    // oslc.where and one for oslc.select. That case exists to find out whether a
    // declaration is needed, so declaring would answer its own question.
    expect(undeclared).toHaveLength(2);
    // Everything after them carries one.
    expect(prefixed.slice(2).every((p) => typeof p['oslc.prefix'] === 'string')).toBe(true);
  });

  it('measures select as supported once the prefix is declared', async () => {
    // The defect this fixes: DOORS Next recorded `select: NO` for a missing
    // declaration, not for missing support.
    const { sent, http } = recorder(false);
    const run = await runWith(false, sent, http);
    expect(run.cases.find((c) => c.name === 'select')?.verdict).not.toBe('unsupported');
  });

  it('declares nothing when the server predefines prefixes', async () => {
    const { sent, http } = recorder(true);
    const run = await runWith(true, sent, http);
    expect(run.cases.find((c) => c.name === 'prefix-declaration')).toBeUndefined();
    expect(sent.every((p) => p['oslc.prefix'] === undefined)).toBe(true);
  });
});
