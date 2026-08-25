/**
 * Reading a server's refusal.
 *
 * A status code is not the diagnosis. Measured against ELM 7.1 SR1 in one
 * session, **four different causes answered `403`** — a save precondition, a
 * missing CSRF token, a genuine permission denial, and an unassigned licence.
 * Only the body distinguishes them, and two applications put it under different
 * predicates.
 */

/** What a refusal turned out to mean. */
export type RefusalKind =
  | 'licence'        // an administrator must assign a licence to this account
  | 'permission'     // an administrator must grant this operation to this role
  | 'csrf'           // a CSRF token is required on this request
  | 'precondition'   // the request is missing something the server requires
  | 'unclassified';  // the server said something we have no rule for

export interface Refusal {
  kind: RefusalKind;
  /** The server's own words, trimmed. Always reported — the rules below are a convenience, not the evidence. */
  message: string | null;
}

/**
 * Error text from a refusal body.
 *
 * Two vocabularies, because ELM uses both: ETM and EWM report under
 * `oslc:message`; DOORS Next reports under `err:detailedMessage`
 * (`http://jazz.net/xmlns/prod/jazz/foundation/1.0/`) and emits no
 * `oslc:message` at all. A client reading only the standard one sees an empty
 * body and reports a refusal with no reason — which is exactly what happened
 * before the second was tried.
 */
export function errorMessage(body: unknown): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;

  for (const tag of ['oslc:message', 'err:detailedMessage', 'err:message']) {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
    if (!match) continue;
    const text = match[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * Classify a refusal from what the server said.
 *
 * The point is to send the reader to the right place. A licence and a
 * permission are both somebody's administrative queue but different queues; a
 * CSRF failure is the client's to fix; a precondition is the request's. Getting
 * this wrong costs an afternoon — `403` reads as authorization and is usually
 * not.
 *
 * Matching is on IBM's own message identifiers where they exist, because they
 * are stable across locales in a way the prose is not.
 */
export function classifyRefusal(body: unknown): Refusal {
  const message = errorMessage(body);
  if (!message) return { kind: 'unclassified', message: null };

  // CRJAZ1848E — "must have one of the following licenses that are installed on the server"
  if (/CRJAZ1848E/.test(message) || /must have one of the following licenses/i.test(message)) {
    return { kind: 'licence', message };
  }
  // CRJAZ6053E — "you need these permissions"
  if (/CRJAZ6053E/.test(message) || /you need these permissions|don't have permission to perform/i.test(message)) {
    return { kind: 'permission', message };
  }
  // The CSRF refusal names the header it wants, and says outright that the
  // roles are fine — so it must not be read as a permission problem.
  if (/X-Jazz-CSRF-Prevent/i.test(message) || /might have been forged/i.test(message)) {
    return { kind: 'csrf', message };
  }
  if (/Preconditions have not been met|needs to be set/i.test(message)) {
    return { kind: 'precondition', message };
  }
  return { kind: 'unclassified', message };
}

/** One line telling the reader what to do about it. */
export function refusalAdvice(kind: RefusalKind): string | null {
  switch (kind) {
    case 'licence':
      return 'An administrator must assign this account a licence for the application. Read access does not imply write access — the two are licensed separately, and nothing in discovery reveals the difference.';
    case 'permission':
      return 'An administrator must grant this operation to the account’s role in the project area.';
    case 'csrf':
      return 'This request needs an X-Jazz-CSRF-Prevent header carrying the current JSESSIONID. The probe sends one where it has a session; a refusal here means it could not obtain the cookie.';
    case 'precondition':
      return 'The request is missing something the server requires. The message names it; the shape usually declares it.';
    case 'unclassified':
      return null;
  }
}
