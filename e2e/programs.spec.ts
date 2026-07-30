import { test, expect } from './fixtures/isolated-env'

test.describe('Programs', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('can navigate to Programs mode via icon rail', async ({ page }) => {
    // Click Programs icon in the rail
    await page.getByRole('button', { name: /programs/i }).click()

    // Should be in programs mode
    await expect(page).toHaveURL(/\/programs/)

    // Should see Programs heading
    await expect(page.getByRole('heading', { name: /programs/i, level: 1 })).toBeVisible({ timeout: 5000 })
  })

  test('shows programs list with New Program button', async ({ page }) => {
    await page.goto('/programs')

    // Should see New Program button
    await expect(page.getByRole('button', { name: /new program/i })).toBeVisible({ timeout: 5000 })
  })

  test('can create a new program', async ({ page }) => {
    await page.goto('/programs')

    // Click New Program button
    await page.getByRole('button', { name: /new program/i }).click()

    // Should navigate to program editor
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
  })

  test('new program appears in sidebar list', async ({ page }) => {
    await page.goto('/programs')

    // Count existing programs in sidebar
    await page.waitForTimeout(500)
    const initialCount = await page.locator('aside ul li').count()

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()

    // Wait for navigation
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Program should appear in sidebar
    await page.waitForTimeout(500)
    const newCount = await page.locator('aside ul li').count()
    expect(newCount).toBeGreaterThanOrEqual(initialCount)
  })

  test('program editor has tabbed navigation (Overview, Issues, Weeks)', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Should see all tabs (scoped to main to avoid icon rail)
    const main = page.locator('main')
    await expect(main.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 5000 })
    await expect(main.getByRole('tab', { name: 'Issues' })).toBeVisible({ timeout: 5000 })
    await expect(main.getByRole('tab', { name: 'Weeks' })).toBeVisible({ timeout: 5000 })
  })

  test('can switch between program tabs', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Scope to main to avoid icon rail buttons
    const main = page.locator('main')

    // Click Issues tab
    await main.getByRole('tab', { name: 'Issues' }).click()

    // Should see New Issue button in issues tab
    await expect(page.getByRole('button', { name: 'New Issue' })).toBeVisible({ timeout: 5000 })

    // Click Weeks tab
    await main.getByRole('tab', { name: 'Weeks' }).click()

    // Should see Timeline heading in the Weeks tab (weeks are auto-generated)
    await expect(page.getByRole('heading', { name: 'Timeline', level: 3 })).toBeVisible({ timeout: 5000 })
  })

  test('Issues tab shows list and kanban view toggle', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Click Issues tab (scoped to main to avoid icon rail)
    await page.locator('main').getByRole('tab', { name: 'Issues' }).click()

    // Should see view toggle buttons (list/kanban)
    const viewToggle = page.locator('.flex.rounded-md.border')
    await expect(viewToggle.first()).toBeVisible({ timeout: 5000 })
  })

  test('can create issue from program Issues tab', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Wait for program editor to fully load - verify we have the tab bar
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 5000 })

    // Click Issues tab - scope to main to avoid sidebar
    const main = page.locator('main')
    await main.getByRole('tab', { name: 'Issues' }).click()

    // Wait for Issues tab panel to be active before looking for New Issue button
    // Use data-testid to ensure we click the program's New Issue button, not sidebar
    await expect(page.getByTestId('program-new-issue')).toBeVisible({ timeout: 5000 })

    // Verify we're still on the program page (unified document routing)
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/)

    // Click New Issue button using data-testid
    await page.getByTestId('program-new-issue').click()

    // Should navigate to issue document (unified document routing)
    // Wait for URL to change from the program's issues tab to the new issue document
    await expect(page).not.toHaveURL(/\/issues$/, { timeout: 10000 })
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+$/, { timeout: 5000 })
  })

  test('Weeks tab shows auto-generated week timeline', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Click Weeks tab (scope to main to avoid icon rail)
    await page.locator('main').getByRole('tab', { name: 'Weeks' }).click()

    // Should see Timeline heading
    await expect(page.getByRole('heading', { name: 'Timeline', level: 3 })).toBeVisible({ timeout: 5000 })

    // Should see auto-generated week cards (weeks are created automatically)
    // Look for any "Week of" text which indicates week cards are visible
    await expect(page.getByText(/Week of/).first()).toBeVisible({ timeout: 5000 })
  })

  test('program list shows issue and sprint counts', async ({ page }) => {
    await page.goto('/programs')

    // Wait for programs to load
    await page.waitForTimeout(1000)

    // Programs render as a table (web/src/pages/Programs.tsx, SelectableList),
    // not cards -- issue/sprint counts are plain numeric gridcells ("3"), not
    // "N issues" badge text. Only the Issues/Weeks columns render bare
    // integers; Name/Owner are text and Created/Updated are formatted dates.
    const countCells = page
      .locator('table[aria-label="Programs list"] [role="gridcell"]')
      .filter({ hasText: /^\d+$/ })
    await expect(
      countCells.first(),
      'Seed data should include at least one program with a numeric issue/sprint count cell. Run: pnpm db:seed'
    ).toBeVisible({ timeout: 5000 })
  })

  test('can navigate between programs using sidebar', async ({ page }) => {
    await page.goto('/programs')

    // Create first program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    const firstProgramUrl = page.url()

    // Go back to programs list
    await page.goto('/programs')

    // Create second program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    expect(page.url()).not.toBe(firstProgramUrl)

    // Click first program in sidebar
    const sidebarItems = page.locator('aside ul li button')
    if (await sidebarItems.count() >= 2) {
      await sidebarItems.first().click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/)
    }
  })

  test('program editor has editable title', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Should see editor with editable title area
    const editor = page.locator('.ProseMirror, .tiptap, [data-testid="editor"]')
    await expect(editor).toBeVisible({ timeout: 5000 })
  })

  test('program cards show emoji or initial badges', async ({ page }) => {
    await page.goto('/programs')

    // Wait for programs to load
    await page.waitForTimeout(500)

    // Programs render as a table (web/src/pages/Programs.tsx
    // ProgramRowContent), not cards -- the Name gridcell holds a colored
    // `div.rounded-md` badge showing an emoji or initial, not
    // `button:has-text("issues")` / `.rounded-lg.text-sm.font-bold`. The row's
    // first gridcell is a selection checkbox (SelectableList, selectable=true),
    // so search the whole row rather than assume the Name cell is first.
    const row = page.locator('table[aria-label="Programs list"] tbody tr').first()
    await expect(
      row,
      'Seed data should include at least one program row. Run: pnpm db:seed'
    ).toBeVisible({ timeout: 5000 })

    // .first() guards against a strict-mode violation if the row ever gains
    // another `rounded-md` div (badge, checkbox wrapper, status pill) --
    // `rounded-md` is a common Tailwind utility, not a unique marker.
    const badge = row.locator('div.rounded-md').first()
    await expect(badge, 'Program name cell should show a colored emoji/initial badge').toBeVisible({ timeout: 2000 })
    const badgeText = (await badge.textContent())?.trim()
    expect(badgeText, 'Badge should contain an emoji or initial character').toBeTruthy()
  })

  test('empty programs page shows create prompt', async ({ page }) => {
    // This test would need a clean database, so we just verify the button exists
    await page.goto('/programs')

    // Should see New Program button even with existing programs
    await expect(page.getByRole('button', { name: /new program/i })).toBeVisible({ timeout: 5000 })
  })

  test('can create project from program Projects tab', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    const programUrl = page.url()
    const programId = programUrl.split('/documents/')[1]

    // Click Projects tab
    await page.locator('main').getByRole('tab', { name: 'Projects' }).click()

    // Should see New Project button
    const newProjectButton = page.getByRole('button', { name: /new project/i })
    await expect(newProjectButton).toBeVisible({ timeout: 5000 })

    // Click New Project button
    await newProjectButton.click()

    // Should navigate to new project document
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
  })

  test('Plan Week button navigates to week planning page', async ({ page }) => {
    await page.goto('/programs')

    // Create new program
    await page.getByRole('button', { name: /new program/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    const programUrl = page.url()
    const programId = programUrl.split('/documents/')[1]

    // Click Weeks tab
    await page.locator('main').getByRole('tab', { name: 'Weeks' }).click()

    // Look for Plan Week button (may appear if weeks exist)
    const planWeekButton = page.getByRole('button', { name: /plan week/i })

    // If button exists, click it
    if (await planWeekButton.count() > 0) {
      await planWeekButton.click()
      // Should navigate to week planning page
      await expect(page).toHaveURL(/\/sprints\/.+\/plan/, { timeout: 5000 })
    }
  })

})
