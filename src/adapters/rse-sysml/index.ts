/**
 * The RSE adapter, as the tool handlers see it.
 *
 * Enabled only by `adapter: rse-sysml` on a server entry — never detected — and
 * when absent the handlers behave exactly as before. That is not only an escape
 * hatch: being able to re-ask the raw provider is what makes any claim the
 * adapter makes checkable.
 */
import { resolveCommit } from './context.js';
import { resolveAnyContext, GC_ACCEPT, type GcHttp } from './global-config.js';
import { fetchCommitElements, linkNext, runQuery, type PostHttp } from './query.js';
import {
  NOT_EXPOSED, indexDescriptions, indexLinks, projectResource, resourceUri,
  type SysmlElement,
} from './project.js';

export interface RseAdapterDeps {
  /** The RSE base, e.g. `https://host/api`. */
  baseUrl: string;
  /** Read at call time, not captured: `set_configuration_context` changes it. */
  currentContext: () => string | undefined;
  http: PostHttp & GcHttp;
}

export interface RseAdapter {
  getResource(uri: string): Promise<string>;
  queryResources(): Promise<string>;
}

/** The local name of a predicate, which is how the OSLC tools render links. */
function localName(predicate: string): string {
  return predicate.split(/[#/]/).pop() || predicate;
}

interface Projected { [k: string]: unknown }

export function createRseAdapter(deps: RseAdapterDeps): RseAdapter {
  /** One read of the configuration per call — never per resource, so a query and
   *  the resources in it describe one configuration rather than a moving one. */
  async function load() {
    const ctx = await resolveAnyContext(deps.http, deps.baseUrl, deps.currentContext());
    const commit = await resolveCommit(deps.http, deps.baseUrl, ctx);
    const all = (await fetchCommitElements(
      deps.http, deps.baseUrl, ctx.projectId, commit)) as unknown as SysmlElement[];
    const byId = new Map(all.map((e) => [e['@id'], e]));
    const lts = await runQuery(deps.http, deps.baseUrl, ctx.projectId, commit,
      { property: '@type', value: 'OSLCLinkType', select: ['@id', 'linkTypeURI'] });
    const { links } = indexLinks(
      all.filter((e) => e['@type'] === 'OSLCLink'),
      new Map(lts.map((l) => [String(l['@id']), String(l.linkTypeURI)])), byId);
    return {
      all, byId, commit,
      amBase: `${deps.baseUrl}/oslc_am/${ctx.projectId}`,
      descriptions: indexDescriptions(all.filter((e) => e['@type'] === 'Documentation'), byId),
      links,
    };
  }

  function render(e: SysmlElement, s: Awaited<ReturnType<typeof load>>): Projected {
    const p = projectResource(e, { amBase: s.amBase, descriptions: s.descriptions, links: s.links });
    const out: Projected = {
      uri: p.uri,
      type: p.types.map((uri) => ({ uri })),
      identifier: p.identifier,
    };
    if (p.title) out.title = p.title;
    if (p.shortTitle) out.shortTitle = p.shortTitle;
    if (p.description) out.description = p.description;
    for (const [predicate, targets] of Object.entries(p.links)) {
      out[localName(predicate)] = targets.map((uri) => ({ uri }));
    }
    // Said rather than hidden: a value this adapter synthesised must never be
    // indistinguishable from one the provider served.
    out._servedBy = {
      adapter: 'rse-sysml', from: 'SysML v2 services', commit: s.commit,
      note: 'description and rdf:type are projected from the SysML model; RSE\'s OSLC AM ' +
            'surface serves neither. Disable the adapter to see the raw provider.',
    };
    if (p.unknownMetaclass) out._unknownMetaclass = p.unknownMetaclass;
    return out;
  }

  return {
    async getResource(uri: string): Promise<string> {
      const s = await load();
      const id = uri.split('/').pop() ?? '';
      const e = s.byId.get(id);
      if (!e) {
        throw new Error(
          `RSE: ${uri} is not in this configuration (commit ${s.commit}). The adapter reports ` +
          `absence rather than returning the server's UnknownElement placeholder, which arrives ` +
          `with a 200 and reads as a real element.`);
      }
      if (NOT_EXPOSED.has(e['@type'] ?? '')) {
        throw new Error(
          `RSE: ${uri} is a ${e['@type']}, which the AM surface does not expose as a resource. ` +
          `A link is a property of the element that owns it, not a resource of its own.`);
      }
      return JSON.stringify(render(e, s), null, 2);
    },

    async queryResources(): Promise<string> {
      const s = await load();
      const members = s.all
        .filter((e) => !NOT_EXPOSED.has(e['@type'] ?? ''))
        .map((e) => render(e, s));
      return JSON.stringify({ members, count: members.length, totalCount: members.length }, null, 2);
    },
  };
}

/** The HTTP shim the adapter needs, over an authenticated axios instance. */
export function httpFromAxios(ax: {
  get(url: string, config?: unknown): Promise<{ status: number; data: unknown; headers?: Record<string, string> }>;
  post(url: string, body: unknown, config?: unknown): Promise<{ status: number; data: unknown }>;
}): PostHttp & GcHttp {
  return {
    get: (url) => ax.get(url),
    post: (url, body, config) => ax.post(url, body, config),
    getWithHeaders: async (url) => {
      const r = await ax.get(url);
      return { data: r.data, linkNext: linkNext(r.headers?.link ?? r.headers?.Link) };
    },
    getRdf: async (url) => {
      const r = await ax.get(url, { headers: { Accept: GC_ACCEPT } });
      return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    },
  };
}

export { resourceUri };
