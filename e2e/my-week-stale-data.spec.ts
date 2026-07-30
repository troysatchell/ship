import { test, expect, Page } from './fixtures/isolated-env'

/**
 * Tests that /my-week reflects plan/retro edits after navigating back.
 *
 * Bug: The my-week query had a 5-minute staleTime and content edits go through
 * Yjs WebSocket (no client-side mutation), so navigating back showed stale data.
 * Fix: staleTime set to 0 so every mount refetches fresh data from the API.
 *
 * ---
 *
 * TRO-225 (audit finding TEST-3): the retro test below failed or timed out on
 * the **first attempt in all three** audit runs and was reported as passing all
 * three times, because `playwright.config.ts` retries once locally. The file
 * header used to blame Yjs persistence timing and recommend "investigation on a
 * separate branch". That diagnosis was wrong.
 *
 * Observed, 2026-07-29, this worktree, `--workers=1 --retries=0`:
 *
 *   whole file            -> plan passes, retro FAILS (element not found)
 *   `-g "retro edits"`    -> retro PASSES
 *
 * The retro test did not fail on its own merits. It failed **because the plan
 * test ran first in the same worker's database** — the "shared state inside a
 * worker's database" root cause the finding names.
 *
 * Mechanism (read from the code, consistent with the above): when a weekly plan
 * already exists for the same person+week, `POST /api/weekly-retros`
 * (`api/src/routes/weekly-plans.ts:641-656`) swaps `WEEKLY_RETRO_TEMPLATE` for
 * `buildRetroTemplateWithPlanItems(...)` — heading, then a `planReference` node
 * and an empty `paragraph` per plan item, then an "Unplanned work" heading and a
 * 3-item bullet list. The old test clicked the editor's *centre*, so in that
 * taller document the caret landed in a top-level paragraph instead of inside a
 * list item. `extractPlanItems` in `api/src/routes/dashboard.ts:279-309` collects
 * only `listItem`/`taskItem` text, so the typed line never reached the /my-week
 * card and the retro rendered with zero items.
 *
 * Two changes remove the dependency without hiding anything:
 *   1. the caret is placed in the first empty list item explicitly, so the typed
 *      text lands in the same node type whichever template the API produced;
 *   2. `page.waitForTimeout(3000)` — a guess at how long persistence takes — is
 *      replaced by polling the API until the content is actually readable, which
 *      also localises the failure if persistence really is the problem.
 *
 * COLLAB-RACE — a second, independent finding, surfaced by the change above and
 * deliberately NOT fixed here. Once the test asserted that the template content
 * had arrived (instead of typing into whatever was on screen), it started failing
 * *for a different reason*: a freshly created weekly plan/retro sometimes never
 * receives its template at all. Observed at `--workers=1 --retries=0`, three
 * repeat runs: run 1 clean, run 2 the plan document blank, run 3 the retro
 * document blank. To a user that is a brand-new plan opening as an empty editor.
 *
 * Derived from code, not instrumented: `getOrCreateDoc`
 * (`api/src/collaboration/index.ts:220-226`) publishes the new `Y.Doc` into the
 * shared `docs` map *before* awaiting the DB read and `jsonToYjs` conversion at
 * `:231-266`, and registers the broadcasting `doc.on('update')` handler only
 * afterwards. A second connection for the same document arriving inside that
 * window is handed the empty doc, is sent `writeSyncStep1` from it, and never
 * receives the conversion update; `freshFromJsonDocs.delete(docName)` after the
 * first client compounds it. The shape of the fix is to store the load *promise*
 * in the map so concurrent callers await the same load. This also explains the
 * *other* my-week entry on the flake list (`plan edits …`, flaky in 1 of 3 audit
 * runs), which the plan/retro template coupling does not.
 *
 * Until that is fixed, the setup below tolerates it with one bounded reload and
 * says so in the failure message. It does not hide it.
 *
 * Left as a third finding, deliberately not fixed here: `extractPlanItems` in
 * `dashboard.ts` ignores top-level paragraphs, while the copies in
 * `weekly-plans.ts:63-95` and `services/ai-analysis.ts:69` include paragraphs
 * longer than 10 characters. So a user who writes their retro in the empty
 * paragraph *under* each auto-populated plan reference — the surface
 * `buildRetroTemplateWithPlanItems` creates for exactly that purpose — sees an
 * empty retro card on /my-week. That is a product bug, not a test bug, and
 * changing what /my-week displays is out of scope for a test-integrity ticket.
 */

const PLAN_TEXT = 'Ship the new dashboard feature'
const RETRO_TEXT = 'Completed the API refactoring'

// The <h2> each template opens with (api/src/routes/weekly-plans.ts:13-53 and
// buildRetroTemplateWithPlanItems). Waiting for it proves the document content
// reached the editor; `.tiptap` goes visible well before that.
const PLAN_TEMPLATE_HEADING = 'What I plan to accomplish this week'
const RETRO_TEMPLATE_HEADING = 'What I delivered this week'

// Both templates are wider than one test: the two tests below run in the same
// worker database, and creating a retro when a plan already exists produces a
// different retro template. Serial mode makes the order explicit rather than
// leaving it to worker assignment, which is what made TEST-3 look like a flake.
test.describe.configure({ mode: 'serial' })

/**
 * Place the caret in the first bullet list item of the open editor and type.
 *
 * Two separate reasons this is not `editor.click()`:
 *
 *  - **Where the caret lands.** Clicking the container puts it wherever the
 *    centre of the document happens to be, which depends on the template the API
 *    generated — and the retro template's shape depends on whether a plan
 *    already exists. Targeting the list item makes the typed text land in the
 *    node type `/my-week` reads, whatever the template.
 *  - **Whether the content has arrived.** These documents are created by the API
 *    with template JSON and no `yjs_state`; the editor receives them only after
 *    the collaboration server's JSON-to-Yjs conversion
 *    (`api/src/collaboration/index.ts:240-266`). `.tiptap` becomes visible before
 *    that lands, so waiting for the template heading is what makes the rest of
 *    the test meaningful rather than a race. Observed: without this wait the
 *    typed text can go into an editor that is still empty.
 */
async function typeIntoTemplateList(
  page: Page,
  templateHeading: string,
  text: string
): Promise<void> {
  const editor = page.locator('.tiptap')
  const heading = editor.getByRole('heading', { name: templateHeading })

  // Reload-and-retry, bounded, and *only* here in setup. A freshly created weekly
  // plan/retro sometimes opens blank — see COLLAB-RACE in the header. A reload
  // opens a new WebSocket connection, by which time the server's cached Y.Doc is
  // populated. This is a workaround for a product defect, not a fix for it, and it
  // is deliberately loud: if the template never arrives, the test fails naming the
  // finding rather than typing into an empty editor the way the old test did.
  //
  // `toPass` is the repo's sanctioned retry construct (e2e/AGENTS.md guideline 2).
  let attempt = 0
  await expect(async () => {
    if (attempt > 0) await page.reload()
    attempt += 1
    await expect(editor).toBeVisible({ timeout: 10000 })
    await expect(
      heading,
      `the editor never received the "${templateHeading}" template from the ` +
        'collaboration server (attempt ' +
        attempt +
        '). This is COLLAB-RACE, not a test bug — see this file\'s header and ' +
        'api/src/collaboration/index.ts:220-226.'
    ).toBeVisible({ timeout: 8000 })
    // Worst case per attempt: 10s editor wait + 8s heading wait = 18s, and a
    // second attempt adds a reload on top. 32s left no headroom for two full
    // attempts, so `toPass`'s own timeout could fire mid-attempt-two with a
    // generic timeout error instead of the actionable COLLAB-RACE message
    // above — the same "assertion never gets to run" shape this file exists to
    // remove. 45s covers 2 x 18s plus reload overhead.
  }).toPass({ timeout: 45000, intervals: [500] })

  const firstListItem = editor.locator('li').first()
  await expect(
    firstListItem,
    'the plan/retro template should provide at least one empty bullet list item ' +
      'to type into (api/src/routes/weekly-plans.ts templates)'
  ).toBeVisible({ timeout: 15000 })

  await firstListItem.click()
  await page.keyboard.type(text)

  await expect(
    editor.locator('li', { hasText: text }).first(),
    'the typed text should land inside a list item — that is the node type ' +
      '/my-week extracts (api/src/routes/dashboard.ts:279)'
  ).toBeVisible({ timeout: 10000 })
}

/**
 * Wait until the /my-week API itself returns the text, rather than sleeping.
 *
 * This separates "the collaboration server has not persisted yet" from "the page
 * rendered stale data" — the two failure modes this file exists to tell apart.
 */
async function waitForMyWeekToContain(
  page: Page,
  section: 'plan' | 'retro',
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/dashboard/my-week')
        if (!res.ok()) return `HTTP ${res.status()}`
        const body = await res.json()
        const items: Array<{ text?: string }> = body?.[section]?.items ?? []
        return items.map((i) => i.text ?? '').join(' | ')
      },
      {
        message:
          `GET /api/dashboard/my-week should report the ${section} item once the ` +
          `collaboration server has persisted it to documents.content`,
        timeout: 30000,
        intervals: [500, 1000, 2000, 2000],
      }
    )
    .toContain(text)
}

/**
 * The /my-week card for the given section, so assertions cannot cross-match the
 * other card. Filtered on `textContent` rather than accessible name because the
 * headings are CSS-uppercased.
 */
function myWeekSection(page: Page, heading: 'Weekly Plan' | 'Weekly Retro') {
  return page.locator('section').filter({ hasText: heading })
}

test.describe('My Week - stale data after editing plan/retro', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('plan edits are visible on /my-week after navigating back', async ({ page }) => {
    await page.goto('/my-week')
    await expect(page.getByRole('heading', { name: /^Week \d+$/ })).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /create plan for this week/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

    await typeIntoTemplateList(page, PLAN_TEMPLATE_HEADING, PLAN_TEXT)

    // "Saved" means the WebSocket synced; the API poll below is what proves the
    // content column was written. Playwright's string getByText matches
    // case-insensitively and by substring, so a bare `getByText('Saved')` would
    // also match the indicator's own failure state, "Not saved"
    // (SyncStatusIndicator.tsx) — exactly the kind of assertion that reports
    // success while observing the opposite this ticket exists to remove.
    // Target the indicator by its stable test id and require an exact label.
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })
    await waitForMyWeekToContain(page, 'plan', PLAN_TEXT)

    // Navigate back with client-side routing (Dashboard icon in the rail).
    await page.getByRole('button', { name: 'Dashboard' }).click()
    await expect(page.getByRole('heading', { name: /^Week \d+$/ })).toBeVisible({ timeout: 10000 })

    await expect(
      myWeekSection(page, 'Weekly Plan').getByText(PLAN_TEXT),
      'the plan card must show the edit after client-side navigation — a stale ' +
        'react-query cache is the bug this test guards'
    ).toBeVisible({ timeout: 15000 })
  })

  test('retro edits are visible on /my-week after navigating back', async ({ page }) => {
    await page.goto('/my-week')
    await expect(page.getByRole('heading', { name: /^Week \d+$/ })).toBeVisible({ timeout: 10000 })

    // The main create button, not the previous-week nudge link.
    await page.getByRole('button', { name: /create retro for this week/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

    await typeIntoTemplateList(page, RETRO_TEMPLATE_HEADING, RETRO_TEXT)

    // See the plan test above: exact match against the stable test id, not a
    // substring match that "Not saved" would also satisfy.
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })
    await waitForMyWeekToContain(page, 'retro', RETRO_TEXT)

    await page.getByRole('button', { name: 'Dashboard' }).click()
    await expect(page.getByRole('heading', { name: /^Week \d+$/ })).toBeVisible({ timeout: 10000 })

    await expect(
      myWeekSection(page, 'Weekly Retro').getByText(RETRO_TEXT),
      'the retro card must show the edit after client-side navigation'
    ).toBeVisible({ timeout: 15000 })
  })
})
