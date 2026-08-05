/**
 * One-off manual utility (TRO-324 / FG-13) — the proactive deterministic
 * tier's own trace-link script, mirroring `trace-invoke.ts` (FG-2 / TRO-313)
 * and `trace-invoke-on-demand.ts` (FG-7 / TRO-318). No equivalent script
 * existed for FG-5's `proactive_fast`/`proactive_steady` path before this
 * ticket (verified: `agent/src/scripts/` held only the two `on_demand`
 * scripts and `cost-report.ts` before this file was added).
 *
 * This path calls NO model by design — FLEETGRAPH.MD's Trigger Model table
 * says "No model." on both the fast and steady tiers, and `graph.ts`'s own
 * module docstring confirms: `pollChangeFeed -> resolveMentions ->
 * detectBlockingApprovals -> commitInboxItems -> END` is pure Ship reads
 * (mention resolution, blocking-approval detection). BUT LangSmith traces
 * ANY traced Runnable invocation once `LANGCHAIN_TRACING_V2=true`, not only
 * LLM calls — so a real trace showing this genuinely different (shorter,
 * deterministic, no `respond`/`composeAnswer`/`composeStandupDraft` node
 * anywhere in it) execution path is producible without spending a cent on
 * the model. The `model` argument `buildGraph` requires positionally is
 * therefore a NEVER-INVOKED stub here: if it is ever actually called, this
 * script throws loudly rather than silently making a real (and
 * structurally wrong) paid call on a path that is not supposed to make one.
 *
 * Doubles as this ticket's real, timed detection-latency measurement
 * (FLEETGRAPH.MD's "< 5 minutes from event appearing in Ship to the agent
 * surfacing it" bar): writes one real comment mentioning a real person
 * (literal `@Full Name` text — the convention `mentions.ts`'s own docstring
 * verifies against `api/src/db/seed.ts`'s FG-3 fixture and
 * `CommentDisplay.tsx`'s plain-text input), records the wall-clock instant
 * of that write, immediately runs one real proactive-tier graph invocation
 * against `SHIP_API_BASE_URL`, and reports how long elapsed before the
 * resulting mention item is present in the (real) `ItemStore` for that
 * person. This measures ONE tick's real event-to-surfaced latency — it does
 * NOT include the up-to-`PROACTIVE_POLL_INTERVAL_MS` wait a running
 * production poller would add if the real event happened to land just
 * after a real tick had already started; see this script's own final
 * printout for the DERIVED (not observed) worst-case bound built from this
 * measurement plus the configured poll interval — never presented with the
 * same confidence as the observed number (this repo's provenance rules).
 *
 * Deliberately NOT a test — same posture as its two siblings: every
 * automated test in `src/__tests__/` (`proactive.test.ts`, `graph.test.ts`)
 * uses stable fakes, so `pnpm test` never spends money, never depends on
 * network availability, and never writes a real comment into a real
 * database.
 *
 * Usage (from repo root, with the worktree's staged .env.local AND a real
 * Ship API token for a real logged-in user):
 *   set -a; source .env.local; set +a
 *   pnpm --filter @ship/agent trace:invoke-proactive -- <seedDocumentId> <personName>
 *
 * <seedDocumentId> — a real, commentable document id on SHIP_API_BASE_URL
 *   (e.g. one of the FG-3 fixture ids `pnpm db:seed` prints).
 * <personName> — the exact `name` of a real Person document on that same
 *   instance who has a linked `user_id` (`GET /api/team/people`) — the
 *   comment mentions them as literal `@<personName>` text. Pick someone
 *   NOT already mentioned by nearby seed/fixture activity, or the "only one
 *   real item, and it's the one this script wrote" check below may see a
 *   pre-existing item instead of (or alongside) the new one.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { buildShipClient } from '../server.js';
import { buildGraph, type AnthropicModel } from '../graph.js';
import { ShipClient } from '../shipClient.js';
import { InMemoryItemStore } from '../itemStore.js';

/** The one field this script actually needs from `GET /api/team/people`'s
 * response shape — typed explicitly rather than trusting `unknown` (repo
 * rule: type the boundary a JSON parse hands you, lessons.md #21). */
interface PersonDirectoryEntry {
  id: string;
  name: string;
  user_id?: string | null;
}

function isPersonDirectoryEntry(value: unknown): value is PersonDirectoryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

function extractPeopleList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  return [];
}

async function main() {
  const config = loadConfig();

  if (!config.shipApiToken) {
    console.error(
      'SHIP_API_TOKEN is not set — this path has nothing to poll without a real, logged-in ' +
        "user's Ship API token (FLEETGRAPH.MD: \"no service account\")."
    );
    process.exitCode = 1;
    return;
  }

  // Same refusal posture as trace-invoke.ts / trace-invoke-on-demand.ts: a
  // real run that produces no trace is worse than useless, even though this
  // particular path spends no API money either way.
  const tracingEnabled = config.langchainTracingV2;
  const langsmithApiKey = process.env.LANGCHAIN_API_KEY ?? process.env.LANGSMITH_API_KEY;
  if (!tracingEnabled || !langsmithApiKey) {
    console.error(
      'Refusing to run: this script only exists to produce a LangSmith trace-link proof, and ' +
        'tracing is not fully configured.' +
        (!tracingEnabled ? ' LANGCHAIN_TRACING_V2 is not exactly "true".' : '') +
        (!langsmithApiKey ? ' Neither LANGCHAIN_API_KEY nor LANGSMITH_API_KEY is set.' : '')
    );
    process.exitCode = 1;
    return;
  }

  const [seedDocumentId, personName] = process.argv.slice(2);
  if (!seedDocumentId || !personName) {
    console.error(
      'Usage: pnpm --filter @ship/agent trace:invoke-proactive -- <seedDocumentId> <personName>\n' +
        'seedDocumentId: a real, commentable document id on SHIP_API_BASE_URL.\n' +
        'personName: the exact name of a real Person with a linked user_id (GET /api/team/people).'
    );
    process.exitCode = 1;
    return;
  }

  // This path calls no model by design. A stub that throws if ever actually
  // invoked is deliberately used instead of a real ChatAnthropic — this
  // script has no legitimate reason to hold (or spend against) an
  // ANTHROPIC_API_KEY at all.
  const neverInvokedModel: AnthropicModel = {
    invoke(): Promise<{ content: unknown }> {
      throw new Error(
        'trace-invoke-proactive: model.invoke() was called on the proactive_steady path — this ' +
          'should be structurally impossible (no respond/composeAnswer/composeStandupDraft node ' +
          'runs on this trigger, per graph.ts\'s routeTrigger). If this fires, something is wrong.'
      );
    },
  };

  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    token: config.shipApiToken,
    client: buildShipClient(config),
  });

  // Resolve the mentioned person's user id up front so we know which
  // recipient's list to check afterward — never guessed.
  const peopleRes = await fetch(`${config.shipApiBaseUrl}/api/team/people`, {
    headers: { Authorization: `Bearer ${config.shipApiToken}` },
  });
  if (!peopleRes.ok) {
    console.error(`GET /api/team/people failed: ${peopleRes.status} ${await peopleRes.text()}`);
    process.exitCode = 1;
    return;
  }
  const peopleList = extractPeopleList(await peopleRes.json());
  const person = peopleList.filter(isPersonDirectoryEntry).find((p) => p.name === personName);
  if (!person?.user_id) {
    console.error(`No person named "${personName}" with a linked user_id was found via GET /api/team/people.`);
    process.exitCode = 1;
    return;
  }

  const itemStore = new InMemoryItemStore();
  const graph = buildGraph(neverInvokedModel, { shipClient, itemStore });

  // A short (60s) lookback fixed to just before the write below — not
  // FG-5's own bootstrap default (24h), which on a freshly-seeded,
  // busy-with-fixture-activity dev database risks the change feed's
  // LIMIT/ORDER BY ASC page filling with older rows before ever reaching
  // this run's own write. Long enough to comfortably predate the POST
  // below; short enough to stay clear of unrelated seed-time activity.
  const cursorBeforeWrite = new Date(Date.now() - 60_000).toISOString();

  console.log(`Writing a real comment mentioning "@${personName}" on document ${seedDocumentId}...`);
  const t0 = Date.now();
  const commentRes = await fetch(`${config.shipApiBaseUrl}/api/documents/${seedDocumentId}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.shipApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      comment_id: randomUUID(),
      content: `@${personName} FYI — trace-invoke-proactive.ts detection-latency probe at ${new Date(t0).toISOString()}.`,
    }),
  });
  if (!commentRes.ok) {
    console.error(`POST .../comments failed: ${commentRes.status} ${await commentRes.text()}`);
    process.exitCode = 1;
    return;
  }

  // Ship's own change-feed endpoint deliberately withholds anything more
  // recent than `now - CHANGE_FEED_LAG_MS` (api/src/routes/change-feed.ts,
  // 5000ms as of this run) — a real, correct safety margin against a
  // slower transaction committing after a faster one's timestamp
  // (FLEETGRAPH.MD's own "the cursor must lag" reliability point). A
  // single tick fired within milliseconds of the write is therefore
  // GUARANTEED to miss it, by design, not by bug — confirmed by direct
  // reproduction while building this script (a first attempt at this exact
  // measurement returned 0 items every time). So this polls a bounded
  // number of REAL, independently-traced graph invocations (never a blind
  // fixed sleep, lessons.md #17) until the item is actually observed
  // present, which is what a running production poller effectively does
  // too — the next tick, not this one, is what would normally catch a
  // change written mid-cycle.
  const POLL_INTERVAL_MS = 1_000;
  const MAX_POLL_ATTEMPTS = 20; // 20s ceiling — comfortably above the 5s lag, nowhere near the 5-minute bar

  console.log('Polling with real proactive_steady graph invocations until the item is observed...');
  let surfaced: ReturnType<typeof itemStore.list>[number] | undefined;
  let t1 = Date.now();
  let lastTickMs = 0;
  let attempts = 0;
  for (; attempts < MAX_POLL_ATTEMPTS; attempts++) {
    const tickStart = Date.now();
    await graph.invoke({ trigger: 'proactive_steady', cursor: cursorBeforeWrite });
    t1 = Date.now();
    lastTickMs = t1 - tickStart;
    const items = itemStore.list(person.user_id);
    surfaced = items.find((i) => i.type === 'mention' && i.evidence.documentId === seedDocumentId);
    if (surfaced) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!surfaced) {
    console.error(
      `The mention was NOT found in ${personName}'s inbox after ${attempts} real tick(s) over ` +
        `~${attempts * POLL_INTERVAL_MS}ms. Possible causes: the change feed has not yet indexed the ` +
        'new comment, the cursor window missed it, or a real bug. Not reporting a latency number for ' +
        'a negative result.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Observed after ${attempts + 1} real tick(s).`);

  const observedMs = t1 - t0;
  console.log('--- detection latency (TRO-324 / FG-13) ---');
  console.log(`Event written at:      ${new Date(t0).toISOString()}`);
  console.log(`Surfaced in inbox by:  ${new Date(t1).toISOString()}`);
  console.log(
    `OBSERVED, this run:    ${observedMs}ms — real comment write -> real proactive_steady graph ` +
      `invocation(s) (${attempts + 1} real, independently-traced tick(s), ${POLL_INTERVAL_MS}ms apart) ` +
      'completing with the mention item present in a real ItemStore, for a real recipient, resolved ' +
      'via a real GET /api/team/people call. This is a single agent process polling as fast as it ' +
      'safely can (bounded below by change-feed.ts\'s own 5000ms CHANGE_FEED_LAG_MS safety margin) — ' +
      'a slightly OPTIMISTIC bound relative to a real deployment ticking once every ' +
      `${config.proactivePollIntervalMs}ms (see the derived worst case below).`
  );
  console.log(`This run's own last tick's processing time (the graph.invoke() call alone): ${lastTickMs}ms.`);
  console.log(
    `DERIVED worst-case bound for a running production poller: ~${config.proactivePollIntervalMs + lastTickMs}ms ` +
      `= configured PROACTIVE_POLL_INTERVAL_MS (${config.proactivePollIntervalMs}ms) + this run's own ` +
      "single-tick processing time. NOT observed directly — it covers the case where the event lands " +
      "immediately after a running poller's tick already started, so the event waits a full interval " +
      "before the NEXT tick catches it (which, per this run's own OBSERVED number above, comfortably " +
      "will, well inside change-feed's 5s lag). Marked derived, not observed, per this repo's " +
      "provenance rules — never presented with the observed number's confidence."
  );
  console.log('');
  console.log('Surfaced item:', JSON.stringify(surfaced, null, 2));
  console.log('--------------------------------------------');
  console.log(
    `Check https://smith.langchain.com for a new trace in project "${config.langchainProject ?? '(default)'}" ` +
      "— compare its node sequence (pollChangeFeed -> resolveMentions -> detectBlockingApprovals -> " +
      "commitInboxItems, no model spans anywhere) against trace-invoke.ts's / " +
      "trace-invoke-on-demand.ts's traces."
  );
  console.log(`Cursor this run used: ${cursorBeforeWrite}`);
  console.log(`Attempts: ${attempts + 1} (of a ${MAX_POLL_ATTEMPTS}-attempt ceiling)`);
}

main().catch((err) => {
  console.error('trace-invoke-proactive failed:', err);
  process.exitCode = 1;
});
