import { describe, it, expect } from '@jest/globals';
import {
  redactHeaders,
  encodeFormParams,
  formatTranscript,
  headerValue,
  REDACTED,
  type HttpExchange,
} from './http-transcript.js';

describe('redactHeaders', () => {
  it('redacts credential-bearing headers whatever their casing', () => {
    const out = redactHeaders({
      'Authorization': 'Basic c2VjcmV0',
      'cookie': 'JSESSIONID=abc123',
      'Set-Cookie': 'JSESSIONID=abc123; Path=/',
      'Proxy-Authorization': 'Basic c2VjcmV0',
      'X-Jazz-CSRF-Prevent': 'abc123',
    });
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('leaves ordinary headers alone', () => {
    const out = redactHeaders({ 'Accept': 'text/turtle', 'OSLC-Core-Version': '2.0' });
    expect(out).toEqual({ 'Accept': 'text/turtle', 'OSLC-Core-Version': '2.0' });
  });

  it('keeps the header names, so a transcript still shows what was sent', () => {
    expect(Object.keys(redactHeaders({ Authorization: 'Basic x' }))).toEqual(['Authorization']);
  });
});

describe('encodeFormParams', () => {
  it("escapes '#', which would otherwise truncate the request at the fragment", () => {
    const body = encodeFormParams([
      ['oslc.prefix', 'oslc=<http://open-services.net/ns/core#>'],
    ]);
    expect(body).toContain('%23');
    expect(body).not.toMatch(/#/);
  });

  it('escapes separators inside values so they cannot split a parameter', () => {
    const body = encodeFormParams([['oslc.where', 'a="x&y" and b="p=q"']]);
    expect(body.split('&')).toHaveLength(1);
    expect(body.indexOf('=')).toBe('oslc.where'.length);
  });

  it('joins several parameters with & in the order given', () => {
    const body = encodeFormParams([['oslc.where', 'a'], ['oslc.select', 'b']]);
    expect(body).toBe('oslc.where=a&oslc.select=b');
  });

  it('returns an empty string for no parameters', () => {
    expect(encodeFormParams([])).toBe('');
  });
});

describe('headerValue', () => {
  it('finds a header regardless of the casing the server used', () => {
    expect(headerValue({ 'Content-Type': 'text/turtle' }, 'content-type')).toBe('text/turtle');
    expect(headerValue({ 'content-type': 'text/turtle' }, 'Content-Type')).toBe('text/turtle');
  });

  it('returns undefined when absent', () => {
    expect(headerValue({}, 'content-type')).toBeUndefined();
  });
});

describe('formatTranscript', () => {
  const exchange: HttpExchange = {
    method: 'POST',
    url: 'https://elm.example.com/rm/views',
    requestHeaders: {
      'OSLC-Core-Version': '2.0',
      'Accept': 'application/rdf+xml',
      'Authorization': 'Basic c2VjcmV0',
    },
    requestParams: [
      ['oslc.prefix', 'oslc=<http://open-services.net/ns/core#>'],
      ['oslc.where', 'dcterms:identifier="PROBE-01"'],
    ],
    requestBody: 'oslc.prefix=oslc%3D%3Chttp%3A%2F%2Fopen-services.net%2Fns%2Fcore%23%3E',
    status: 400,
    responseHeaders: { 'Content-Type': 'application/rdf+xml' },
    responseBody: 'oslc:Error "Unknown prefix: dcterms"',
  };

  it('never leaks a credential', () => {
    const text = formatTranscript(exchange);
    expect(text).not.toContain('c2VjcmV0');
    expect(text).toContain(REDACTED);
  });

  it('prints the decoded parameters before the encoded body', () => {
    const text = formatTranscript(exchange);
    expect(text.indexOf('body (decoded)')).toBeLessThan(text.indexOf('body (encoded)'));
  });

  it('prints decoded parameters one per line, not joined into a pastable URL', () => {
    const text = formatTranscript(exchange);
    const decoded = text.slice(text.indexOf('body (decoded)'), text.indexOf('body (encoded)'));
    // A '=' between name and value would make the block pastable as a query
    // string — which is exactly the '#' trap this formatting exists to avoid.
    expect(decoded).toContain('oslc.prefix  oslc=<http://open-services.net/ns/core#>');
    expect(decoded).not.toContain('oslc.prefix=oslc');
  });

  it('records the status, content type and body size', () => {
    expect(formatTranscript(exchange)).toContain('→ 400  application/rdf+xml  (36 bytes)');
  });

  it('omits both body blocks for a request that had none', () => {
    const text = formatTranscript({
      method: 'GET',
      url: 'https://elm.example.com/rm/rootservices',
      requestHeaders: { 'Accept': 'text/turtle' },
      status: 200,
      responseHeaders: { 'Content-Type': 'text/turtle' },
      responseBody: '',
    });
    expect(text).not.toContain('body (decoded)');
    expect(text).not.toContain('body (encoded)');
    expect(text).toContain('GET https://elm.example.com/rm/rootservices');
  });
});
