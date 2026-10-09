/**
 * Reading a commit, and the one thing the ad-hoc query route may be used for.
 *
 * **`POST /query-results` cannot be used for configuration-scoped reads.** It
 * applies its `where`, projects its `select`, and ignores `commitId` entirely:
 * every branch answers the same number, omitting the parameter answers the same
 * number, and a commit that does not exist is not rejected. It returns the union
 * across the project's history, and nothing in the response says so — the rows
 * are real, correctly typed and correctly filtered, and only the configuration
 * is wrong. See quirk 37c.
 *
 * So reads go through `GET /projects/{p}/commits/{c}/elements`, which IS
 * commit-scoped and which pages honestly, with a `Link ... rel="next"` cursor.
 */
import type { Http } from './context.js';

/**
 * The page size sent on every query.
 *
 * **1000 is the server's maximum**, not a preference: `page[size]=1001` is
 * refused with *"must be less than 1001"*. That refusal is the one good thing
 * about this parameter — it validates the value it recognises, while silently
 * ignoring the names it does not. See `runQuery`.
 */
export const PAGE_SIZE = 1000;

export interface QuerySpec {
  /** The single property to constrain. `where` takes ONE PrimitiveConstraint:
   *  `CompositeConstraint` is rejected, so an `and` is two queries intersected
   *  by the caller. */
  property: string;
  value: string;
  /** Properties to project. An empty select returns `[{}]` — objects with no
   *  fields — rather than whole elements, so it is never useful. */
  select: string[];
}

export interface PostHttp extends Http {
  post(url: string, body: unknown, config?: unknown): Promise<{ status: number; data: unknown }>;
  /** Paging the elements route needs the response headers, not only the body. */
  getWithHeaders?(url: string): Promise<{ data: unknown; linkNext?: string }>;
}

/**
 * Every element of one commit, following the cursor to exhaustion.
 *
 * This is the adapter's only configuration-scoped read. The route answers with
 * `Link: <...page[after]=...>; rel="next"` while more remain, so completeness is
 * something the server states rather than something the client infers — the
 * opposite of `runQuery` below.
 */
export async function fetchCommitElements(
  http: PostHttp, baseUrl: string, projectId: string, commitId: string
): Promise<Record<string, unknown>[]> {
  const get = http.getWithHeaders;
  if (!get) throw new Error('RSE adapter: the HTTP client cannot read response headers, so paging ' +
                            'the elements route would silently stop at the first page.');
  let url: string | undefined =
    `${baseUrl}/projects/${projectId}/commits/${commitId}/elements?page%5Bsize%5D=${PAGE_SIZE}`;
  const out: Record<string, unknown>[] = [];
  // A cursor cannot loop by construction, but a server that repeats one would
  // hang the tool rather than fail it, which is worse.
  for (let page = 0; url && page < 1000; page++) {
    const r: { data: unknown; linkNext?: string } = await get(url);
    if (!Array.isArray(r.data)) {
      throw new Error(`RSE: commit ${commitId} elements page ${page} was not a list: ` +
                      `${JSON.stringify(r.data).slice(0, 200)}`);
    }
    out.push(...(r.data as Record<string, unknown>[]));
    url = r.linkNext;
  }
  return out;
}

/** The `rel="next"` target of a `Link` header, if there is one. */
export function linkNext(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  return /<([^>]+)>;\s*rel="next"/.exec(header)?.[1];
}

/**
 * Run one ad-hoc query and return its rows.
 *
 * **Only for things that are not configuration-scoped**, which in practice means
 * `OSLCLinkType`: the seven link types are project-level, so the route's
 * configuration-blindness (quirk 37c) costs nothing. Using it for anything about
 * the product would return the union across every branch, silently.
 *
 * **Paging is the trap this function exists for** (quirk 37b). Measured against a
 * branch holding 44 `OSLCLink` elements:
 *
 *     no paging parameter   25        page[size]=1000   44
 *     pageSize=1000          3        limit=1000         3
 *
 * There is no `Link` header, no total, and nothing else to distinguish a
 * truncated answer from a complete one — and an unrecognised parameter name does
 * not fall back to the default, it answers a third wrong number. So the size is
 * always sent, spelled exactly `page[size]`, and a full page is treated as
 * truncation and RAISED rather than returned. An assistant reasoning from
 * absence cannot tell a short answer from a complete one; returning one quietly
 * is how a confident wrong answer gets made.
 */
export async function runQuery(
  http: PostHttp, baseUrl: string, projectId: string, commitId: string, spec: QuerySpec
): Promise<Record<string, unknown>[]> {
  const url =
    `${baseUrl}/projects/${projectId}/query-results` +
    `?commitId=${encodeURIComponent(commitId)}&page%5Bsize%5D=${PAGE_SIZE}`;

  const body = {
    '@type': 'Query',
    select: spec.select,
    where: {
      '@type': 'PrimitiveConstraint',
      inverse: false,
      operator: '=',
      property: spec.property,
      value: spec.value,
    },
  };

  const r = await http.post(url, body, { headers: { 'Content-Type': 'application/json' } });
  const rows = r.data;
  if (!Array.isArray(rows)) {
    throw new Error(
      `RSE query for ${spec.property}=${spec.value} returned ${typeof rows}, not a list: ` +
      `${JSON.stringify(rows).slice(0, 200)}`
    );
  }
  if (rows.length >= PAGE_SIZE) {
    throw new Error(
      `RSE query for ${spec.property}=${spec.value} filled a page of ${PAGE_SIZE}, so the result ` +
      `is probably truncated — and nothing in the response says so. Refusing to return a possibly ` +
      `partial set, because an absence in it would be indistinguishable from a fact.`
    );
  }
  return rows as Record<string, unknown>[];
}
