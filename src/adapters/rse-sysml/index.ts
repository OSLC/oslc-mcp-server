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
import { buildCreateCommit, buildUpdateCommit, postCommit } from './write.js';
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
  updateResource(uri: string, properties: Record<string, unknown>): Promise<string>;
  createResource(properties: Record<string, unknown>): Promise<string>;
}

/** Property names the adapter understands, besides a link predicate. */
const TITLE = new Set(['title', 'dcterms:title', 'http://purl.org/dc/terms/title']);
const SHORT = new Set(['shortTitle', 'oslc:shortTitle', 'http://open-services.net/ns/core#shortTitle']);
const DESC = new Set(['description', 'dcterms:description', 'http://purl.org/dc/terms/description']);
const PARENT = new Set(['parent', 'owningRelatedElement', 'oslc:parent']);

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
    const typeUriById = new Map(lts.map((l) => [String(l['@id']), String(l.linkTypeURI)]));
    const { links } = indexLinks(all.filter((e) => e['@type'] === 'OSLCLink'), typeUriById, byId);
    return {
      all, byId, commit, ctx,
      amBase: `${deps.baseUrl}/oslc_am/${ctx.projectId}`,
      descriptions: indexDescriptions(all.filter((e) => e['@type'] === 'Documentation'), byId),
      links,
      typeUriById,
      /** `trace` -> `http://jazz.net/ns/dm/linktypes#trace`, for naming a predicate. */
      linkTypeByName: new Map([...typeUriById.values()].map((u) => [u.split(/[#/]/).pop()!, u])),
      /** the inverse, for creating one: predicate -> the OSLCLinkType element. */
      linkTypeIdByUri: new Map([...typeUriById].map(([id, u]) => [u, id])),
    };
  }

  type State = Awaited<ReturnType<typeof load>>;
  const ctxOf = (s: State) => s.ctx;

  /**
   * The branch to commit to.
   *
   * A write needs a stream. A baseline is immutable by definition, and the
   * useful thing to say about writing to one is that it cannot be done — not
   * to fail later with whatever the server makes of a missing branch id.
   */
  function branchFor(s: State): { projectId: string; branchId: string } {
    if (s.ctx.kind !== 'stream') {
      throw new Error(
        `RSE: the configuration context is a baseline (${s.ctx.baselineId}), which is immutable. ` +
        `Set a stream before writing.`);
    }
    return { projectId: s.ctx.projectId, branchId: s.ctx.branchId };
  }
  const ownedIds = (s: State, id: string) =>
    (s.byId.get(id)?.ownedRelationship ?? []).map((r) => ({ '@id': r['@id'] }));

  /** Set an element's documentation: amend the body if it has one, else create it. */
  async function setDocumentation(s: State, el: SysmlElement, body: string): Promise<string[]> {
    const { projectId, branchId } = branchFor(s);
    const existing = s.all.find((e) => e['@type'] === 'Documentation' && ownerOfIn(s, e) === el['@id']);
    if (existing) {
      return [await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildUpdateCommit(
        `documentation of ${el.declaredShortName ?? el['@id']}`,
        [{ id: existing['@id'], type: 'Documentation', set: { body } }]))];
    }
    const c1 = await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildCreateCommit(
      `documentation for ${el.declaredShortName ?? el['@id']}`,
      [{ type: 'Documentation', props: { body } }, { type: 'OwningMembership', props: { visibility: 'public' } }]));
    const after = await fetchCommitElements(deps.http, deps.baseUrl, projectId, c1) as unknown as SysmlElement[];
    const added = after.filter((e) => !s.byId.has(e['@id']));
    const doc = added.find((e) => e['@type'] === 'Documentation')!;
    const mem = added.find((e) => e['@type'] === 'OwningMembership')!;
    const c2 = await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildUpdateCommit(
      `wire documentation of ${el.declaredShortName ?? el['@id']}`, [
        { id: mem['@id'], type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': el['@id'] }, ownedRelatedElement: [{ '@id': doc['@id'] }] } },
        { id: doc['@id'], type: 'Documentation', set: { owningRelationship: { '@id': mem['@id'] } } },
        { id: el['@id'], type: el['@type']!, set: { ownedRelationship: [...ownedIds(s, el['@id']), { '@id': mem['@id'] }] } },
      ]));
    return [c1, c2];
  }

  /** The owner of a relationship-owned element, within this state. */
  function ownerOfIn(s: State, e: SysmlElement): string | undefined {
    const ref = (e.owningRelationship as { '@id'?: string } | null | undefined)?.['@id'];
    if (!ref) return undefined;
    const owner = s.byId.get(ref)?.owningRelatedElement?.['@id'];
    if (!owner) return undefined;
    return (s.byId.get(owner)?.ownedRelationship ?? []).some((r) => r['@id'] === ref) ? owner : undefined;
  }

  /**
   * Make an element's links under one predicate exactly the given set.
   *
   * Additions are the two-commit create. **Removals DETACH rather than
   * delete** — the membership comes out of the owner's forward list, which is
   * what the AM surface honours, and the `OSLCLink` element is left where it
   * is. Deleting it is the trap: an element that has been through a few commits
   * stops being deletable at all, and a half-deleted one strands a reference
   * that takes the whole AM query base down with it (quirks 37, 38).
   */
  async function setLinks(s: State, el: SysmlElement, predicate: string, want: string[]): Promise<string[]> {
    const { projectId, branchId } = branchFor(s);
    const have = (s.links.get(el['@id']) ?? []).filter((l) => l.predicate === predicate);
    const add = want.filter((t) => !have.some((l) => l.target === t));
    const drop = have.filter((l) => !want.includes(l.target));
    const commits: string[] = [];

    if (drop.length) {
      const dropMems = new Set(s.all
        .filter((e) => e['@type'] === 'OSLCLink' && ownerOfIn(s, e) === el['@id'] && drop.some((d) => d.target === e.linkURL))
        .map((e) => (e.owningRelationship as { '@id'?: string })?.['@id'])
        .filter((x): x is string => !!x));
      commits.push(await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildUpdateCommit(
        `detach ${drop.length} ${predicate.split(/[#/]/).pop()} link(s)`,
        [{ id: el['@id'], type: el['@type']!, set: { ownedRelationship: ownedIds(s, el['@id']).filter((r) => !dropMems.has(r['@id'])) } }])));
    }

    // The id set is re-snapshotted BEFORE EACH create, not taken once from the
    // state at entry. Diffing against the entry state made the second link in a
    // batch adopt the FIRST link's membership — both ended up owned by one
    // membership, and detaching either then removed both. Measured.
    let known = new Set(s.all.map((e) => e['@id']));

    for (const target of add) {
      const linkTypeId = s.linkTypeIdByUri.get(predicate);
      if (!linkTypeId) throw new Error(`RSE: no OSLCLinkType for ${predicate} in this project.`);
      const c1 = await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildCreateCommit(
        `link ${el.declaredShortName ?? el['@id']} -> ${target}`,
        [{ type: 'OSLCLink', props: { linkType: { '@id': linkTypeId }, linkURL: target } },
         { type: 'OwningMembership', props: { visibility: 'public' } }]));
      const after = await fetchCommitElements(deps.http, deps.baseUrl, projectId, c1) as unknown as SysmlElement[];
      const added = after.filter((e) => !known.has(e['@id']));
      const link = added.find((e) => e['@type'] === 'OSLCLink' && e.linkURL === target)!;
      const mem = added.find((e) => e['@type'] === 'OwningMembership')!;
      if (!link || !mem) throw new Error(`RSE: could not identify the link just created for ${target}.`);
      known = new Set(after.map((e) => e['@id']));
      const current = (after.find((e) => e['@id'] === el['@id'])?.ownedRelationship ?? []).map((r) => ({ '@id': r['@id'] }));
      commits.push(c1, await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildUpdateCommit(
        `wire link to ${target}`, [
          { id: mem['@id'], type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': el['@id'] }, ownedRelatedElement: [{ '@id': link['@id'] }] } },
          { id: link['@id'], type: 'OSLCLink', set: { owningRelationship: { '@id': mem['@id'] } } },
          { id: el['@id'], type: el['@type']!, set: { ownedRelationship: [...current, { '@id': mem['@id'] }] } },
        ])));
    }
    return commits;
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

  /** Every target of one property, as URI strings. */
  function targets(v: unknown): string[] {
    const one = (x: unknown) =>
      typeof x === 'string' ? x : (x as { uri?: string; '@id'?: string })?.uri ?? (x as { '@id'?: string })?.['@id'];
    return (Array.isArray(v) ? v : [v]).map(one).filter((x): x is string => !!x);
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

    /**
     * Set properties on one element.
     *
     * OSLC `update_resource` semantics: a property given replaces its existing
     * values, one omitted is untouched. Three kinds are handled — the declared
     * names, the documentation body, and link predicates — and anything else is
     * REFUSED rather than silently dropped, because a write that reports
     * success and changed nothing is the failure this estate specialises in.
     */
    async updateResource(uri: string, properties: Record<string, unknown>): Promise<string> {
      const s = await load();
      const id = uri.split('/').pop() ?? '';
      const el = s.byId.get(id);
      if (!el) throw new Error(`RSE: ${uri} is not in this configuration (commit ${s.commit}).`);

      const set: Record<string, unknown> = {};
      const linkProps: [string, string[]][] = [];
      let docBody: string | undefined;
      const unknown: string[] = [];

      for (const [k, v] of Object.entries(properties)) {
        const name = k.split(/[#/]/).pop() ?? k;
        if (TITLE.has(k) || name === 'title') set.declaredName = String(v);
        else if (SHORT.has(k) || name === 'shortTitle') set.declaredShortName = String(v);
        else if (DESC.has(k) || name === 'description') docBody = String(v);
        else if (s.linkTypeByName.has(name)) linkProps.push([s.linkTypeByName.get(name)!, targets(v)]);
        else unknown.push(k);
      }
      if (unknown.length) {
        throw new Error(
          `RSE: no mapping for ${unknown.join(', ')}. Known: dcterms:title, oslc:shortTitle, ` +
          `dcterms:description, and the link types ${[...s.linkTypeByName.keys()].join(', ')}.`);
      }

      const commits: string[] = [];
      if (Object.keys(set).length) {
        commits.push(await postCommit(deps.http, deps.baseUrl, branchFor(s).projectId, branchFor(s).branchId,
          buildUpdateCommit(`set ${Object.keys(set).join(', ')} on ${el.declaredShortName ?? id}`,
            [{ id, type: el['@type']!, set }])));
      }
      if (docBody !== undefined) commits.push(...await setDocumentation(s, el, docBody));
      for (const [predicate, want] of linkProps) commits.push(...await setLinks(s, el, predicate, want));

      return JSON.stringify({
        uri, commits,
        message: commits.length
          ? `${commits.length} commit(s). Re-read to confirm: the OSLC AM projection of a link ` +
            `lags by up to two minutes, so an immediate look there can be a false negative.`
          : 'nothing to change',
      }, null, 2);
    },

    /**
     * Create an element.
     *
     * **A parent is required**, which RSE's own AM factory does not demand —
     * and that is deliberate. An element created with no containment is real
     * over SysML, invisible to commit-scoped reads until something touches it
     * (quirk 29), and absent from the UI. Refusing is better than producing one.
     */
    async createResource(properties: Record<string, unknown>): Promise<string> {
      const s = await load();
      const parentKey = Object.keys(properties).find((k) => PARENT.has(k) || PARENT.has(k.split(/[#/]/).pop() ?? ''));
      const parentUri = parentKey ? targets(properties[parentKey])[0] : undefined;
      const parentId = parentUri?.split('/').pop();
      const parent = parentId ? s.byId.get(parentId) : undefined;
      if (!parent) {
        throw new Error(
          'RSE: creating an element needs a `parent` — the element or package that will own it. ' +
          'Without containment the result is real over SysML, invisible to commit-scoped reads ' +
          'until something touches it, and absent from the Rhapsody UI.');
      }
      const type = String(properties['@type'] ?? properties.type ?? 'PartUsage');
      const title = properties.title ?? properties['dcterms:title'];
      const short = properties.shortTitle ?? properties['oslc:shortTitle'];
      const body = properties.description ?? properties['dcterms:description'];
      const { projectId, branchId } = branchFor(s);

      const c1 = await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildCreateCommit(
        `create ${short ?? title ?? type}`,
        [{ type, props: { ...(title ? { declaredName: String(title) } : {}), ...(short ? { declaredShortName: String(short) } : {}) } },
         { type: 'OwningMembership', props: { visibility: 'public' } },
         ...(body ? [{ type: 'Documentation', props: { body: String(body) } }, { type: 'OwningMembership', props: { visibility: 'public' } }] : [])]));

      const after = await fetchCommitElements(deps.http, deps.baseUrl, projectId, c1) as unknown as SysmlElement[];
      const added = after.filter((e) => !s.byId.has(e['@id']));
      const el = added.find((e) => e['@type'] === type)!;
      const mems = added.filter((e) => e['@type'] === 'OwningMembership');
      const doc = added.find((e) => e['@type'] === 'Documentation');
      const own = (id: string) => (after.find((e) => e['@id'] === id)?.ownedRelationship ?? []).map((r) => ({ '@id': r['@id'] }));

      const c2 = await postCommit(deps.http, deps.baseUrl, projectId, branchId, buildUpdateCommit(
        `wire ${short ?? type}`, [
          { id: mems[0]['@id'], type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': parent['@id'] }, ownedRelatedElement: [{ '@id': el['@id'] }] } },
          { id: el['@id'], type, set: { owningRelationship: { '@id': mems[0]['@id'] }, ...(doc ? { ownedRelationship: [{ '@id': mems[1]['@id'] }] } : {}) } },
          { id: parent['@id'], type: parent['@type']!, set: { ownedRelationship: [...own(parent['@id']), { '@id': mems[0]['@id'] }] } },
          ...(doc ? [
            { id: mems[1]['@id'], type: 'OwningMembership', set: { visibility: 'public', owningRelatedElement: { '@id': el['@id'] }, ownedRelatedElement: [{ '@id': doc['@id'] }] } },
            { id: doc['@id'], type: 'Documentation', set: { owningRelationship: { '@id': mems[1]['@id'] } } },
          ] : []),
        ]));

      return JSON.stringify({ uri: resourceUri(s.amBase, el['@id']), identifier: el['@id'], commits: [c1, c2] }, null, 2);
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
