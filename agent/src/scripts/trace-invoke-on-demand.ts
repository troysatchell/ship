/**
 * One-off manual utility (TRO-318 / FG-7) — the on-demand-expansion sibling
 * of `trace-invoke.ts` (FG-2). Invokes the real compiled graph, through the
 * REAL expansion path (real Ship API calls, real Anthropic call), with
 * LangSmith tracing on, to produce the SECOND trace-link proof artifact the
 * bundle epic (TRO-327) needs: "two LangSmith traces (this path vs FG-5's
 * deterministic path) showing genuinely different node sequences."
 *
 * FG-13 (TRO-324) owns actually capturing and writing up that comparison
 * into FLEETGRAPH.MD's Test Cases table — this script is the tool that
 * produces the trace to link, not the writeup itself.
 *
 * Deliberately NOT a test — same posture as `trace-invoke.ts`: every
 * automated test uses a stable fake `AnthropicModel` AND a stable fake
 * `OnDemandShipClientLike` (`__tests__/graph.test.ts`), so `pnpm test`
 * never spends money, never depends on network availability, and never
 * needs a real Ship deployment to seed against.
 *
 * Usage (from repo root, with the worktree's staged .env.local AND a Ship
 * API token for a real logged-in user):
 *   set -a; source .env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke-on-demand -- <seedDocumentId> ["question text"]
 */
import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { loadConfig } from '../config.js';
import { buildShipClient } from '../server.js';
import { buildGraph } from '../graph.js';
import { ShipClient } from '../shipClient.js';
import { FileCostTracker } from '../costTracking.js';

async function main() {
  const config = loadConfig();

  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set — cannot make a real invocation.');
    process.exitCode = 1;
    return;
  }
  if (!config.shipApiToken) {
    console.error(
      'SHIP_API_TOKEN is not set — the expansion path has nothing to walk without a real, ' +
        "logged-in user's Ship API token (FLEETGRAPH.MD: \"no service account\")."
    );
    process.exitCode = 1;
    return;
  }

  // Same refusal posture as trace-invoke.ts: a live (paid) call that
  // produces no trace is worse than useless.
  const tracingEnabled = config.langchainTracingV2;
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

  const [seedDocumentId, ...questionParts] = process.argv.slice(2);
  if (!seedDocumentId) {
    console.error(
      'Usage: pnpm --filter @ship/agent trace:invoke-on-demand -- <seedDocumentId> ["question text"]\n' +
        'Pass a real document id from the target Ship deployment (e.g. one of the FG-3 fixture ' +
        'ids printed by `pnpm db:seed`) — this script makes a real, visibility-checked HTTP call ' +
        "against SHIP_API_BASE_URL under SHIP_API_TOKEN's own permissions."
    );
    process.exitCode = 1;
    return;
  }
  const question = questionParts.length > 0 ? questionParts.join(' ') : 'What is going on with this?';

  const model = new ChatAnthropic({
    apiKey,
    // Cheapest/fastest model available — this is a trace-shape smoke test,
    // not a quality one (same choice as trace-invoke.ts).
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
  });

  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    token: config.shipApiToken,
    client: buildShipClient(config),
  });

  // TRO-339 / FG-21: record this real invocation's real token usage AND the
  // real documentsPulled count — this is the on-demand-expansion path's own
  // trace-link script, so it is also the only place that can produce a real
  // measured composeAnswer data point (cost cliff #1/#2).
  const costTracker = new FileCostTracker();
  // TRO-342: OnDemandDeps.shipClient became shipClientFactory — this manual
  // script has only ONE real token available (SHIP_API_TOKEN, checked
  // above), so the factory just returns the same client regardless of the
  // token argument it's called with. That is correct for THIS script's own
  // purpose (a human runs it with their own token to produce a trace), not
  // a workaround: production (index.ts) uses the argument for real.
  const graph = buildGraph(
    model,
    undefined,
    { shipClientFactory: () => shipClient, documentCap: config.onDemandDocumentCap },
    undefined,
    costTracker
  );

  const result = await graph.invoke({
    trigger: 'on_demand',
    input: question,
    seedDocumentId,
    askingUserToken: config.shipApiToken,
  });

  console.log('--- graph output ---');
  console.log(result.output);
  console.log('--------------------');
  console.log(`Cited ${result.citedSources.length} source(s):`);
  for (const source of result.citedSources) {
    console.log(`  - [${source.documentType}] "${source.title}" (${source.documentId}) — ${source.reason}`);
  }
  console.log(`Cap reached: ${result.expansionCapped} (documentCap=${config.onDemandDocumentCap})`);
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${
      config.langchainProject ?? '(default)'
    }" — compare its node sequence against trace-invoke.ts's proactive/on-demand-chat trace.`
  );
  console.log(`Recorded to cost ledger: ${costTracker.ledgerPath}`);
  console.log('Run `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` to see the aggregated numbers.');
}

main().catch((err) => {
  console.error('trace-invoke-on-demand failed:', err);
  process.exitCode = 1;
});
