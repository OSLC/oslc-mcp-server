import { describe, it, expect, jest } from '@jest/globals';
import { HttpToolContext } from './server.js';

/**
 * A create must go out as RDF/XML, not Turtle.
 *
 * DOORS Next rejects a Turtle creation body with
 *   415  CRRRS6402E  Content is not allowed. Content type must be application/rdf+xml
 * and accepts the identical content as RDF/XML (measured 2026-09-25: turtle 415,
 * rdf+xml 403 for a bare requirement, 201 once it carried an oslc:instanceShape --
 * so the media type is the transport layer's bug and the 403 was the caller's).
 *
 * updateResource already converted for the same reason; createResource did not,
 * which is the regression this guards.
 */
function stubClient() {
  const post = jest.fn(async () => ({ headers: { location: 'https://elm.example.com/rm/resources/TX_1' } }));
  return { client: { client: { post } }, post };
}

const FACTORY = 'https://elm.example.com/rm/requirementFactory';
const TURTLE =
  '@prefix dcterms: <http://purl.org/dc/terms/> .\n' +
  '@prefix oslc_rm: <http://open-services.net/ns/rm#> .\n' +
  '[] a oslc_rm:Requirement ; dcterms:title "A requirement" .';

describe('createResource', () => {
  it('posts application/rdf+xml, because ELM refuses Turtle on writes', async () => {
    const { client, post } = stubClient();
    const ctx = new HttpToolContext(client as any, 'https://elm.example.com/rm', 'https://elm.example.com/rm/catalog');
    await ctx.createResource(FACTORY, TURTLE);

    const [, , config] = (post as any).mock.calls[0];
    expect(config.headers['Content-Type']).toBe('application/rdf+xml');
  });

  it('converts the body, so it is RDF/XML rather than the Turtle it was handed', async () => {
    const { client, post } = stubClient();
    const ctx = new HttpToolContext(client as any, 'https://elm.example.com/rm', 'https://elm.example.com/rm/catalog');
    await ctx.createResource(FACTORY, TURTLE);

    const body = (post as any).mock.calls[0][1] as string;
    expect(body).toContain('<rdf:RDF');
    expect(body).not.toContain('@prefix');
  });

  it('returns the Location header, which is how the caller learns the new URI', async () => {
    const { client } = stubClient();
    const ctx = new HttpToolContext(client as any, 'https://elm.example.com/rm', 'https://elm.example.com/rm/catalog');
    expect(await ctx.createResource(FACTORY, TURTLE)).toBe('https://elm.example.com/rm/resources/TX_1');
  });
});
