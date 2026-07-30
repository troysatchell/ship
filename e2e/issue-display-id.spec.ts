import { test, expect } from './fixtures/isolated-env';

test.describe('Issue Display IDs', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 10000 })
  });

  test('displays issue with hash-number format (#N) in issues list', async ({ page }) => {
    // Navigate to issues page directly
    await page.goto('/issues')

    // Create a new issue first to ensure there's at least one
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to issues list
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Check for #N format in the issues list
    const issueDisplayId = page.getByText(/#\d+/).first()
    await expect(issueDisplayId).toBeVisible({ timeout: 5000 })
  });

  test('displays issue with hash-number format (#N) in issue editor header', async ({ page }) => {
    // Navigate to issues page and create a new issue
    await page.goto('/issues')
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to issues list to verify the issue has #N format
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Check for #N format in the issues list (issue ID column)
    const issueId = page.getByText(/#\d+/).first()
    await expect(issueId).toBeVisible({ timeout: 5000 })
  });

  test('new issue gets sequential ticket number', async ({ page }) => {
    // Navigate to issues
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Create new issue (use the specific button in the header, not the sidebar icon)
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to issues list
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // New issue should have a number in the issues list
    const issueId = page.getByText(/#\d+/).first()
    await expect(issueId).toBeVisible({ timeout: 5000 })
    await expect(issueId).toHaveText(/#\d+/)
  });

  test('issue display ID does not contain program prefix', async ({ page }) => {
    // Navigate to issues and create a new issue
    await page.goto('/issues')
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to issues list
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Find the issue ID in the list (gridcell with #N format)
    const idCell = page.locator('[role="gridcell"]').filter({ hasText: /^#\d+$/ }).first()
    await expect(idCell).toBeVisible({ timeout: 5000 })

    const text = await idCell.textContent()
    // Should be #N format, not PREFIX-N format
    expect(text?.trim()).toMatch(/^#\d+$/)
    expect(text?.trim()).not.toMatch(/^[A-Z]+-\d+$/)
  });

  test('all issue display IDs use hash-number format', async ({ page }) => {
    // Navigate to issues and create a few issues
    await page.goto('/issues')
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    await page.goto('/issues')
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to issues list
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Verify all visible issue display IDs use #N format
    // The issues list uses ARIA grid with gridcell elements, not td elements
    const idCells = page.locator('[role="gridcell"]').filter({ hasText: /^#\d+$/ })
    const count = await idCells.count()

    // Should have found at least one issue with #N format
    expect(count).toBeGreaterThan(0)

    // Verify each ID cell matches the expected format
    for (let i = 0; i < count; i++) {
      const cellText = await idCells.nth(i).textContent()
      expect(cellText?.trim()).toMatch(/^#\d+$/)
      expect(cellText?.trim()).not.toMatch(/^[A-Z]+-\d+$/)
    }
  });

  test('program issues list shows hash-number format', async ({ page }) => {
    // Navigate to programs
    await page.goto('/programs')
    await page.waitForTimeout(500)

    // Click on first program in the list. Programs render as a table row
    // (web/src/pages/Programs.tsx, SelectableList) -- not
    // [data-testid="program-card"], ".contextual-sidebar button", or a
    // "button:has-text(issues)" card; none of those selectors exist in
    // web/src.
    const programCard = page.locator('table[aria-label="Programs list"] tbody tr').first()
    await expect(
      programCard,
      'Seed data should include at least one program with issues. Run: pnpm db:seed'
    ).toBeVisible({ timeout: 5000 })
    await programCard.click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Click the Issues tab. Document tabs render with role="tab"
    // (web/src/components/ui/TabBar.tsx), not role="button" -- the previous
    // selector never matched, so isVisible() was always false and the tab was
    // never actually clicked.
    const issuesTab = page.getByRole('tab', { name: /issues/i })
    await expect(issuesTab, 'Program document view should have an Issues tab').toBeVisible({ timeout: 5000 })
    await issuesTab.click()
    // TabBar.tsx sets aria-selected on the active tab -- wait for that instead
    // of a fixed sleep before reading its content.
    await expect(issuesTab).toHaveAttribute('aria-selected', 'true', { timeout: 3000 })

    // Check that issues in the program view show #N format. `getByText(/#\d+/)`
    // resolves to the smallest matching element, which may still carry
    // surrounding text (e.g. "#12 · Fix login"), contradicting the anchored
    // `toHaveText(/^#\d+$/)` below even when the UI is correct -- target the id
    // gridcell precisely instead, matching the other tests in this file
    // (lines 77, 102).
    const issueDisplayId = page.locator('[role="gridcell"]').filter({ hasText: /^#\d+$/ }).first()
    await expect(
      issueDisplayId,
      'Program view should show at least one issue in #N format'
    ).toBeVisible({ timeout: 3000 })
    await expect(issueDisplayId).toHaveText(/^#\d+$/)
  });

  test('command palette shows issues with hash-number format (#N)', async ({ page }) => {
    // Create an issue first so there's something to search for
    await page.goto('/issues')
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back and open command palette
    await page.goto('/issues')
    await page.waitForTimeout(500)

    // Open command palette with Cmd+K (or Ctrl+K on non-Mac)
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(300)

    // If command palette didn't open, try Ctrl+K
    const commandPalette = page.locator('[cmdk-root], [data-testid="command-palette"]')
    if (!(await commandPalette.isVisible())) {
      await page.keyboard.press('Control+k')
      await page.waitForTimeout(300)
    }

    // Type to search for issues
    const searchInput = page.locator('[cmdk-input], input[placeholder*="Search"], input[placeholder*="Type"]')
    if (await searchInput.isVisible()) {
      await searchInput.fill('#')
      await page.waitForTimeout(500)

      // Check that any issue results use #N format, not PREFIX-N format
      const issueResults = page.locator('[cmdk-item]')
      const count = await issueResults.count()

      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await issueResults.nth(i).textContent()
        if (text && text.includes('#')) {
          // Should see #N format
          expect(text).toMatch(/#\d+/)
          // Should NOT see PREFIX-N format (uppercase letters followed by hyphen and number)
          expect(text).not.toMatch(/[A-Z]{2,}-\d+/)
        }
      }
    }

    // Close command palette
    await page.keyboard.press('Escape')
  });
});
