import { test, expect } from './fixtures/isolated-env'
import { hoverWithRetry, waitForTableData } from './fixtures/test-helpers'

test.describe('Context Menus - Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test.describe('Wiki Documents', () => {
    test('three-dot menu opens context menu', async ({ page }) => {
      // Navigate to docs to ensure sidebar shows wiki documents
      await page.goto('/docs')
      await page.waitForLoadState('networkidle')

      // Look for document tree items in the sidebar
      const tree = page.getByRole('list', { name: 'Workspace documents' }).or(page.getByRole('list', { name: 'Documents' }))
      const firstDoc = tree.first().locator('[data-testid="doc-item"]').first()

      // Data should always exist - fail if it doesn't
      await expect(firstDoc).toBeVisible({ timeout: 5000 })
      await firstDoc.hover()
      await page.waitForTimeout(300) // Wait for hover state

      // Look for three-dot menu button that appears on hover (has aria-label="Document actions")
      const menuButton = firstDoc.locator('button[aria-label="Document actions"]')
      if (await menuButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuButton.click()

        // Context menu should appear with options (it's not a role="menu", it's a custom div)
        const contextMenu = page.locator('[data-contextmenu]').or(page.getByText('Create sub-document'))
        await expect(contextMenu).toBeVisible({ timeout: 3000 })
      }
    })

    test('right-click opens context menu', async ({ page }) => {
      await page.goto('/docs')
      await page.waitForLoadState('networkidle')

      // Look for document tree items
      const tree = page.getByRole('list', { name: 'Workspace documents' }).or(page.getByRole('list', { name: 'Documents' }))
      const firstDoc = tree.first().locator('[data-testid="doc-item"]').first()

      // Data should always exist - fail if it doesn't
      await expect(firstDoc).toBeVisible({ timeout: 5000 })
      await firstDoc.click({ button: 'right' })

      // Context menu should appear (it's a custom div with menu options)
      const contextMenu = page.locator('[data-contextmenu]').or(page.getByText('Create sub-document'))
      await expect(contextMenu).toBeVisible({ timeout: 3000 })
    })
  })

  test.describe('Programs', () => {
    test('three-dot menu opens context menu for program', async ({ page }) => {
      // Navigate to a page where programs are visible in sidebar
      await page.goto('/programs')
      await page.waitForLoadState('networkidle')

      // Find a program in sidebar and hover. Sidebar renders each program as
      // <li data-testid="program-item"> (see web/src/pages/App.tsx ProgramsSidebar).
      const programItem = page.locator('[data-testid="program-item"]').first()
      await expect(programItem, 'Seed data should include at least one program in the sidebar. Run: pnpm db:seed').toBeVisible({ timeout: 5000 })

      // Look for the three-dot menu button. getByRole matches the accessible
      // name (consistent with the Kanban card locator below) rather than a
      // case-sensitive CSS attribute substring. Hover is retried alongside the
      // visibility check (hoverWithRetry) so a stray pointer move or re-render
      // between the two steps can't leave the button hidden and the assertion
      // timing out.
      const menuButton = programItem.getByRole('button', { name: /actions/i })
      await hoverWithRetry(programItem, async () => {
        await expect(menuButton, 'Program sidebar item should expose an Actions button on hover').toBeVisible({ timeout: 3000 })
      })
      await menuButton.click()

      // Context menu should appear
      const contextMenu = page.getByRole('menu', { name: 'Context menu' })
      await expect(contextMenu).toBeVisible({ timeout: 3000 })
    })
  })

  test.describe('Issues Sidebar', () => {
    test('three-dot menu opens context menu for issue', async ({ page }) => {
      await page.goto('/issues')
      await page.waitForLoadState('networkidle')

      // Find an issue in sidebar and hover. Sidebar renders each issue as
      // <li data-testid="issue-item"> (see web/src/pages/App.tsx IssuesList).
      const issueItem = page.locator('[data-testid="issue-item"]').first()
      await expect(issueItem, 'Seed data should include at least one issue in the sidebar. Run: pnpm db:seed').toBeVisible({ timeout: 5000 })

      // Look for the three-dot menu button. See the Programs section above for
      // why this uses getByRole + hoverWithRetry instead of a case-sensitive
      // CSS attribute selector with a bare hover().
      const menuButton = issueItem.getByRole('button', { name: /actions/i })
      await hoverWithRetry(issueItem, async () => {
        await expect(menuButton, 'Issue sidebar item should expose an Actions button on hover').toBeVisible({ timeout: 3000 })
      })
      await menuButton.click()

      // Context menu should appear with status change option
      const contextMenu = page.getByRole('menu', { name: 'Context menu' })
      await expect(contextMenu).toBeVisible({ timeout: 3000 })
      await expect(contextMenu.getByText(/status/i)).toBeVisible()
    })
  })
})

test.describe('Context Menus - Team Directory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('right-click on team member shows context menu', async ({ page }) => {
    await page.goto('/team/directory')
    await waitForTableData(page)

    // Team Directory renders people as table rows, not "PersonCard" elements
    // (see web/src/pages/TeamDirectory.tsx: <tr onContextMenu={...}>).
    const memberRow = page.locator('tbody tr').first()
    await expect(memberRow, 'Seed data should include at least one team member row. Run: pnpm db:seed').toBeVisible({ timeout: 5000 })
    await memberRow.click({ button: 'right' })

    // Context menu should appear with view profile option
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })
    await expect(contextMenu.getByText(/view profile/i)).toBeVisible()
  })

  /**
   * Deliberately left as test.fixme() -- TRO-286 (TEST-14) Part 1.
   *
   * Unlike the other conversions in this file, this one is not a stale selector:
   * web/src/pages/TeamDirectory.tsx renders team members as table rows with only
   * an `onContextMenu` handler (right-click). There is no hover-revealed
   * three-dot / "Actions" button anywhere in that component -- grepping the file
   * for `aria-label`, `<button`, and `Actions for` turns up nothing for rows.
   * The feature this test describes does not exist in the current UI; it is not
   * a test bug to fix but a product gap to (maybe) build. Converting this to a
   * real assertion would require adding a UI affordance, which is out of scope
   * for a test-quality ticket -- see CHANGES.md (TRO-286).
   */
  test.fixme('three-dot menu on team member row opens context menu', async ({ page }) => {
    await page.goto('/team/directory')
    await page.waitForLoadState('networkidle')

    const memberRow = page.locator('tbody tr').first()
    await expect(memberRow).toBeVisible({ timeout: 5000 })
    await memberRow.hover()

    const menuButton = memberRow.getByRole('button', { name: /actions/i })
    await expect(menuButton).toBeVisible({ timeout: 3000 })
    await menuButton.click()

    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Context Menus - Kanban Board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('right-click on kanban card shows context menu', async ({ page }) => {
    await page.goto('/issues')
    await page.waitForLoadState('networkidle')

    // Switch to kanban view
    await page.getByRole('button', { name: 'Kanban view' }).click()
    await page.waitForTimeout(500)

    // Find a kanban card and right-click. Cards render with a `data-issue`
    // attribute, not a "kanban-card" testid (see web/src/components/KanbanBoard.tsx).
    const card = page.locator('[data-issue]').first()
    await expect(card, 'Seed data should include at least one issue to render as a kanban card. Run: pnpm db:seed').toBeVisible({ timeout: 5000 })
    await card.click({ button: 'right' })

    // Context menu should appear
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })
  })

  test('three-dot menu on kanban card opens context menu', async ({ page }) => {
    await page.goto('/issues')
    await page.waitForLoadState('networkidle')

    // Switch to kanban view
    await page.getByRole('button', { name: 'Kanban view' }).click()
    await page.waitForTimeout(500)

    // Hover over kanban card to reveal menu button
    const card = page.locator('[data-issue]').first()
    await expect(card, 'Seed data should include at least one issue to render as a kanban card. Run: pnpm db:seed').toBeVisible({ timeout: 5000 })

    // Look for the three-dot menu button. Its aria-label is "More actions for
    // issue #N" (lowercase "actions"), so the match must be case-insensitive.
    // Hover is retried alongside the visibility check (hoverWithRetry) so a
    // stray pointer move or re-render between the two steps can't leave the
    // button hidden and the assertion timing out.
    const menuButton = card.getByRole('button', { name: /actions/i })
    await hoverWithRetry(card, async () => {
      await expect(menuButton, 'Kanban card should expose an Actions button on hover').toBeVisible({ timeout: 3000 })
    })
    await menuButton.click()

    // Context menu should appear
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })
  })
})
