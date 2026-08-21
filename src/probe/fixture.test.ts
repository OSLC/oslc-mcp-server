import { describe, it, expect } from '@jest/globals';
import {
  FIXTURE_PREFIX,
  fixtureSpecs,
  fixtureTurtle,
  createManifest,
  chooseFixtureType,
} from './fixture.js';

describe('fixtureSpecs', () => {
  const specs = fixtureSpecs();

  it('creates five resources, so pageSize=2 can page', () => {
    expect(specs).toHaveLength(5);
  });

  it('gives every resource a unique identifier', () => {
    expect(new Set(specs.map((s) => s.identifier)).size).toBe(5);
  });

  it('marks every resource as the probe\'s own, so cleanup is unambiguous', () => {
    for (const spec of specs) expect(spec.identifier.startsWith(FIXTURE_PREFIX)).toBe(true);
  });

  it('orders titles predictably, so orderBy has something to observe', () => {
    const titles = specs.map((s) => s.title);
    expect(titles).toEqual([...titles].sort());
    expect(new Set(titles).size).toBe(5);
  });

  it('sets the optional property on some resources and not others', () => {
    const withNote = specs.filter((s) => s.optionalNote !== undefined);
    expect(withNote.length).toBeGreaterThan(0);
    expect(withNote.length).toBeLessThan(specs.length);
  });
});

describe('fixtureTurtle', () => {
  const TYPE = 'http://open-services.net/ns/rm#Requirement';

  it('types the resource and carries its identifier and title', () => {
    const turtle = fixtureTurtle({ identifier: 'PROBE-01', title: 'Probe 01' }, TYPE);
    expect(turtle).toContain(`a <${TYPE}>`);
    expect(turtle).toContain('"PROBE-01"');
    expect(turtle).toContain('"Probe 01"');
  });

  it('omits the optional property when the spec has none', () => {
    const turtle = fixtureTurtle({ identifier: 'PROBE-02', title: 'Probe 02' }, TYPE);
    expect(turtle).not.toContain('description');
  });

  it('escapes quotes so a value cannot break out of its literal', () => {
    const turtle = fixtureTurtle({ identifier: 'PROBE-03', title: 'He said "hi"' }, TYPE);
    expect(turtle).toContain('\\"hi\\"');
  });
});

describe('createManifest', () => {
  it('records a URI before it is reported as created', () => {
    const lines: string[] = [];
    const manifest = createManifest((line) => lines.push(line));
    manifest.record('https://elm.example.com/rm/r/1');
    expect(lines).toEqual(['https://elm.example.com/rm/r/1']);
    expect(manifest.created()).toEqual(['https://elm.example.com/rm/r/1']);
  });

  it('keeps recording after a write failure, so the in-memory list stays complete', () => {
    const manifest = createManifest(() => { throw new Error('disk full'); });
    expect(() => manifest.record('https://elm.example.com/rm/r/1')).not.toThrow();
    expect(manifest.created()).toEqual(['https://elm.example.com/rm/r/1']);
  });
});

describe('chooseFixtureType', () => {
  const factory = (title: string, required: number) => ({
    title,
    creationURI: `https://elm.example.com/rm/create/${title}`,
    resourceType: `http://example.com/${title}`,
    shape: {
      description: '',
      properties: Array.from({ length: required }, (_, i) => ({
        name: `p${i}`, occurs: 'http://open-services.net/ns/core#Exactly-one',
      })),
    },
  });

  it('prefers the factory whose shape demands least, to fail for fewer unrelated reasons', () => {
    const sp = { factories: [factory('Heavy', 5), factory('Light', 1)] } as any;
    expect(chooseFixtureType(sp)?.title).toBe('Light');
  });

  it('ignores a factory with no shape — no shape means no tool and no schema', () => {
    const sp = { factories: [{ ...factory('Shapeless', 0), shape: null }, factory('Usable', 3)] } as any;
    expect(chooseFixtureType(sp)?.title).toBe('Usable');
  });

  it('returns null when nothing is creatable', () => {
    expect(chooseFixtureType({ factories: [] } as any)).toBeNull();
  });
});
