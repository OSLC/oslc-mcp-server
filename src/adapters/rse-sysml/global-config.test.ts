import { resolveGlobalConfiguration, resolveAnyContext, describeContributions } from './global-config.js';

const GC = 'https://elm.example.com/gc/cdcm/C/oslc/areas/a/components/c/configuration/g1';
const RSE = 'https://rse.example.com/api';
const RSE_STREAM = `${RSE}/oslc_config/P9/stream/B7`;

const rdf = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF
     xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:dcterms="http://purl.org/dc/terms/"
     xmlns:oslc_config="http://open-services.net/ns/config#">${body}</rdf:RDF>`;

const gcDoc = (...cons: string[]) => rdf(
  `<rdf:Description rdf:about="${GC}">${cons
    .map((c) => `<oslc_config:contribution rdf:resource="${c}"/>`).join('')}</rdf:Description>`);

const conDoc = (uri: string, title: string, cfg: string) => rdf(
  `<rdf:Description rdf:about="${uri}"><dcterms:title>${title}</dcterms:title>` +
  `<oslc_config:configuration rdf:resource="${cfg}"/></rdf:Description>`);

const http = (docs: Record<string, string>) => ({
  get: async () => ({ status: 200, data: {} }),
  getRdf: async (u: string) => docs[u] ?? rdf(''),
});

// The four contributions of a real AEB-200 global configuration: DOORS Next,
// EWM SCM, Rhapsody SE, ETM. Note ETM's URI also contains `/oslc_config/`.
const docs = {
  [GC]: gcDoc(`${GC}/contributions/1`, `${GC}/contributions/2`, `${GC}/contributions/3`, `${GC}/contributions/4`),
  [`${GC}/contributions/1`]: conDoc(`${GC}/contributions/1`, 'AEB-200 Requirements', 'https://elm.example.com/rm/cm/stream/_q1'),
  [`${GC}/contributions/2`]: conDoc(`${GC}/contributions/2`, 'Acme AEB-200 SCM stream', 'https://elm.example.com/ccm/rtcoslc/scm/config/s/_w1'),
  [`${GC}/contributions/3`]: conDoc(`${GC}/contributions/3`, 'AEB-200 Design Models', RSE_STREAM),
  [`${GC}/contributions/4`]: conDoc(`${GC}/contributions/4`, 'AEB-200 QM', 'https://elm.example.com/qm/oslc_config/resources/com.ibm.team.vvc.Configuration/_o1'),
};

describe('resolveGlobalConfiguration', () => {
  it('finds the RSE contribution among the four', async () => {
    await expect(resolveGlobalConfiguration(http(docs), GC, RSE))
      .resolves.toEqual({ kind: 'stream', projectId: 'P9', branchId: 'B7' });
  });

  // ETM's contribution URI contains /oslc_config/ too, so shape alone is not a
  // discriminator — which is why the origin is checked as well.
  it('is not fooled by ETM, whose URI also contains oslc_config', async () => {
    const without = { ...docs };
    delete without[`${GC}/contributions/3`];
    await expect(resolveGlobalConfiguration(http(without), GC, RSE)).resolves.toBeNull();
  });

  it('rejects an RSE-shaped stream on a different server', async () => {
    const other = { ...docs,
      [`${GC}/contributions/3`]: conDoc(`${GC}/contributions/3`, 'Someone else\'s models',
        'https://other-rse.example.com/api/oslc_config/P9/stream/B7') };
    await expect(resolveGlobalConfiguration(http(other), GC, RSE)).resolves.toBeNull();
  });

  // Version skew: a hierarchy can hold several RSE configurations, and which
  // one applies is decided by the depth-first order of the GCM/CDCM traversal
  // API. Until that is used, choosing would mean reading a configuration the
  // caller did not ask for and could not tell apart from the right one.
  it('refuses to choose when two RSE configurations are contributed', async () => {
    const two = { ...docs,
      [`${GC}/contributions/4`]: conDoc(`${GC}/contributions/4`, 'Other design models',
        `${RSE}/oslc_config/P9/stream/BOTHER`) };
    await expect(resolveGlobalConfiguration(http(two), GC, RSE))
      .rejects.toThrow(/contributes 2 configurations/);
  });

  it('refuses rather than returning null when the hierarchy is nested', async () => {
    const nested = {
      [GC]: gcDoc(`${GC}/contributions/1`),
      [`${GC}/contributions/1`]: conDoc(`${GC}/contributions/1`, 'A sub-configuration', `${GC}/sub`),
      [`${GC}/sub`]: rdf(`<rdf:Description rdf:about="${GC}/sub">` +
        `<oslc_config:contribution rdf:resource="${GC}/sub/contributions/1"/></rdf:Description>`),
    };
    await expect(resolveGlobalConfiguration(http(nested), GC, RSE))
      .rejects.toThrow(/not traversed yet/);
  });

  it('returns null for a global configuration with no contributions', async () => {
    await expect(resolveGlobalConfiguration(http({ [GC]: gcDoc() }), GC, RSE)).resolves.toBeNull();
  });
});

describe('resolveAnyContext', () => {
  it('uses an RSE stream directly, without touching the network', async () => {
    const h = { ...http({}), getRdf: async () => { throw new Error('should not fetch'); } };
    await expect(resolveAnyContext(h, RSE, RSE_STREAM))
      .resolves.toEqual({ kind: 'stream', projectId: 'P9', branchId: 'B7' });
  });

  it('resolves a global configuration through its contributions', async () => {
    await expect(resolveAnyContext(http(docs), RSE, GC))
      .resolves.toMatchObject({ branchId: 'B7' });
  });

  // Carrying on without a context is how RSE serves its default branch and then
  // answers a 500 that looks like an outage.
  it('refuses an absent context loudly', async () => {
    await expect(resolveAnyContext(http(docs), RSE, undefined)).rejects.toThrow(/no configuration context/);
  });

  it('refuses a configuration that contains no RSE contribution', async () => {
    await expect(resolveAnyContext(http({ [GC]: gcDoc() }), RSE, GC))
      .rejects.toThrow(/neither an RSE configuration nor a global configuration/);
  });
});

describe('describeContributions', () => {
  it('names each contribution, for saying which was chosen', async () => {
    const d = await describeContributions(http(docs), GC);
    expect(d.map((x) => x.title)).toEqual(
      ['AEB-200 Requirements', 'Acme AEB-200 SCM stream', 'AEB-200 Design Models', 'AEB-200 QM']);
  });
});
