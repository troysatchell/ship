/**
 * One-off manual utility (TRO-356 / FG-22) — the retro-drafting tier's own
 * trace-link script (`trigger: 'proactive_retro'`). No equivalent existed
 * before this ticket. Produces a real, public trace for `gatherRetroActivity
 * -> composeRetroDraft -> commitRetroDraft` — FLEETGRAPH.MD Test Case 3's
 * own path.
 *
 * Same "deliberately NOT a test" posture as its siblings — every automated
 * test in `src/__tests__/graph.test.ts` uses a stable fake model AND a
 * stable fake `DeepShipClientLike`, so `pnpm test` never spends money, never
 * depends on network availability, and never needs a real Ship deployment to
 * seed against.
 *
 * Usage (from repo root, with the worktree's staged .env.local AND a real
 * Ship API token for a real logged-in user):
 *   set -a; source agent/.env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke-retro <weekId>
 *
 * <weekId> — a real `sprint` document id on SHIP_API_BASE_URL whose plan
 * carries at least one success criterion and a recorded owner (e.g. the
 * FG-3 Test Case 3 fixture's week, printed by `pnpm db:seed`).
 *
 * TRO-356: do NOT put `--` between the script name and the argument —
 * verified directly (pnpm 10.27.0) that this pnpm version forwards a
 * literal `"--"` token through as `process.argv[2]` rather than stripping
 * it (contrary to what TRO-324's own usage comments assumed for its two
 * sibling scripts). Filtered out defensively below either way.
 */
import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { loadConfig } from '../config.js';
import { buildShipClient } from '../server.js';
import { buildGraph } from '../graph.js';
import { ShipClient } from '../shipClient.js';
import { InMemoryItemStore } from '../itemStore.js';
import { InMemoryDraftStore } from '../draftStore.js';
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
      'SHIP_API_TOKEN is not set — the retro tier has nothing to gather without a real, logged-in ' +
        "user's Ship API token (FLEETGRAPH.MD: \"no service account\")."
    );
    process.exitCode = 1;
    return;
  }

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

  // Defensively drop a stray leading `--` — see this file's module docstring.
  const [weekId] = process.argv.slice(2).filter((a) => a !== '--');
  if (!weekId) {
    console.error(
      'Usage: pnpm --filter @ship/agent trace:invoke-retro <weekId>\n' +
        'weekId: a real sprint document id on SHIP_API_BASE_URL.'
    );
    process.exitCode = 1;
    return;
  }

  const model = new ChatAnthropic({
    apiKey,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
  });

  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    token: config.shipApiToken,
    client: buildShipClient(config),
  });

  const costTracker = new FileCostTracker();
  const itemStore = new InMemoryItemStore();
  const draftStore = new InMemoryDraftStore();

  const graph = buildGraph(model, undefined, undefined, { shipClient, itemStore, draftStore }, costTracker);

  const result = await graph.invoke({ trigger: 'proactive_retro', weekId });

  console.log('--- retro tier (proactive_retro) result ---');
  console.log(`Skip reason: ${result.retroSkipReason ?? '(none — draft was composed)'}`);
  if (result.weekDeliverySummary) {
    console.log(
      `Week ${result.weekDeliverySummary.weekNumber}: ${result.weekDeliverySummary.successCriteria.length} ` +
        `success criteria, ${result.weekDeliverySummary.closedIssues.length} issues closed within it, ` +
        `ownerUserId=${result.weekDeliverySummary.ownerUserId ?? '(none)'}`
    );
  }
  if (result.retroDraftText) {
    console.log('--- draft text ---');
    console.log(result.retroDraftText);
  }
  console.log('--------------------------------------------');
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${
      config.langchainProject ?? '(default)'
    }" — compare its node sequence (gatherRetroActivity -> composeRetroDraft -> ` +
      "commitRetroDraft) against this package's other trace scripts."
  );
  console.log(`Recorded to cost ledger: ${costTracker.ledgerPath}`);
}

main().catch((err) => {
  console.error('trace-invoke-retro failed:', err);
  process.exitCode = 1;
});
