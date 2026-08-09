/**
 * TRO-366 — FLEETGRAPH.MD's Cost Analysis section publishes cost figures as
 * "reproduced verbatim" from `cost-report.ts`, but nothing ever checked that
 * the transcribed numbers still matched what the code actually computes. They
 * drifted 3x (published 3 invocations / $0.001922 vs. the real ledger's 7 /
 * $0.006055) before anyone noticed, and the ledger sits right next to the
 * text that quotes it. This test closes that gap mechanically: it feeds the
 * REAL `aggregate`/`aggregateByNode` functions (`costTracking.ts` — the exact
 * ones `cost-report.ts` calls) the seven real records currently on the
 * project's long-lived development ledger, then parses FLEETGRAPH.MD's own
 * "Refreshed (TRO-366, 2026-08-08)" table out of the file and asserts the two
 * agree.
 *
 * TRO-373 (2026-08-09) — the seven records used to live ONLY as an inline
 * fixture here (`REFERENCE_LEDGER_RECORDS`, hand-transcribed from the real
 * ledger and never itself checked against anything). That was a second copy
 * of the same data FLEETGRAPH.MD's reproduction command was supposed to
 * produce — and the command couldn't, because `agent/.cache/cost-ledger.jsonl`
 * is gitignored (`.gitignore:42`) and per-checkout, so it doesn't exist on a
 * fresh clone. TRO-373 committed a byte-identical, read-only copy of that
 * ledger's 7 records as a tracked snapshot, `agent/cost-ledger-snapshot.jsonl`
 * (see FLEETGRAPH.MD's rewritten "Configuration note" in the Cost Analysis
 * section for the reproduction command that now reads it). This file now
 * reads that SAME committed snapshot directly via `FileCostTracker` — never
 * writes to it — instead of carrying its own hand-copied fixture, so there is
 * one source of truth: if the snapshot and the document ever disagree, this
 * test fails against the snapshot, the same artifact a grader's reproduction
 * command reads.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FileCostTracker,
  aggregate,
  aggregateByNode,
  invocationsByDay,
  type ModelInvocationRecord,
} from '../costTracking.js';

// `agent/cost-ledger-snapshot.jsonl` — committed, tracked, read-only from
// this test (only `readAll()` is ever called on it, never `record()`). Two
// levels up from `agent/src/__tests__/` is `agent/`, matching FLEETGRAPH_PATH
// below going three levels up to the repo root.
const SNAPSHOT_PATH = fileURLToPath(new URL('../../cost-ledger-snapshot.jsonl', import.meta.url));

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

describe('FLEETGRAPH.MD cost figures vs. the committed ledger snapshot (TRO-366 / TRO-373)', () => {
  let records: ModelInvocationRecord[];

  beforeAll(() => {
    // Read-only: this constructs a tracker pointed at the committed snapshot
    // purely to reuse `readAll`'s parsing, and only `readAll()` is called —
    // `record()` never is, so the tracked file is never written to by this
    // test.
    const tracker = new FileCostTracker({ ledgerPath: SNAPSHOT_PATH });
    records = tracker.readAll();
  });

  it('the committed snapshot still holds exactly the seven real records this test pins against', () => {
    // Guards against the snapshot file silently changing shape (e.g. a
    // future ticket appending more real invocations without updating this
    // test's expectations, or the file going missing/empty and `readAll`
    // quietly returning `[]`).
    expect(records).toHaveLength(7);
    expect(records.filter((r) => r.node === 'composeAnswer')).toHaveLength(6);
    expect(records.filter((r) => r.node === 'composeStandupDraft')).toHaveLength(1);
  });

  it('reproduces the exact "Development spend to date" total FLEETGRAPH.MD publishes', () => {
    const overall = aggregate(records);

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
    const byNode = aggregateByNode(records);
    const composeAnswerStats = byNode.find((tier) => tier.node === 'composeAnswer');
    const standupStats = byNode.find((tier) => tier.node === 'composeStandupDraft');
    if (!composeAnswerStats || !standupStats) {
      throw new Error('unreachable — the snapshot always contains both composeAnswer and composeStandupDraft records');
    }
    if (composeAnswerStats.costPerRunUsd === undefined || standupStats.costPerRunUsd === undefined) {
      throw new Error('unreachable — every snapshot record uses a priced model');
    }

    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');

    const answerInvocations = lastMatch(docText, /`composeAnswer` — invocations[^|]*\|\s*(\d+)\s*\|/g);
    const answerCostPerRun = lastMatch(
      docText,
      /`composeAnswer` — cost\/run \(mean over the \d+ priced invocations\)\s*\|\s*\$([\d.]+)\s*\|/g
    );
    const standupInvocations = lastMatch(docText, /`composeStandupDraft` — invocations\s*\|\s*(\d+)\s*\|/g);
    const standupCostPerRun = lastMatch(docText, /`composeStandupDraft` — cost\/run\s*\|\s*\$([\d.]+)\s*\|/g);

    // Real, measured values — not just re-asserting the snapshot's own shape.
    expect(composeAnswerStats.invocationCount).toBe(6);
    expect(standupStats.invocationCount).toBe(1);

    expect(Number(answerInvocations[1])).toBe(composeAnswerStats.invocationCount);
    expect(Number(answerCostPerRun[1])).toBe(Number(composeAnswerStats.costPerRunUsd.toFixed(6)));
    expect(Number(standupInvocations[1])).toBe(standupStats.invocationCount);
    expect(Number(standupCostPerRun[1])).toBe(Number(standupStats.costPerRunUsd.toFixed(6)));
  });

  // CodeRabbit review, PR #156 (finding 4): the two figures below were
  // published in FLEETGRAPH.MD's "Refreshed (TRO-366...)" section but never
  // parsed or asserted by this file — an incorrect value in either would
  // have passed silently, which is precisely the rot this test exists to
  // prevent.
  it('reproduces the exact composeAnswer avg-documents-pulled figure FLEETGRAPH.MD publishes', () => {
    const byNode = aggregateByNode(records);
    const composeAnswerStats = byNode.find((tier) => tier.node === 'composeAnswer');
    if (!composeAnswerStats) {
      throw new Error('unreachable — the snapshot always contains composeAnswer records');
    }
    if (composeAnswerStats.avgDocumentsPulled === undefined) {
      throw new Error('unreachable — every composeAnswer snapshot record sets documentsPulled');
    }

    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');
    const avgDocsPulledMatch = lastMatch(
      docText,
      /`composeAnswer` — avg documents pulled\s*\|\s*([\d.]+)\s*\(/g
    );

    // Real, measured value — not just re-asserting the snapshot's own shape.
    expect(composeAnswerStats.avgDocumentsPulled).toBe(6.5);
    expect(Number(avgDocsPulledMatch[1])).toBe(composeAnswerStats.avgDocumentsPulled);
  });

  it('reproduces the exact 2026-08-05 / 2026-08-07 daily invocation distribution FLEETGRAPH.MD publishes', () => {
    // Derived from the committed snapshot via the real invocationsByDay
    // aggregation rather than hardcoded here — so this test tracks the
    // snapshot's own dates/counts, not a second, independently-maintained
    // copy of "6" and "1" that could drift from the snapshot the same way
    // the document itself once drifted from the ledger.
    const byDay = invocationsByDay(records);
    expect(byDay).toEqual([
      { day: '2026-08-07', count: 1 },
      { day: '2026-08-05', count: 6 },
    ]);

    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');
    for (const { day, count } of byDay) {
      expect(docText).toMatch(new RegExp('`' + day + '`\\s*\\(' + count + '\\)'));
    }
  });

  it('does not still assert composeStandupDraft has zero real invocations anywhere in the file', () => {
    // The defect this ticket also fixed: a sentence flatly contradicted by
    // the ledger's own newest entry (2026-08-07, a real composeStandupDraft
    // invocation). Guards against it silently coming back in a future edit.
    const docText = readFileSync(FLEETGRAPH_PATH, 'utf8');
    expect(docText).not.toMatch(/composeStandupDraft`? still has zero real\s*\n?\s*invocations/);
  });
});
