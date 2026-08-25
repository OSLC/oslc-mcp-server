import type { ProbeRun } from './orchestrate.js';
import type { CaseResult } from './verdicts.js';

/**
 * The six triage categories of §10, as empty headings.
 *
 * Deliberately unfilled. Whether an absence is a conformant choice or a fault is
 * a judgement about the specification, not an observation (D8), and emitting it
 * automatically would make the report an opinion rather than evidence. The
 * second and fourth are the pair most easily conflated, so their wording says
 * what separates them.
 */
const TRIAGE_CATEGORIES = [
  ['Works', 'Rely on it.'],
  ['Not implemented, and that is conformant', 'The specification made it optional and this server declined it. Nothing to ask anyone — record it so nobody relies on it.'],
  ['Needs a special case', 'Workable around in this client. Per D9: only where the specification leaves it optional and a server was measured to have declined it.'],
  ['To raise with the vendor', 'Advertised and does not work, or the specification says MUST. Attach the transcript.'],
  ['Ours to fix', 'A gap in this client rather than the server.'],
  ["The specification's gap", 'Behaviour the specification permits to vary with no way for a client to discover which way. Feedback to OSLC-OP, not to a product.'],
];

/** What a fixture measures and sampling cannot, named so its absence is visible. */
const FIXTURE_ONLY_MEASUREMENTS = [
  'properties dropped on create',
  'whether an update is visible to query',
  'whether a created resource is visible to query',
];

function table(cases: CaseResult[]): string[] {
  if (cases.length === 0) return ['_No cases were run._'];
  const width = Math.max(...cases.map((c) => c.name.length), 4);
  return [
    `| ${'Case'.padEnd(width)} | Verdict      | Observation |`,
    `|${'-'.repeat(width + 2)}|--------------|-------------|`,
    ...cases.map((c) => `| ${c.name.padEnd(width)} | ${c.verdict.padEnd(12)} | ${c.reason} |`),
  ];
}

/**
 * The report: a summary for the caller, and the whole of it — transcripts
 * included — for the file the caller names.
 *
 * The inconclusive list sits near the top rather than at the end, because it is
 * the run's explicit handover of what it could not settle, and is what a
 * read-only report is chiefly for.
 */
export function formatProbeReport(
  run: ProbeRun,
  options: { transcripts?: boolean } = {}
): string {
  // §10: the caller gets a summary, the file gets everything. A run against a
  // provider with hundreds of members produces megabytes of transcript, which is
  // evidence in a file and unreadable as a tool result — and would crowd out the
  // findings it exists to support.
  const withTranscriptBodies = options.transcripts !== false;
  const lines: string[] = ['# OSLC capability probe', ''];

  if (run.mode === 'read-only') {
    lines.push(
      '> **READ-ONLY RUN — verification is weaker.**',
      `> ${run.modeReason}.`,
      '> Nothing was written, so ground truth was sampled from existing content rather than created.',
      ''
    );
  } else {
    lines.push(`Mode: **fixture** — ${run.modeReason}.`, '');
  }

  lines.push('## What this run touched', '');
  if (run.serviceProvidersWritten.length === 0) {
    lines.push('- No service provider was written to.');
  } else {
    lines.push('- Written to:');
    for (const uri of run.serviceProvidersWritten) lines.push(`  - ${uri}`);
  }
  lines.push(
    `- Delete: ${run.deleteSupported === null ? 'not established' : run.deleteSupported ? 'supported' : 'not supported'}`,
  );
  if (run.fixtureVisibleToQuery !== undefined) {
    lines.push(`- Fixture visible to an unfiltered query: ${run.fixtureVisibleToQuery ? 'yes' : 'no'}`);
  }
  lines.push('');

  if (run.needingCleanup.length > 0) {
    lines.push(
      '## Needing manual cleanup',
      '',
      'These were created and could not be removed. They are named rather than dropped, so someone can finish the job:',
      '',
      ...run.needingCleanup.map((uri) => `- ${uri}`),
      ''
    );
  }

  const inconclusive = run.cases.filter((c) => c.verdict === 'inconclusive');
  lines.push('## Inconclusive — what this run could not settle', '');
  if (inconclusive.length === 0) {
    lines.push('_Every case reached a verdict._', '');
  } else {
    for (const c of inconclusive) {
      lines.push(`### ${c.name}`, '', `- Why: ${c.reason}`);
      if (c.expected) lines.push(`- A correct result would look like: ${c.expected}`);
      lines.push('');
    }
  }

  if (run.mode === 'read-only') {
    lines.push(
      '## Not measured',
      '',
      'Stated rather than omitted, since an omission reads as having been checked:',
      '',
      ...FIXTURE_ONLY_MEASUREMENTS.map((m) => `- ${m} — **not measured** (no fixture was created)`),
      ''
    );
  }

  lines.push('## Query cases', '', ...table(run.cases), '');

  const withTranscripts = run.cases.filter((c) => c.transcripts.length > 0);
  // Refusals first, before the transcripts: an unassigned licence or a missing
  // permission is not a finding about the server's OSLC support, and reading
  // the case table without knowing one occurred gives entirely the wrong
  // impression of the deployment.
  if (run.refusals && run.refusals.length > 0) {
    lines.push('## Refusals — administrative, not capability', '');
    lines.push(
      'These are not findings about OSLC support. Each is an account or request problem, and the',
      'run below should be read as provisional until they are resolved and it is repeated.',
      ''
    );
    lines.push('| Operation | Status | Cause | What the server said |');
    lines.push('|---|---|---|---|');
    for (const r of run.refusals) {
      const said = (r.message ?? '').replace(/\|/g, '\\|').slice(0, 160);
      lines.push(`| ${r.operation} | ${r.status} | **${r.kind}** | ${said || '_(no message)_'} |`);
    }
    lines.push('');
    for (const r of run.refusals) {
      if (r.advice) lines.push(`- **${r.kind}** — ${r.advice}`);
    }
    lines.push('');
  }

  lines.push('## Transcripts', '');
  if (withTranscripts.length === 0) {
    lines.push('_No requests were recorded._', '');
  } else if (!withTranscriptBodies) {
    const total = withTranscripts.reduce((n, c) => n + c.transcripts.length, 0);
    lines.push(
      `_${total} exchange(s) recorded across ${withTranscripts.length} case(s), omitted here._`,
      '_Pass `reportPath` to write them: they are the evidence a finding rests on._',
      ''
    );
  } else {
    for (const c of withTranscripts) {
      lines.push(`### ${c.name}`, '');
      for (const transcript of c.transcripts) lines.push('```http', transcript, '```', '');
    }
  }

  lines.push(
    '## Triage',
    '',
    'The probe records what happened; a person decides what it means. Sort the cases above into these:',
    ''
  );
  for (const [heading, guidance] of TRIAGE_CATEGORIES) {
    lines.push(`### ${heading}`, '', `_${guidance}_`, '');
  }

  return lines.join('\n');
}
