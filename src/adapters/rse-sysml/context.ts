/**
 * Turning an OSLC configuration context into the commit a SysML v2 read needs.
 *
 * OSLC callers name a configuration; the SysML v2 services read a commit. The
 * conversion is the adapter's, and it is not optional: without it a request
 * reaches RSE's default branch, where `GET /oslc_am/{p}/resource` answers 500
 * and reads as an outage rather than as a missing context.
 */

/** An RSE configuration context, decomposed. */
export type RseContext =
  | { kind: 'stream'; projectId: string; branchId: string }
  | { kind: 'baseline'; projectId: string; baselineId: string };

/**
 * Decompose an RSE configuration context URI.
 *
 * Pure, so the shape is tested without a server. Returns null for anything that
 * is not an RSE configuration — including a CDCM global configuration, which is
 * a different problem with a different answer (see `resolveGlobalConfiguration`).
 */
export function parseRseContext(uri: string | null | undefined): RseContext | null {
  if (!uri) return null;
  const m = /\/oslc_config\/([^/]+)\/(stream|baseline)\/([^/?#]+)/.exec(uri);
  if (!m) return null;
  const [, projectId, kind, id] = m;
  return kind === 'stream'
    ? { kind: 'stream', projectId, branchId: id }
    : { kind: 'baseline', projectId, baselineId: id };
}

/** The minimum this module needs of an HTTP client, so tests need no server. */
export interface Http {
  get(url: string, config?: unknown): Promise<{ status: number; data: unknown }>;
}

/**
 * The commit a context resolves to.
 *
 * A stream resolves to its branch head and therefore MOVES; a baseline is fixed.
 * Callers re-resolve at most once per tool call, never per resource: a query and
 * the resources it returns should describe one configuration rather than a
 * moving one.
 */
export async function resolveCommit(
  http: Http, baseUrl: string, ctx: RseContext
): Promise<string> {
  if (ctx.kind === 'stream') {
    const r = await http.get(`${baseUrl}/projects/${ctx.projectId}/branches/${ctx.branchId}`);
    const head = (r.data as { head?: { '@id'?: string } })?.head?.['@id'];
    if (!head) {
      throw new Error(
        `RSE: branch ${ctx.branchId} returned no head commit. Without one there is nothing to ` +
        `read against, and continuing would silently read the default branch.`
      );
    }
    return head;
  }

  // Measured 2026-10-09: this deployment's AEB-200 project exposes streams only,
  // so the baseline form is unexercised. Failing loudly beats guessing a route
  // and reading the wrong configuration — the exact failure this conversion
  // exists to prevent.
  throw new Error(
    `RSE: baseline configurations are not yet supported by the adapter ` +
    `(${ctx.baselineId}). Use a stream, or disable the adapter for this server.`
  );
}
