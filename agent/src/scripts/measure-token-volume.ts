/**
 * One-off manual utility (TRO-620) — runs an IDENTICAL small on-demand
 * workload (one seed document, the same fixed questions) through the real
 * compiled graph, with a real Anthropic call, in whichever
 * `AGENT_PLATFORM_MODE` (`internal` | `sdk`) the environment selects, and
 * records every model call's real token usage to a per-mode cost ledger so
 * the two ledgers can be diffed. This is the measurement behind
 * `docs/submission/PF-905-AI-COST-ANALYSIS.md` §2.1 / `PF-704-COST-LEDGER-
 * DELTA.md`'s "does the sdk rewire change token volume?" question.
 *
 * Deliberately NOT a test — same posture as every `trace-invoke-*.ts`
 * sibling: every automated test uses a stable fake model, so `pnpm test`
 * never spends money or needs a network.
 *
 * Mirrors `index.ts`'s on-demand `shipClientFactory` construction exactly:
 * in `sdk` mode the per-asker `ShipClient` delegates to a `@ship/sdk`
 * client authenticated with the SAME personal token (never the app's
 * Client Credentials token — TRO-342's "no service account for on-demand
 * reads" guarantee), so this script needs no FLEETGRAPH_OAUTH_CLIENT_SECRET.
 * `askingUserId` is passed so `expansion.ts`'s `passesAskerVisibility`
 * runs for real — that is exactly the check that pre-TRO-620 sdk mode
 * failed closed on (synthesized `visibility`), dropping every document
 * from context.
 *
 * Usage (from repo root, with agent/.env holding ANTHROPIC_API_KEY, and a
 * local Ship API running against a seeded DB):
 *   AGENT_PLATFORM_MODE=sdk SHIP_API_BASE_URL=http://localhost:PORT \
 *   SHIP_API_TOKEN=<personal api token> ASKING_USER_ID=<that user's id> \
 *   AGENT_COST_LEDGER_PATH=/path/to/ledger.jsonl \
 *   pnpm --filter @ship/agent exec tsx src/scripts/measure-token-volume.ts <seedDocumentId>
 */
import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { ShipClient as SdkShipClient } from '@ship/sdk';
import { loadConfig } from '../config.js';
import { buildShipClient } from '../server.js';
import { buildGraph } from '../graph.js';
import { ShipClient } from '../shipClient.js';
import { FileCostTracker } from '../costTracking.js';

/** Fixed, identical across modes — the whole point is that ONLY the mode
 *  differs between the two runs. */
const QUESTIONS = [
  'What is this project about, and what is its current status?',
  'Which issues in this project look blocked or at risk, and why?',
  'Summarize the most recent activity on this project in three bullets.',
];

async function main() {
  const config = loadConfig();
  const seedDocumentId = process.argv[2];
  const askingUserId = process.env.ASKING_USER_ID;
  if (!config.anthropicApiKey || !config.shipApiToken || !seedDocumentId || !askingUserId) {
    console.error(
      'Requires ANTHROPIC_API_KEY, SHIP_API_TOKEN, ASKING_USER_ID and a <seedDocumentId> argument.'
    );
    process.exitCode = 1;
    return;
  }
  const mode = config.agentPlatformMode;
  const token = config.shipApiToken;

  const model = new ChatAnthropic({
    apiKey: config.anthropicApiKey,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    // Deterministic-ish output so the OUTPUT token count is comparable
    // across modes; input tokens are what the rewire could change.
    temperature: 0,
    maxRetries: config.anthropicMaxRetries,
    clientOptions: { timeout: config.anthropicRequestTimeoutMs },
  });

  const resilient = buildShipClient(config);
  const shipClientFactory = (t: string) =>
    new ShipClient({
      baseUrl: config.shipApiBaseUrl,
      token: t,
      client: resilient,
      sdk: mode === 'sdk' ? new SdkShipClient({ token: t, baseUrl: config.shipApiBaseUrl }) : undefined,
    });

  const costTracker = new FileCostTracker();
  const graph = buildGraph(
    model,
    undefined,
    { shipClientFactory, documentCap: config.onDemandDocumentCap },
    undefined,
    costTracker
  );

  console.log(`mode=${mode} seed=${seedDocumentId} ledger=${costTracker.ledgerPath}`);
  for (const [i, question] of QUESTIONS.entries()) {
    const result = await graph.invoke({
      trigger: 'on_demand',
      input: question,
      seedDocumentId,
      askingUserId,
      askingUserToken: token,
    });
    console.log(
      `[${mode}] Q${i + 1}: cited=${result.citedSources.length} capped=${result.expansionCapped} ` +
        `outputChars=${String(result.output ?? '').length}`
    );
  }
}

main().catch((err) => {
  console.error('measure-token-volume failed:', err);
  process.exitCode = 1;
});
