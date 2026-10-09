/**
 * Reading an answer from the payload rather than from the status code.
 *
 * The SysML v2 services are an API carried over HTTP rather than an HTTP API,
 * and the status code is not where the outcome lives. Measured against RSE:
 *
 *   element exists                    200  the element
 *   element id that is not a UUID     200  { "@type": "UnknownElement" }
 *   well-formed id, no such element   200  { "@type": "UnknownElement" }
 *   COMMIT THAT DOES NOT EXIST        200  []            <- the dangerous one
 *   project not found                 404  { "@type": "Error", success: false }
 *   branch not found                  404  { "@type": "Error", success: false }
 *   page[size] above the maximum      500  { "@type": "Error", success: false }
 *   no credential                     401  (no JSON at all)
 *
 * Every genuinely misleading case is a 200. A client that branches on
 * `response.ok` concludes that a garbage element id is a real element, and that
 * a mistyped commit contains **nothing** — which is a plausible answer, and
 * therefore the worst kind of wrong.
 */

export type Outcome<T> =
  | { kind: 'ok'; value: T }
  /** The server answered, and says this element is not in this configuration. */
  | { kind: 'absent' }
  | { kind: 'error'; message: string; status: number };

interface Errorish { '@type'?: string; success?: boolean; description?: string }

/**
 * Classify one response. **The status is used for the message, never for the
 * decision** — except that a body which is not JSON can only be a transport or
 * authentication failure, since every API-level answer is JSON.
 */
export function classify<T = unknown>(
  status: number, body: unknown, what: string
): Outcome<T> {
  if (body === undefined || body === null || typeof body === 'string') {
    return {
      kind: 'error', status,
      message: `${what}: HTTP ${status} with no JSON body — a transport or credential failure ` +
               `rather than an API answer.`,
    };
  }

  if (!Array.isArray(body) && typeof body === 'object') {
    const b = body as Errorish;
    if (b['@type'] === 'Error' || b.success === false) {
      return {
        kind: 'error', status,
        message: `${what}: ${b.description ?? 'the server reported an error'} (HTTP ${status})`,
      };
    }
    // Absence, and it arrives as a 200. It also arrives for an id that is not a
    // UUID and for a commit that does not exist, so "absent" here means only
    // "the server will not show it", not "it was never there".
    if (b['@type'] === 'UnknownElement') return { kind: 'absent' };
  }

  return { kind: 'ok', value: body as T };
}

/** `classify`, throwing — for the paths where there is nothing useful to do with a failure. */
export function expectOk<T>(status: number, body: unknown, what: string): T {
  const o = classify<T>(status, body, what);
  if (o.kind === 'ok') return o.value;
  if (o.kind === 'absent') throw new Error(`${what}: the server reports it as absent.`);
  throw new Error(o.message);
}
