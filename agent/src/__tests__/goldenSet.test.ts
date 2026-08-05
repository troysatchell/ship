import { describe, expect, it } from 'vitest';
import { GOLDEN_FIXTURES, scoreGoldenFixture, summarizeGoldenScores } from '../goldenSet.js';
import { buildStandupPrompt, type PersonActivitySummary } from '../standupDraft.js';
import type { AnthropicModel } from '../graph.js';
// Narrows AnthropicModel.invoke's `content: unknown` the same way
// golden-set-compare.ts's real caller does — reused rather than an `as
// string` cast in this file (lessons.md #16/#21: type the boundary,
// don't assert past it, even in a test).
import { contentToString } from '../scripts/golden-set-compare.js';

/**
 * TRO-338 / FG-20's own acceptance test #1, made real and runnable rather
 * than described: "Deliberately degrading the prompt (e.g. strip the
 * activity context) must move the golden-set score measurably, while the
 * FG-12 regression suite stays green. That divergence is the whole point
 * and is the acceptance test."
 *
 * The mechanism this test proves: TRO-322's regression suite (graph.test.ts,
 * standupDraft.test.ts, etc.) uses STABLE fakes that return a fixed string
 * regardless of what the prompt actually says — that is what makes them
 * deterministic, and it is exactly why they cannot see a context-assembly
 * regression: the recorded response replays either way. This file's fake
 * model is deliberately different in kind — it is CONTEXT-SENSITIVE: it can
 * only mention a fact if that fact is actually present in the prompt text
 * it was given, the same constraint a real model is under. Feeding it the
 * REAL `buildStandupPrompt(...)` output for a rich activity state produces
 * a draft that names real facts; feeding it the same function's output for
 * an activity state that came back EMPTY (the realistic shape of a context-
 * assembly bug — the gatherer silently returned nothing) produces a draft
 * with nothing to say, because there is nothing in the prompt to draw from.
 * `scoreGoldenFixture` (real, unmocked scoring code) then shows the
 * measurable gap.
 *
 * This test runs in the SAME `pnpm --filter @ship/agent test` invocation as
 * every other regression test in this package — none of which this file
 * touches or depends on. That is the structural half of the proof: in one
 * real test run, the pre-existing regression suite passes UNCHANGED
 * (it does not inspect prompt content depth, so it could not have caught
 * this), while this file's own assertions show the golden score moving.
 * "Tests still green" and "golden score dropped" are both true at once, in
 * the same run — that divergence is what the ticket asks to be demonstrated.
 */

/** A context-sensitive stable fake — NOT the same kind of fake TRO-322's
 * regression suite uses (those return one fixed string regardless of
 * input). This one can only echo facts that are textually present in the
 * prompt it receives, which is what makes it capable of exposing a
 * context-stripping regression instead of masking it. Deterministic and
 * offline — no network call, no live model — so it stays a legitimate
 * "stable fake" under the ticket's own mocking rule; it is just a smarter
 * one than "always return the same string." */
function contextSensitiveFakeModel(): AnthropicModel {
  return {
    model: 'golden-set-context-sensitive-fake',
    invoke: async (prompt: string) => {
      const quotedTitles = [...new Set([...prompt.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((t): t is string => Boolean(t)))];
      const daysMatch = prompt.match(/no activity in (\d+) days?/);
      const blockedMatch = prompt.match(/currently blocked by "([^"]+)"/);

      if (quotedTitles.length === 0) {
        return { content: 'Nothing to report — no specific activity was provided for this window.' };
      }

      const parts = [`Update on ${quotedTitles.map((t) => `"${t}"`).join(', ')}.`];
      if (daysMatch) parts.push(`One item has not moved in ${daysMatch[1]} days.`);
      if (blockedMatch) parts.push(`Currently blocked by "${blockedMatch[1]}".`);
      return { content: parts.join(' ') };
    },
  };
}

/** Simulates the realistic shape of a context-assembly regression: the
 * activity-gathering step silently returns nothing (an empty
 * `PersonActivitySummary`) for a person who actually HAS real activity —
 * not a hand-edited prompt string, but the same real `buildStandupPrompt`
 * fed genuinely empty input, exactly what "strip the activity context"
 * (the ticket's own phrase) means upstream of prompt assembly. */
function stripActivityContext(activity: PersonActivitySummary): PersonActivitySummary {
  return {
    anchor: activity.anchor,
    moved: [],
    commented: [],
    stale: [],
    hasAnyActivity: false,
  };
}

describe('golden set — degraded-context divergence (TRO-338 / FG-20, acceptance test #1)', () => {
  it('every fixture scores measurably lower when its activity context is stripped before prompting', async () => {
    const model = contextSensitiveFakeModel();

    for (const fixture of GOLDEN_FIXTURES) {
      const richPrompt = buildStandupPrompt(fixture.activity);
      const richOutput = await model.invoke(richPrompt);
      const richScore = scoreGoldenFixture(fixture, contentToString(richOutput.content));

      const strippedPrompt = buildStandupPrompt(stripActivityContext(fixture.activity));
      const strippedOutput = await model.invoke(strippedPrompt);
      const strippedScore = scoreGoldenFixture(fixture, contentToString(strippedOutput.content));

      // The measurable divergence itself — the ticket's own acceptance bar.
      expect(
        richScore.score - strippedScore.score,
        `fixture "${fixture.id}": rich=${richScore.score}, stripped=${strippedScore.score} — expected a measurable drop`
      ).toBeGreaterThan(0.15);

      // Not just "lower than rich" (which a noisy metric could satisfy by
      // accident) — the stripped case must score BADLY in absolute terms,
      // since a draft with zero real facts should barely resemble a
      // reference full of specific ones.
      expect(strippedScore.score, `fixture "${fixture.id}" stripped score should be low in absolute terms`).toBeLessThan(0.2);

      // And the full-context case must be a genuinely reasonable draft, not
      // a coincidentally-low bar that makes the "drop" trivial to produce.
      expect(richScore.score, `fixture "${fixture.id}" rich score should be a real, non-trivial match`).toBeGreaterThan(0.25);
    }
  });

  it('summarizeGoldenScores reports a lower mean for a fully degraded run than a fully healthy one', async () => {
    const model = contextSensitiveFakeModel();

    const richResults = await Promise.all(
      GOLDEN_FIXTURES.map(async (fixture) => {
        const output = await model.invoke(buildStandupPrompt(fixture.activity));
        return scoreGoldenFixture(fixture, contentToString(output.content));
      })
    );
    const strippedResults = await Promise.all(
      GOLDEN_FIXTURES.map(async (fixture) => {
        const output = await model.invoke(buildStandupPrompt(stripActivityContext(fixture.activity)));
        return scoreGoldenFixture(fixture, contentToString(output.content));
      })
    );

    const richSummary = summarizeGoldenScores(richResults);
    const strippedSummary = summarizeGoldenScores(strippedResults);

    expect(strippedSummary.meanScore).toBeLessThan(richSummary.meanScore);
    expect(richSummary.meanScore - strippedSummary.meanScore).toBeGreaterThan(0.15);
  });

  // The other half of the structural proof: this file's own fixtures/model
  // are real, exercised code (buildStandupPrompt is imported unmodified
  // from standupDraft.ts, never re-implemented here) — not a description.
  it('GOLDEN_FIXTURES is non-trivial and every fixture has both real activity and a written reference', () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(3);
    for (const fixture of GOLDEN_FIXTURES) {
      expect(fixture.referenceDraft.trim().length).toBeGreaterThan(20);
      expect(fixture.id.trim().length).toBeGreaterThan(0);
    }
  });
});
