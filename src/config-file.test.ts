import { describe, it, expect, jest } from '@jest/globals';
import { parseConfigFile } from './config-file.js';

const MINIMAL = `
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
`;

describe('parseConfigFile', () => {
  it('parses a minimal server entry', () => {
    const config = parseConfigFile(MINIMAL);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].alias).toBe('dng');
    expect(config.servers[0].baseUrl).toBe('https://elm.example.com/rm');
  });

  it('leaves catalogUrl undefined when absent, for startup to resolve', () => {
    const config = parseConfigFile(MINIMAL);
    expect(config.servers[0].catalogUrl).toBeUndefined();
  });

  it('keeps an explicit catalogUrl', () => {
    const config = parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
    catalogUrl: https://elm.example.com/rm/oslc_rm/catalog
`);
    expect(config.servers[0].catalogUrl).toBe('https://elm.example.com/rm/oslc_rm/catalog');
  });

  it('parses service providers with their configuration context', () => {
    const config = parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
    serviceProviders:
      - uri: https://elm.example.com/rm/oslc_rm/_a/services.xml
        alias: requirements
        configurationContext: https://elm.example.com/gc/configuration/1
`);
    const sps = config.servers[0].serviceProviders!;
    expect(sps).toHaveLength(1);
    expect(sps[0].alias).toBe('requirements');
    expect(sps[0].configurationContext).toBe('https://elm.example.com/gc/configuration/1');
  });

  it('accepts literal credentials and warns once, naming the server', () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    const config = parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
    credentials:
      username: jim
      password: hunter2
`);
    expect(config.servers[0].credentials).toEqual({
      usernameEnv: undefined,
      passwordEnv: undefined,
      username: 'jim',
      password: 'hunter2',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/dng/);
    warn.mockRestore();
  });

  it('does not warn when credentials are environment references', () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
    credentials:
      usernameEnv: ELM_USER
      passwordEnv: ELM_PASSWORD
`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects credentials that are neither a complete pair nor a complete reference', () => {
    expect(() => parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://elm.example.com/rm
    credentials:
      username: jim
`)).toThrow(/dng.*credentials/s);
  });

  it('rejects duplicate server aliases', () => {
    expect(() => parseConfigFile(`
servers:
  - alias: dng
    baseUrl: https://a.example.com/rm
  - alias: dng
    baseUrl: https://b.example.com/rm
`)).toThrow(/duplicate.*dng/i);
  });

  it('rejects a server with no alias', () => {
    expect(() => parseConfigFile(`
servers:
  - baseUrl: https://elm.example.com/rm
`)).toThrow(/alias/i);
  });

  it('rejects an empty server list', () => {
    expect(() => parseConfigFile('servers: []')).toThrow(/at least one server/i);
  });
});
