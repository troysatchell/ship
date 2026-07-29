import { test, expect } from './fixtures/isolated-env';

/**
 * Rewritten for audit finding TEST-2 (TRO-224).
 *
 * This file used to be a diagnostic script wearing a test's clothes: **zero
 * `expect()` calls**, nineteen `console.log`s, and `if` guards that `return`ed
 * early ("SKIP: No nested documents"). It could not fail. It was one of the three
 * specs the brace-scanner found with no assertion at all, and it sits next to the
 * sidebar ARIA work (A11Y-1 / TRO-215) it appears to have been written to
 * investigate.
 *
 * It now asserts the contract A11Y-1's fix established: the expand/collapse
 * affordance in the document sidebar is a real `<button>` carrying
 * `aria-expanded`, that state tracks the visible children, and it survives
 * navigating into a child document. Every precondition is an assertion with an
 * actionable message rather than an early `return`.
 *
 * Seed data dependency: `seedMinimalTestData` creates "Welcome to Ship" with two
 * children ("Getting Started", "Advanced Topics") — that is what makes an
 * expandable row exist at all.
 *
 * Caveat, stated because A11Y-1 was itself an over-claim: this asserts the ARIA
 * *contract* and that the control is a real button. It says nothing about what a
 * screen reader announces. That still requires a human.
 */

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  const setupButton = page.getByRole('button', { name: /create admin account/i })
  const signInButton = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(setupButton.or(signInButton)).toBeVisible({ timeout: 10000 })

  if (await setupButton.isVisible()) {
    await page.locator('#name').fill('Dev User')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await setupButton.click()
  } else {
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await signInButton.click()
  }
  await expect(page, 'login should navigate away from /login').not.toHaveURL(/\/login($|\?)/, {
    timeout: 15000,
  })
}

/** The document-list sidebar on /docs. */
function documentSidebar(page: import('@playwright/test').Page) {
  return page.locator('#sidebar-content, aside[aria-label="Document list"]').first()
}

test('check aria-expanded elements', async ({ page }) => {
  await login(page)
  await page.goto('/docs')

  const sidebar = documentSidebar(page)
  await expect(sidebar, 'the document list sidebar should render on /docs').toBeVisible({
    timeout: 15000,
  })

  // Seed data guarantees a nested document, so an expandable row must exist. The
  // old version `return`ed here when it found none, which is exactly why it never
  // reported the absence.
  const expanders = sidebar.locator('[aria-expanded]')
  await expect(
    expanders.first(),
    'Seed data should provide at least one document with children ' +
      '("Welcome to Ship" has two). See e2e/fixtures/isolated-env.ts.'
  ).toBeVisible({ timeout: 15000 })

  // A11Y-1: aria-expanded belongs on the interactive control. An <li> or a <div>
  // carrying it is precisely the defect that finding described.
  const tagNames = await expanders.evaluateAll((els) => els.map((el) => el.tagName))
  expect(tagNames.length, 'at least one aria-expanded element should be present').toBeGreaterThan(0)
  for (const tag of tagNames) {
    expect(tag, 'aria-expanded must sit on a <button>, not a container element').toBe('BUTTON')
  }

  // Every disclosure button must be named and operable.
  const firstExpander = expanders.first()
  await expect(firstExpander).toHaveAttribute('aria-label', /expand|collapse/i)
  await expect(firstExpander).toBeEnabled()
})

test('aria-expanded tracks the visible children and survives navigating into one', async ({
  page,
}) => {
  await login(page)
  await page.goto('/docs')

  const sidebar = documentSidebar(page)
  await expect(sidebar).toBeVisible({ timeout: 15000 })

  // "Welcome to Ship" is the seeded parent; target it by name so the test cannot
  // silently pick up an unrelated row.
  const parentRow = sidebar.locator('li', { hasText: 'Welcome to Ship' }).first()
  await expect(
    parentRow,
    'Seed data should provide a "Welcome to Ship" document with children ' +
      '(e2e/fixtures/isolated-env.ts)'
  ).toBeVisible({ timeout: 15000 })

  const expander = parentRow.locator('button[aria-expanded]').first()
  await expect(
    expander,
    '"Welcome to Ship" has children, so it must render a disclosure button'
  ).toBeVisible({ timeout: 10000 })

  // Collapse first if it happens to start open, so the assertion below is about
  // the toggle rather than about the initial state.
  if ((await expander.getAttribute('aria-expanded')) === 'true') {
    await expander.click()
  }
  await expect(expander, 'the row should be collapsed before expanding').toHaveAttribute(
    'aria-expanded',
    'false',
    { timeout: 10000 }
  )

  const child = sidebar.getByRole('link', { name: 'Getting Started' })
  await expect(child, 'a collapsed parent must not show its children').toHaveCount(0)

  await expander.click()
  await expect(
    expander,
    'clicking the disclosure button must set aria-expanded="true"'
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 })
  await expect(child, 'expanding must reveal the seeded child document').toBeVisible({
    timeout: 10000,
  })

  // Navigating into the child must leave the parent expanded — a disclosure that
  // silently collapses loses the user's place.
  await child.click()
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 15000 })
  await expect(
    documentSidebar(page)
      .locator('li', { hasText: 'Welcome to Ship' })
      .first()
      .locator('button[aria-expanded]')
      .first(),
    'the parent must remain expanded after navigating to its child'
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 15000 })
})
