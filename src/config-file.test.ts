import { describe, it, expect, jest } from '@jest/globals';
import { parseConfigFile, loadConfigFile } from './config-file.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

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

describe('loadConfigFile — where a relative reportPath points', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oslc-cfg-'));
  const configPath = join(dir, 'nested', 'oslc-mcp-server.yaml');
  const write = (reportPath: string) => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath,
      `reportPath: ${reportPath}\nservers:\n  - alias: one\n    baseUrl: http://example.org\n`, 'utf8');
  };

  it('resolves against the configuration file, not the working directory', () => {
    write('./oslc-discovery.md');
    // The bug this covers: the path was handed to writeFileSync unresolved, so the
    // report landed next to whatever directory node was invoked from, while a stale
    // file beside the config kept being read as the current one.
    expect(loadConfigFile(configPath).reportPath)
      .toBe(join(dir, 'nested', 'oslc-discovery.md'));
  });

  it('resolves a path that climbs out of the configuration directory', () => {
    write('../reports/discovery.md');
    expect(loadConfigFile(configPath).reportPath).toBe(join(dir, 'reports', 'discovery.md'));
  });

  it('leaves an absolute path alone', () => {
    write('/var/tmp/oslc-discovery.md');
    expect(loadConfigFile(configPath).reportPath).toBe('/var/tmp/oslc-discovery.md');
  });

  it('reports the configuration directory as the base for other relative paths', () => {
    write('./x.md');
    expect(loadConfigFile(configPath).baseDir).toBe(join(dir, 'nested'));
  });

  it('leaves reportPath undefined when the configuration omits it', () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath,
      'servers:\n  - alias: one\n    baseUrl: http://example.org\n', 'utf8');
    const loaded = loadConfigFile(configPath);
    expect(loaded.reportPath).toBeUndefined();
    expect(loaded.baseDir).toBe(join(dir, 'nested'));   // still known, for the probe report
  });
});
