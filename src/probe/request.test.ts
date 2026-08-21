import { describe, it, expect, jest } from '@jest/globals';
import { probeGet, probeQueryPost, probeQueryGet } from './request.js';

const QUERY_BASE = 'https://elm.example.com/rm/views?componentURI=urn:c1';
const PREFIX_PARAM: [string, string] = ['oslc.prefix', 'oslc=<http://open-services.net/ns/core#>'];

function stubHttp(response = { status: 200, headers: { 'content-type': 'application/rdf+xml' }, data: '<rdf:RDF/>' }) {
  return { request: jest.fn(async () => response) } as any;
}

describe('probeQueryPost', () => {
  it('POSTs a form-encoded body to the query base', async () => {
    const http = stubHttp();
    await probeQueryPost(http, QUERY_BASE, [['oslc.where', 'a="x"']]);
    const config = (http.request as any).mock.calls[0][0];
    expect(config.method).toBe('POST');
    expect(config.url).toBe(QUERY_BASE);
    expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(config.data).toBe('oslc.where=a%3D%22x%22');
  });

  it("escapes '#' in the body, which would otherwise truncate the request", async () => {
    const http = stubHttp();
    await probeQueryPost(http, QUERY_BASE, [PREFIX_PARAM]);
    expect((http.request as any).mock.calls[0][0].data).toContain('%23');
    expect((http.request as any).mock.calls[0][0].data).not.toMatch(/#/);
  });

  it("keeps the query base's own parameters in the URL, not the body", async () => {
    const http = stubHttp();
    await probeQueryPost(http, QUERY_BASE, [['oslc.where', 'a="x"']]);
    const config = (http.request as any).mock.calls[0][0];
    expect(config.url).toContain('componentURI=urn:c1');
    expect(config.data).not.toContain('componentURI');
  });

  it('never throws on an error status — a 400 is an answer', async () => {
    const http = stubHttp({ status: 400, headers: {}, data: 'Bad Request' });
    const result = await probeQueryPost(http, QUERY_BASE, [['oslc.where', 'a="x"']]);
    expect(result.status).toBe(400);
    expect((http.request as any).mock.calls[0][0].validateStatus()).toBe(true);
  });

  it('records the decoded parameters and the encoded body in the transcript', async () => {
    const http = stubHttp();
    const result = await probeQueryPost(http, QUERY_BASE, [PREFIX_PARAM]);
    expect(result.transcript).toContain('body (decoded)');
    expect(result.transcript).toContain('oslc=<http://open-services.net/ns/core#>');
    expect(result.transcript).toContain('body (encoded)');
    expect(result.transcript).toContain('%23');
  });
});

describe('probeQueryGet', () => {
  it('puts the parameters in the query string, appending to existing ones', async () => {
    const http = stubHttp();
    await probeQueryGet(http, QUERY_BASE, [['oslc.where', 'a="x"']]);
    const config = (http.request as any).mock.calls[0][0];
    expect(config.method).toBe('GET');
    expect(config.url).toBe(`${QUERY_BASE}&oslc.where=a%3D%22x%22`);
    expect(config.data).toBeUndefined();
  });

  it('uses ? when the query base has no parameters of its own', async () => {
    const http = stubHttp();
    await probeQueryGet(http, 'https://elm.example.com/rm/views', [['oslc.where', 'a="x"']]);
    expect((http.request as any).mock.calls[0][0].url).toBe(
      'https://elm.example.com/rm/views?oslc.where=a%3D%22x%22'
    );
  });
});

describe('probeGet', () => {
  it('sends OSLC-Core-Version and the requested Accept', async () => {
    const http = stubHttp();
    await probeGet(http, 'https://elm.example.com/rm/r/1', 'text/turtle');
    const config = (http.request as any).mock.calls[0][0];
    expect(config.headers['OSLC-Core-Version']).toBe('2.0');
    expect(config.headers['Accept']).toBe('text/turtle');
  });

  it('records a transcript with no body blocks', async () => {
    const result = await probeGet(stubHttp(), 'https://elm.example.com/rm/r/1');
    expect(result.transcript).toContain('GET https://elm.example.com/rm/r/1');
    expect(result.transcript).not.toContain('body (decoded)');
  });
});
