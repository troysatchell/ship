/**
 * One-off manual utility (TRO-313 / FG-2): invoke the real compiled graph
 * against the real Anthropic API, with LangSmith tracing on, to produce the
 * trace-link proof artifact the ticket requires.
 *
 * Deliberately NOT a test — this is the one place in the package permitted to
 * make a live call. Every automated test in `src/__tests__/` uses a stable
 * fake `AnthropicModel` instead (see graph.test.ts) so `pnpm test` never
 * spends money or depends on network/API availability.
 *
 * Usage (from repo root, with the worktree's staged .env.local):
 *   set -a; source .env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke
 */
import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { buildGraph } from '../graph.js';
import { FileCostTracker } from '../costTracking.js';
import { loadConfig } from '../config.js';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set — cannot make a real invocation.');
    process.exitCode = 1;
    return;
  }

  // This script's entire purpose is the trace-link proof — a live call that
  // produces no trace is worse than useless (it still spends real money).
  // Both prerequisites must hold, or the paid call never happens: tracing
  // must be exactly "true" (not merely truthy), and a LangSmith API key must
  // be set under either the current or legacy env var name (both accepted
  // by @langchain/core / langsmith — see agent/.env.example).
  const tracingEnabled = process.env.LANGCHAIN_TRACING_V2 === 'true';
  const langsmithApiKey = process.env.LANGCHAIN_API_KEY ?? process.env.LANGSMITH_API_KEY;
  if (!tracingEnabled || !langsmithApiKey) {
    console.error(
      'Refusing to make a live (paid) model call: this script only exists to produce a ' +
        'LangSmith trace-link proof, and tracing is not fully configured.' +
        (!tracingEnabled ? ' LANGCHAIN_TRACING_V2 is not exactly "true".' : '') +
        (!langsmithApiKey ? ' Neither LANGCHAIN_API_KEY nor LANGSMITH_API_KEY is set.' : '')
    );
    process.exitCode = 1;
    return;
  }

  // TRO-368: explicit timeout/retries, same values and reasoning as the
  // production construction (index.ts) — see anthropicRequestTimeoutMs/
  // anthropicMaxRetries in config.ts.
  const config = loadConfig();
  const model = new ChatAnthropic({
    apiKey,
    // Cheapest/fastest model available to this API key (verified via
    // GET /v1/models) — this is a smoke-test invocation, not a quality one.
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 128,
    maxRetries: config.anthropicMaxRetries,
    clientOptions: { timeout: config.anthropicRequestTimeoutMs },
  });

  // TRO-339 / FG-21: record this real invocation's real token usage —
  // this script is the one place in the package permitted to make a live
  // call, so it is also the one place that can produce a REAL
  // "development spend to date" data point rather than a projected one.
  const costTracker = new FileCostTracker();
  const graph = buildGraph(model, undefined, undefined, undefined, costTracker);
  const result = await graph.invoke({
    input:
      'In one sentence, confirm you are the FleetGraph agent foundation graph (TRO-313) running end to end.',
  });

  console.log('--- graph output ---');
  console.log(result.output);
  console.log('--------------------');
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${
      process.env.LANGCHAIN_PROJECT ?? '(default)'
    }".`
  );
  console.log(`Recorded to cost ledger: ${costTracker.ledgerPath}`);
  console.log('Run `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` to see the aggregated numbers.');
}

main().catch((err) => {
  console.error('trace-invoke failed:', err);
  process.exitCode = 1;
});
