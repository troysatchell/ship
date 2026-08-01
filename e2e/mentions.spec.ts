import { test, expect, Page } from './fixtures/isolated-env';

// Helper to create a new document using the available buttons
async function createNewDocument(page: Page) {
  await page.goto('/docs');

  // Wait for the page to stabilize (may auto-redirect to existing doc)
  await page.waitForLoadState('networkidle');

  // Get current URL to detect change after clicking
  const currentUrl = page.url();

  // Try sidebar button first, fall back to main "New Document" button
  const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first();
  const mainButton = page.getByRole('button', { name: 'New Document', exact: true });

  if (await sidebarButton.isVisible({ timeout: 2000 })) {
    await sidebarButton.click();
  } else {
    await expect(mainButton).toBeVisible({ timeout: 5000 });
    await mainButton.click();
  }

  // Wait for URL to change to a new document - unified document routing
  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  );

  // Wait for editor to be ready
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

  // Verify this is a NEW document (title should be "Untitled")
  // The title input has placeholder="Untitled" and should be empty or show "Untitled"
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 });
}

test.describe('Mentions', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
  });

  test('typing @ opens mention popup', async ({ page }) => {
    // Collect console messages
    const consoleMessages: string[] = [];
    page.on('console', msg => consoleMessages.push(`${msg.type()}: ${msg.text()}`));

    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    // Editor must actually have focus before '@' can trigger the mention
    // extension - a bare click doesn't guarantee it lands before the next
    // keystroke under load.
    await expect(editor).toBeFocused({ timeout: 3000 });

    await page.keyboard.type('@');

    // Mention popup should appear once the mentions API call resolves.
    // Debug logging runs in `finally` so it still fires (and still helps
    // diagnose a real failure) even if the popup assertion below times out -
    // previously this only ran after a fixed 1s guess, unconditionally.
    try {
      await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });
    } finally {
      console.log('Console messages:', consoleMessages);
      console.log('Tippy elements found:', await page.locator('[data-tippy-root]').count());
      console.log(
        'Popup elements found:',
        await page.locator('.tippy-box, .tippy-content, [role="listbox"]').count()
      );
    }
  });

  test('mention popup shows search results', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();

    // Type @ to trigger mention popup
    await page.keyboard.type('@');
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Should show People and/or Documents sections
    const popup = page.locator('[role="listbox"]');
    await expect(popup).toBeVisible();
  });

  test('can navigate mention list with keyboard', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Press ArrowDown to navigate
    await page.keyboard.press('ArrowDown');

    // Verify keyboard navigation works (option should be selected)
    const selectedOption = page.locator('[role="option"][aria-selected="true"]');
    await expect(selectedOption).toBeVisible({ timeout: 3000 });
  });

  test('pressing Escape closes mention popup', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Popup should be hidden
    await expect(page.locator('[role="listbox"]')).toBeHidden({ timeout: 3000 });
  });

  test('selecting mention inserts styled inline link', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // If there are results, click the first one
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.isVisible()) {
      await firstOption.click();

      // Should have inserted a mention (class="mention")
      await expect(editor.locator('.mention')).toBeVisible({ timeout: 3000 });
    }
  });

  test('mention shows correct styling for people', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Look for a person option and click it
    const personOption = page.locator('[role="option"]').first();
    if (await personOption.isVisible()) {
      await personOption.click();

      // Verify mention was inserted with proper class
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });
    }
  });

  test('filtering works when typing after @', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();

    // Type @test to filter
    await page.keyboard.type('@test');

    // Popup should be visible (even if showing "No results"). toBeVisible
    // already polls until the filter request resolves - no need to guess
    // how long filtering takes first.
    const popup = page.locator('[role="listbox"]');
    await expect(popup).toBeVisible({ timeout: 5000 });
  });

  test('mention popup positioned below cursor', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    const popup = page.locator('[role="listbox"]');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Popup should be visible and positioned (basic check)
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.y).toBeGreaterThan(0);
  });

  test('can insert mention with Enter key', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Check if there are options
    const optionCount = await page.locator('[role="option"]').count();
    if (optionCount > 0) {
      // Press Enter to select first option
      await page.keyboard.press('Enter');

      // Should have inserted a mention
      await expect(editor.locator('.mention')).toBeVisible({ timeout: 3000 });
    }
  });

  test('empty search shows no results message', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();

    // Type @ followed by gibberish
    await page.keyboard.type('@zzzznonexistent12345');

    // Either show "No results" or have no options. toBeVisible below already
    // polls for the search API response - no fixed guess needed first.
    const popup = page.locator('[role="listbox"]');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Either no options or "No results found" text
    const noResultsText = page.getByText('No results');
    const optionCount = await page.locator('[role="option"]').count();

    // Either we have no options or we have "No results" text
    expect(optionCount === 0 || await noResultsText.isVisible()).toBeTruthy();
  });

  test('should navigate to person on click', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Look for a person option (has avatar/person icon)
    const personOption = page.locator('[role="option"]').first();
    if (await personOption.isVisible()) {
      await personOption.click();

      // Wait for mention to be inserted
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });

      // Click on the mention
      await mention.click();

      // Should navigate to person's profile (URL contains /people/).
      // Note: Navigation behavior depends on implementation - no assertion
      // follows this click today (nothing here to synchronize on), so the
      // fixed 1s wait that used to sit here was pure dead time, not a
      // guard for a check below it. Left unasserted rather than inventing
      // a new navigation assertion, which is out of this ticket's scope.
      // The mention click should trigger onNavigate callback.
    }
  });

  test('should navigate to document on click', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Look for a document option
    const documentOption = page.locator('[role="option"]').first();
    if (await documentOption.isVisible()) {
      await documentOption.click();

      // Wait for mention to be inserted
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });

      // Click on the mention
      await mention.click();

      // Should navigate to document. Navigation behavior depends on
      // implementation - no assertion follows this click today, so the
      // fixed 1s wait that used to sit here was dead time rather than a
      // guard for a check below it. Left unasserted rather than inventing
      // a new navigation assertion, which is out of this ticket's scope.
    }
  });

  test('should show broken styling for deleted target', async ({ page }) => {
    // This test requires:
    // 1. Creating a document with a mention to another document
    // 2. Deleting the target document
    // 3. Verifying the mention shows broken styling

    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Insert a mention
    const option = page.locator('[role="option"]').first();
    if (await option.isVisible()) {
      await option.click();

      // Verify mention was inserted
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });

      // Note: Full broken link testing requires:
      // 1. Identifying the target document ID from the mention
      // 2. Deleting that document via API
      // 3. Reloading and checking for broken styling
      // This is covered in edge-cases.spec.ts
    }
  });

  test('should update mention label when target renamed', async ({ page }) => {
    // This test verifies that when a mentioned document is renamed,
    // the mention displays the new name

    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Insert a mention
    const option = page.locator('[role="option"]').first();
    if (await option.isVisible()) {
      const originalLabel = await option.textContent();
      await option.click();

      // Verify mention was inserted
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });

      // The mention should show the document's current title
      // Note: Full rename testing requires:
      // 1. Renaming the target document
      // 2. Reloading and verifying the mention shows new title
      // This is covered in edge-cases.spec.ts
    }
  });

  test('should sync mentions between collaborators', async ({ page, browser }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('@');

    // Wait for popup
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });

    // Insert a mention
    const option = page.locator('[role="option"]').first();
    if (await option.isVisible()) {
      await option.click();

      // Verify mention was inserted
      const mention = editor.locator('.mention');
      await expect(mention).toBeVisible({ timeout: 3000 });

      // Get current document URL
      const docUrl = page.url();

      // Wait for the collaboration socket to report the mention edit has
      // actually reached and been persisted by the server, rather than
      // guessing 2s is long enough - this is the fixed sleep the TEST-3
      // audit (TRO-225) traced this test's flakiness to. "Saved" requires a
      // live, completed Yjs sync handshake with no in-flight write
      // (SyncStatusIndicator.tsx `deriveSyncIndicator`), which is the
      // strongest client-observable proxy for "page2 will see this if it
      // connects now."
      await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible(
        { timeout: 10000 }
      );

      // Open second tab with same document
      const page2 = await browser.newPage();

      // Login on second page
      await page2.goto('/login');
      await page2.locator('#email').fill('dev@ship.local');
      await page2.locator('#password').fill('admin123');
      await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page2).not.toHaveURL('/login', { timeout: 5000 });

      // Navigate to same document
      await page2.goto(docUrl);

      // Wait for editor to load - the mention assertion below already
      // polls for up to 15s, which covers Yjs sync completing, so no fixed
      // guess is needed between the two.
      await expect(page2.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

      // Verify mention synced to second tab (Yjs sync can be slow)
      await expect(page2.locator('.ProseMirror .mention')).toBeVisible({ timeout: 15000 });

      // Clean up
      await page2.close();
    }
  });
});
