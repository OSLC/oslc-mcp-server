import { describe, it, expect } from '@jest/globals';
import { graph, parse } from 'rdflib';
import { parseShape } from 'oslc-service/mcp';
import {
  FIXTURE_PREFIX,
  fixtureSpecs,
  fixtureRdfXml,
  createManifest,
  chooseFixtureType,
  requiredExtras,
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

describe('the PROBE- marker', () => {
  it('is in the title, since dcterms:identifier is not sent', () => {
    // A human hunting leftover fixtures in the server's own UI has only the title
    // to go on: the identifier is whatever the server assigned.
    for (const spec of fixtureSpecs()) {
      expect(spec.title.startsWith(FIXTURE_PREFIX)).toBe(true);
    }
  });

  it('keeps titles unique and sortable, for filters and ordering', () => {
    const titles = fixtureSpecs().map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect([...titles].sort()).toEqual(titles);
  });
});

describe('fixtureRdfXml', () => {
  const TYPE = 'http://open-services.net/ns/rm#Requirement';

  it('types the resource and carries its title', () => {
    const body = fixtureRdfXml({ identifier: 'PROBE-01', title: 'PROBE-01' }, TYPE);
    // RDF/XML, not Turtle: OSLC Core requires it and makes Turtle optional, so a
    // fixture established over Turtle can fail against a conformant server.
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('xmlns:t="http://open-services.net/ns/rm#"');
    expect(body).toContain('<t:Requirement rdf:about="">');
    expect(body).toContain('<dcterms:title>PROBE-01</dcterms:title>');
  });

  it('does not send dcterms:identifier, which Core makes server-assigned', () => {
    // Sending it asked a conformant server to ignore it, and its absence from the
    // read-back then registered as a "property dropped on create" finding.
    expect(fixtureRdfXml({ identifier: 'PROBE-01', title: 'PROBE-01' }, TYPE))
      .not.toContain('dcterms:identifier');
  });

  it('leaves the URI to the server, as rdf:about=""', () => {
    expect(fixtureRdfXml({ identifier: 'PROBE-01', title: 'Probe 01' }, TYPE))
      .toContain('rdf:about=""');
  });

  it('omits the optional property when the spec has none', () => {
    expect(fixtureRdfXml({ identifier: 'PROBE-02', title: 'Probe 02' }, TYPE))
      .not.toContain('description');
  });

  it('escapes markup so a value cannot break out of its element', () => {
    const body = fixtureRdfXml({ identifier: 'PROBE-03', title: 'a < b & c' }, TYPE);
    expect(body).toContain('a &lt; b &amp; c');
    expect(body).not.toContain('a < b & c');
  });

  it('handles a type URI whose namespace ends in a slash', () => {
    const body = fixtureRdfXml({ identifier: 'PROBE-04', title: 'Probe 04' }, 'http://example.org/vocab/Widget');
    expect(body).toContain('xmlns:t="http://example.org/vocab/"');
    expect(body).toContain('<t:Widget rdf:about="">');
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

describe('required properties are read from the shape', () => {
  const factory = (title: string, properties: any[]) => ({
    title, creationURI: `https://elm.example.com/f/${title}`,
    resourceType: 'http://open-services.net/ns/cm#ChangeRequest',
    shape: { description: '', properties },
  }) as any;
  const TITLE = { name: 'title', propertyDefinition: 'http://purl.org/dc/terms/title', occurs: 'exactly-one' };
  const FILED = {
    name: 'filedAgainst',
    propertyDefinition: 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/filedAgainst',
    occurs: 'exactly-one',
    valueType: 'http://open-services.net/ns/core#Resource',
    allowedValues: ['https://elm.example.com/cat/JKE', 'https://elm.example.com/cat/Unassigned'],
  };

  it('counts a lowercase `occurs`, which is how discovery reports it', () => {
    // The bug: requiredCount compared against 'http://…core#Exactly-one' while the
    // discovered shape carries 'exactly-one', so every factory looked unconstrained
    // and the fixture omitted properties the server insists on.
    const chosen = chooseFixtureType({
      title: 'sp', uri: 'https://elm.example.com/sp',
      factories: [factory('Defect', [TITLE, FILED]), factory('Task', [TITLE])],
      queries: [], domains: [],
    } as any);
    expect(chosen?.title).toBe('Task');
  });

  it('supplies a required reference from its first allowed value', async () => {
    const extras = await requiredExtras({ properties: [TITLE, FILED] }, 'PROBE-01');
    expect(extras).toEqual([{
      predicate: 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/filedAgainst',
      value: 'https://elm.example.com/cat/JKE',
      isReference: true,
    }]);
  });

  it('does not repeat a property the fixture already sends', async () => {
    expect(await requiredExtras({ properties: [TITLE] }, 'PROBE-01')).toEqual([]);
  });

  it('will not invent a URI for a required reference with no allowed values', async () => {
    // Any URI would be a fabricated link. Better to let the create fail with the
    // server's own message, which names what is missing.
    const extras = await requiredExtras({ properties: [{ ...FILED, allowedValues: [] }] }, 'PROBE-01');
    expect(extras).toEqual([]);
  });

  it('gives a required literal the PROBE- marker, so residue stays identifiable', async () => {
    const extras = await requiredExtras({ properties: [
      { name: 'summary', propertyDefinition: 'http://example.org/summary', occurs: 'exactly-one' },
    ] }, 'PROBE-01');
    expect(extras).toEqual([{ predicate: 'http://example.org/summary', value: 'PROBE-01', isReference: false }]);
  });

  it('writes a reference as rdf:resource and a literal as element text', () => {
    const body = fixtureRdfXml({ identifier: 'PROBE-01', title: 'PROBE-01' },
      'http://open-services.net/ns/cm#ChangeRequest', [
        { predicate: 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/filedAgainst', value: 'https://elm.example.com/cat/JKE', isReference: true },
        { predicate: 'http://example.org/summary', value: 'PROBE-01', isReference: false },
      ]);
    expect(body).toContain('filedAgainst xmlns:e0="http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/" rdf:resource="https://elm.example.com/cat/JKE"');
    expect(body).toContain('<e1:summary xmlns:e1="http://example.org/">PROBE-01</e1:summary>');
  });
});

describe('required properties via the graph, not the flattened array', () => {
  const SHAPE_URI = 'http://example.org/shapes/Defect';
  const FILED = 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/filedAgainst';
  const DEFAULT_CAT = 'https://elm.example.com/cat/Unassigned';

  /** A shape as it comes off the wire, parsed the way discovery parses it. */
  const parsed = () => {
    const rdf = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:oslc="http://open-services.net/ns/core#"
         xmlns:dcterms="http://purl.org/dc/terms/">
  <oslc:ResourceShape rdf:about="${SHAPE_URI}">
    <oslc:property>
      <oslc:Property>
        <oslc:name>filedAgainst</oslc:name>
        <oslc:propertyDefinition rdf:resource="${FILED}"/>
        <oslc:occurs rdf:resource="http://open-services.net/ns/core#Exactly-one"/>
        <oslc:valueType rdf:resource="http://open-services.net/ns/core#Resource"/>
        <oslc:defaultValue rdf:resource="${DEFAULT_CAT}"/>
        <oslc:allowedValue rdf:resource="${DEFAULT_CAT}"/>
        <oslc:allowedValue rdf:resource="https://elm.example.com/cat/JKE"/>
      </oslc:Property>
    </oslc:property>
  </oslc:ResourceShape>
</rdf:RDF>`;
    const store = graph();
    parse(rdf, store, SHAPE_URI, 'application/rdf+xml');
    return parseShape(store, SHAPE_URI);
  };

  it('reads Exactly-one from the OSLC URI the server published', async () => {
    expect(await requiredExtras(parsed(), 'PROBE-01')).toHaveLength(1);
  });

  it('avoids the shape’s advertised default when another value exists', async () => {
    // EWM advertises `Unassigned` as filedAgainst's default and rejects it on
    // save. A required property whose default the server would accept need not
    // have been required at all.
    expect((await requiredExtras(parsed(), 'PROBE-01'))[0]).toEqual({
      predicate: FILED,
      value: 'https://elm.example.com/cat/JKE',
      isReference: true,
    });
  });

  it('falls back to the default when it is the only allowed value', async () => {
    const shape = parsed();
    shape.access = undefined;   // a hand-built shape: no store behind it
    (shape.properties as any) = [{
      predicateURI: FILED, occurs: 'exactly-one',
      valueType: 'http://open-services.net/ns/core#Resource',
      allowedValues: [DEFAULT_CAT], defaultValue: DEFAULT_CAT,
    }];
    expect((await requiredExtras(shape, 'PROBE-01'))[0].value).toBe(DEFAULT_CAT);
  });
});

describe('allowed values referenced rather than inlined', () => {
  const FILED = 'http://jazz.net/xmlns/prod/jazz/rtc/cm/1.0/filedAgainst';
  const REF = 'https://elm.example.com/ccm/shapes/defect/property/category/allowedValues';

  /** A shape whose required reference names its values in another document. */
  const shape = {
    properties: [{
      propertyDefinition: FILED,
      occurs: 'http://open-services.net/ns/core#Exactly-one',
      valueType: 'http://open-services.net/ns/core#Resource',
      allowedValues: [],
      allowedValuesRef: REF,
      defaultValue: 'https://elm.example.com/cat/Unassigned',
    }],
  };

  it('fetches the referenced document and uses a value from it', async () => {
    // EWM's Defect shape references its categories instead of inlining them, so
    // allowedValues is empty for a property that is Exactly-one. Skipping it
    // produces a 403 the client cannot explain.
    const extras = await requiredExtras(shape, 'PROBE-01', async (uri) => {
      expect(uri).toBe(REF);
      return ['https://elm.example.com/cat/Unassigned', 'https://elm.example.com/cat/JKE'];
    });
    expect(extras).toEqual([
      { predicate: FILED, value: 'https://elm.example.com/cat/JKE', isReference: true },
    ]);
  });

  it('still avoids the advertised default among the fetched values', async () => {
    // Unassigned is EWM's default and is rejected on save with the same 403 as
    // sending nothing — an allowed value that is not allowed.
    const extras = await requiredExtras(shape, 'PROBE-01', async () => [
      'https://elm.example.com/cat/Unassigned',
      'https://elm.example.com/cat/JKE',
    ]);
    expect(extras[0].value).not.toContain('Unassigned');
  });

  it('skips the property when the reference cannot be fetched', async () => {
    // No worse than before this existed: the create is refused and the server's
    // own message names what is missing.
    expect(await requiredExtras(shape, 'PROBE-01', async () => [])).toEqual([]);
  });

  it('does not fetch when the values are already inline', async () => {
    const inline = { properties: [{ ...shape.properties[0], allowedValues: ['https://elm.example.com/cat/JKE'], allowedValuesRef: null }] };
    let fetched = false;
    await requiredExtras(inline, 'PROBE-01', async () => { fetched = true; return []; });
    expect(fetched).toBe(false);
  });
});
