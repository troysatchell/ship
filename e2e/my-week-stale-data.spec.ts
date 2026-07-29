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
 * Left as a separate finding, deliberately not fixed here: `extractPlanItems` in
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
  await expect(editor).toBeVisible({ timeout: 15000 })

  await expect(
    editor.getByRole('heading', { name: templateHeading }),
    `the editor should have received the "${templateHeading}" template from the ` +
      'collaboration server before anything is typed'
  ).toBeVisible({ timeout: 30000 })

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
    // content column was written.
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 })
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

    await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 })
    await waitForMyWeekToContain(page, 'retro', RETRO_TEXT)

    await page.getByRole('button', { name: 'Dashboard' }).click()
    await expect(page.getByRole('heading', { name: /^Week \d+$/ })).toBeVisible({ timeout: 10000 })

    await expect(
      myWeekSection(page, 'Weekly Retro').getByText(RETRO_TEXT),
      'the retro card must show the edit after client-side navigation'
    ).toBeVisible({ timeout: 15000 })
  })
})
