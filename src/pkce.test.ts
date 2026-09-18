import { describe, it, expect } from '@jest/globals';
import { createPkcePair, randomState, buildAuthorizeUrl } from './pkce.js';

describe('createPkcePair', () => {
  it('produces an S256 challenge derived from the verifier', async () => {
    const { verifier, challenge, method } = createPkcePair();
    expect(method).toBe('S256');

    // Derive it independently rather than trusting the implementation's own maths.
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('uses only unreserved characters, 43-128 long, as RFC 7636 requires', () => {
    for (let i = 0; i < 20; i++) {
      const { verifier } = createPkcePair();
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    }
  });

  it('never repeats a verifier, or a replayed code would be usable', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(200);
  });
});

describe('randomState', () => {
  it('is unguessable and unique per call', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomState()));
    expect(seen.size).toBe(200);
    expect(randomState()).toMatch(/^[A-Za-z0-9\-._~]{20,}$/);
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    authorizationEndpoint: 'https://jas.example.com/oidc/endpoint/jazzop/authorize',
    clientId: 'resource-navigator',
    redirectUri: 'http://127.0.0.1:8765/callback',
    state: 'STATE',
    challenge: 'CHALLENGE',
    scope: 'general',
  };

  it('carries every parameter the authorization code + PKCE flow needs', () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe(base.authorizationEndpoint);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('resource-navigator');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(q.get('state')).toBe('STATE');
    expect(q.get('code_challenge')).toBe('CHALLENGE');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('scope')).toBe('general');
  });

  it('omits scope when none is configured rather than sending an empty one', () => {
    const q = new URL(buildAuthorizeUrl({ ...base, scope: undefined })).searchParams;
    expect(q.has('scope')).toBe(false);
  });

  it('never sends the code verifier, which would defeat PKCE entirely', () => {
    const { verifier, challenge } = createPkcePair();
    const url = buildAuthorizeUrl({ ...base, challenge });
    expect(url).not.toContain(verifier);
  });
});
