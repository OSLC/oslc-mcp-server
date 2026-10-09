import { parseRseContext, resolveCommit } from './context.js';

const STREAM =
  'https://trs-filter-light.smartfacts.com/api/oslc_config/9931e482-aaac-4edd-b7e8-f67198987462' +
  '/stream/7c6880e7-d529-4aae-a320-1fb3a4d2e3a9';

describe('parseRseContext', () => {
  it('decomposes a stream context into the two ids the SysML routes need', () => {
    expect(parseRseContext(STREAM)).toEqual({
      kind: 'stream',
      projectId: '9931e482-aaac-4edd-b7e8-f67198987462',
      branchId: '7c6880e7-d529-4aae-a320-1fb3a4d2e3a9',
    });
  });

  it('decomposes a baseline context', () => {
    expect(parseRseContext(STREAM.replace('/stream/', '/baseline/'))).toMatchObject({
      kind: 'baseline', baselineId: '7c6880e7-d529-4aae-a320-1fb3a4d2e3a9',
    });
  });

  // A global configuration is a DIFFERENT problem, and answering it here would
  // hand back a project id scraped out of the wrong server's URL.
  it('returns null for a CDCM global configuration rather than guessing', () => {
    expect(parseRseContext(
      'https://trs-filter.smartfacts.com/gc/cdcm/CDCM-X/oslc/areas/a/components/c/configuration/6ac4'
    )).toBeNull();
  });

  it('returns null for no context at all', () => {
    expect(parseRseContext(undefined)).toBeNull();
    expect(parseRseContext('')).toBeNull();
  });
});

describe('resolveCommit', () => {
  const ctx = parseRseContext(STREAM)!;

  it('resolves a stream to its branch head', async () => {
    const http = { get: async () => ({ status: 200, data: { head: { '@id': 'c1c7a7dd' } } }) };
    await expect(resolveCommit(http, 'https://h/api', ctx)).resolves.toBe('c1c7a7dd');
  });

  // Reading on without a commit means reading the default branch, which is how
  // RSE produces a 500 that looks like an outage.
  it('throws rather than continuing when a branch reports no head', async () => {
    const http = { get: async () => ({ status: 200, data: {} }) };
    await expect(resolveCommit(http, 'https://h/api', ctx)).rejects.toThrow(/no head commit/);
  });

  it('refuses a baseline loudly while it is unimplemented', async () => {
    const http = { get: async () => ({ status: 200, data: {} }) };
    const b = parseRseContext(STREAM.replace('/stream/', '/baseline/'))!;
    await expect(resolveCommit(http, 'https://h/api', b)).rejects.toThrow(/not yet supported/);
  });
});
