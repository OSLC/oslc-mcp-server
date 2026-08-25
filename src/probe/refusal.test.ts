import { describe, it, expect } from '@jest/globals';
import { errorMessage, classifyRefusal, refusalAdvice } from './refusal.js';

const wrap = (tag: string, text: string) =>
  `<rdf:RDF xmlns:oslc="http://open-services.net/ns/core#" ` +
  `xmlns:err="http://jazz.net/xmlns/prod/jazz/foundation/1.0/">` +
  `<rdf:Description><${tag}>${text}</${tag}></rdf:Description></rdf:RDF>`;

describe('errorMessage', () => {
  it('reads oslc:message, as ETM and EWM use', () => {
    expect(errorMessage(wrap('oslc:message', 'Save failed'))).toBe('Save failed');
  });

  it('reads err:detailedMessage, as DOORS Next uses', () => {
    // DNG emits no oslc:message at all; reading only the standard vocabulary
    // reports a refusal with no reason.
    expect(errorMessage(wrap('err:detailedMessage', 'CRJAZ1848E licences'))).toBe('CRJAZ1848E licences');
  });

  it('unescapes entities and collapses whitespace', () => {
    expect(errorMessage(wrap('oslc:message', 'work item &lt;03:06:02&gt;\n  needs   a value')))
      .toBe('work item <03:06:02> needs a value');
  });

  it('returns null for a body with no error vocabulary', () => {
    expect(errorMessage('<rdf:RDF/>')).toBeNull();
    expect(errorMessage('')).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
  });
});

describe('classifyRefusal', () => {
  it('identifies an unassigned licence', () => {
    const body = wrap('err:detailedMessage',
      'CRJAZ1848E To perform the "com.ibm.rrs.team.saveArtifact" operation, the user must have one of the following licenses');
    expect(classifyRefusal(body).kind).toBe('licence');
  });

  it('identifies a permission the role lacks', () => {
    const body = wrap('oslc:message',
      "CRJAZ6053E To complete the 'Delete Work Item' task, you need these permissions: Delete a work item");
    expect(classifyRefusal(body).kind).toBe('permission');
  });

  it('identifies a CSRF refusal, and does not read it as a permission problem', () => {
    // This message says outright that the roles are fine. Reading it as a
    // permission problem sends the reader to the wrong queue — and it masks
    // the real permission refusal underneath.
    const body = wrap('oslc:message',
      'The user has the roles required to perform this operation, but the permission has been denied because ' +
      "this request might have been forged by a malicious website. To prove that this request is not part of a " +
      "CSRF attack add a new HTTP header with the name 'X-Jazz-CSRF-Prevent'");
    expect(classifyRefusal(body).kind).toBe('csrf');
  });

  it('identifies a save precondition', () => {
    const body = wrap('oslc:message',
      "'Save Work Item' failed. Preconditions have not been met: The 'Filed Against' attribute needs to be set");
    expect(classifyRefusal(body).kind).toBe('precondition');
  });

  it('always carries the server’s own words, whatever the classification', () => {
    const body = wrap('oslc:message', 'CRJAZ6053E you need these permissions: Delete a work item');
    expect(classifyRefusal(body).message).toContain('Delete a work item');
  });

  it('says unclassified rather than guessing', () => {
    const r = classifyRefusal(wrap('oslc:message', 'Something else went wrong'));
    expect(r.kind).toBe('unclassified');
    expect(r.message).toBe('Something else went wrong');
  });

  it('is unclassified with no message at all', () => {
    expect(classifyRefusal('<rdf:RDF/>')).toEqual({ kind: 'unclassified', message: null });
  });
});

describe('refusalAdvice', () => {
  it('sends a licence and a permission to different places', () => {
    expect(refusalAdvice('licence')).toMatch(/licence/i);
    expect(refusalAdvice('licence')).toMatch(/read access does not imply write access/i);
    expect(refusalAdvice('permission')).toMatch(/role/i);
    expect(refusalAdvice('licence')).not.toBe(refusalAdvice('permission'));
  });

  it('offers nothing for an unclassified refusal rather than inventing advice', () => {
    expect(refusalAdvice('unclassified')).toBeNull();
  });
});
