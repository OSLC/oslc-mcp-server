/**
 * Recording of HTTP exchanges as probe evidence (design §6.1), and the
 * parameter encoding rule that keeps the record faithful (§6.2).
 *
 * A result without the request that produced it is unfalsifiable (D5), so
 * every probe request is recorded — never behind a debug flag.
 */

/**
 * Header names whose values must never reach a transcript. Transcripts are
 * written to files and pasted into issues, so a session cookie in one is a
 * leaked credential. Matched case-insensitively: HTTP header names are not
 * case sensitive and servers vary in what they echo.
 */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-jazz-csrf-prevent',
]);

export const REDACTED = '<redacted>';

/** One HTTP request and its response, as recorded for the report. */
export interface HttpExchange {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  /** Decoded form parameters in the order sent. Absent for a GET. */
  requestParams?: Array<[string, string]>;
  /** The encoded body actually put on the wire. Absent for a GET. */
  requestBody?: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

/** Replace credential-bearing header values, keeping the names visible. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Encode form parameters for an OSLC query body.
 *
 * Every name and value goes through encodeURIComponent, without exception.
 * RDF namespace URIs end in '#' more often than not, and an unescaped '#' in
 * a request URI is a fragment identifier — never transmitted — which
 * truncates that parameter and every parameter after it, invisibly.
 */
export function encodeFormParams(params: Array<[string, string]>): string {
  return params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** Case-insensitive header lookup — servers differ in the casing they return. */
export function headerValue(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Render an exchange in copy-pasteable form.
 *
 * Decoded parameters come first, because that is what goes into an HTTP
 * client's parameter fields when someone reproduces the request by hand;
 * the encoded body follows, because that is what went on the wire and the
 * difference between them is occasionally the bug.
 *
 * Decoded parameters are printed one per line with name and value separated
 * by whitespace rather than joined by '=' and '&'. That is deliberate: the
 * block cannot be pasted into a URL bar as a unit, so the '#' trap becomes
 * awkward to fall into rather than merely warned about.
 */
export function formatTranscript(exchange: HttpExchange): string {
  const lines: string[] = [`${exchange.method} ${exchange.url}`];

  for (const [name, value] of Object.entries(redactHeaders(exchange.requestHeaders))) {
    lines.push(`  ${name}: ${value}`);
  }

  if (exchange.requestParams?.length) {
    const width = Math.max(...exchange.requestParams.map(([name]) => name.length));
    lines.push('');
    lines.push("  body (decoded) — paste into parameter FIELDS, not a URL bar: '#' truncates");
    for (const [name, value] of exchange.requestParams) {
      lines.push(`    ${name.padEnd(width)}  ${value}`);
    }
  }

  if (exchange.requestBody) {
    lines.push('');
    lines.push('  body (encoded) — what actually went on the wire');
    lines.push(`    ${exchange.requestBody}`);
  }

  const contentType = headerValue(exchange.responseHeaders, 'content-type') ?? '';
  const bytes = Buffer.byteLength(exchange.responseBody, 'utf8');
  lines.push('');
  lines.push(`→ ${exchange.status}  ${contentType}  (${bytes} bytes)`);
  if (exchange.responseBody) {
    lines.push(exchange.responseBody.split('\n').map((line) => `  ${line}`).join('\n'));
  }

  return lines.join('\n');
}
