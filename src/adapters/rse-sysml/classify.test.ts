import { classify, expectOk } from './classify.js';

describe('classify reads the payload, not the status', () => {
  it('accepts a real element at 200', () => {
    expect(classify(200, { '@id': 'a', '@type': 'PartUsage' }, 'x').kind).toBe('ok');
  });

  it('calls UnknownElement absent, even though it arrives as 200', () => {
    expect(classify(200, { '@id': 'a', '@type': 'UnknownElement' }, 'x').kind).toBe('absent');
  });

  // Both of these are 200s in practice; only the body distinguishes them.
  it('treats an Error body as a failure whatever the status says', () => {
    for (const status of [200, 404, 500]) {
      const o = classify(status, { '@type': 'Error', success: false, description: 'Branch not found' }, 'x');
      expect(o).toMatchObject({ kind: 'error' });
      expect((o as { message: string }).message).toContain('Branch not found');
    }
  });

  it('treats success:false as a failure even without the Error type', () => {
    expect(classify(200, { success: false, description: 'nope' }, 'x').kind).toBe('error');
  });

  // A 401 answers with no JSON at all, so this is the only case the status decides.
  it('calls a non-JSON body a transport or credential failure', () => {
    expect(classify(401, '', 'x')).toMatchObject({ kind: 'error' });
    expect(classify(200, undefined, 'x')).toMatchObject({ kind: 'error' });
  });

  it('passes a list through — including an empty one, which it cannot judge alone', () => {
    expect(classify(200, [], 'x')).toEqual({ kind: 'ok', value: [] });
  });
});

describe('expectOk', () => {
  it('returns the value', () => expect(expectOk(200, { a: 1 }, 'x')).toEqual({ a: 1 }));
  it('throws the server description', () =>
    expect(() => expectOk(500, { '@type': 'Error', description: 'boom' }, 'x')).toThrow(/boom/));
  it('throws on absence rather than returning a sentinel element', () =>
    expect(() => expectOk(200, { '@type': 'UnknownElement' }, 'x')).toThrow(/absent/));
});
