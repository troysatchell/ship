import { test, expect, Page } from './fixtures/isolated-env'
import type { Locator } from '@playwright/test'
import { triggerMentionPopup } from './fixtures/test-helpers'

/**
 * Backlinks E2E Tests
 *
 * Tests backlink panel display, creation, removal, and navigation.
 */

// Helper to login before each test
async function login(page: Page) {
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

// Helper to create a new document and get to the editor
async function createNewDocument(page: Page) {
  await page.goto('/docs')
  await page.getByRole('button', { name: 'New Document', exact: true }).click()
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
  return page.url()
}

// Helper to set document title
async function setDocumentTitle(page: Page, title: string) {
  const titleInput = page.getByPlaceholder('Untitled')
  await expect(titleInput).toBeVisible({ timeout: 5000 })
  // Register the response listener BEFORE fill() triggers the PATCH - awaiting
  // fill() first risks the response arriving before waitForResponse attaches,
  // which would then hang on a future PATCH that never comes (CodeRabbit,
  // PR review, TRO-310). The PATCH response itself confirms the server has
  // the new title - no further wait is needed before whatever the caller
  // does next.
  const titlePatched = page.waitForResponse(
    resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH',
    { timeout: 5000 }
  )
  await titleInput.fill(title)
  await titlePatched
}

/**
 * Wait for `BacklinksPanel` to finish its first fetch after mounting.
 *
 * `BacklinksPanel.tsx` only renders "Loading..." while `backlinks.length === 0`,
 * which is exactly the state right after a fresh mount (a `page.goto()` or
 * `page.reload()`) before its first `fetch` resolves. Waiting for that text to
 * disappear is a real signal that the panel's data is settled, replacing the
 * fixed sleeps this file used to have between a reload and reading the
 * panel's content (TRO-310 / TEST-11 batch 2).
 */
async function waitForBacklinksLoaded(scope: Page | Locator) {
  await expect(scope.getByText('Loading...')).not.toBeVisible({ timeout: 10000 })
}

test.describe('Backlinks', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('backlinks panel shows in sidebar', async ({ page }) => {
    await createNewDocument(page)

    // Look for backlinks panel in properties sidebar (right side)
    // Common selectors: "Backlinks", "Referenced by", or a data attribute
    const backlinksPanel = page.locator('text="Backlinks"').or(
      page.locator('text="Referenced by"')
    ).or(
      page.locator('[data-backlinks-panel]')
    )

    // Backlinks panel should be visible in sidebar
    await expect(backlinksPanel.first()).toBeVisible({ timeout: 5000 })
  })

  test('creating mention adds backlink', async ({ page }) => {
    // Create Document A (will be mentioned)
    const docAUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Document A')

    // Create Document B (will mention Document A)
    const docBUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Document B')

    const editor = page.locator('.ProseMirror')
    await triggerMentionPopup(page, editor)

    // Type search term to filter - the option assertion right below already
    // retries, so no extra wait is needed between typing and checking (TRO-310).
    await page.keyboard.type('Document A')

    // Select Document A from list. `/api/search/mentions` is a real network +
    // DB round trip (`MentionExtension.ts`'s `fetchMentionSuggestions`), and
    // this suite runs many workers' worth of it concurrently - TRO-310 found
    // via repeated full-file re-runs that 5000ms here is not always enough
    // under real contention (a genuine, reproducible flake, confirmed
    // present even against the pre-hardening code, not something this
    // ticket's changes introduced), so this uses the same generous budget as
    // this file's "Saved" sync-status waits rather than the plain-DOM-check
    // 5000ms used elsewhere.
    const docAOption = page.locator('[role="option"]').filter({ hasText: 'Document A' })
    await expect(docAOption).toBeVisible({ timeout: 10000 })
    await docAOption.click()

    // Wait for the mention edit to actually reach the server before
    // navigating away - navigating before persistence completes can race an
    // in-flight write. "Saved" requires a live, completed Yjs sync with no
    // pending local edit (TEST-11/TRO-233's sync-status pattern;
    // `SyncStatusIndicator.tsx`'s `deriveSyncIndicator`).
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate to Document A
    await page.goto(docAUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Reload to ensure backlinks are fetched fresh
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Document A should now show Document B in backlinks
    // Scope to properties sidebar to avoid matching sidebar doc list
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })
    await waitForBacklinksLoaded(propertiesSidebar)

    const backlinksPanel = propertiesSidebar.locator('text="Backlinks"').or(
      propertiesSidebar.locator('text="Referenced by"')
    ).or(
      propertiesSidebar.locator('[data-backlinks-panel]')
    ).first()

    await expect(backlinksPanel).toBeVisible({ timeout: 3000 })

    // Look for Document B in backlinks (within properties sidebar) - a real
    // auto-retrying assertion instead of the previous
    // `isVisible({ timeout: 5000 })` (Playwright ignores `isVisible`'s
    // `timeout` option entirely - it never actually waited).
    await expect(propertiesSidebar.getByText('Document B')).toBeVisible({ timeout: 5000 })
  })

  test('removing mention removes backlink', async ({ page }) => {
    // Create Document A (will be mentioned)
    const docAUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Doc to Mention')

    // Create Document B (will mention Document A, then remove it)
    const docBUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Doc with Mention')

    const editor = page.locator('.ProseMirror')
    await triggerMentionPopup(page, editor)

    await page.keyboard.type('Doc to Mention')

    const docOption = page.locator('[role="option"]').filter({ hasText: 'Doc to Mention' })
    await expect(docOption).toBeVisible({ timeout: 10000 })
    await docOption.click()

    // Delete the mention by selecting all content and deleting it
    // NOTE: Can't click on .mention directly because MentionExtension's click handler
    // calls onNavigate() which navigates away from the page.
    // Instead, use keyboard shortcuts to select all and delete.
    const mention = editor.locator('.mention')
    await expect(mention).toBeVisible({ timeout: 3000 })

    // Focus the editor and select all content. `ControlOrMeta+a` is
    // Playwright's cross-platform select-all alias (TEST-11/TRO-233 found a
    // hard-coded `Control+a` silently no-op on macOS Chromium, where `Mod`
    // resolves to `Meta`).
    await editor.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace') // Delete selected content

    // Verify mention is deleted before waiting for POST - `.not.toBeVisible()`
    // already retries, replacing the fixed "debounce is 500ms" wait that used
    // to sit here.
    await expect(editor.locator('.mention')).not.toBeVisible({ timeout: 3000 })

    // Wait for the link sync POST request (debounced 500ms)
    await page.waitForResponse(
      resp => resp.url().includes('/links') && resp.request().method() === 'POST',
      { timeout: 5000 }
    ).catch((err) => {
      console.log('No /links POST detected after mention removal:', err.message)
    })

    // Confirm the removal itself reached the server (real gate, replacing a
    // fixed "extra wait for sync to propagate").
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate to Document A and reload to ensure fresh backlinks data
    await page.goto(docAUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Reload to ensure backlinks are fetched fresh from server
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Document A should NOT show Document B in backlinks (or show empty state)
    // Look within the properties sidebar for backlinks
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })
    await waitForBacklinksLoaded(propertiesSidebar)

    // Should either show "No backlinks" or not have "Doc with Mention" in the backlinks section.
    // Both reads happen only after `waitForBacklinksLoaded` confirms the
    // panel's data has settled, so a plain (non-waiting) `isVisible()` is
    // honest here rather than the previous `{ timeout: 2000 }` that implied,
    // incorrectly, that it would wait.
    const hasNoBacklinks = await propertiesSidebar.getByText('No backlinks').isVisible()
    const hasDocWithMention = await propertiesSidebar.getByText('Doc with Mention').isVisible()

    // Either "No backlinks" is shown, OR the doc is not in the backlinks
    expect(hasNoBacklinks || !hasDocWithMention).toBeTruthy()
  })

  test('backlinks show correct document info', async ({ page }) => {
    // Create Document X
    const docXUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Target Document')

    // Create Document Y that mentions X
    const docYUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Referencing Document')

    const editor = page.locator('.ProseMirror')
    await triggerMentionPopup(page, editor)

    await page.keyboard.type('Target Document')

    const docOption = page.locator('[role="option"]').filter({ hasText: 'Target Document' })
    await expect(docOption).toBeVisible({ timeout: 10000 })
    await docOption.click()

    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate to Target Document
    await page.goto(docXUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Reload to ensure backlinks are fetched fresh
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Check backlinks panel shows correct info
    // Scope to properties sidebar to avoid matching sidebar doc list
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })

    const backlinksPanel = propertiesSidebar.locator('text="Backlinks"').or(
      propertiesSidebar.locator('text="Referenced by"')
    ).or(
      propertiesSidebar.locator('[data-backlinks-panel]')
    ).first()

    // Both checks below already auto-retry, so no wait is needed between the
    // reload above and here (TRO-310).
    await expect(backlinksPanel).toBeVisible({ timeout: 3000 })

    // Should show "Referencing Document" with document icon or title (within properties sidebar)
    const backlink = propertiesSidebar.locator('text="Referencing Document"')
    await expect(backlink).toBeVisible({ timeout: 5000 })
  })

  test('clicking backlink navigates to source document', async ({ page }) => {
    // Listen for console messages
    page.on('console', msg => {
      if (msg.text().includes('LinkSync')) {
        console.log('[Browser]', msg.text())
      }
    })

    // Create Document M (will be mentioned)
    const docMUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Mentioned Doc')

    // Create Document N (will mention Document M)
    const docNUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Source Doc')

    const editor = page.locator('.ProseMirror')
    await triggerMentionPopup(page, editor)

    await page.keyboard.type('Mentioned Doc')

    const docOption = page.locator('[role="option"]').filter({ hasText: 'Mentioned Doc' })
    await expect(docOption).toBeVisible({ timeout: 10000 })
    await docOption.click()

    // Wait for the link sync POST request (debounced 500ms)
    await page.waitForResponse(
      resp => resp.url().includes('/links') && resp.request().method() === 'POST',
      { timeout: 5000 }
    ).catch(() => console.log('No /links POST detected'))

    // Confirm the sync actually completed (real gate, replacing a fixed
    // "wait for any pending syncs").
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate to Mentioned Doc and reload to ensure fresh backlinks data
    await page.goto(docMUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Reload to ensure backlinks are fetched fresh from server
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Find backlink to Source Doc in the properties sidebar and click it
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })

    // Look for "Source Doc" link within the properties sidebar
    const sourceLinkInBacklinks = propertiesSidebar.locator('text="Source Doc"')
    await expect(sourceLinkInBacklinks.first()).toBeVisible({ timeout: 5000 })
    await sourceLinkInBacklinks.first().click()

    // Should navigate to Source Doc (Document N). `toHaveURL` auto-retries -
    // the previous version did a fixed 1000ms sleep then a plain synchronous
    // `expect(page.url())`, a point-in-time check on an async navigation
    // (AGENTS.md anti-pattern 3).
    const docNId = docNUrl.split('/').pop()
    if (!docNId) {
      throw new Error(`docNUrl did not contain a document id: ${docNUrl}`)
    }
    await expect(page).toHaveURL(new RegExp(docNId), { timeout: 5000 })

    // Verify we're on Source Doc page - `toHaveValue` auto-retries the title
    // load instead of reading `inputValue()` once, immediately after navigation.
    const titleInput = page.getByPlaceholder('Untitled')
    await expect(titleInput).toHaveValue('Source Doc', { timeout: 5000 })
  })

  test('backlinks update in real-time', async ({ page, browser }) => {
    // Create Document P (will be mentioned)
    const docPUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Real-time Doc')

    // Open second browser context for Document Q
    const page2 = await browser.newPage()
    await page2.goto('/login')
    await page2.locator('#email').fill('dev@ship.local')
    await page2.locator('#password').fill('admin123')
    await page2.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page2).not.toHaveURL('/login', { timeout: 5000 })

    // Create Document Q in second tab
    await page2.goto('/docs')
    // Wait for the page to actually settle (a real condition) before
    // dismissing any modal that might be open, rather than a fixed 500ms guess.
    await page2.waitForLoadState('networkidle')
    await page2.keyboard.press('Escape')
    await page2.getByRole('button', { name: 'New Document', exact: true }).click()
    await expect(page2).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
    await expect(page2.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    const titleInput2 = page2.getByPlaceholder('Untitled')
    await titleInput2.fill('Live Update Doc')
    await page2.waitForResponse(
      resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH',
      { timeout: 5000 }
    )
    // TRO-310: tried removing this as dead time (matching every other
    // title-save-then-continue site in this file, all of which were safe to
    // trim). This one is not: A/B tested with repeated solo re-runs
    // (`--repeat-each=5 --workers=1`, no cross-test contention) against
    // *unchanged* code either side of it - removing it made the *later*,
    // seemingly unrelated mention-search interaction below fail 5/5
    // (the typed "Real-time Doc" query landed as literal paragraph text
    // instead of opening a mention, because the suggestion plugin had
    // already exited by the time it was checked); restoring it passed 5/5,
    // twice. Replacing it with `page2.waitForLoadState('networkidle')` (a
    // real condition, not a guessed duration) was tried first and did NOT
    // fix it (still 5/5 failed), ruling out "waiting for network to settle"
    // as the mechanism. The duration matches this codebase's own named
    // constant for the debounce that starts on every editor update
    // (`Editor.tsx:875`'s `syncLinks` debounce, `setTimeout(syncLinks, 500)`;
    // also named in this same file's own "debounce is 500ms" comment on the
    // "removing mention removes backlink" test above) - kept as a real,
    // named-constant exception in the same spirit as TEST-11/TRO-233's one
    // sanctioned fixed-wait (a CSS-transition duration), though the exact
    // causal path from this page's title-save to the second page's mention
    // interaction below was not traced further within this ticket's scope.
    await page2.waitForTimeout(500)

    // In page2, mention Document P
    const editor2 = page2.locator('.ProseMirror')
    await triggerMentionPopup(page2, editor2)

    // Type search term to filter
    await page2.keyboard.type('Real-time Doc')

    // Select the document option
    const docOption = page2.locator('[role="option"]').filter({ hasText: 'Real-time Doc' })
    await expect(docOption).toBeVisible({ timeout: 10000 })
    await docOption.click()

    // Wait for sync to complete in page2 (real gate, replacing a fixed 2000ms wait)
    await expect(page2.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // In page1 (Document P), check if backlinks updated
    await page.goto(docPUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Reload to ensure backlinks are fetched fresh from server
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Should see "Live Update Doc" in backlinks within properties sidebar
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })

    // Look for backlinks heading
    const backlinksHeading = propertiesSidebar.locator('text="Backlinks"')
    await expect(backlinksHeading).toBeVisible({ timeout: 3000 })

    // Check for "Live Update Doc" within the properties sidebar
    const liveUpdateDocLink = propertiesSidebar.locator('text="Live Update Doc"')
    await expect(liveUpdateDocLink).toBeVisible({ timeout: 5000 })

    // Clean up
    await page2.close()
  })

  test('backlinks panel shows empty state when no backlinks', async ({ page }) => {
    await createNewDocument(page)
    await setDocumentTitle(page, 'Lonely Document')

    // Find backlinks panel
    const backlinksPanel = page.locator('text="Backlinks"').or(
      page.locator('text="Referenced by"')
    ).or(
      page.locator('[data-backlinks-panel]')
    ).first()

    await expect(backlinksPanel).toBeVisible({ timeout: 3000 })
    // Wait for the real "loaded" condition instead of a fixed "wait a moment
    // for any potential backlinks to load".
    await waitForBacklinksLoaded(page)

    // Should show empty state message
    const emptyMessage = page.getByText('No backlinks', { exact: false }).or(
      page.getByText('No documents reference this page', { exact: false })
    ).or(
      page.getByText('Not referenced', { exact: false })
    )

    // Either empty message is visible or no backlink items exist - both reads
    // happen only after the loading gate above, so a plain `isVisible()` is
    // accurate (no implied wait, unlike the previous `{ timeout: 2000 }`).
    const hasEmptyMessage = await emptyMessage.isVisible()
    const backlinkItems = page.locator('[data-backlink-item], .backlink-item, .backlink')
    const itemCount = await backlinkItems.count()

    expect(hasEmptyMessage || itemCount === 0).toBeTruthy()
  })

  test('backlinks count updates correctly', async ({ page }) => {
    // Create Document Z (will be mentioned)
    const docZUrl = await createNewDocument(page)
    await setDocumentTitle(page, 'Popular Doc')

    // Create two documents that mention Document Z
    for (let i = 1; i <= 2; i++) {
      await page.goto('/docs')
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

      const titleInput = page.getByPlaceholder('Untitled')
      await titleInput.fill(`Referrer ${i}`)
      await page.waitForResponse(
        resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH',
        { timeout: 5000 }
      )

      const editor = page.locator('.ProseMirror')

      // Blur the title input, then focus the editor and confirm it actually
      // has focus before typing - a real, auto-retrying condition replacing
      // two fixed sleeps and a defensive manual `.focus()` poke that were
      // compensating for exactly this race (TRO-310).
      await page.keyboard.press('Tab')
      await editor.click()
      await expect(editor).toBeFocused({ timeout: 5000 })

      // Type @ to trigger mention popup
      await page.keyboard.type('@')

      // Wait for mention popup to appear (may take a moment for API call)
      const mentionPopup = page.locator('[role="listbox"]')
      await expect(mentionPopup).toBeVisible({ timeout: 10000 })

      // Type search term
      await page.keyboard.type('Popular Doc')

      // Wait for our document to appear in results and select it. TRO-310:
      // this timeout was 3000ms here (inconsistent with the 5000ms used for
      // the identical check everywhere else in this file) and was the
      // confirmed cause of a real, reproduced flake - the mention search
      // filter occasionally takes longer than 3s under load
      // (`test-results/errors/backlinks.spec__backlinks_count_updates_correctly.log`,
      // captured on this ticket's own pre-change baseline run). Bumped to
      // 10000ms, not just 5000ms: a full-file 3x repeat re-run surfaced the
      // same class of failure at 5000ms too (`/api/search/mentions` is a
      // real network + DB round trip run under many concurrent workers,
      // `MentionExtension.ts`'s `fetchMentionSuggestions`) - confirmed via
      // an A/B run that this is a pre-existing flake class (also reproduced
      // against the unmodified pre-ticket code under the same concurrent
      // full-file load), not one this ticket's changes introduced.
      const docOption = page.locator('[role="option"]').filter({ hasText: 'Popular Doc' })
      await expect(docOption).toBeVisible({ timeout: 10000 })

      // Press Enter to select
      await page.keyboard.press('Enter')

      // Wait for mention to be inserted
      await expect(editor.locator('[data-type="mention"], .mention')).toBeVisible({ timeout: 3000 })

      // Wait for link sync to complete (real gate, replacing a fixed 1000ms wait)
      await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
        timeout: 10000,
      })
    }

    // Navigate to Popular Doc
    await page.goto(docZUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Should show 2 backlinks (or backlinks count)
    // Scope to properties sidebar to avoid matching sidebar doc list
    const propertiesSidebar = page.locator('aside[aria-label="Document properties"]')
    await expect(propertiesSidebar).toBeVisible({ timeout: 3000 })

    const backlinksPanel = propertiesSidebar.locator('text="Backlinks"').or(
      propertiesSidebar.locator('text="Referenced by"')
    ).or(
      propertiesSidebar.locator('[data-backlinks-panel]')
    ).first()

    await expect(backlinksPanel).toBeVisible({ timeout: 3000 })

    // Check for both referrers (within properties sidebar) using retry pattern
    await expect(async () => {
      const hasReferrer1 = await propertiesSidebar.locator('text="Referrer 1"').isVisible()
      const hasReferrer2 = await propertiesSidebar.locator('text="Referrer 2"').isVisible()
      expect(hasReferrer1 && hasReferrer2).toBeTruthy()
    }).toPass({ timeout: 10000 })
  })
})
