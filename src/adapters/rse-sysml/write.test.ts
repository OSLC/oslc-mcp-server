import { buildCreateCommit, buildUpdateCommit, buildWireCommit, postCommit, verifyOnAmSurface } from './write.js';

describe('buildCreateCommit', () => {
  it('carries no identity, because the server assigns the id', () => {
    const c = buildCreateCommit('x', [{ type: 'PartUsage', props: { declaredShortName: 'U' } }]);
    expect(c.change[0].identity).toBeUndefined();
    expect(c.change[0].payload).toEqual({ '@type': 'PartUsage', declaredShortName: 'U' });
  });

  it('batches the whole subgraph into one commit', () => {
    expect(buildCreateCommit('x', [
      { type: 'PartUsage' }, { type: 'Documentation', props: { body: 'b' } }, { type: 'OwningMembership' },
    ]).change).toHaveLength(3);
  });

});

describe('buildUpdateCommit', () => {
  // The rule that cost beat 3: a payload echoing a GET fails the whole commit,
  // because derived properties are rejected rather than ignored.
  it('sends only @type, @id and what is being set', () => {
    const c = buildUpdateCommit('x', [{ id: 'e1', type: 'PartUsage', set: { ownedRelationship: [] } }]);
    expect(Object.keys(c.change[0].payload).sort()).toEqual(['@id', '@type', 'ownedRelationship']);
  });

  // Not redundant: on an update the id is taken from payload.@id.
  it('repeats the id inside the payload as well as in identity', () => {
    const c = buildUpdateCommit('x', [{ id: 'e1', type: 'PartUsage', set: {} }]);
    expect(c.change[0].identity).toEqual({ '@id': 'e1' });
    expect(c.change[0].payload['@id']).toBe('e1');
  });
});

describe('buildWireCommit', () => {
  const w = {
    owner: 'cmp', ownerType: 'PartDefinition', ownerRelationships: ['old1', 'mem'],
    membership: 'mem', membershipType: 'FeatureMembership' as const,
    owned: 'unit', ownedType: 'PartUsage', ownedRelationships: ['docmem', 'typing'],
  };

  it('sets all three directions', () => {
    const byId = Object.fromEntries(buildWireCommit('x', w).change.map((c) => [c.identity!['@id'], c.payload]));
    // 1 and 2: the membership's two ends
    expect(byId.mem).toMatchObject({ owningRelatedElement: { '@id': 'cmp' }, ownedRelatedElement: [{ '@id': 'unit' }] });
    // 3: the element's pointer back up — the one the published recipe omitted
    expect(byId.unit).toMatchObject({ owningRelationship: { '@id': 'mem' } });
    // and the owner's forward list, which the UI is the thing that trusts
    expect(byId.cmp).toMatchObject({ ownedRelationship: [{ '@id': 'old1' }, { '@id': 'mem' }] });
  });

  // ownedRelationship is SET, not appended, so a caller that passes only the new
  // id silently orphans everything the owner already had.
  it('takes the owner\'s whole relationship list, not just the addition', () => {
    const c = buildWireCommit('x', w).change.find((x) => x.identity!['@id'] === 'cmp')!;
    expect(c.payload.ownedRelationship).toHaveLength(2);
  });

  it('leaves the owned element\'s own relationships untouched when not given', () => {
    const c = buildWireCommit('x', { ...w, ownedRelationships: undefined }).change
      .find((x) => x.identity!['@id'] === 'unit')!;
    expect(c.payload).not.toHaveProperty('ownedRelationship');
  });
});

describe('postCommit', () => {
  const http = (status: number, data: unknown) => ({
    get: async () => ({ status: 200, data: {} }),
    post: async () => ({ status, data }),
  });
  const body = buildCreateCommit('d', [{ type: 'PartUsage' }]);

  it('returns the commit id', async () => {
    await expect(postCommit(http(201, { '@id': 'c1', '@type': 'Commit' }), 'https://h/api', 'P', 'B', body))
      .resolves.toBe('c1');
  });

  it('raises the server description rather than the status', async () => {
    await expect(postCommit(http(500, { '@type': 'Error', description: 'invalid value' }), 'https://h/api', 'P', 'B', body))
      .rejects.toThrow(/invalid value/);
  });

  // A 2xx that did not produce a Commit is the symmetric risk to beat 3's 500:
  // a write that reports success and changed less than it claimed.
  it('raises when a 2xx did not come back as a Commit', async () => {
    await expect(postCommit(http(200, { ok: true }), 'https://h/api', 'P', 'B', body))
      .rejects.toThrow(/did not come back as a Commit/);
  });
});

describe('verifyOnAmSurface', () => {
  it('accepts a check that only succeeds on a later look', async () => {
    let n = 0;
    await expect(verifyOnAmSurface(async () => ++n >= 3, 5, 1)).resolves.toBe(true);
    expect(n).toBe(3);
  });

  it('gives up eventually rather than retrying forever', async () => {
    await expect(verifyOnAmSurface(async () => false, 3, 1)).resolves.toBe(false);
  });
});
