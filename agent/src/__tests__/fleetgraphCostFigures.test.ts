/**
 * TRO-366 — FLEETGRAPH.MD's Cost Analysis section publishes cost figures as
 * "reproduced verbatim" from `cost-report.ts`, but nothing ever checked that
 * the transcribed numbers still matched what the code actually computes. They
 * drifted 3x (published 3 invocations / $0.001922 vs. the real ledger's 7 /
 * $0.006055) before anyone noticed, and the ledger sits right next to the
 * text that quotes it. This test closes that gap mechanically: it feeds the
 * REAL `aggregate`/`aggregateByNode` functions (`costTracking.ts` — the exact
 * ones `cost-report.ts` calls) a frozen snapshot of the seven real records
 * currently on the project's long-lived development ledger (transcribed
 * verbatim from that ledger's own JSONL, 2026-08-08 — see this ticket's
 * CHANGES.md entry for the configuration note on why THIS worktree's own
 * `.cache` is empty and the reference lives here as a fixture instead), then
 * parses FLEETGRAPH.MD's own "Refreshed (TRO-366, 2026-08-08)" table out of
 * the file and asserts the two agree.
 *
 * Deliberately NOT reading the real `agent/.cache/cost-ledger.jsonl` at its
 * default path (lessons.md #25 / ship-qa's "the host is not under test"):
 * that file is gitignored, per-checkout, and empty in every fresh worktree —
 * a test that depended on it would pass or fail based on which machine ran
 * it, not on whether the code or the document is correct. Freezing the
 * records as a fixture makes this a test of the RELATIONSHIP between the doc
 * and the aggregation code, which is what actually matters and is what
 * FLEETGRAPH.MD's numbers should stay pinned to going forward — if either the
 * document's numbers or costTracking.ts's aggregation logic changes without
 * the other, this fails.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCostTracker, aggregate, aggregateByNode, type ModelInvocationRecord } from '../costTracking.js';

// Transcribed verbatim from the real development ledger, 2026-08-08 — six
// `composeAnswer` invocations (2026-08-05) and one `composeStandupDraft`
// invocation (2026-08-07), the same seven records `cost-report.ts` reported
// when this ticket re-ran it against that ledger.
const REFERENCE_LEDGER_RECORDS: readonly ModelInvocationRecord[] = [
  { timestamp: '2026-08-05T14:32:41.562Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 435, outputTokens: 211, documentsPulled: 12 },
  { timestamp: '2026-08-05T15:01:21.929Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 405, outputTokens: 122, documentsPulled: 12 },
  { timestamp: '2026-08-05T15:08:40.306Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 373, outputTokens: 44, documentsPulled: 12 },
  { timestamp: '2026-08-05T15:19:42.278Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 95, outputTokens: 159, documentsPulled: 1 },
  { timestamp: '2026-08-05T15:20:10.868Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 95, outputTokens: 97, documentsPulled: 1 },
  { timestamp: '2026-08-05T15:20:53.019Z', node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 109, outputTokens: 116, documentsPulled: 1 },
  { timestamp: '2026-08-07T14:36:16.889Z', node: 'composeStandupDraft', trigger: 'proactive_deep', model: 'claude-haiku-4-5-20251001', inputTokens: 348, outputTokens: 90 },
];

const FLEETGRAPH_PATH = fileURLToPath(new URL('../../../FLEETGRAPH.MD', import.meta.url));

/** Returns the LAST regex match's capture groups — FLEETGRAPH.MD keeps the
 * superseded 2026-08-05 snapshot table in place as dated history (see this
 * file's own docstring / the ticket's "do not restructure the cost section"
 * instruction), so a pattern that also matches the historical table must
 * resolve to whichever occurrence comes later in the document, which is
 * always the current one. Throws with a clear message rather than returning
 * `undefined` on no match, so a doc restructuring that removes the pattern
 * fails loudly here instead of silently skipping the assertion. */
function lastMatch(text: string, pattern: RegExp): RegExpMatchArray {
  const matches = [...text.matchAll(pattern)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new Error(`FLEETGRAPH.MD: no match for ${pattern} — has the Cost Analysis table's shape changed?`);
  }
  return last;
}

function parseUsd(raw: string): number {
  return Number(raw);
}

function parseIntWithCommas(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

describe('FLEETGRAPH.MD cost figures vs. the real ledger (TRO-366)', () => {
  let ledgerDir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'fleetgraph-cost-ledger-'));
    ledgerPath = join(ledgerDir, 'cost-ledger.jsonl');
    const tracker = new FileCostTracker({ ledgerPath });
    // Sequential, not Promise.all: FileCostTracker.record's own docstring
    // notes O_APPEND gives no cross-process ORDER guarantee, only atomicity —
    // irrelevant to aggregation (which only sums/group-bys), but sequential
    // writes here keep the on-disk line order matching REFERENCE_LEDGER_RECORDS'
    // own declared order, which is easier to eyeball against the real ledger.
    for (const record of REFERENCE_LEDGER_RECORDS) {
      await tracker.record(record);
    }
  });

  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it('reproduces the exact "Development spend to date" total FLEETGRAPH.MD publishes', () => {
    const tracker = new FileCostTracker({ ledgerPath });
    const overall = aggregate(tracker.readAll());

    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');
    const totalMatch = lastMatch(
      docText,
      /\*\*Total development spend to date, all nodes in this ledger\*\*\s*\|\s*\*\*\$([\d.]+) \(([\d,]+) invocations?, ([\d,]+) input tokens, ([\d,]+) output tokens\)\*\*/g
    );
    const [, docSpendRaw, docInvocationsRaw, docInputRaw, docOutputRaw] = totalMatch;
    if (!docSpendRaw || !docInvocationsRaw || !docInputRaw || !docOutputRaw) {
      throw new Error('FLEETGRAPH.MD: Total development spend row matched but a capture group was empty');
    }

    expect(overall.invocationCount).toBe(7);
    expect(overall.inputTokens).toBe(1860);
    expect(overall.outputTokens).toBe(839);

    expect(parseIntWithCommas(docInvocationsRaw)).toBe(overall.invocationCount);
    expect(parseIntWithCommas(docInputRaw)).toBe(overall.inputTokens);
    expect(parseIntWithCommas(docOutputRaw)).toBe(overall.outputTokens);
    // Compared at the same precision cost-report.ts's own formatUsd prints
    // at (.toFixed(6)) — the document's number is that formatted string.
    expect(Number(overall.totalCostUsd.toFixed(6))).toBe(parseUsd(docSpendRaw));
  });

  it('reproduces the exact composeAnswer and composeStandupDraft per-tier figures FLEETGRAPH.MD publishes', () => {
    const tracker = new FileCostTracker({ ledgerPath });
    const byNode = aggregateByNode(tracker.readAll());
    const composeAnswerStats = byNode.find((tier) => tier.node === 'composeAnswer');
    const standupStats = byNode.find((tier) => tier.node === 'composeStandupDraft');
    if (!composeAnswerStats || !standupStats) {
      throw new Error('unreachable — the fixture ledger always contains both composeAnswer and composeStandupDraft records');
    }
    if (composeAnswerStats.costPerRunUsd === undefined || standupStats.costPerRunUsd === undefined) {
      throw new Error('unreachable — every fixture record uses a priced model');
    }

    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');

    const answerInvocations = lastMatch(docText, /`composeAnswer` — invocations[^|]*\|\s*(\d+)\s*\|/g);
    const answerCostPerRun = lastMatch(
      docText,
      /`composeAnswer` — cost\/run \(mean over the \d+ priced invocations\)\s*\|\s*\$([\d.]+)\s*\|/g
    );
    const standupInvocations = lastMatch(docText, /`composeStandupDraft` — invocations\s*\|\s*(\d+)\s*\|/g);
    const standupCostPerRun = lastMatch(docText, /`composeStandupDraft` — cost\/run\s*\|\s*\$([\d.]+)\s*\|/g);

    // Real, measured values — not just re-asserting the fixture's own shape.
    expect(composeAnswerStats.invocationCount).toBe(6);
    expect(standupStats.invocationCount).toBe(1);

    expect(Number(answerInvocations[1])).toBe(composeAnswerStats.invocationCount);
    expect(Number(answerCostPerRun[1])).toBe(Number(composeAnswerStats.costPerRunUsd.toFixed(6)));
    expect(Number(standupInvocations[1])).toBe(standupStats.invocationCount);
    expect(Number(standupCostPerRun[1])).toBe(Number(standupStats.costPerRunUsd.toFixed(6)));
  });

  it('does not still assert composeStandupDraft has zero real invocations anywhere in the file', () => {
    // The defect this ticket also fixed: a sentence flatly contradicted by
    // the ledger's own newest entry (2026-08-07, a real composeStandupDraft
    // invocation). Guards against it silently coming back in a future edit.
    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');
    expect(docText).not.toMatch(/composeStandupDraft`? still has zero real\s*\n?\s*invocations/);
  });
});
