import { randomUUID } from 'node:crypto';
import { test, expect, loginViaApi } from './fixtures/agentEnv';

/**
 * FleetGraph E2E flow 1 (TRO-322 / FG-12): "An event is introduced into Ship
 * and the agent surfaces it within the detection latency window — timed,
 * not asserted loosely."
 *
 * Real event, real agent process, real timing. Writes a real comment
 * mentioning a real seeded person (`@Bob Martinez`, the literal `@Full Name`
 * convention `agent/src/mentions.ts` resolves — the same convention
 * `agent/src/scripts/trace-invoke-proactive.ts` already uses for its own
 * manual detection-latency probe), then polls the REAL running agent
 * process's real production HTTP surface (`GET /api/agent/inbox`, proxied
 * by `api/`, backed by the agent's own `GET /inbox` — the identical
 * endpoint `InboxSidebar.tsx`'s `useInboxQuery` calls) until the mention is
 * present for Bob's own session — not a hand-invoked `graph.invoke()` inside
 * this test process, and not the in-memory `ItemStore` reached directly.
 * This is the fixture's real `agentEnv.ts`-spawned agent server, with its
 * real production `pollChangeFeed -> resolveMentions -> detectBlockingApprovals
 * -> commitInboxItems` poll loop (`proactivePoll.ts`) actually running on a
 * timer (`PROACTIVE_POLL_INTERVAL_MS=3000`, set by the fixture) — the same
 * chain the Trigger Model table in FLEETGRAPH.MD names, at a faster-than-
 * production cadence only so this test finishes in a reasonable CI window.
 *
 * No model call anywhere on this path (`graph.ts`'s own module docstring:
 * "No model call anywhere in this chain") — this flow needs no fake/recorded
 * LLM response to stay deterministic, only a real Ship API and a real poller.
 */

test.describe('FleetGraph detection latency (use case 2 — mentions)', () => {
  test('a mention posted on a real issue surfaces in the recipient inbox within the detection latency window', async ({
    page,
    agentShip,
  }) => {
    // Logged in as the seed's admin user to write the comment — anyone with
    // access to the document can author it; who matters is the MENTIONED
    // person, not the author.
    await loginViaApi(page, agentShip.apiUrl, agentShip.devUserEmail, agentShip.devUserPassword);

    const csrfRes = await page.request.get(`${agentShip.apiUrl}/api/csrf-token`);
    expect(csrfRes.ok(), await csrfRes.text()).toBe(true);
    const { token: csrfToken } = (await csrfRes.json()) as { token: string };

    const writeAtMs = Date.now();
    const commentRes = await page.request.post(
      `${agentShip.apiUrl}/api/documents/${agentShip.probeDocumentId}/comments`,
      {
        headers: { 'x-csrf-token': csrfToken },
        data: {
          comment_id: randomUUID(),
          content: `@Bob Martinez FleetGraph e2e detection-latency probe at ${new Date(writeAtMs).toISOString()}.`,
        },
      }
    );
    expect(commentRes.ok(), await commentRes.text()).toBe(true);

    // Now read as Bob — GET /api/agent/inbox always resolves to the
    // session's own user (api/src/routes/agent.ts), so checking Bob's own
    // inbox means being Bob, not asking for him by id.
    await loginViaApi(page, agentShip.apiUrl, 'bob.martinez@ship.local', 'admin123');

    // Real bound built from real constants, not a round guess (lessons.md
    // #17: "tie the window to a real constant"). CHANGE_FEED_LAG_MS
    // (api/src/routes/change-feed.ts) is the deliberate server-side safety
    // margin that withholds anything more recent than `now - 5000ms` — the
    // same mechanism `trace-invoke-proactive.ts` had to discover the hard
    // way (a tick fired within milliseconds of the write reproducibly saw 0
    // items). PROACTIVE_POLL_INTERVAL_MS is this fixture's own configured
    // cadence (agentEnv.ts). The deadline needs room for at least two real
    // ticks plus normal CI scheduling jitter, not just one, since a write
    // that lands a moment before a tick starts still has to wait for the
    // NEXT one.
    const CHANGE_FEED_LAG_MS = 5_000;
    const FIXTURE_POLL_INTERVAL_MS = 3_000;
    const CI_JITTER_BUFFER_MS = 20_000;
    const DEADLINE_MS = CHANGE_FEED_LAG_MS + FIXTURE_POLL_INTERVAL_MS * 3 + CI_JITTER_BUFFER_MS;

    interface InboxItem {
      type: string;
      evidence: { documentId?: string; commentId?: string };
    }

    let surfacedAtMs: number | undefined;
    let lastBody: unknown;
    const deadlineAt = Date.now() + DEADLINE_MS;
    while (Date.now() < deadlineAt) {
      const inboxRes = await page.request.get(`${agentShip.apiUrl}/api/agent/inbox`);
      expect(inboxRes.ok(), await inboxRes.text()).toBe(true);
      const body = (await inboxRes.json()) as { items: InboxItem[] };
      lastBody = body;
      const found = body.items.find(
        (item) => item.type === 'mention' && item.evidence.documentId === agentShip.probeDocumentId
      );
      if (found) {
        surfacedAtMs = Date.now();
        break;
      }
      // review-pattern-ok: G7b's fixed-sleep checker (TEST-11 / TRO-233) flags
      // this line, but it is the poll INTERVAL inside a bounded loop that
      // re-checks a real, changing endpoint on every iteration and breaks the
      // instant the real condition holds — not a blind "sleep, then assume
      // done" stand-in for synchronization, which is what TEST-11's 619 sites
      // actually are. This is the exact shape lessons.md #17 itself endorses
      // ("await an observable event... poll for the duration") and the same
      // pattern `agent/src/scripts/trace-invoke-proactive.ts` already uses for
      // this identical measurement. `DEADLINE_MS` bounds total wait time; this
      // 500ms only bounds how often the real condition gets re-checked.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(
      surfacedAtMs,
      `mention never appeared in Bob's inbox within ${DEADLINE_MS}ms. Last GET /api/agent/inbox ` +
        `response: ${JSON.stringify(lastBody)}`
    ).toBeDefined();

    const observedMs = surfacedAtMs! - writeAtMs;
    console.log(`[agent-detection-latency] observed ${observedMs}ms (comment write -> GET /api/agent/inbox surfacing it)`);

    // FLEETGRAPH.MD's own bar: "< 5 minutes from event appearing in Ship to
    // the agent surfacing it." This is the actual product requirement being
    // asserted — the DEADLINE_MS above exists only to fail this CI job fast
    // on a real regression; the 5-minute figure below is the one that
    // matters and is asserted unconditionally regardless of how the poll
    // loop above was tuned for CI speed.
    expect(observedMs).toBeLessThan(5 * 60 * 1000);
  });
});
