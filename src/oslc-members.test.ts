import { describe, it, expect } from '@jest/globals';
import rdflib from 'rdflib';
import { membersFromStore, totalCountFromStore } from './oslc-members.js';

const { graph, parse } = rdflib as any;

const BASE = 'https://elm.example.com/qm/views/TestCaseQuery';

function storeOf(rdfXml: string, base = BASE) {
  const store = graph();
  parse(rdfXml, store, base, 'application/rdf+xml');
  return store;
}

const NS =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" ' +
  'xmlns:ldp="http://www.w3.org/ns/ldp#" ' +
  'xmlns:oslc="http://open-services.net/ns/core#" ' +
  'xmlns:oslc_qm="http://open-services.net/ns/qm#" ' +
  'xmlns:dcterms="http://purl.org/dc/terms/"';

describe('membersFromStore', () => {
  it('reads rdfs:member, as DOORS Next and EWM use', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<rdfs:member rdf:resource="https://elm.example.com/r/1"/>` +
      `<rdfs:member rdf:resource="https://elm.example.com/r/2"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual([
      'https://elm.example.com/r/1',
      'https://elm.example.com/r/2',
    ]);
  });

  it('reads ldp:contains', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<ldp:contains rdf:resource="https://elm.example.com/r/1"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual(['https://elm.example.com/r/1']);
  });

  it('reads a domain membership predicate, as ETM uses', () => {
    // ETM links Test Case results by oslc_qm:testCase and publishes no
    // rdfs:member anywhere. Reading only the standard predicates reported
    // thirty test cases as zero.
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<oslc_qm:testCase rdf:resource="https://elm.example.com/tc/1"/>` +
      `<oslc_qm:testCase rdf:resource="https://elm.example.com/tc/2"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual([
      'https://elm.example.com/tc/1',
      'https://elm.example.com/tc/2',
    ]);
  });

  it('does not mistake the container describing itself for membership', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<oslc:serviceProvider rdf:resource="https://elm.example.com/sp/1"/>` +
      `<oslc:instanceShape rdf:resource="https://elm.example.com/shape/1"/>` +
      `<oslc_qm:testCase rdf:resource="https://elm.example.com/tc/1"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual(['https://elm.example.com/tc/1']);
  });

  it('finds members hanging off an oslc:ResponseInfo published under its own URI', () => {
    // ETM publishes ResponseInfo under a paged URI, not the query base, so
    // totalCount and the members hang off different subjects.
    const paged = `${BASE}?rqm_qm.pageNum=0`;
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${paged}">` +
      `<rdf:type rdf:resource="http://open-services.net/ns/core#ResponseInfo"/>` +
      `<oslc:totalCount>30</oslc:totalCount>` +
      `<oslc_qm:testCase rdf:resource="https://elm.example.com/tc/1"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual(['https://elm.example.com/tc/1']);
  });

  it('prefers the standard predicates when both are present', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<rdfs:member rdf:resource="https://elm.example.com/r/1"/>` +
      `<oslc_qm:testCase rdf:resource="https://elm.example.com/tc/1"/>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual(['https://elm.example.com/r/1']);
  });

  it('returns nothing for a container with no members at all', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<dcterms:title>Empty</dcterms:title>` +
      `</rdf:Description></rdf:RDF>`
    );
    expect(membersFromStore(store, BASE)).toEqual([]);
  });
});

describe('totalCountFromStore', () => {
  it("reports the server's own count", () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<oslc:totalCount>30</oslc:totalCount></rdf:Description></rdf:RDF>`
    );
    expect(totalCountFromStore(store)).toBe(30);
  });

  it('is undefined when the server published none', () => {
    const store = storeOf(
      `<rdf:RDF ${NS}><rdf:Description rdf:about="${BASE}">` +
      `<dcterms:title>No count</dcterms:title></rdf:Description></rdf:RDF>`
    );
    expect(totalCountFromStore(store)).toBeUndefined();
  });
});
