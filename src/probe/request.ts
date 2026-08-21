import {
  encodeFormParams,
  formatTranscript,
  type HttpExchange,
} from '../http-transcript.js';

/** The axios instance `OSLCClient` exposes as `.client`, narrowed to what is used. */
export interface ProbeHttp {
  request(config: Record<string, unknown>): Promise<{
    status: number;
    headers: Record<string, string>;
    data: string;
  }>;
}

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  exchange: HttpExchange;
  transcript: string;
}

const DEFAULT_ACCEPT = 'application/rdf+xml';

function baseHeaders(accept: string): Record<string, string> {
  return { 'Accept': accept, 'OSLC-Core-Version': '2.0' };
}

/**
 * Send one request and record it.
 *
 * `validateStatus` always passes, because a 400 is an answer rather than an
 * exception — the probe's job is to report what the server did. The response
 * is kept as text: parsing here would pre-empt the measurement.
 */
async function send(
  http: ProbeHttp,
  config: Record<string, unknown>,
  exchangeFields: Pick<HttpExchange, 'method' | 'url' | 'requestHeaders' | 'requestParams' | 'requestBody'>
): Promise<ProbeResponse> {
  const response = await http.request({
    ...config,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(body: unknown) => body],
  });

  const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const exchange: HttpExchange = {
    ...exchangeFields,
    status: response.status,
    responseHeaders: response.headers ?? {},
    responseBody: body,
  };

  return {
    status: response.status,
    headers: exchange.responseHeaders,
    body,
    exchange,
    transcript: formatTranscript(exchange),
  };
}

/** A plain recorded GET — used for reading resources by URI. */
export async function probeGet(
  http: ProbeHttp,
  url: string,
  accept: string = DEFAULT_ACCEPT
): Promise<ProbeResponse> {
  const requestHeaders = baseHeaders(accept);
  return send(http, { method: 'GET', url, headers: requestHeaders }, {
    method: 'GET', url, requestHeaders,
  });
}

/**
 * An OSLC query as a form-encoded POST against the query base (§6.3).
 *
 * Query strings grow past URL length limits quickly once oslc.where and
 * oslc.select are both populated, so POST is the primary form. The query
 * base's own parameters stay in the request URI — some servers advertise
 * bases like `…/query?componentURI=…`, and those belong to the base, not to
 * the query.
 */
export async function probeQueryPost(
  http: ProbeHttp,
  queryBase: string,
  params: Array<[string, string]>,
  accept: string = DEFAULT_ACCEPT
): Promise<ProbeResponse> {
  const requestHeaders = {
    ...baseHeaders(accept),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const requestBody = encodeFormParams(params);
  return send(
    http,
    { method: 'POST', url: queryBase, headers: requestHeaders, data: requestBody },
    { method: 'POST', url: queryBase, requestHeaders, requestParams: params, requestBody }
  );
}

/**
 * The same query as a GET, for servers where POST-query is not supported.
 * A fallback, never an assumption — whether POST works is case 2.
 */
export async function probeQueryGet(
  http: ProbeHttp,
  queryBase: string,
  params: Array<[string, string]>,
  accept: string = DEFAULT_ACCEPT
): Promise<ProbeResponse> {
  const requestHeaders = baseHeaders(accept);
  const separator = queryBase.includes('?') ? '&' : '?';
  const url = `${queryBase}${separator}${encodeFormParams(params)}`;
  return send(http, { method: 'GET', url, headers: requestHeaders }, {
    method: 'GET', url, requestHeaders, requestParams: params,
  });
}
