import { describe, it, expect } from '@jest/globals';
import { formatProbeReport } from './report.js';
import type { ProbeRun } from './orchestrate.js';

function run(overrides: Partial<ProbeRun> = {}): ProbeRun {
  return {
    mode: 'fixture',
    modeReason: 'a creation factory was advertised and the fixture was created',
    serviceProvidersWritten: ['https://elm.example.com/rm/sp/1'],
    fixtureVisibleToQuery: true,
    needingCleanup: [],
    deleteSupported: true,
    cases: [
      { name: 'where-identity', verdict: 'supported', reason: 'exactly the expected resource', transcripts: ['POST /views\n  200'] },
      { name: 'order-by', verdict: 'ignored', reason: 'both directions lead with r/1', transcripts: ['POST /views\n  200'] },
      {
        name: 'paging', verdict: 'inconclusive',
        reason: 'only 1 resources are visible, which fits in one page of 2',
        expected: 'a page of 2 members and an oslc:nextPage pointing at the rest',
        transcripts: [],
      },
    ],
    ...overrides,
  };
}

describe('formatProbeReport', () => {
  it('labels a read-only run prominently, at the top', () => {
    const out = formatProbeReport(run({ mode: 'read-only', modeReason: 'no creation factory advertised' }));
    const head = out.split('\n').slice(0, 8).join('\n');
    expect(head).toMatch(/read-only/i);
    expect(head).toMatch(/no creation factory advertised/);
  });

  it('names every service provider the run wrote to', () => {
    expect(formatProbeReport(run())).toContain('https://elm.example.com/rm/sp/1');
  });

  it('lists every inconclusive case with the request sent and what a correct result would look like', () => {
    const out = formatProbeReport(run());
    expect(out).toMatch(/inconclusive/i);
    expect(out).toContain('a page of 2 members and an oslc:nextPage pointing at the rest');
  });

  it('lists artifacts needing manual cleanup, with their URIs', () => {
    const out = formatProbeReport(run({ needingCleanup: ['https://elm.example.com/rm/r/9'] }));
    expect(out).toMatch(/cleanup/i);
    expect(out).toContain('https://elm.example.com/rm/r/9');
  });

  it('says which measurements were not made at all in read-only mode', () => {
    const out = formatProbeReport(run({ mode: 'read-only', cases: [] }));
    expect(out).toMatch(/not measured/i);
    expect(out).toMatch(/properties dropped on create/i);
  });

  it('never labels a finding a defect, a bug, or non-conformant', () => {
    // triage is a person's judgement (D8); the probe records mechanical facts
    const out = formatProbeReport(run({ needingCleanup: ['https://elm.example.com/rm/r/9'] }));
    expect(out).not.toMatch(/\b(defect|bug|broken|non-?conformant|violation)\b/i);
  });

  it('leaves the triage section empty for a person to fill in', () => {
    const out = formatProbeReport(run());
    const triage = out.slice(out.toLowerCase().indexOf('## triage'));
    expect(triage).toMatch(/works/i);
    expect(triage).toMatch(/optional/i);
    // headings only — no verdicts assigned to any category
    expect(triage).not.toContain('where-identity');
  });

  it('includes the transcripts', () => {
    expect(formatProbeReport(run())).toContain('POST /views');
  });

  it('omits transcript bodies when the caller asked for a summary, and says where to get them', () => {
    // a run over hundreds of members produces megabytes of exchange: evidence in
    // a file, noise in a tool result.
    const summary = formatProbeReport(run(), { transcripts: false });
    expect(summary).not.toContain('POST /views');
    expect(summary).toMatch(/exchange\(s\) recorded/);
    expect(summary).toMatch(/reportPath/);
    // the findings themselves must survive the omission
    expect(summary).toContain('where-identity');
    expect(summary).toMatch(/## Triage/);
  });
});
