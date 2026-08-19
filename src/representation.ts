// rdflib is CommonJS — take the default and destructure, or Jest's ESM
// linker cannot load this module.
import rdflib from 'rdflib';
import { formatTranscript, headerValue, type HttpExchange } from './http-transcript.js';

const { graph, parse } = rdflib as any;

/**
 * What the server did when asked for Turtle (design §7).
 *
 * `error` and `other-representation` are both legitimate: a server asked for
 * a representation it does not have may refuse outright, or may disregard
 * Accept and send what it does have — HTTP leaves that choice to the server.
 * They are kept apart because *how* a server declines is what a client has to
 * cope with, and the two need quite different client code.
 */
export type TurtleVerdict =
  | { kind: 'supported' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'other-representation'; contentType: string }
  | { kind: 'malformed'; parseError: string };

export interface TurtleCheckResult {
  url: string;
  verdict: TurtleVerdict;
  /** The full exchange, per D5 — evidence is never behind a flag. */
  transcript: string;
}

/** The axios instance `OSLCClient` exposes as `.client`, narrowed to what is used. */
export interface HttpGetter {
  get(url: string, config: Record<string, unknown>): Promise<{
    status: number;
    headers: Record<string, string>;
    data: string;
  }>;
}

const ACCEPT_TURTLE = 'text/turtle';

/**
 * Ask one URL for Turtle and record what came back.
 *
 * Accept names Turtle alone — no quality-weighted alternatives — so that a
 * response in another format is an unambiguous observation rather than the
 * server picking a lower-ranked option we also offered.
 */
export async function checkTurtleSupport(
  http: HttpGetter,
  url: string
): Promise<TurtleCheckResult> {
  const requestHeaders = { 'Accept': ACCEPT_TURTLE, 'OSLC-Core-Version': '2.0' };

  const response = await http.get(url, {
    headers: requestHeaders,
    // Report the status rather than throwing on it: a 406 is an answer.
    validateStatus: () => true,
    // Keep the body as text; a parse here would pre-empt the measurement.
    responseType: 'text',
    transformResponse: [(body: unknown) => body],
  });

  const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const exchange: HttpExchange = {
    method: 'GET',
    url,
    requestHeaders,
    status: response.status,
    responseHeaders: response.headers ?? {},
    responseBody: body,
  };

  return {
    url,
    verdict: classify(response.status, exchange.responseHeaders, body),
    transcript: formatTranscript(exchange),
  };
}

function classify(
  status: number,
  responseHeaders: Record<string, string>,
  body: string
): TurtleVerdict {
  if (status >= 400) {
    return { kind: 'error', status, message: body.trim().slice(0, 500) };
  }

  const contentType = headerValue(responseHeaders, 'content-type') ?? '';
  // Strip parameters — 'text/turtle; charset=utf-8' is still Turtle.
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'text/turtle') {
    return { kind: 'other-representation', contentType: contentType || '(none)' };
  }

  try {
    parse(body, graph(), 'http://example.org/base', 'text/turtle');
    return { kind: 'supported' };
  } catch (err) {
    // Claims Turtle, is not Turtle. A distinct fact from not producing it.
    return { kind: 'malformed', parseError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Render the result.
 *
 * The wording is load-bearing. Since disregarding Accept is permitted, the
 * probe can only report that the server *did not produce* Turtle when asked;
 * it cannot distinguish a server that cannot from one that chose not to. No
 * verdict here is labelled a defect — that is a person's judgement (D8).
 */
export function formatTurtleCheck(result: TurtleCheckResult): string {
  const lines = [`## Turtle support — ${result.url}`, ''];

  switch (result.verdict.kind) {
    case 'supported':
      lines.push('Turtle was requested and returned, and it parses.');
      break;
    case 'error':
      lines.push(
        `The server did not produce Turtle when asked. It responded ${result.verdict.status}.`,
        '',
        `Server message: ${result.verdict.message || '(empty)'}`
      );
      break;
    case 'other-representation':
      lines.push(
        'The server did not produce Turtle when asked. It returned ' +
        `${result.verdict.contentType} instead.`
      );
      break;
    case 'malformed':
      lines.push(
        'The server returned a body typed text/turtle that a conformant parser rejects.',
        '',
        `Parse error: ${result.verdict.parseError}`
      );
      break;
  }

  lines.push(
    '',
    'A server may disregard the Accept header and return whatever representation it ' +
    'chooses, so this records only what the server did on this request. It is not a ' +
    'statement about what the server is able to produce.',
    '',
    '### Evidence',
    '',
    '```',
    result.transcript,
    '```'
  );

  return lines.join('\n');
}
