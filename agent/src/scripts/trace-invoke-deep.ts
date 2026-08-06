/**
 * One-off manual utility (TRO-356 / FG-22) — the deep tier's own trace-link
 * script (`trigger: 'proactive_deep'`, standup draft composition). No
 * equivalent existed before this ticket: `trace-invoke-proactive.ts`
 * (TRO-324) only covers `proactive_steady` (no model call anywhere on that
 * chain). This is the first script in this package that produces a real,
 * public trace for `gatherStandupActivity -> composeStandupDraft ->
 * commitStandupDraft` — FLEETGRAPH.MD Test Case 1's own path.
 *
 * Same "deliberately NOT a test" posture as its siblings
 * (`trace-invoke.ts`/`trace-invoke-on-demand.ts`/`trace-invoke-proactive.ts`):
 * every automated test in `src/__tests__/graph.test.ts` uses a stable fake
 * model AND a stable fake `DeepShipClientLike`, so `pnpm test` never spends
 * money, never depends on network availability, and never needs a real Ship
 * deployment to seed against.
 *
 * Usage (from repo root, with the worktree's staged .env.local AND a real
 * Ship API token for a real logged-in user):
 *   set -a; source agent/.env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke-deep <targetPersonUserId>
 *
 * <targetPersonUserId> — a real `users.id` with assigned issues on
 * SHIP_API_BASE_URL (e.g. the FG-3 Test Case 1 fixture's engineer,
 * `GET /api/team/people` to resolve a name to a user id).
 *
 * TRO-356: do NOT put `--` between the script name and the argument, even
 * though `trace-invoke.ts`/`trace-invoke-on-demand.ts`'s own usage comments
 * (and FLEETGRAPH.MD's Execution Traces section, written under TRO-324) show
 * that form. Verified directly (this ticket, pnpm 10.27.0): unlike what
 * TRO-324 documented ("pnpm --filter @ship/agent trace:invoke-on-demand --
 * <args>` — via the package script — strips it"), this pnpm version does
 * NOT strip a `--` passed after the script name; it forwards the literal
 * `"--"` token through as `process.argv[2]`, silently becoming the id
 * argument (an empty-result, no-op run, not a crash — the exact failure
 * shape TRO-324's own accidental-spend paragraph describes for the OTHER
 * bypass form). This file's own arg parsing below filters out a stray
 * leading `--` defensively so this mistake degrades to a harmless no-op
 * instead of a wasted (if cheap) real model call either way.
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
      'SHIP_API_TOKEN is not set — the deep tier has nothing to gather without a real, logged-in ' +
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
  const [targetPersonUserId] = process.argv.slice(2).filter((a) => a !== '--');
  if (!targetPersonUserId) {
    console.error(
      'Usage: pnpm --filter @ship/agent trace:invoke-deep <targetPersonUserId>\n' +
        'targetPersonUserId: a real users.id with assigned issues on SHIP_API_BASE_URL.'
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

  const result = await graph.invoke({ trigger: 'proactive_deep', targetPersonUserId });

  console.log('--- deep tier (proactive_deep) result ---');
  console.log(`Skip reason: ${result.standupSkipReason ?? '(none — draft was composed)'}`);
  if (result.standupActivity) {
    console.log(
      `Activity gathered: ${result.standupActivity.moved.length} moved, ` +
        `${result.standupActivity.commented.length} commented, ${result.standupActivity.stale.length} stale, ` +
        `hasAnyActivity=${result.standupActivity.hasAnyActivity}`
    );
  }
  if (result.standupDraftText) {
    console.log('--- draft text ---');
    console.log(result.standupDraftText);
    console.log('--- proposed transitions ---');
    console.log(JSON.stringify(result.standupProposedTransitions, null, 2));
  }
  console.log('------------------------------------------');
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${
      config.langchainProject ?? '(default)'
    }" — compare its node sequence (gatherStandupActivity -> composeStandupDraft -> ` +
      "commitStandupDraft) against this package's other trace scripts."
  );
  console.log(`Recorded to cost ledger: ${costTracker.ledgerPath}`);
}

main().catch((err) => {
  console.error('trace-invoke-deep failed:', err);
  process.exitCode = 1;
});
