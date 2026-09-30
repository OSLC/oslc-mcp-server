import { describe, it, expect } from '@jest/globals';
import { GENERIC_TOOLS } from './server.js';

/**
 * The query constraint argument is `where`, and an unknown argument is refused.
 *
 * Both halves of this guard a failure that produced a wrong answer with a 200.
 *
 * The argument was once called `filter`, which no OSLC server calls it -- the
 * protocol parameter is `oslc.where` -- and which inverts the meaning: a filter
 * removes matches, `oslc.where` selects them. The genOSLC servers always called
 * it `where`, so a caller moving between the two families named it wrongly and
 * the server, having no `additionalProperties: false`, accepted the call and
 * ignored the argument. The result was the entire unfiltered collection, a 200,
 * and nothing to distinguish it from a constraint that matched everything. It
 * was reported as a server defect before being traced to the argument name.
 *
 * So: the name is asserted, and the refusal of unknown names is asserted with
 * it. The name alone is not enough -- renaming without the schema constraint
 * just moves which spelling fails silently.
 */
const queryTool = () => {
  const tool = GENERIC_TOOLS.find((t) => t.name === 'query_resources');
  if (!tool) throw new Error('query_resources is not among the generic tools');
  return tool;
};

describe('query_resources input schema', () => {
  it('names the constraint `where`, matching oslc.where', () => {
    const properties = (queryTool().inputSchema as any).properties;
    expect(Object.keys(properties)).toContain('where');
  });

  it('does not accept `filter`, the name that silently did nothing', () => {
    const properties = (queryTool().inputSchema as any).properties;
    expect(Object.keys(properties)).not.toContain('filter');
  });

  it('refuses an unknown argument instead of ignoring it', () => {
    expect((queryTool().inputSchema as any).additionalProperties).toBe(false);
  });

  it('requires only queryBase', () => {
    expect((queryTool().inputSchema as any).required).toEqual(['queryBase']);
  });

  it('does not describe the argument as a filter', () => {
    const tool = queryTool();
    const described = `${tool.description} ${JSON.stringify(tool.inputSchema)}`;
    expect(described).not.toMatch(/\bfilter argument\b/);
  });
});
