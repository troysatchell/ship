import { test, expect } from './fixtures/isolated-env'

test.describe('Inline Comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  /**
   * Helper: create a document, type text, and return the document page
   */
  async function createDocumentWithText(page: any, text: string) {
    await page.goto('/docs')
    const newButton = page.getByRole('button', { name: 'New Document', exact: true })
    await expect(newButton).toBeVisible({ timeout: 5000 })
    await newButton.click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Type text into editor
    const editor = page.locator('.ProseMirror')
    await editor.click()
    await page.keyboard.type(text, { delay: 5 })
    // Wait for the collaboration socket to confirm the typed text actually
    // reached and was persisted by the server. "Saved" requires a live,
    // completed Yjs sync handshake with no in-flight write
    // (SyncStatusIndicator.tsx `deriveSyncIndicator`) - the strongest
    // client-observable proxy available, in place of guessing 500ms is long
    // enough. This helper backs every test in this file, including
    // "canceling a comment removes the highlight" on the TEST-3 (TRO-225)
    // flake list - an under-synced create here is a plausible source of that
    // flake, since every downstream selection/comment action builds on it.
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    })
  }

  /**
   * Helper: select a specific substring within the editor paragraph
   */
  async function selectText(page: any, target: string) {
    await page.evaluate((t: string) => {
      const p = document.querySelector('[data-testid="tiptap-editor"] .ProseMirror p')
      if (!p) return
      const text = p.textContent || ''
      const idx = text.indexOf(t)
      if (idx === -1) return
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let node: Text | null
      let offset = 0
      while ((node = walker.nextNode() as Text | null)) {
        const len = node.textContent?.length || 0
        if (offset + len > idx) {
          const range = document.createRange()
          range.setStart(node, idx - offset)
          range.setEnd(node, idx - offset + t.length)
          window.getSelection()?.removeAllRanges()
          window.getSelection()?.addRange(range)
          break
        }
        offset += len
      }
    }, target)
    // The evaluate() above only sets the native DOM Selection. ProseMirror
    // mirrors that into its own editor.state.selection asynchronously via
    // the browser's `selectionchange` event, and there is no earlier signal
    // available than an effect of that mirroring completing. The BubbleMenu
    // Comment button renders only once ProseMirror's internal selection is
    // non-empty, so waiting for it here is real evidence the selection
    // landed inside the editor (not just the raw DOM) - for every caller,
    // including the Cmd+Shift+M keyboard-shortcut test, which reads that
    // same internal selection (CommentMark.ts `addKeyboardShortcuts` ->
    // `addComment()`) but has no UI of its own to wait on before this.
    await expect(page.getByRole('button', { name: 'Comment' })).toBeVisible({ timeout: 5000 })
  }

  test('bubble menu shows Comment button on text selection', async ({ page }) => {
    await createDocumentWithText(page, 'Select this text to see the comment button appear.')

    await selectText(page, 'this text')

    // BubbleMenu should appear with Comment button
    const commentBtn = page.getByRole('button', { name: 'Comment' })
    await expect(commentBtn).toBeVisible({ timeout: 3000 })
  })

  test('can create an inline comment via bubble menu', async ({ page }) => {
    await createDocumentWithText(page, 'This paragraph has text that will receive an inline comment.')

    await selectText(page, 'inline comment')

    // Click Comment in bubble menu
    await page.getByRole('button', { name: 'Comment' }).click()

    // Comment input should appear
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await expect(commentInput).toBeVisible({ timeout: 3000 })

    // Type and submit
    await commentInput.fill('This is a test comment')
    await commentInput.press('Enter')

    // The assertions below already poll for the API response and decoration
    // re-render - no fixed guess needed first.

    // The inline comment card should appear with the comment text
    await expect(page.getByText('This is a test comment')).toBeVisible({ timeout: 5000 })

    // The highlighted text should have the comment-highlight class
    const highlight = page.locator('.comment-highlight')
    await expect(highlight).toBeVisible()
  })

  test('can create a comment via Cmd+Shift+M keyboard shortcut', async ({ page }) => {
    await createDocumentWithText(page, 'Testing keyboard shortcut for adding comments quickly.')

    await selectText(page, 'keyboard shortcut')

    // Press Cmd+Shift+M
    await page.keyboard.press('Meta+Shift+m')

    // Comment input should appear
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await expect(commentInput).toBeVisible({ timeout: 3000 })

    // Submit comment
    await commentInput.fill('Created via keyboard shortcut')
    await commentInput.press('Enter')

    await expect(page.getByText('Created via keyboard shortcut')).toBeVisible({ timeout: 5000 })
  })

  test('canceling a comment removes the highlight', async ({ page }) => {
    await createDocumentWithText(page, 'This text will have a comment that gets canceled.')

    await selectText(page, 'comment that gets canceled')

    await page.getByRole('button', { name: 'Comment' }).click()

    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await expect(commentInput).toBeVisible({ timeout: 3000 })

    // Press Escape to cancel
    await page.keyboard.press('Escape')

    // Highlight should be removed (auto-retries until timeout)
    await expect(page.locator('.comment-highlight')).not.toBeVisible({ timeout: 10000 })
  })

  // ERR-6 / TRO-193: dismissing the pending comment by clicking away (not
  // Escape) previously left the mark orphaned in persisted content with no
  // backing comment row (audit/error-handling/raw/probe8-comment-orphan-blur.json).
  test('dismissing a comment by clicking away removes the highlight', async ({ page }) => {
    await createDocumentWithText(page, 'This text will have a comment dismissed by clicking away.')

    await selectText(page, 'dismissed by clicking away')

    await page.getByRole('button', { name: 'Comment' }).click()

    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await expect(commentInput).toBeVisible({ timeout: 3000 })

    // Click away from the pending input — outside the comment widget entirely
    // — rather than pressing Escape or submitting.
    await page.locator('[data-testid="tiptap-editor"]').click({ position: { x: 5, y: 5 } })

    // Highlight should be removed (auto-retries until timeout)
    await expect(page.locator('.comment-highlight')).not.toBeVisible({ timeout: 10000 })

    // The document must not still be carrying the mark once dismissed —
    // reload and confirm it does not come back (this is exactly what
    // probe8-comment-orphan-blur.json found broken: the mark survived reload
    // with 0 backing comment rows). Wait for the actual persisted text to
    // reappear (not just the editor shell) before asserting the highlight is
    // gone — otherwise the assertion could pass vacuously while content is
    // still loading. A count of 0 (not `not.toBeVisible`) confirms the mark
    // doesn't exist in the DOM at all, not merely that it's hidden.
    await page.reload()
    await expect(page.locator('.ProseMirror')).toContainText(
      'This text will have a comment dismissed by clicking away.',
      { timeout: 5000 }
    )
    await expect(page.locator('.comment-highlight')).toHaveCount(0, { timeout: 5000 })
  })

  test('inline comment card shows quoted text, author, and timestamp', async ({ page }) => {
    await createDocumentWithText(page, 'The quoted text should appear in the comment card.')

    await selectText(page, 'quoted text')

    await page.getByRole('button', { name: 'Comment' }).click()
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await commentInput.fill('Checking the card layout')
    await commentInput.press('Enter')

    // Verify card shows quoted text
    await expect(page.getByText('"quoted text"')).toBeVisible({ timeout: 5000 })

    // Verify author name
    await expect(page.locator('.comment-author').first()).toContainText('Dev User')

    // Verify timestamp
    await expect(page.locator('.comment-time').first()).toBeVisible()

    // Verify reply input
    const replyInput = page.getByRole('textbox', { name: 'Reply...' })
    await expect(replyInput).toBeVisible()
  })

  test('can reply to an existing comment', async ({ page }) => {
    await createDocumentWithText(page, 'This comment will receive a reply from another user.')

    await selectText(page, 'receive a reply')

    // Create initial comment
    await page.getByRole('button', { name: 'Comment' }).click()
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await commentInput.fill('Original comment')
    await commentInput.press('Enter')

    // Click the reply input and type a reply. The reply input only exists
    // once the original comment's thread card has rendered (CommentDisplay.tsx
    // template), so `.click()`'s own actionability wait already covers the
    // original comment's round trip - no separate wait needed here.
    const replyInput = page.getByRole('textbox', { name: 'Reply...' })
    await replyInput.click()
    await page.keyboard.type('This is a reply to the original', { delay: 5 })
    await page.keyboard.press('Enter')

    // The reply write goes through useCreateComment (useCommentsQuery.ts),
    // which has no optimistic update - the reply text only renders after its
    // POST succeeds and the subsequent GET refetch completes. Confirming it
    // is visible here (rather than guessing 1500ms is long enough) is what
    // proves the reply is actually persisted before we reload - reloading
    // any earlier could cancel an in-flight request and lose the write.
    await expect(page.getByText('This is a reply to the original')).toBeVisible({ timeout: 5000 })

    // Reload to verify persistence
    await page.reload()

    // Both comments should be visible after reload
    await expect(page.getByText('Original comment')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('This is a reply to the original')).toBeVisible({ timeout: 5000 })
  })

  test('resolving a comment collapses thread and removes highlight', async ({ page }) => {
    await createDocumentWithText(page, 'This highlighted text will be resolved and collapsed.')

    await selectText(page, 'resolved and collapsed')

    // Create comment
    await page.getByRole('button', { name: 'Comment' }).click()
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await commentInput.fill('This will be resolved')
    await commentInput.press('Enter')

    // Verify comment card is visible
    await expect(page.getByText('This will be resolved')).toBeVisible({ timeout: 5000 })

    // Click resolve button - the assertions below already poll for the
    // PATCH (useUpdateComment) and its cache-invalidation refetch.
    await page.getByRole('button', { name: '✓' }).click()

    // Thread should collapse to indicator
    await expect(page.getByText('Resolved by Dev User')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Show thread')).toBeVisible()

    // Original comment text should NOT be visible (collapsed)
    await expect(page.getByText('This will be resolved')).not.toBeVisible()

    // Highlight should be removed (transparent via CSS :has()). The mark's
    // background-color transitions over 150ms (index.css
    // `.comment-highlight`), so use the auto-retrying CSS matcher instead of
    // reading the computed style once - a single read could sample
    // mid-transition.
    const highlight = page.locator('.comment-highlight')
    if (await highlight.count() > 0) {
      await expect(highlight).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)', { timeout: 3000 })
    }
  })

  test('un-resolving restores thread and highlight', async ({ page }) => {
    await createDocumentWithText(page, 'Un-resolving should restore the full comment thread.')

    await selectText(page, 'restore the full')

    // Create and resolve
    await page.getByRole('button', { name: 'Comment' }).click()
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await commentInput.fill('Will be resolved then un-resolved')
    await commentInput.press('Enter')

    // The assertion below already polls for the resolve PATCH and its
    // refetch - no fixed guess needed first.
    await page.getByRole('button', { name: '✓' }).click()

    // Verify collapsed
    await expect(page.getByText('Show thread')).toBeVisible({ timeout: 5000 })

    // Click "Show thread" to un-resolve - the assertion below already polls
    // for the un-resolve PATCH and its refetch.
    await page.getByText('Show thread').click()

    // Thread should be expanded again
    await expect(page.getByText('Will be resolved then un-resolved')).toBeVisible({ timeout: 5000 })

    // Highlight should be restored (visible amber color). The `:has()`
    // selector swap triggers a 150ms CSS transition (index.css
    // `.comment-highlight`), so use the auto-retrying CSS matcher rather
    // than reading the computed style once after a guessed delay - avoids
    // sampling mid-transition.
    const highlight = page.locator('.comment-highlight')
    await expect(highlight).toBeVisible()
    // rgba(245, 158, 11, 0.2)
    await expect(highlight).toHaveCSS('background-color', /245/, { timeout: 3000 })
  })

  test('comments persist across page reload', async ({ page }) => {
    await createDocumentWithText(page, 'Comments should survive a full page reload for persistence.')

    await selectText(page, 'full page reload')

    // Create comment
    await page.getByRole('button', { name: 'Comment' }).click()
    const commentInput = page.getByRole('textbox', { name: 'Write a comment...' })
    await commentInput.fill('Persistence check')
    await commentInput.press('Enter')

    // Confirms the create POST (useCreateComment, no optimistic update) has
    // actually completed before reload - reloading any earlier could cancel
    // an in-flight request and lose the write.
    await expect(page.getByText('Persistence check')).toBeVisible({ timeout: 5000 })

    // Reload
    await page.reload()

    // Comment should still be visible after reload
    await expect(page.getByText('Persistence check')).toBeVisible({ timeout: 10000 })
  })
})
