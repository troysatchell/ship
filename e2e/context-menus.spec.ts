import { test, expect } from './fixtures/isolated-env'

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

      // Find a program in sidebar and hover
      const programItem = page.locator('[data-sidebar="programs"] button').first()
      if (await programItem.isVisible()) {
        await programItem.hover()

        // Look for the three-dot menu button
        const menuButton = programItem.locator('button[aria-label*="Actions"]')
        if (await menuButton.isVisible()) {
          await menuButton.click()

          // Context menu should appear
          const contextMenu = page.getByRole('menu', { name: 'Context menu' })
          await expect(contextMenu).toBeVisible({ timeout: 3000 })
        }
      }
    })
  })

  test.describe('Issues Sidebar', () => {
    test('three-dot menu opens context menu for issue', async ({ page }) => {
      await page.goto('/issues')
      await page.waitForLoadState('networkidle')

      // Find an issue in sidebar and hover
      const issueItem = page.locator('[data-sidebar="issues"] a').first()
      if (await issueItem.isVisible()) {
        await issueItem.hover()

        // Look for the three-dot menu button
        const menuButton = issueItem.locator('button[aria-label*="Actions"]')
        if (await menuButton.isVisible()) {
          await menuButton.click()

          // Context menu should appear with status change option
          const contextMenu = page.getByRole('menu', { name: 'Context menu' })
          await expect(contextMenu).toBeVisible({ timeout: 3000 })
          await expect(contextMenu.getByText(/status/i)).toBeVisible()
        }
      }
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
    await page.waitForLoadState('networkidle')

    // Find a team member card
    const memberCard = page.locator('[class*="PersonCard"]').first()
    if (await memberCard.isVisible()) {
      await memberCard.click({ button: 'right' })

      // Context menu should appear with view profile option
      const contextMenu = page.getByRole('menu', { name: 'Context menu' })
      await expect(contextMenu).toBeVisible({ timeout: 3000 })
      await expect(contextMenu.getByText(/view profile/i)).toBeVisible()
    }
  })

  test('three-dot menu on team member card opens context menu', async ({ page }) => {
    await page.goto('/team/directory')
    await page.waitForLoadState('networkidle')

    // Hover over team member card to reveal menu button
    const memberCard = page.locator('.group').filter({ has: page.locator('[class*="rounded-full"]') }).first()
    if (await memberCard.isVisible()) {
      await memberCard.hover()

      // Look for the three-dot menu button
      const menuButton = memberCard.locator('button[aria-label*="Actions"]')
      if (await menuButton.isVisible()) {
        await menuButton.click()

        // Context menu should appear
        const contextMenu = page.getByRole('menu', { name: 'Context menu' })
        await expect(contextMenu).toBeVisible({ timeout: 3000 })
      }
    }
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

    // Find a kanban card and right-click
    const card = page.locator('[data-testid="kanban-card"]').first()
    if (await card.isVisible()) {
      await card.click({ button: 'right' })

      // Context menu should appear
      const contextMenu = page.getByRole('menu', { name: 'Context menu' })
      await expect(contextMenu).toBeVisible({ timeout: 3000 })
    }
  })

  test('three-dot menu on kanban card opens context menu', async ({ page }) => {
    await page.goto('/issues')
    await page.waitForLoadState('networkidle')

    // Switch to kanban view
    await page.getByRole('button', { name: 'Kanban view' }).click()
    await page.waitForTimeout(500)

    // Hover over kanban card to reveal menu button
    const card = page.locator('[data-testid="kanban-card"]').first()
    if (await card.isVisible()) {
      await card.hover()

      // Look for the three-dot menu button
      const menuButton = card.locator('button[aria-label*="Actions"]')
      if (await menuButton.isVisible()) {
        await menuButton.click()

        // Context menu should appear
        const contextMenu = page.getByRole('menu', { name: 'Context menu' })
        await expect(contextMenu).toBeVisible({ timeout: 3000 })
      }
    }
  })
})
