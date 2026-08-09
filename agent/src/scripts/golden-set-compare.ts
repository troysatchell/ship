/**
 * Golden-set comparison run (TRO-338 / FG-20) — "did the drafts get worse?"
 *
 * Deliberately NOT part of `pnpm --filter @ship/agent test` / the CI gate.
 * The ticket's own table draws the line: the regression suite (FG-12) runs
 * on every CI run against recorded responses, for determinism; this script
 * runs against the REAL Anthropic API, on demand, "when the prompt or
 * model changes" — invoked by hand, same posture as `trace-invoke.ts` (the
 * one other place in this package permitted to make a live call).
 *
 * For each fixture in `goldenSet.ts`'s `GOLDEN_FIXTURES`: builds the real
 * prompt via the real, unmodified `buildStandupPrompt`, sends it to a real
 * model, and scores the real response against that fixture's human-written
 * reference draft (`computeTextSimilarity`, `textSimilarity.ts`). Prints a
 * per-fixture table and the mean score. Exits non-zero if the mean falls
 * below `--threshold` (default 0.25 — see `goldenSet.test.ts`'s own
 * "rich score should be a real, non-trivial match" bound, which this
 * mirrors), so this is a usable CI-adjacent gate for a human/future
 * automation to invoke on a prompt-change PR without making it part of the
 * every-commit gate this ticket is explicit it must NOT be.
 *
 * Usage (from repo root, with the worktree's staged .env.local):
 *   set -a; source .env.local; set +a
 *   pnpm --filter @ship/agent golden-set:compare -- [--threshold 0.25]
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { GOLDEN_FIXTURES, scoreGoldenFixture, summarizeGoldenScores } from '../goldenSet.js';
import { buildStandupPrompt } from '../standupDraft.js';
import type { AnthropicModel } from '../graph.js';
import { loadConfig } from '../config.js';

export function parseThreshold(argv: readonly string[]): number {
  const idx = argv.indexOf('--threshold');
  if (idx === -1) return 0.25;
  const raw = argv[idx + 1];
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}"`);
  }
  return parsed;
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? JSON.stringify(part)))
      .join('');
  }
  return String(content);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set — this script makes a real, live model call per fixture.');
    process.exitCode = 1;
    return;
  }

  const threshold = parseThreshold(process.argv.slice(2));
  // TRO-368: explicit timeout/retries, same values and reasoning as the
  // production construction (index.ts) — see anthropicRequestTimeoutMs/
  // anthropicMaxRetries in config.ts.
  const config = loadConfig();
  const model: AnthropicModel = new ChatAnthropic({
    apiKey,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    maxRetries: config.anthropicMaxRetries,
    clientOptions: { timeout: config.anthropicRequestTimeoutMs },
  });

  console.log(`Golden-set comparison — ${GOLDEN_FIXTURES.length} fixture(s), threshold ${threshold}`);
  console.log('');

  const results = [];
  for (const fixture of GOLDEN_FIXTURES) {
    const prompt = buildStandupPrompt(fixture.activity);
    // One fixture at a time, deliberately sequential — real API rate limits apply.
    const response = await model.invoke(prompt);
    const actualDraftText = contentToString(response.content);
    const result = scoreGoldenFixture(fixture, actualDraftText);
    results.push(result);

    console.log(`--- ${fixture.id} ---`);
    console.log(`  ${fixture.description}`);
    console.log(`  reference: ${fixture.referenceDraft}`);
    console.log(`  actual:    ${actualDraftText}`);
    console.log(`  score:     ${result.score.toFixed(3)}`);
    console.log('');
  }

  const summary = summarizeGoldenScores(results);
  console.log('=== summary ===');
  for (const r of summary.results) {
    console.log(`  ${r.fixtureId}: ${r.score.toFixed(3)}`);
  }
  console.log(`  mean: ${summary.meanScore.toFixed(3)} (threshold ${threshold})`);

  if (summary.meanScore < threshold) {
    console.error(`\nFAIL: mean score ${summary.meanScore.toFixed(3)} is below threshold ${threshold}.`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS.');
  }
}

// Only run when executed directly, never on import — a test can import
// `parseThreshold`/`contentToString` without triggering a real, live model
// call. Same guard `cost-report.ts` and `check-readiness-and-rollback.ts`
// already use for the identical reason.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('golden-set-compare failed:', err);
    process.exitCode = 1;
  });
}
