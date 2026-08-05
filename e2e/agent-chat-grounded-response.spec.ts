import { test, expect, loginAsDevUser } from './fixtures/agentEnv';

/**
 * FleetGraph E2E flow 2 (TRO-322 / FG-12): "A user invokes the agent from
 * the context-aware chat interface and gets a grounded (source-naming)
 * response."
 *
 * Drives the real chat surface end to end: the floating FleetGraph pill
 * (`web/src/components/agent/AgentPill.tsx`) -> `AgentChatPanel.tsx`'s
 * question form -> `POST /api/agent/chat` (`api/src/routes/agent.ts`,
 * session-authed, same-origin) -> the real agent server's own `POST /chat`
 * (`agent/src/server.ts`) -> the real compiled LangGraph graph
 * (`resolveSeed -> expandFrontier -> finalizeExpansion -> composeAnswer`,
 * on-demand expansion, FG-7) -> back through both proxies to the browser.
 *
 * The one substitution anywhere in that chain is the model call itself:
 * the fixture's agent process runs `agent/src/scripts/e2e-server.ts`, a
 * stable, deterministic fake in place of `ChatAnthropic` (the ticket's own
 * mocking rule — "stable fakes or recorded fixtures, not live services").
 * That does not weaken "grounded" here: `citedSources` is built by
 * `finalizeExpansion` directly from the documents the walk actually
 * visited, independent of anything the model writes (`graph.ts`'s own
 * module docstring) — the citation this test asserts on is real Ship data,
 * walked for real, through the real graph.
 */

test.describe('FleetGraph chat grounded response (use case 6 — on-demand expansion)', () => {
  test('asking about the open document returns an answer that names its source document', async ({
    page,
    agentShip,
  }) => {
    await loginAsDevUser(page, agentShip);

    // Navigate straight to the seeded probe issue via the canonical unified-
    // document route (main.tsx: `issues/:id` is a redirect onto this same
    // route, so going here directly skips that extra hop) — AgentPill/
    // AgentChatPanel seed every question with whatever document is
    // currently open (AgentChatPanel.tsx's own docstring: "no
    // `question`-scoping prop exists, only `documentId`").
    await page.goto(`/documents/${agentShip.probeDocumentId}`);
    await expect(page.getByText(agentShip.probeDocumentTitle).first()).toBeVisible({ timeout: 15_000 });

    const pillButton = page.getByRole('button', { name: /FleetGraph/ });
    await expect(pillButton).toBeVisible({ timeout: 15_000 });
    await pillButton.click();

    const chatRegion = page.getByRole('region', { name: 'FleetGraph chat' });
    await expect(chatRegion).toBeVisible();

    const questionInput = page.locator('#agent-chat-question');
    await expect(questionInput).toBeEnabled({ timeout: 10_000 });
    await questionInput.fill('What is the status of this issue?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    // The panel's own degradation contract (AgentChatPanel.tsx): a "loading"
    // status region while in flight, then either an answer or a visible
    // degraded message via role="alert" — never an unresolving spinner.
    // Waiting out the loading region first, rather than racing straight for
    // "Sources", makes a genuine failure (a degraded/alert message) show up
    // as a clear assertion failure below instead of a bare timeout.
    //
    // Scoped to `chatRegion`, not `page` — the document list/sidebar renders
    // its own unrelated `role="status"`/`role="alert"` regions (one per row,
    // for their own async states), so an unscoped `page.getByRole('alert')`
    // resolves to several elements and fails Playwright's strict-mode check
    // before it ever gets to read the chat panel's own alert text.
    await expect(chatRegion.getByRole('status').getByText('Thinking…')).toBeVisible({ timeout: 10_000 });
    await expect(chatRegion.getByRole('status').getByText('Thinking…')).not.toBeVisible({ timeout: 30_000 });

    // By this point loading has already resolved one way or the other — a
    // stable read, not a retrying assertion, is the right tool: fail with
    // the actual degraded message rather than a bare "not visible" timeout.
    const alertText = (await chatRegion.getByRole('alert').textContent())?.trim() ?? '';
    expect(alertText, `Agent chat degraded instead of answering: "${alertText}"`).toBe('');

    // Grounded = names its sources. "Sources" only renders once the answer
    // has an answer AND at least one citedSources entry (AnswerBlock's own
    // `done &&` gate) — asserting its presence is asserting citedSources was
    // non-empty, which is also what AgentChatPanel itself requires before
    // ever reaching the "answered" state (a citations-less response is
    // rendered as degraded, not as an answer with no sources).
    await expect(chatRegion.getByText('Sources')).toBeVisible({ timeout: 5_000 });

    // The seed document itself is always the first visited/cited document
    // (`resolveSeed`, graph.ts) — its title must appear in the sources list,
    // naming the actual Ship document the answer drew from, not a generic
    // "grounded" claim with nothing to check it against. The expansion walk
    // (FG-7) may pull in several MORE documents beyond the seed — the probe
    // issue's own project/program associations are real Ship data too — so
    // the sources `<ol>` legitimately holds more than one `<li>`.
    // `toContainText` checks the ALREADY-RESOLVED `sourcesList` element's
    // own text rather than creating a second nested `getByText(...)` search
    // over its descendants, which is what produced a "resolved to 6
    // elements" strict-mode failure here (every `<li>` in a multi-source
    // list is itself a valid partial match for a chained `getByText`).
    const sourcesList = chatRegion.locator('ol').filter({ hasText: agentShip.probeDocumentTitle }).first();
    await expect(sourcesList).toBeVisible();
    await expect(sourcesList).toContainText(agentShip.probeDocumentTitle);
  });
});
