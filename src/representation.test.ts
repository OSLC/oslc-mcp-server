import { describe, it, expect, jest } from '@jest/globals';
import { checkTurtleSupport, formatTurtleCheck } from './representation.js';

const URL = 'https://elm.example.com/rm/catalog';
const VALID_TURTLE = '@prefix dcterms: <http://purl.org/dc/terms/> .\n<' + URL + '> dcterms:title "Catalog" .';

/** Stub of the axios instance OSLCClient exposes as `.client`. */
function stubHttp(response: { status: number; headers: Record<string, string>; data: string }) {
  return { get: jest.fn(async () => response) } as any;
}

describe('checkTurtleSupport', () => {
  it('asks only for Turtle, so the answer is unambiguous', async () => {
    const http = stubHttp({ status: 200, headers: { 'content-type': 'text/turtle' }, data: VALID_TURTLE });
    await checkTurtleSupport(http, URL);
    const config = (http.get as any).mock.calls[0][1];
    expect(config.headers.Accept).toBe('text/turtle');
  });

  it('never throws on an error status, so the status can be reported', async () => {
    const http = stubHttp({ status: 406, headers: {}, data: '' });
    await checkTurtleSupport(http, URL);
    expect((http.get as any).mock.calls[0][1].validateStatus()).toBe(true);
  });

  it('reports Turtle that parses as supported', async () => {
    const http = stubHttp({ status: 200, headers: { 'content-type': 'text/turtle' }, data: VALID_TURTLE });
    const result = await checkTurtleSupport(http, URL);
    expect(result.verdict).toEqual({ kind: 'supported' });
  });

  it('reports the status and message when the server refuses', async () => {
    const http = stubHttp({ status: 406, headers: {}, data: 'Not Acceptable' });
    const result = await checkTurtleSupport(http, URL);
    expect(result.verdict).toEqual({ kind: 'error', status: 406, message: 'Not Acceptable' });
  });

  it('reports which representation came back instead', async () => {
    const http = stubHttp({
      status: 200,
      headers: { 'content-type': 'application/rdf+xml' },
      data: '<rdf:RDF/>',
    });
    const result = await checkTurtleSupport(http, URL);
    expect(result.verdict).toEqual({ kind: 'other-representation', contentType: 'application/rdf+xml' });
  });

  it('separates a body that claims Turtle but does not parse', async () => {
    const http = stubHttp({
      status: 200,
      headers: { 'content-type': 'text/turtle' },
      data: 'PREFIX dcterms: <http://purl.org/dc/terms/>\nSELECT * WHERE { ?s ?p ?o }',
    });
    const result = await checkTurtleSupport(http, URL);
    expect(result.verdict.kind).toBe('malformed');
  });

  it('tolerates a content type carrying a charset parameter', async () => {
    const http = stubHttp({
      status: 200,
      headers: { 'content-type': 'text/turtle; charset=utf-8' },
      data: VALID_TURTLE,
    });
    expect((await checkTurtleSupport(http, URL)).verdict).toEqual({ kind: 'supported' });
  });

  it('records a transcript of the exchange', async () => {
    const http = stubHttp({ status: 200, headers: { 'content-type': 'text/turtle' }, data: VALID_TURTLE });
    const result = await checkTurtleSupport(http, URL);
    expect(result.transcript).toContain(`GET ${URL}`);
    expect(result.transcript).toContain('Accept: text/turtle');
    expect(result.transcript).toContain('→ 200');
  });
});

describe('formatTurtleCheck', () => {
  it('never claims the server cannot produce Turtle', async () => {
    const http = stubHttp({ status: 200, headers: { 'content-type': 'application/rdf+xml' }, data: '' });
    const text = formatTurtleCheck(await checkTurtleSupport(http, URL));
    // A server may disregard Accept entirely and still be conformant, so
    // "cannot" is a claim no external test can support.
    expect(text).not.toMatch(/cannot produce|does not support|unsupported/i);
    expect(text).toContain('did not produce Turtle when asked');
  });

  it('does not call the absence a defect', async () => {
    const http = stubHttp({ status: 406, headers: {}, data: '' });
    const text = formatTurtleCheck(await checkTurtleSupport(http, URL));
    expect(text).not.toMatch(/defect|bug|broken|non-conformant/i);
  });
});
