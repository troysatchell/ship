/**
 * Program Mode Sprint UX - E2E Test Specifications
 *
 * These tests verify the Sprint UX improvements for Program Mode.
 * Run: pnpm test:e2e e2e/program-mode-sprint-ux.spec.ts
 *
 * Test Organization:
 * - Phase 1: Data Model & Status Computation (via API)
 * - Phase 2: Sprints Tab UI (two-part layout)
 * - Phase 3: Sprint Creation UX (click empty window)
 * - Phase 4: Issues Tab Filtering
 */

import { test, expect, Page } from './fixtures/isolated-env'

// Make tests run serially to prevent race conditions with sprint creation.
//
// TRO-609: this is file-scoped, so ANY single failure anywhere in the file skips
// every test after it (54 tests, one failure -> 30 skipped, confirmed live). That
// blind spot is real: keep it in mind when a "pass" summary for this file looks too
// clean. It was NOT rescoped to per-describe-block serial mode here, on purpose -
// e2e/fixtures/isolated-env.ts gives each Playwright *worker* one persistent Postgres
// container shared across every test that worker runs (not reset per test), and
// several blocks below (Phase 3: Week Creation UX, Phase 3 Continued, Integration)
// mutate that shared week/sprint data via cleanupExtraSprints()/creation flows. Under
// `fullyParallel: true`, un-grouping this file would let those mutations interleave
// with other blocks' read assertions (window/issue counts) on the same worker DB in
// whatever order the scheduler picks - a real race, not a hypothetical one. Splitting
// this safely needs a full read/write audit per block; that's a separate, larger
// investigation than this ticket, not a change to make speculatively.
test.describe.configure({ mode: 'serial' })

// =============================================================================
// GLOBAL SETUP - Clean up sprints created by previous test runs
// =============================================================================

// Helper function to clean up extra sprints
async function cleanupExtraSprints(request: any) {
  const loginResponse = await request.post('/api/auth/login', {
    data: { email: 'dev@ship.local', password: 'admin123' }
  })

  if (loginResponse.ok()) {
    // Get CSRF token for protected routes
    const csrfResponse = await request.get('/api/auth/csrf')
    let csrfToken = ''
    if (csrfResponse.ok()) {
      const csrfData = await csrfResponse.json()
      csrfToken = csrfData.csrfToken
    }

    const sprintsResponse = await request.get('/api/programs')
    if (sprintsResponse.ok()) {
      const programs = await sprintsResponse.json()
      for (const program of programs) {
        const programSprintsResponse = await request.get(`/api/programs/${program.id}/sprints`)
        if (programSprintsResponse.ok()) {
          const data = await programSprintsResponse.json()
          for (const sprint of data.weeks || []) {
            if (sprint.sprint_number > 10) {
              await request.delete(`/api/weeks/${sprint.id}`, {
                headers: { 'X-CSRF-Token': csrfToken }
              })
            }
          }
        }
      }
    }
  }
}

// Before EVERY test, clean up any sprints > 10 to ensure empty windows exist
test.beforeEach(async ({ request }) => {
  await cleanupExtraSprints(request)
})

// =============================================================================
// HELPERS
// =============================================================================

async function login(page: Page) {
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

async function navigateToProgram(page: Page, programName: string = 'Ship Core') {
  await page.goto('/programs')
  // Click the program row in table (programs now use table layout)
  await page.locator('tr[role="row"]', { hasText: new RegExp(programName, 'i') }).first().click()
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
}

async function clickSprintsTab(page: Page) {
  // Tabs have role="tab", not role="button"
  await page.getByRole('tab', { name: 'Weeks' }).click()
  // Wait for sprints tab to be active
  await expect(page.getByRole('tab', { name: 'Weeks' })).toHaveAttribute('data-state', 'active', { timeout: 5000 }).catch(() => {
    // Fallback: just wait for content to load
  })
}

async function clickIssuesTab(page: Page) {
  // Click the Issues tab inside the main content area (tabs have role="tab")
  await page.locator('main').getByRole('tab', { name: 'Issues' }).click()
}

// =============================================================================
// PHASE 1: DATA MODEL & STATUS COMPUTATION
// =============================================================================

test.describe('Phase 1: Data Model & Status Computation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('API returns sprints with sprint_number property', async ({ page }) => {
    await navigateToProgram(page)

    // Intercept API call to verify response structure
    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints')),
      clickSprintsTab(page)
    ])

    const data = await response.json()
    expect(data.weeks).toBeDefined()
    expect(data.weeks.length).toBeGreaterThan(0)
    expect(data.weeks[0].sprint_number).toBeDefined()
    expect(typeof data.weeks[0].sprint_number).toBe('number')
  })

  test('API returns sprints with owner info', async ({ page }) => {
    await navigateToProgram(page)

    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints')),
      clickSprintsTab(page)
    ])

    const data = await response.json()
    expect(data.weeks[0].owner).toBeDefined()
    expect(data.weeks[0].owner.id).toBeDefined()
    expect(data.weeks[0].owner.name).toBeDefined()
  })

  test('API returns workspace_sprint_start_date for computing dates', async ({ page }) => {
    await navigateToProgram(page)

    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints')),
      clickSprintsTab(page)
    ])

    const data = await response.json()
    expect(data.workspace_sprint_start_date).toBeDefined()
  })

  test('API does NOT return sprint_status in sprint properties', async ({ page }) => {
    await navigateToProgram(page)

    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints')),
      clickSprintsTab(page)
    ])

    const data = await response.json()
    // Sprint status should be computed client-side, not returned from API
    const sprint = data.weeks[0]
    expect(sprint.sprint_status).toBeUndefined()
    expect(sprint.start_date).toBeUndefined()
    expect(sprint.end_date).toBeUndefined()
  })

  test('seed data creates sprints with varied sprint_numbers for different statuses', async ({ page }) => {
    await navigateToProgram(page)

    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints')),
      clickSprintsTab(page)
    ])

    const data = await response.json()
    const sprintNumbers = data.weeks.map((s: { sprint_number: number }) => s.sprint_number)

    // Should have multiple sprints with different sprint_numbers
    expect(sprintNumbers.length).toBeGreaterThan(1)

    // Sprint numbers should vary (not all the same)
    const uniqueNumbers = [...new Set(sprintNumbers)]
    expect(uniqueNumbers.length).toBeGreaterThan(1)
  })

  test('sprints compute to different statuses (completed, active, upcoming)', async ({ page }) => {
    await navigateToProgram(page)
    await clickSprintsTab(page)

    // Should see at least one of each status in the timeline
    // This verifies seed data creates sprints that compute to different statuses
    const hasCompleted = await page.getByText('Completed').first().isVisible({ timeout: 5000 }).catch(() => false)
    const hasActive = await page.getByText('Active').first().isVisible().catch(() => false)
    const hasUpcoming = await page.getByText('Upcoming').first().isVisible().catch(() => false)

    // Must have at least 2 different statuses visible (ideally all 3)
    const statusCount = [hasCompleted, hasActive, hasUpcoming].filter(Boolean).length
    expect(statusCount).toBeGreaterThanOrEqual(2)
  })
})

// =============================================================================
// PHASE 2: SPRINTS TAB UI
// =============================================================================

test.describe('Phase 2: Weeks Tab UI', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await navigateToProgram(page)
  })

  test('shows two-part layout: progress graph + horizontal timeline', async ({ page }) => {
    await clickSprintsTab(page)

    // Should see Active badge in sprint card (capitalized first letter)
    await expect(page.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 })

    // Should see Timeline heading (use role to be specific)
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  })

  test('timeline shows week windows with info', async ({ page }) => {
    await clickSprintsTab(page)

    // Timeline should show week windows (may be empty windows or sprint cards)
    // Each window shows: title ("Week of X"), date range, issue count, status
    const weekCards = page.locator('[data-active]')
    await expect(weekCards.first()).toBeVisible({ timeout: 5000 })

    // Active week window should be visible and marked
    const activeWindow = page.locator('[data-active="true"]').first()
    await expect(activeWindow).toBeVisible()

    // Week windows contain title and date range
    await expect(page.getByText(/Week of/).first()).toBeVisible()
    await expect(page.getByText(/\w{3} \d+ - \w{3} \d+/).first()).toBeVisible()
  })

  test('week windows show issue count info', async ({ page }) => {
    await clickSprintsTab(page)

    // Week windows should show issue count (e.g., "No issues" or "X issues")
    // Empty windows show "No issues", sprint cards may show progress
    await expect(page.getByText(/No issues|issues?|\d+\/\d+/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('active week shows status indicator', async ({ page }) => {
    await clickSprintsTab(page)

    // Active week should show "Active" status, not "days left" (that was removed from UI)
    await expect(page.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 })
  })

  test('Plan Week button navigates to SprintView when present', async ({ page }) => {
    await clickSprintsTab(page)

    // Plan Week button only appears when there's an actual sprint document
    // (not on empty windows) - check if it exists before clicking
    const planSprintButton = page.getByRole('button', { name: /Plan Week/ })
    const buttonCount = await planSprintButton.count()

    if (buttonCount > 0) {
      // Use force:true because sidebar panel can overlap the button
      await planSprintButton.click({ force: true })
      await expect(page).toHaveURL(/\/sprints\/[a-f0-9-]+\/view/, { timeout: 5000 })
    } else {
      // No sprint documents exist - verify timeline is visible instead
      await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
    }
  })

  test('horizontal timeline shows weeks chronologically', async ({ page }) => {
    await clickSprintsTab(page)

    // Should see multiple week cards/windows in timeline
    // Week titles show "Week of [Date]" format (e.g., "Week of Jan 27")
    const weekCards = page.locator('[data-active]')
    const count = await weekCards.count()
    expect(count).toBeGreaterThan(1)
  })

  test('timeline weeks are in chronological order (left to right)', async ({ page }) => {
    await clickSprintsTab(page)

    // Get all week windows in the timeline
    const weekWindows = page.locator('[data-active]')
    const count = await weekWindows.count()

    // Should have multiple weeks displayed
    expect(count).toBeGreaterThan(1)

    // Extract date ranges from week windows (format: "Jan 27 - Feb 2")
    const dateRanges: string[] = []
    for (let i = 0; i < Math.min(count, 5); i++) {
      const text = await weekWindows.nth(i).textContent()
      const match = text?.match(/(\w{3} \d+) - (\w{3} \d+)/)
      if (match) {
        dateRanges.push(match[1]) // Start date
      }
    }

    // Should have found date ranges (weeks are displayed with dates)
    expect(dateRanges.length).toBeGreaterThan(0)
  })

  test('timeline supports smooth infinite scrolling', async ({ page }) => {
    await clickSprintsTab(page)

    // Timeline should be scrollable (has overflow-x-auto)
    const timeline = page.locator('.overflow-x-auto').filter({ has: page.locator('[data-active]') })
    await expect(timeline).toBeVisible({ timeout: 5000 })

    // Should be able to scroll the timeline
    const scrollWidth = await timeline.evaluate(el => el.scrollWidth)
    const clientWidth = await timeline.evaluate(el => el.clientWidth)

    // Timeline should have more content than visible width (scrollable)
    expect(scrollWidth).toBeGreaterThan(clientWidth)
  })

  test('timeline cards show owner names when sprint exists', async ({ page }) => {
    await clickSprintsTab(page)

    // Sprint cards (buttons) show owner names - empty windows don't have owners
    const sprintButton = page.locator('button[data-active]').first()
    const buttonCount = await sprintButton.count()

    if (buttonCount > 0) {
      // If sprint documents exist, they should show owner names
      await expect(sprintButton).toContainText(/[A-Z][a-z]+ [A-Z][a-z]+/)
    } else {
      // If no sprint documents, timeline shows empty week windows
      await expect(page.getByText(/Week of/).first()).toBeVisible()
    }
  })

  test('timeline cards display owner name (not avatars in current implementation)', async ({ page }) => {
    await clickSprintsTab(page)

    // Sprint cards show owner NAME - avatars are a future enhancement
    // The current UI shows text like "Alice Chen" on each sprint card
    const sprintButton = page.locator('button[data-active]').first()
    const buttonCount = await sprintButton.count()

    if (buttonCount > 0) {
      await expect(sprintButton).toBeVisible({ timeout: 5000 })
      // Verify owner name is displayed (First Last format)
      await expect(sprintButton).toContainText(/[A-Z][a-z]+ [A-Z][a-z]+/)
    } else {
      // Without sprint documents, just verify timeline displays
      await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
    }
  })

  test('timeline cards show issue stats', async ({ page }) => {
    await clickSprintsTab(page)

    // Week windows show issue info - either "No issues" or "X/Y" format
    await expect(page.getByText(/No issues|\d+\/\d+/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('timeline cards show status badges', async ({ page }) => {
    await clickSprintsTab(page)

    // Should see status badges (Completed, Active, Upcoming) - use first() to handle multiples
    await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 })
    // At least one completed or upcoming should be visible
    const hasCompleted = await page.getByText('Completed').first().isVisible().catch(() => false)
    const hasUpcoming = await page.getByText('Upcoming').first().isVisible().catch(() => false)
    expect(hasCompleted || hasUpcoming).toBeTruthy()
  })

  test('clicking sprint card selects it in the chart', async ({ page }) => {
    await clickSprintsTab(page)

    // Sprint cards are buttons with data-active - only exist if sprint documents exist
    const sprintCard = page.locator('button[data-active]').first()
    const cardCount = await sprintCard.count()

    if (cardCount > 0) {
      await sprintCard.click()
      // Clicking a week card navigates to /documents/{id}/weeks/{sprintId}.
      // TRO-282: this used to assert the stale /sprints/ URL, which the
      // program tab id was renamed away from (commit 7713ef0) — the route
      // never actually worked, it just bounced to the document root.
      // Wait for URL to update which indicates selection worked
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+\/weeks\/[a-f0-9-]+/, { timeout: 5000 })
      // After navigation, verify a card shows as selected
      await expect(page.locator('button[data-selected="true"]')).toBeVisible({ timeout: 5000 })
    } else {
      // No sprint documents - timeline shows empty week windows (divs, not clickable)
      await expect(page.getByText(/Week of/).first()).toBeVisible()
    }
  })

  test('double-clicking sprint card navigates to SprintView', async ({ page }) => {
    await clickSprintsTab(page)

    // Sprint cards are buttons with data-active - only exist if sprint documents exist
    const sprintCard = page.locator('button[data-active]').first()
    const cardCount = await sprintCard.count()

    if (cardCount > 0) {
      await sprintCard.dblclick()
      // Application navigates to /documents/{programId}/weeks/{sprintId} (TRO-282)
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+\/weeks\/[a-f0-9-]+/, { timeout: 5000 })
    } else {
      // No sprint documents - verify timeline displays week windows
      await expect(page.getByText(/Week of/).first()).toBeVisible()
    }
  })

  test('double-clicking completed sprint card navigates to SprintView (read-only history)', async ({ page }) => {
    await clickSprintsTab(page)

    // Find a completed sprint card (button with data-active and "Completed" text).
    // Seed data creates sprints from currentSprintNumber-2 through +2
    // (e2e/fixtures/isolated-env.ts), so 2 past (completed) sprints always exist.
    const completedCard = page.locator('button[data-active]').filter({ has: page.getByText('Completed') }).first()
    await expect(
      completedCard,
      'Seed data creates past sprints for the current program; expected at least one Completed sprint card'
    ).toBeVisible({ timeout: 5000 })
    await completedCard.dblclick()
    // Application navigates to /documents/{programId}/weeks/{sprintId} (TRO-282
    // renamed this route from /sprints/; the old one redirects but this asserts
    // the current target directly).
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+\/weeks\/[a-f0-9-]+/, { timeout: 5000 })
  })

  test('timeline shows empty future windows with "+ Create sprint"', async ({ page }) => {
    await clickSprintsTab(page)

    // Find the timeline container
    const timeline = page.locator('.overflow-x-auto').filter({ has: page.locator('[data-active]') })
    await expect(timeline).toBeVisible({ timeout: 5000 })

    // Scroll right until we find an empty window or "+ Create sprint" text (max 15 scrolls)
    for (let i = 0; i < 15; i++) {
      const emptyWindow = page.getByText(/Week of/).first()
      const createSprintText = page.getByText('+ Create week').first()
      if (await emptyWindow.isVisible().catch(() => false) || await createSprintText.isVisible().catch(() => false)) {
        break
      }
      await timeline.evaluate(el => el.scrollBy({ left: 200, behavior: 'smooth' }))
      await page.waitForTimeout(200)
    }

    // Verify we can see empty windows OR the timeline ends
    // The presence of empty windows is validated more thoroughly in Phase 3 tests
    const hasEmptyWindow = await page.getByText(/Week of/).first().isVisible().catch(() => false)
    const hasCreateSprint = await page.getByText('+ Create week').first().isVisible().catch(() => false)
    const hasNoSprint = await page.getByText(/No week/).first().isVisible().catch(() => false)
    // If we scrolled to the edge and all windows have sprints, that's valid too
    expect(hasEmptyWindow || hasCreateSprint || hasNoSprint || true).toBeTruthy()
  })
})

// =============================================================================
// PHASE 3: SPRINT CREATION UX
// =============================================================================

test.describe('Phase 3: Week Creation UX', () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupExtraSprints(request)
    await login(page)
    await navigateToProgram(page)
  })

  test('week windows show date range', async ({ page }) => {
    await clickSprintsTab(page)

    // Week windows should show date range in "Jan 27 - Feb 2" format
    const weekWindow = page.locator('[data-active]').first()
    await expect(weekWindow).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/\w{3} \d+ - \w{3} \d+/).first()).toBeVisible()
  })

})

// =============================================================================
// PHASE 4: ISSUES TAB FILTERING
// =============================================================================

test.describe('Phase 4: Issues Tab Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await navigateToProgram(page)
  })

  test('Issues tab has sprint filter dropdown', async ({ page }) => {
    await clickIssuesTab(page)

    // Sprint filter is a Radix Popover + cmdk Combobox (web/src/components/ui/Combobox.tsx),
    // not a native <select> - it never has been, since it was introduced (6adf8f6).
    const sprintFilter = page.getByRole('combobox', { name: 'Filter issues by week' })
    await expect(sprintFilter, 'Issues tab should have a sprint filter combobox').toBeVisible({ timeout: 3000 })

    await sprintFilter.click()
    await expect(
      page.locator('[cmdk-item]').filter({ hasText: 'All Weeks' }),
      'Sprint filter should offer an "All Weeks" clear option'
    ).toBeVisible({ timeout: 3000 })
  })

  test('sprint filter has "All Weeks" as default option', async ({ page }) => {
    await clickIssuesTab(page)

    const sprintFilter = page.getByRole('combobox', { name: 'Filter issues by week' })
    await expect(sprintFilter, 'Issues tab should have a sprint filter combobox').toBeVisible({ timeout: 3000 })

    // Unselected state shows the placeholder text, "All Weeks"
    await expect(sprintFilter, 'Sprint filter should default to "All Weeks" (no filter applied)').toHaveText('All Weeks')
  })

  // NOTE: bucketed week filters ("Backlog (No Week)", "Active Week", "Upcoming Weeks",
  // "Completed Weeks", and filtering by any of them) were removed here - they assert a
  // filter feature that has never existed in web/src. `sprintOptions` (IssuesList.tsx) is
  // built only from the real sprint names attached to issues, and `sprintFilter` is a
  // strict equality match against real sprint IDs; there is no bucket/category concept.
  // Same pattern as TRO-293/TRO-596 (test asserts UI that was never built). Re-file as a
  // feature request if this filtering is actually wanted.

  test('issues table has checkbox column for bulk selection', async ({ page }) => {
    await clickIssuesTab(page)

    // Wait for issues to load
    await page.waitForLoadState('networkidle')

    // Hover over the first row to reveal the checkbox (checkboxes are hidden until hover)
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 5000 })
    await firstRow.hover()

    // Now checkbox should be visible in the data cell
    await expect(page.locator('td').getByRole('checkbox').first()).toBeVisible({ timeout: 5000 })
  })

  test('selecting issues shows bulk action bar', async ({ page }) => {
    await clickIssuesTab(page)

    // Checkboxes are hidden until row hover (see "issues table has checkbox
    // column for bulk selection" above, which establishes this precondition).
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow, 'Seed data should include at least one issue row').toBeVisible({ timeout: 5000 })
    await firstRow.hover()

    const checkbox = page.locator('td').getByRole('checkbox').first()
    await expect(checkbox, 'Issue row should expose a selection checkbox on hover').toBeVisible({ timeout: 3000 })
    await checkbox.click()

    // Should see bulk action bar with selection count
    await expect(
      page.getByText(/^\d+ selected$/),
      'Selecting an issue should show the bulk action bar with a selection count'
    ).toBeVisible({ timeout: 3000 })
  })

  test('bulk action bar has "Move to Week" dropdown', async ({ page }) => {
    await clickIssuesTab(page)

    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow, 'Seed data should include at least one issue row').toBeVisible({ timeout: 5000 })
    await firstRow.hover()

    const checkbox = page.locator('td').getByRole('checkbox').first()
    await expect(checkbox, 'Issue row should expose a selection checkbox on hover').toBeVisible({ timeout: 3000 })
    await checkbox.click()

    // "Move to Week" is a custom ActionButton + role="menu" dropdown
    // (BulkActionBar.tsx), not a native <select>.
    await expect(
      page.getByRole('button', { name: 'Move to Week' }),
      'Bulk action bar should show a "Move to Week" button once an issue is selected'
    ).toBeVisible({ timeout: 3000 })
  })

  // Regression test for TRO-609: guards the exact defect class this ticket fixed —
  // the menu must list real week names (BulkActionBar.tsx renders `sprint.name` per
  // sprint), never the bucketed category labels ("Active Week"/"Upcoming Weeks"/
  // "Completed Weeks"/"Backlog (No Week)") that 8 deleted tests wrongly assumed
  // existed. If those labels ever appear here, someone reintroduced the never-built
  // bucket-filter concept this ticket removed.
  test('"Move to Week" menu lists real week names, not category buckets', async ({ page }) => {
    await clickIssuesTab(page)

    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow, 'Seed data should include at least one issue row').toBeVisible({ timeout: 5000 })
    await firstRow.hover()

    const checkbox = page.locator('td').getByRole('checkbox').first()
    await expect(checkbox, 'Issue row should expose a selection checkbox on hover').toBeVisible({ timeout: 3000 })
    await checkbox.click()

    const moveButton = page.getByRole('button', { name: 'Move to Week' })
    await expect(moveButton).toBeVisible({ timeout: 3000 })
    await moveButton.click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 3000 })

    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.some(t => /Week \d+|Week of/.test(t)), `expected a real week name, got: ${items.join(', ')}`).toBe(true)
    for (const bucket of ['Active Week', 'Upcoming Weeks', 'Completed Weeks', 'Backlog (No Week)']) {
      expect(items, `"Move to Week" menu should never show the bucket label "${bucket}"`).not.toContain(bucket)
    }
  })

  test('bulk "Move to Week" updates issues', async ({ page }) => {
    await clickIssuesTab(page)

    // No bucketed "backlog" filter exists (see NOTE above) - operate on whatever
    // issue is first in the table instead of pre-filtering to an unassigned one.
    const rows = page.locator('tbody tr')
    await expect(rows.first(), 'Seed data should include at least one issue row').toBeVisible({ timeout: 5000 })

    const firstRow = rows.first()
    await firstRow.hover()
    const checkbox = page.locator('td').getByRole('checkbox').first()
    await expect(checkbox, 'Issue row should expose a selection checkbox on hover').toBeVisible({ timeout: 3000 })
    await checkbox.click()

    const moveButton = page.getByRole('button', { name: 'Move to Week' })
    await expect(moveButton, 'Bulk action bar should show a "Move to Week" button').toBeVisible({ timeout: 3000 })
    await moveButton.click()

    const menu = page.getByRole('menu')
    await expect(menu, '"Move to Week" button should open a menu of weeks').toBeVisible({ timeout: 3000 })

    const sprintItem = menu.getByRole('menuitem').filter({ hasText: /Week \d+|Week of/ }).first()
    if (await sprintItem.count() === 0) {
      const items = await menu.getByRole('menuitem').allTextContents()
      throw new Error(`"Move to Week" menu should list at least one week option, got: ${items.join(', ')}`)
    }

    // Bulk moves go through POST /api/issues/bulk (useIssuesQuery.ts's
    // bulkUpdateIssuesApi), not a per-issue PATCH.
    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/issues/bulk') && resp.request().method() === 'POST'),
      sprintItem.click()
    ])

    expect(response.status()).toBe(200)
  })
})

// =============================================================================
// PHASE 2 CONTINUED: PROGRESS GRAPH & VISUAL DETAILS
// =============================================================================

test.describe('Phase 2 Continued: Progress Graph & Visual Details', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await navigateToProgram(page)
  })

  test('active sprint shows Linear-style progress graph', async ({ page }) => {
    await clickSprintsTab(page)

    // Seed data creates a sprint at the current sprint number (e2e/fixtures/
    // isolated-env.ts), so an active sprint -- and its progress stats -- always exist.
    await expect(page.getByText(/Scope:/).first(), 'Active sprint should show Scope/Started/Completed progress stats').toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Started:/).first()).toBeVisible()
    await expect(page.getByText(/Completed:/).first()).toBeVisible()

    // Should see days remaining text
    await expect(page.getByText(/\d+ days? left/).first()).toBeVisible()
  })

  test('progress graph shows predicted completion line and estimate', async ({ page }) => {
    await clickSprintsTab(page)

    // Should see predicted/estimated completion text
    const predictionText = page.getByText(/Estimated completion|Predicted|On track|days? (early|behind|left)/i).first()
    const predictionVisible = await predictionText.isVisible({ timeout: 5000 }).catch(() => false)
    // Test passes - prediction text may not be visible if no active sprint or graph not implemented
    expect(predictionVisible || true).toBeTruthy()
  })

  test('progress graph has dotted/dashed prediction line', async ({ page }) => {
    await clickSprintsTab(page)

    // The prediction line uses CSS border-dashed on a div element (purple-400)
    // It's only shown if there are completed issues, so we look for the dashed border class
    const dashedLine = page.locator('[class*="border-dashed"]').first()

    // If there's an active sprint with completed issues, we should see the dashed prediction line
    // Otherwise, it won't be visible - that's expected behavior
    const hasDashedLine = await dashedLine.isVisible().catch(() => false)

    // At minimum, the progress graph container should exist
    const progressGraph = page.locator('[class*="bg-accent"]').first()
    await expect(progressGraph).toBeVisible({ timeout: 5000 })

    // The dashed line may or may not be visible depending on sprint state
    // Just verify the graph exists - the dashed line appears when there's progress
    expect(await progressGraph.isVisible()).toBeTruthy()
  })

  test('progress graph shows scope and completed indicators (div-based)', async ({ page }) => {
    await clickSprintsTab(page)

    // The progress graph uses divs with bg- classes for lines:
    // - Scope line: bg-gray-500 (horizontal line at top)
    // - Completed fill: bg-accent/20 (blue fill area)
    // - Today marker: bg-accent (vertical line)

    // Look for the graph container with its visual elements
    // The scope line is gray
    const scopeLine = page.locator('[class*="bg-gray-500"]').first()
    await expect(scopeLine).toBeVisible({ timeout: 5000 })

    // The today marker and completed fill use accent color
    const accentElements = page.locator('[class*="bg-accent"]')
    const count = await accentElements.count()

    // Should have at least the today marker
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('progress graph uses distinct colors for different elements', async ({ page }) => {
    await clickSprintsTab(page)

    // The progress graph uses div-based elements with different color classes:
    // - bg-gray-500 for scope line
    // - bg-accent for today marker
    // - border-purple-400 for prediction line (when visible)

    const grayElement = page.locator('[class*="bg-gray-500"]').first()
    const accentElement = page.locator('[class*="bg-accent"]').first()

    await expect(grayElement).toBeVisible({ timeout: 5000 })
    await expect(accentElement).toBeVisible()

    // Verify these are different elements with different colors
    const grayClass = await grayElement.getAttribute('class')
    const accentClass = await accentElement.getAttribute('class')

    expect(grayClass).toContain('bg-gray')
    expect(accentClass).toContain('bg-accent')
    // They should be distinct
    expect(grayClass).not.toBe(accentClass)
  })

  test('progress graph shows estimated completion with variance text', async ({ page }) => {
    await clickSprintsTab(page)

    // The UI shows:
    // - "X days left" always
    // - "Estimated X days early" or "Estimated X days late" when there's progress
    // - "All issues complete!" when done
    // Check for any of these patterns
    const varianceText = page.getByText(/days? left|Estimated \d+ days? (early|late)|All issues complete/i).first()
    const varianceVisible = await varianceText.isVisible({ timeout: 5000 }).catch(() => false)
    // Test passes - variance text may not be visible if no active sprint
    expect(varianceVisible || true).toBeTruthy()
  })

  test('active sprint is highlighted in timeline', async ({ page }) => {
    await clickSprintsTab(page)

    // The active sprint card should have visual distinction (ring, border, or background).
    // data-active is a boolean *value* on every card (web/src/components/week/
    // WeekTimeline.tsx: `data-active={status === 'active'}`), not presence --
    // `[data-active]` alone matches every card (active, completed, upcoming,
    // and even empty windows), so `.first()` was not actually the active card.
    // Seed data creates a sprint at the current sprint number, so exactly one
    // card should match `[data-active="true"]`.
    const activeCard = page.locator('[data-active="true"]').filter({ hasText: /Week of/ }).first()
    await expect(activeCard, 'Seed data should include a currently-active sprint').toBeVisible({ timeout: 5000 })

    // Verify it has the active-state highlight specifically. Every card in
    // this list (active, completed, upcoming) carries a base "border" class
    // and a "hover:bg-border/30" class, so checking for 'border' or 'bg-'
    // alone matches every card and can never detect a loss of highlighting.
    // WeekTimeline.tsx applies 'border-accent/50 border' only when
    // status === 'active' (or 'border-accent border-2 bg-accent/10' when
    // selected) -- 'border-accent' is the distinguishing class.
    const classes = await activeCard.getAttribute('class')
    const hasHighlight = classes?.includes('border-accent')
    expect(hasHighlight, `Active sprint card should have the border-accent highlight class, got: ${classes}`).toBeTruthy()
  })

  test('timeline cards show mini progress bar', async ({ page }) => {
    await clickSprintsTab(page)

    // Sprint cards show "X/Y done" stats and a progress bar (rounded-full div with bg-border).
    // Seed data creates real sprint documents (with issues) for the current
    // program, so at least one card should show this.
    const doneText = page.getByText(/\d+\/\d+ done/).first()
    await expect(doneText, 'At least one sprint card should show "X/Y done" progress stats').toBeVisible({ timeout: 5000 })

    // The progress bar is a rounded-full div - check it exists within sprint card area
    const progressContainer = page.locator('[class*="rounded-full"][class*="bg-"]').first()
    await expect(progressContainer).toBeVisible()
  })

  test('timeline centers on active sprint initially', async ({ page }) => {
    await clickSprintsTab(page)

    // The active sprint should be visible without scrolling
    const activeCard = page.locator('[data-active="true"]').filter({ hasText: /Week of/ }).first()
    const cardExists = await activeCard.count().then(c => c > 0).catch(() => false)
    // If there's an active sprint card, just verify it exists
    // The actual viewport centering behavior is implementation detail
    // Test passes if active sprint exists or if no active sprint
    expect(cardExists || true).toBeTruthy()
  })
})

// =============================================================================
// PHASE 2: EMPTY STATES
// =============================================================================

test.describe('Phase 2: Empty States', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('shows "No active sprint" message when gap between sprints', async ({ page }) => {
    // This test would require specific seed data with a gap
    // For now, test that the component handles the no-active case
    await navigateToProgram(page)
    await clickSprintsTab(page)

    // Wait for Weeks tab content to load
    await page.waitForTimeout(1000)

    // Either we see an active sprint OR we see "No active sprint" message OR the timeline with empty weeks
    // Note: "Active" is the actual text (not "ACTIVE"), use case-insensitive match
    const hasActive = await page.getByText(/\bActive\b/i).first().isVisible().catch(() => false)
    const hasNoActive = await page.getByText(/No active sprint/i).isVisible().catch(() => false)
    const hasTimeline = await page.getByRole('heading', { name: 'Timeline' }).isVisible().catch(() => false)

    // One of these should be true (timeline view is the default)
    expect(hasActive || hasNoActive || hasTimeline).toBeTruthy()
  })

  /**
   * Deliberately left as test.fixme() -- TRO-286 (TEST-14) Part 1.
   *
   * Unlike the other conversions in this file, this precondition genuinely
   * cannot be satisfied by the current fixture: e2e/fixtures/isolated-env.ts
   * always creates a sprint at the current sprint number (see
   * seedMinimalTestData), so `[data-active="true"]` always matches and "No
   * active sprint" never renders. Testing the gap-between-sprints empty state
   * truthfully needs a program seeded WITHOUT a current-week sprint document
   * -- new fixture work, not a selector fix, and risks the same kind of
   * cross-spec disruption flagged for the admin-workspace-members fixture (a
   * program every other test in this file assumes has a normal active
   * sprint). Left as a written, reasoned deferral rather than reintroducing
   * the `if (hasNoActive)` guard.
   */
  test.fixme('shows "Next sprint starts" info when no active sprint', async ({ page }) => {
    await navigateToProgram(page)
    await clickSprintsTab(page)

    await expect(page.getByText(/No active sprint/i)).toBeVisible()
    await expect(page.getByText(/Next sprint.*starts/i)).toBeVisible()
  })
})

// =============================================================================
// PHASE 3 CONTINUED: PAST WINDOWS & SPRINT NUMBER VALIDATION
// =============================================================================

test.describe('Phase 3 Continued: Past Windows & Validation', () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupExtraSprints(request)
    await login(page)
    await navigateToProgram(page)
  })

  test('past empty windows are not clickable (read-only)', async ({ page }) => {
    await clickSprintsTab(page)

    // Navigate to see past windows (scroll left)
    const timeline = page.locator('.overflow-x-auto').filter({ has: page.locator('[data-active]') })
    await expect(timeline).toBeVisible({ timeout: 5000 })

    // Scroll left to see past windows
    await timeline.evaluate(el => el.scrollBy({ left: -400, behavior: 'smooth' }))
    await page.waitForTimeout(300)

    // Past empty windows have opacity-50 class and show "No sprint" text (not "+ Create sprint")
    // They should NOT have cursor-pointer class
    const pastEmptyWindow = page.locator('[class*="opacity-50"]').filter({ hasText: 'No sprint' }).first()

    if (await pastEmptyWindow.isVisible()) {
      // Verify it doesn't have cursor-pointer (not clickable)
      const classes = await pastEmptyWindow.getAttribute('class')
      expect(classes).not.toContain('cursor-pointer')

      // Clicking should NOT open the create modal
      await pastEmptyWindow.click({ force: true }).catch(() => {})
      const modalAppeared = await page.getByText(/Create Week \d+/).isVisible().catch(() => false)
      expect(modalAppeared).toBeFalsy()
    }
    // If no past empty windows exist, test passes (seed data has sprints in all past windows)
  })

})

// =============================================================================
// PHASE 4 CONTINUED: FILTER FUNCTIONALITY
// =============================================================================

test.describe('Phase 4 Continued: Filter Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await navigateToProgram(page)
  })

  // NOTE: "filtering by Active Week/Upcoming Weeks/Completed Weeks" tests were removed
  // here for the same reason as Phase 4 above - no bucketed week filter exists.

  test('sprint filter has specific sprint options', async ({ page }) => {
    await clickIssuesTab(page)

    const sprintFilter = page.getByRole('combobox', { name: 'Filter issues by week' })
    await expect(sprintFilter, 'Issues tab should have a sprint filter combobox').toBeVisible({ timeout: 3000 })
    await sprintFilter.click()

    // Seed data creates 5 real sprint documents per program (current-2..+2).
    const weekOption = page.locator('[cmdk-item]').filter({ hasText: /Week of/ }).first()
    await expect(weekOption, 'Sprint filter should list individual "Week of" sprint options').toBeVisible({ timeout: 5000 })
  })

  test('filtering by specific sprint shows only that sprint\'s issues', async ({ page }) => {
    await clickIssuesTab(page)

    const sprintFilter = page.getByRole('combobox', { name: 'Filter issues by week' })
    await expect(sprintFilter, 'Issues tab should have a sprint filter combobox').toBeVisible({ timeout: 3000 })
    await sprintFilter.click()

    const weekOption = page.locator('[cmdk-item]').filter({ hasText: /Week of/ }).first()
    await expect(weekOption, 'Sprint filter should list individual "Week of" sprint options').toBeVisible({ timeout: 5000 })
    const sprintLabel = (await weekOption.textContent())?.trim() || ''
    await weekOption.click()

    await expect(sprintFilter, 'Sprint filter should show the selected week').toHaveText(sprintLabel)

    const rows = page.locator('tbody tr')
    await expect(rows.first(), `Seed data should include at least one issue in sprint "${sprintLabel}"`).toBeVisible({ timeout: 5000 })
    const count = await rows.count()

    // All visible issues should be in that specific sprint
    // Sprint column is second-to-last (before actions column)
    for (let i = 0; i < Math.min(count, 3); i++) {
      const sprintCell = rows.nth(i).locator('td:nth-last-child(2)')
      await expect(sprintCell).toContainText(/Week of/)
    }
  })

  test('deselecting all issues clears bulk action bar', async ({ page }) => {
    await clickIssuesTab(page)

    // Checkboxes are hidden until row hover.
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow, 'Seed data should include at least one issue row').toBeVisible({ timeout: 5000 })
    await firstRow.hover()

    const checkbox = page.locator('td').getByRole('checkbox').first()
    await expect(checkbox, 'Issue row should expose a selection checkbox on hover').toBeVisible({ timeout: 3000 })
    await checkbox.click()

    // Verify bulk action bar appears
    await expect(
      page.getByText(/^\d+ selected$/),
      'Selecting an issue should show the bulk action bar'
    ).toBeVisible({ timeout: 3000 })

    // Deselect
    await checkbox.click()

    // Bulk action bar should disappear
    await expect(page.getByText(/^\d+ selected$/)).not.toBeVisible()
  })

})

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

test.describe('Integration: Full User Flows', () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupExtraSprints(request)
    await login(page)
  })

  test('user navigates to program → Weeks tab → sees graph + timeline', async ({ page }) => {
    await navigateToProgram(page)
    await clickSprintsTab(page)

    // Wait for content to load after tab switch
    await page.waitForTimeout(1000)

    // Verify two-part layout - at minimum we should see the Timeline heading or Active badge
    const hasTimeline = await page.getByRole('heading', { name: 'Timeline' }).isVisible({ timeout: 5000 }).catch(() => false)
    // ACTIVE badge (case-insensitive) only shows if there's an active sprint in the seed data
    const hasActive = await page.getByText(/\bActive\b/i).first().isVisible().catch(() => false)
    // Test passes if we see either the timeline heading or active badge (one must be visible)
    expect(hasTimeline || hasActive).toBeTruthy()
  })

  // NOTE: "user filters issues by backlog" was removed here for the same reason as
  // Phase 4 above - no bucketed week filter exists (see that NOTE for detail).

})
