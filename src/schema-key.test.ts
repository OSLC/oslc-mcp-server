import { describe, it, expect } from '@jest/globals';
import { schemaKey, MAX_SCHEMA_KEY, buildPredicateMap } from 'oslc-service/mcp';

/**
 * Over-long shape property names are shortened from the FRONT.
 *
 * The Anthropic API enforces /^[a-zA-Z0-9_.-]{1,64}$/ on schema property keys
 * and drops the entire tool when one key fails, which is why every EWM
 * `create_*` tool was missing from a session: measured on the live task,
 * defect and capability shapes, 23 of 119 property names exceed 64 characters,
 * the longest at 143.
 *
 * These names share long leading segments, so truncating from the back
 * collides immediately; truncating from the front does not.
 */
const REPORTED = 'com.ibm.team.build.linktype.reportedWorkItems.com.ibm.team.build.common.link.reportedAgainstBuilds';
const INCLUDED = 'com.ibm.team.build.linktype.includedDeployments.com.ibm.team.build.common.link.includedInDeployment';

describe('schemaKey', () => {
  it('leaves a short enough name alone', () => {
    expect(schemaKey('dcterms:title')).toBe('dcterms:title');
  });

  it('shortens an over-long name to exactly the limit', () => {
    expect(schemaKey(REPORTED)).toHaveLength(MAX_SCHEMA_KEY);
    expect(schemaKey(INCLUDED)).toHaveLength(MAX_SCHEMA_KEY);
  });

  it('keeps the tail, because the head is boilerplate', () => {
    expect(schemaKey(REPORTED).endsWith('reportedAgainstBuilds')).toBe(true);
    expect(schemaKey(REPORTED).startsWith('com.ibm.team.build')).toBe(false);
  });

  it('distinguishes two names that truncating from the back would collide', () => {
    // The first 64 characters of these two differ only late; the point is that
    // the front carries no information the API limit can afford.
    expect(schemaKey(REPORTED)).not.toBe(schemaKey(INCLUDED));
  });
});

describe('buildPredicateMap', () => {
  it('resolves both the real property name and the shortened key', () => {
    const shape = {
      properties: [
        {
          name: REPORTED,
          predicateURI: 'http://example.com/ns#reported',
          valueType: '',
          occurs: 'zero-or-many',
          allowedValues: [],
          readOnly: false,
        },
      ],
    } as any;
    const map = buildPredicateMap(shape);
    expect(map.get(REPORTED)).toBe('http://example.com/ns#reported');
    expect(map.get(schemaKey(REPORTED))).toBe('http://example.com/ns#reported');
  });
});
