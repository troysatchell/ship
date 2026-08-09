/**
 * One-off manual utility (TRO-356 / FG-22) — the blocker-escalation fan-out
 * tier's own trace-link script (`trigger: 'proactive_escalation'`). TRO-346
 * built the graph path; no trace-link script existed for it before this
 * ticket. Produces a real, public trace for `detectBlockerFanout ->
 * composeBlockerEscalation -> commitBlockerEscalation` — FLEETGRAPH.MD Test
 * Case 5's own path.
 *
 * Same "deliberately NOT a test" posture as its siblings — every automated
 * test in `src/__tests__/graph.test.ts`/`blockerFanout.test.ts` uses a
 * stable fake model AND a stable fake `DeepShipClientLike`, so `pnpm test`
 * never spends money, never depends on network availability, and never
 * needs a real Ship deployment to seed against.
 *
 * Usage (from repo root, with the worktree's staged .env.local AND a real
 * Ship API token for a real logged-in user):
 *   set -a; source agent/.env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke-escalation <blockingIssueId>
 *
 * <blockingIssueId> — a real issue id on SHIP_API_BASE_URL that has 'blocks'
 * associations (POST /api/documents/:id/associations) to two or more issues
 * in a different project, assigned to people in different reporting lines.
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
      'SHIP_API_TOKEN is not set — the escalation tier has nothing to gather without a real, ' +
        "logged-in user's Ship API token (FLEETGRAPH.MD: \"no service account\")."
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
  const [blockingIssueId] = process.argv.slice(2).filter((a) => a !== '--');
  if (!blockingIssueId) {
    console.error(
      'Usage: pnpm --filter @ship/agent trace:invoke-escalation <blockingIssueId>\n' +
        'blockingIssueId: a real issue id on SHIP_API_BASE_URL with real \'blocks\' associations.'
    );
    process.exitCode = 1;
    return;
  }

  const model = new ChatAnthropic({
    apiKey,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    // TRO-368: same explicit values as the production construction
    // (index.ts) — see anthropicRequestTimeoutMs/anthropicMaxRetries in
    // config.ts for why, so every ChatAnthropic in this package is
    // consistent rather than only the server path being configured.
    maxRetries: config.anthropicMaxRetries,
    clientOptions: { timeout: config.anthropicRequestTimeoutMs },
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

  const result = await graph.invoke({ trigger: 'proactive_escalation', blockingIssueId });

  console.log('--- escalation tier (proactive_escalation) result ---');
  console.log(`Skip reason: ${result.blockerEscalationSkipReason ?? '(none — escalation was warranted)'}`);
  if (result.blockerFanoutImpact) {
    console.log(
      `Blocking issue "${result.blockerFanoutImpact.blockingIssueTitle}" — ` +
        `${result.blockerFanoutImpact.blockedIssues.length} blocked issue(s) across ` +
        `${result.blockerFanoutImpact.distinctProjectIds.length} project(s), ` +
        `${result.blockerFanoutImpact.blockedPeopleUserIds.length} distinct blocked people`
    );
  }
  if (result.blockerEscalationManager) {
    console.log(
      `Lowest common manager: reason=${result.blockerEscalationManager.reason}, ` +
        `managerUserId=${result.blockerEscalationManager.managerUserId ?? '(none)'}, ` +
        `highestReachableUserId=${result.blockerEscalationManager.highestReachableUserId ?? '(none)'}`
    );
  }
  if (result.blockerEscalationDraftText) {
    console.log('--- draft text ---');
    console.log(result.blockerEscalationDraftText);
  }
  console.log('-------------------------------------------------------');
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${
      config.langchainProject ?? '(default)'
    }" — compare its node sequence (detectBlockerFanout -> composeBlockerEscalation -> ` +
      "commitBlockerEscalation) against this package's other trace scripts."
  );
  console.log(`Recorded to cost ledger: ${costTracker.ledgerPath}`);
}

main().catch((err) => {
  console.error('trace-invoke-escalation failed:', err);
  process.exitCode = 1;
});
