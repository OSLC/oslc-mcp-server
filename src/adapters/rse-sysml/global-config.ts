/**
 * Resolving a global configuration to the RSE contribution inside it.
 *
 * This is the piece worth the most. Rhapsody SE cannot resolve a foreign global
 * configuration: it matches on a component URL rather than a configuration URI,
 * so a request carrying one reaches its default branch, where the AM query base
 * answers `500` and reads as an outage. Every run has worked around that by
 * PINNING the RSE stream in `oslc-mcp-server-acme.yaml` — the only per-run file
 * edit in the whole setup, the reason `allServers: false` is a standing rule,
 * and the reason RSE is documented as "the one real exception".
 *
 * None of that is necessary. What the setup procedure tells a human to do by
 * hand — open the global configuration, walk its contributions, find the one
 * that is an RSE stream — is four HTTP requests.
 */
import rdflib from 'rdflib';
import { parseRseContext, type RseContext, type Http } from './context.js';

const CFG = 'http://open-services.net/ns/config#';
const DCTERMS = 'http://purl.org/dc/terms/';

/**
 * CDCM serves `application/rdf+xml` and **nothing else**: `text/turtle`,
 * `application/ld+json` and `application/json` each answer `500`, not `406`.
 */
export const GC_ACCEPT = 'application/rdf+xml';

function parseRdf(text: string, base: string): rdflib.IndexedFormula {
  const g = rdflib.graph();
  rdflib.parse(text, g, base, 'application/rdf+xml');
  return g;
}

export interface GcHttp extends Http {
  /** RDF/XML, because CDCM will not serve anything else. */
  getRdf(url: string): Promise<string>;
}

/**
 * The RSE contribution of a global configuration, or null when it has none.
 *
 * A contribution qualifies on two counts, not one: its configuration URI must
 * parse as an RSE context **and** share an origin with the RSE server this
 * adapter is configured for. The shape alone is not enough — ETM's contribution
 * URI also contains `/oslc_config/`, and a second SysML server in the same
 * global configuration would otherwise be indistinguishable from ours.
 */
export async function resolveGlobalConfiguration(
  http: GcHttp, gcUri: string, rseBaseUrl: string
): Promise<RseContext | null> {
  const wanted = new URL(rseBaseUrl).origin;
  const g = parseRdf(await http.getRdf(gcUri), gcUri);
  const contributions = g
    .each(rdflib.sym(gcUri), rdflib.sym(`${CFG}contribution`), null)
    .map((n) => (n as { value: string }).value);

  for (const c of contributions) {
    const cg = parseRdf(await http.getRdf(c), c);
    const cfg = cg.any(rdflib.sym(c), rdflib.sym(`${CFG}configuration`), null) as
      { value?: string } | null;
    const uri = cfg?.value;
    if (!uri) continue;
    const ctx = parseRseContext(uri);
    if (ctx && new URL(uri).origin === wanted) return ctx;
  }
  return null;
}

/** A contribution's title, for saying which one was chosen. */
export async function describeContributions(
  http: GcHttp, gcUri: string
): Promise<{ title: string; configuration?: string }[]> {
  const g = parseRdf(await http.getRdf(gcUri), gcUri);
  const out: { title: string; configuration?: string }[] = [];
  for (const c of g.each(rdflib.sym(gcUri), rdflib.sym(`${CFG}contribution`), null)
    .map((n) => (n as { value: string }).value)) {
    const cg = parseRdf(await http.getRdf(c), c);
    out.push({
      title: (cg.any(rdflib.sym(c), rdflib.sym(`${DCTERMS}title`), null) as { value?: string } | null)?.value ?? '(untitled)',
      configuration: (cg.any(rdflib.sym(c), rdflib.sym(`${CFG}configuration`), null) as { value?: string } | null)?.value,
    });
  }
  return out;
}

/**
 * Accept either kind of configuration context.
 *
 * An RSE stream is used as given; anything else is tried as a global
 * configuration. **Failure is loud**, because the alternative — carrying on
 * without a context — is how RSE serves its default branch and answers a `500`
 * that looks like an outage.
 */
export async function resolveAnyContext(
  http: GcHttp, rseBaseUrl: string, contextUri: string | null | undefined
): Promise<RseContext> {
  const direct = parseRseContext(contextUri);
  if (direct) return direct;
  if (!contextUri) {
    throw new Error(
      'RSE: no configuration context is set. Without one RSE reads its default branch, which is ' +
      'not an error and not the configuration you meant.');
  }
  const viaGc = await resolveGlobalConfiguration(http, contextUri, rseBaseUrl);
  if (viaGc) return viaGc;
  throw new Error(
    `RSE: ${contextUri} is neither an RSE configuration nor a global configuration containing ` +
    `one for ${new URL(rseBaseUrl).origin}.`);
}
