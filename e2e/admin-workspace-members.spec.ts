import { test, expect, Page } from './fixtures/isolated-env'

// Helper to login as super admin
async function loginAsSuperAdmin(page: Page) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 10000 })
}

test.describe('Admin Workspace Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page)
  })

  test('can navigate to workspace detail by clicking workspace name', async ({ page }) => {
    await page.goto('/admin')

    // Click on a workspace name (should be a link)
    // Note: The isolated-env fixture seeds "Test Workspace", not "Ship Workspace"
    const workspaceLink = page.getByRole('link', { name: /Test Workspace/i }).first()
    await workspaceLink.click()

    // Should navigate to workspace detail page
    await expect(page).toHaveURL(/\/admin\/workspaces\//)
    await expect(page.getByText('Workspace: Test Workspace')).toBeVisible()
  })

  test('workspace detail page shows members table', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Should show members section with table
    await expect(page.getByRole('heading', { name: /Members \(\d+\)/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Name' }).first()).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Email' }).first()).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Role' }).first()).toBeVisible()
  })

  test('workspace detail page shows pending invites section', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Should show pending invites section
    await expect(page.getByRole('heading', { name: /Pending Invites/ })).toBeVisible()
  })

  test('workspace detail page shows add existing user section', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Should show "Add Existing User" section
    await expect(page.getByRole('heading', { name: 'Add Existing User' })).toBeVisible()
    await expect(page.getByPlaceholder('Search by email...')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add User' })).toBeVisible()
  })

  test('workspace detail page shows invite form', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Should show invite form
    await expect(page.getByRole('heading', { name: 'Invite New Member' })).toBeVisible()
    await expect(page.getByPlaceholder('email@example.com')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send Invite' })).toBeVisible()
  })

  test('back button returns to admin dashboard', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Click back button
    await page.getByRole('button').filter({ has: page.locator('svg') }).first().click()

    // Should return to admin dashboard
    await expect(page).toHaveURL('/admin')
  })
})

test.describe('Admin Workspace Member Management', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page)
  })

  /**
   * Rewritten for audit finding TEST-2 (TRO-224).
   *
   * The whole body was wrapped in `if (await roleSelect.isVisible())`, so the
   * test passed whenever the member table failed to render — which is the most
   * likely way for role management to be broken. Seed data guarantees
   * bob.martinez@ship.local is a `member` of Test Workspace
   * (`e2e/fixtures/isolated-env.ts`), so the row's existence is now asserted.
   *
   * It also only checked the local `<select>` value, which a client-side change
   * satisfies without any request succeeding. It now reloads and re-reads, so a
   * silently-failed PATCH fails the test.
   */
  test('can change member role', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Find the seeded member row and its role control.
    const memberRow = page.locator('tr').filter({ hasText: 'Member' }).first()
    await expect(
      memberRow,
      'Seed data should provide a workspace member (bob.martinez@ship.local) in ' +
        'Test Workspace. See e2e/fixtures/isolated-env.ts.'
    ).toBeVisible({ timeout: 15000 })

    const roleSelect = memberRow.locator('select')
    await expect(
      roleSelect,
      'each member row should expose a role <select> for an admin to change'
    ).toBeVisible({ timeout: 10000 })

    const currentRole = await roleSelect.inputValue()
    const newRole = currentRole === 'admin' ? 'member' : 'admin'

    // bob.martinez's role is shared, seeded state: other specs in this worker's
    // database (e2e/authorization.spec.ts's member-only checks, in particular)
    // assume it is 'member'. If an assertion between the change and the restore
    // below throws, an un-guarded test would leave the role changed for every
    // test that runs after it in this worker. try/finally makes the restore run
    // regardless of which assertion failed.
    try {
      await roleSelect.selectOption(newRole)
      await expect(roleSelect, 'the control should show the newly selected role').toHaveValue(
        newRole,
        { timeout: 10000 }
      )

      // The real claim: the change reached the server. Re-reading after a reload
      // is the only way to tell that apart from a purely local <select> update.
      await page.reload()
      const reloadedRow = page.locator('tr').filter({ hasText: /bob\.martinez/i }).first()
      await expect(
        reloadedRow,
        'the member row should still be present after reload'
      ).toBeVisible({ timeout: 15000 })
      await expect(
        reloadedRow.locator('select'),
        'the role change must persist across a reload, not just in local state'
      ).toHaveValue(newRole, { timeout: 15000 })
    } finally {
      // Restore the seeded role so later tests in this worker see the fixture
      // state. Re-navigate rather than reuse `reloadedRow`: if the try block
      // failed before the reload, that locator was never resolved.
      await page.goto('/admin')
      await page.getByRole('link', { name: /Test Workspace/i }).first().click()
      const restoreRow = page.locator('tr').filter({ hasText: /bob\.martinez/i }).first()
      await expect(restoreRow, 'the member row must still exist to restore its role').toBeVisible({
        timeout: 15000,
      })
      await restoreRow.locator('select').selectOption(currentRole)
      await expect(restoreRow.locator('select')).toHaveValue(currentRole, { timeout: 10000 })
    }
  })

  test('can send invite to new email', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Generate unique email
    const testEmail = `test-admin-${Date.now()}@example.com`

    // Fill invite form
    await page.getByPlaceholder('email@example.com').fill(testEmail)
    await page.getByRole('button', { name: 'Send Invite' }).click()

    // Should see invite in pending list
    await expect(page.getByText(testEmail)).toBeVisible({ timeout: 5000 })
  })

  test('can revoke invite', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // First create an invite
    const testEmail = `test-revoke-${Date.now()}@example.com`
    await page.getByPlaceholder('email@example.com').fill(testEmail)
    await page.getByRole('button', { name: 'Send Invite' }).click()
    await expect(page.getByText(testEmail)).toBeVisible({ timeout: 5000 })

    // Find and click revoke button for this invite
    const inviteRow = page.locator('tr').filter({ hasText: testEmail })
    await inviteRow.getByRole('button', { name: 'Revoke' }).click()

    // Invite should be removed
    await expect(page.getByText(testEmail)).not.toBeVisible({ timeout: 5000 })
  })

  test('can copy invite link', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /Test Workspace/i }).first().click()

    // Create an invite first
    const testEmail = `test-copy-${Date.now()}@example.com`
    await page.getByPlaceholder('email@example.com').fill(testEmail)
    await page.getByRole('button', { name: 'Send Invite' }).click()
    await expect(page.getByText(testEmail)).toBeVisible({ timeout: 5000 })

    // Find and click copy link button
    const inviteRow = page.locator('tr').filter({ hasText: testEmail })
    await inviteRow.getByRole('button', { name: 'Copy Link' }).click()

    // Can't easily verify clipboard in Playwright, but button should exist and be clickable
  })
})

test.describe('Admin User Search', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page)
  })

  test('user search shows results when typing', async ({ page }) => {
    // Navigate to a workspace with few members (test space has 1 member: the seeded admin)
    await page.goto('/admin')

    const workspaceLink = page.getByRole('link').filter({ hasText: /test space/i }).first()
    await expect(
      workspaceLink,
      'Seed data should include a "Test Space" workspace for admin user-search tests. See e2e/fixtures/isolated-env.ts (seedAdminUserSearchFixtures).'
    ).toBeVisible({ timeout: 5000 })
    await workspaceLink.click()

    // Type in search box
    await page.getByPlaceholder('Search by email...').fill('dev')

    // Wait for debounced search results (300ms + network)
    await page.waitForTimeout(500)

    // Should show search results or "No users found"
    const hasResults = await page.locator('button').filter({ hasText: /@/ }).first().isVisible().catch(() => false)
    const noResults = await page.getByText('No users found').isVisible().catch(() => false)

    expect(hasResults || noResults).toBeTruthy()
  })

  test('selecting user from search enables Add User button', async ({ page }) => {
    await page.goto('/admin')

    // Go to test space (fewer members, more users to add)
    const testSpaceLink = page.getByRole('link').filter({ hasText: /test space/i }).first()
    await expect(
      testSpaceLink,
      'Seed data should include a "Test Space" workspace. See e2e/fixtures/isolated-env.ts (seedAdminUserSearchFixtures).'
    ).toBeVisible({ timeout: 5000 })
    await testSpaceLink.click()

    // Search for a user. bob.martinez is a member of "Test Workspace" but not
    // "Test Space", so the workspace-scoped search should surface him as addable.
    await page.getByPlaceholder('Search by email...').fill('bob')
    await page.waitForTimeout(500)

    const userResult = page.locator('button').filter({ hasText: /bob/i }).first()
    await expect(
      userResult,
      'Search for "bob" should surface bob.martinez@ship.local as addable to Test Space'
    ).toBeVisible({ timeout: 3000 })
    await userResult.click()

    // Add User button should now be enabled
    const addButton = page.getByRole('button', { name: 'Add User' })
    await expect(addButton).not.toBeDisabled()
  })

  test('can add existing user to workspace', async ({ page }) => {
    await page.goto('/admin')

    // Go to test space
    const testSpaceLink = page.getByRole('link').filter({ hasText: /test space/i }).first()
    await expect(
      testSpaceLink,
      'Seed data should include a "Test Space" workspace. See e2e/fixtures/isolated-env.ts (seedAdminUserSearchFixtures).'
    ).toBeVisible({ timeout: 5000 })
    await testSpaceLink.click()

    // Get initial member count
    const memberHeading = page.getByRole('heading', { name: /Members \((\d+)\)/ })
    const headingText = await memberHeading.textContent()
    const initialCount = parseInt(headingText?.match(/\d+/)?.[0] || '0')

    // isolated-env's DB is worker-scoped (shared across every test file this
    // worker runs), and carol is seeded with no workspace membership anywhere
    // specifically so this search always finds her. Adding her to Test Space
    // without restoring afterward would make this test pass only once per
    // worker -- a retry, or a re-run in the same worker, would no longer find
    // her addable. Restore in `finally`, mirroring the role-change test above.
    try {
      // Search for carol, who is seeded with no workspace membership at all,
      // so she should always be addable here.
      await page.getByPlaceholder('Search by email...').fill('carol')
      await page.waitForTimeout(500)

      const userResult = page.locator('button').filter({ hasText: /carol/i }).first()
      await expect(
        userResult,
        'Search for "carol" should surface carol@ship.local as addable to Test Space'
      ).toBeVisible({ timeout: 3000 })
      await userResult.click()
      await page.getByRole('button', { name: 'Add User' }).click()

      // Member count should increase
      await expect(page.getByRole('heading', { name: /Members \((\d+)\)/ })).toContainText(
        `(${initialCount + 1})`,
        { timeout: 5000 }
      )
    } finally {
      // Best-effort restore: remove carol from Test Space so the fixture's
      // "no membership anywhere" invariant holds for the next run in this
      // worker. If the try block failed before she was added, this is a no-op.
      const carolRow = page.locator('tr').filter({ hasText: /carol/i }).first()
      if (await carolRow.isVisible().catch(() => false)) {
        page.once('dialog', (dialog) => dialog.accept())
        await carolRow.getByRole('button', { name: 'Remove' }).click()
      }
    }
  })
})

test.describe('Admin Workspace Access Control', () => {
  test('non-super-admin cannot access workspace detail', async ({ page }) => {
    // Clear cookies and try to access directly
    await page.context().clearCookies()
    await page.goto('/admin/workspaces/some-id')

    // Should redirect to login (may include query params)
    await expect(page).toHaveURL(/\/login/)
  })
})
