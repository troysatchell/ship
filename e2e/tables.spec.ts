import { test, expect, Page } from './fixtures/isolated-env';
import { insertTableViaSlashCommand } from './fixtures/test-helpers';

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
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 });
}

test.describe('Tables', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
  });

  test('should create table via /table command', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await insertTableViaSlashCommand(page, editor);
  });

  // TRO-310: "should add rows to table", "should add columns to table",
  // "should delete rows from table", and "should delete columns from table"
  // used to live here as real-looking tests. All four right-clicked a table
  // cell and looked for a context-menu item ("Add row"/"Delete column"/etc.)
  // behind `if (await option.isVisible({ timeout: 2000 }).catch(() => false))`
  // with no `else` — so a menu that never appeared just skipped the entire
  // verification block and the test still reported green. Investigated
  // (TRO-310): `Editor.tsx` wires only the stock TipTap `Table`/`TableRow`/
  // `TableCell`/`TableHeader` extensions (`Editor.tsx:705-713`); the only
  // `onContextMenu` handler in the editor is the unrelated "Add Comment" menu
  // (`Editor.tsx:1068-1096`), gated on a non-empty text selection, so
  // right-clicking a caret-only cell (as these tests did) doesn't even open
  // that. There is no row/column-mutation UI anywhere in `web/src` — the
  // underlying TipTap commands (`addRowAfter`, `deleteColumn`, etc.) exist in
  // `@tiptap/extension-table` but nothing wires them to a menu, toolbar, or
  // shortcut. These four tests were therefore always vacuous: not flaky, not
  // broken by a bad wait — asserting on UI that has never existed. Converted
  // to `test.fixme()` (TEST-2's sanctioned pattern for "reports covered,
  // isn't") rather than deleted, so the gap stays visible. This is a product
  // surface gap, not a fix for this test-hardening ticket to make — flagged
  // in the ticket's final report for a human product decision (build
  // row/column controls, or delete these test stubs outright).
  test.fixme('should add rows to table', async ({ page }) => {
    await createNewDocument(page);
    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);
    const initialRows = await table.locator('tr').count();

    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await firstCell.click({ button: 'right' });

    const addRowOption = page.getByText(/Add row|Insert row/i);
    await expect(addRowOption).toBeVisible({ timeout: 5000 });
    await addRowOption.click();

    await expect(table.locator('tr')).toHaveCount(initialRows + 1);
  });

  test.fixme('should add columns to table', async ({ page }) => {
    await createNewDocument(page);
    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);
    const firstRow = table.locator('tr').first();
    const initialCols = await firstRow.locator('td, th').count();

    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await firstCell.click({ button: 'right' });

    const addColOption = page.getByText(/Add column|Insert column/i);
    await expect(addColOption).toBeVisible({ timeout: 5000 });
    await addColOption.click();

    await expect(firstRow.locator('td, th')).toHaveCount(initialCols + 1);
  });

  test.fixme('should delete rows from table', async ({ page }) => {
    await createNewDocument(page);
    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);
    const initialRows = await table.locator('tr').count();

    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await firstCell.click({ button: 'right' });

    const deleteRowOption = page.getByText(/Delete row|Remove row/i);
    await expect(deleteRowOption).toBeVisible({ timeout: 5000 });
    await deleteRowOption.click();

    await expect(table.locator('tr')).toHaveCount(initialRows - 1);
  });

  test.fixme('should delete columns from table', async ({ page }) => {
    await createNewDocument(page);
    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);
    const firstRow = table.locator('tr').first();
    const initialCols = await firstRow.locator('td, th').count();

    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await firstCell.click({ button: 'right' });

    const deleteColOption = page.getByText(/Delete column|Remove column/i);
    await expect(deleteColOption).toBeVisible({ timeout: 5000 });
    await deleteColOption.click();

    await expect(firstRow.locator('td, th')).toHaveCount(initialCols - 1);
  });

  test('should navigate cells with Tab key', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Click in first cell and type content, then Tab to the next cell
    const cells = table.locator('td, th');
    await cells.nth(0).click();
    await page.keyboard.type('FIRST');
    await page.keyboard.press('Tab');
    await page.keyboard.type('SECOND');

    // Verify both cells have different content (Tab moved cursor to next cell).
    // Auto-retrying assertions absorb any render lag between the keystrokes
    // above and the DOM reflecting them, so no interstitial waits are needed.
    await expect(cells.nth(0)).toContainText('FIRST');
    await expect(cells.nth(1)).toContainText('SECOND');
  });

  test('should edit cell content', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Click in first cell
    const firstCell = table.locator('td, th').first();
    await firstCell.click();

    // Type content
    await page.keyboard.type('Cell content');

    // Verify content appears
    await expect(firstCell).toContainText('Cell content');
  });

  test('should show header row styling', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Check if first row has header cells (th) or special styling
    const headerRow = table.locator('tr').first();
    const headerCells = headerRow.locator('th');

    // Either has th elements or td with header class
    const hasHeaders = await headerCells.count().then(count => count > 0);
    const hasHeaderClass = await headerRow.locator('td[class*="header"], td[class*="Header"]').count().then(count => count > 0);

    expect(hasHeaders || hasHeaderClass).toBeTruthy();
  });

  test('should select entire table', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Add identifiable content to the table
    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await page.keyboard.type('TABLE_CONTENT');
    await expect(firstCell).toContainText('TABLE_CONTENT');

    // TRO-310: this test used to press `Meta+a` and check for a
    // `.selectedCell`/`ProseMirror-selectednode` marker, but the check was
    // masked by `|| true` in the DOM `evaluate()` — it always passed
    // regardless of the real state. Removing the fallback and re-running
    // showed the real check failing 3/3: `Meta+a` performs a normal
    // document-wide select-all in this editor (a `TextSelection`, not a
    // table `CellSelection`), confirmed by probing further — typing after
    // it replaces the *entire document* with the typed text, destroying the
    // table outright, not just its content. `.selectedCell` is real product
    // behavior (it has a dedicated rule in `index.css`), but it requires an
    // actual multi-cell mouse drag to produce, not a keyboard select-all.
    // Verified empirically: dragging from the first cell to the last cell
    // marks all 9 cells `.selectedCell`.
    const cells = table.locator('td, th');
    const cellCount = await cells.count();
    await cells.first().hover();
    await page.mouse.down();
    await cells.last().hover();
    await page.mouse.move(1, 1, { steps: 3 });
    await page.mouse.up();

    await expect(table.locator('.selectedCell')).toHaveCount(cellCount);

    // The drag-select is a selection, not an edit — table content is untouched.
    await expect(table).toContainText('TABLE_CONTENT');
  });

  test('should delete entire table', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    const firstCell = table.locator('td, th').first();
    await firstCell.click();

    // TRO-310: there is no "Delete table" context-menu item in this editor
    // (see the fixme block above for the investigation) — the previous
    // `if (await deleteTableOption.isVisible(...))` branch could never run,
    // and the test only ever passed via its `else` fallback. Simplified to
    // that fallback directly: select-all-and-backspace clears the whole
    // document, table included. `ControlOrMeta+a` is Playwright's
    // cross-platform select-all alias (TEST-11/TRO-233 found a hard-coded
    // `Control+a` silently no-op on macOS Chromium, where `Mod` resolves to
    // `Meta`); used here even though this file's Chromium is macOS today; so
    // the same test also produces a real select-all under CI's Linux runners.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    await expect(table).toBeHidden({ timeout: 3000 });
  });

  test('should persist table after reload', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Add some content to first cell
    const firstCell = table.locator('td, th').first();
    await firstCell.click();
    await page.keyboard.type('Persistent data');

    // Wait for the collaboration socket to report a completed sync before
    // reloading - reloading before the edit reaches the server would race an
    // in-flight write and could read back stale content (TEST-11/TRO-233's
    // sync-status pattern; "Saved" requires `isSynced` with no pending local
    // edit, `SyncStatusIndicator.tsx`'s `deriveSyncIndicator`).
    await expect(page.getByTestId('sync-status').getByText('Saved', { exact: true })).toBeVisible({
      timeout: 10000,
    });

    // Hard refresh
    await page.reload();

    // Wait for editor to load
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

    // Verify table still exists
    await expect(page.locator('.ProseMirror table')).toBeVisible({ timeout: 5000 });

    // Verify content persisted
    await expect(page.locator('.ProseMirror table')).toContainText('Persistent data');
  });

  test('should navigate with Shift+Tab to go backwards', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // Click in first cell, type content, then Tab to second cell
    const cells = table.locator('td, th');
    await cells.nth(0).click();
    await page.keyboard.type('CELL1');
    await page.keyboard.press('Tab');
    await page.keyboard.type('CELL2');

    // Now press Shift+Tab to go back to first cell
    // NOTE: Shift+Tab selects all content in destination cell (TipTap behavior)
    await page.keyboard.press('Shift+Tab');

    // TipTap selects cell content on Shift+Tab, verify we're in the first cell
    // by checking that typing replaces the content (expected TipTap behavior)
    await page.keyboard.type('REPLACED');

    // Verify first cell content was replaced (TipTap selects all on Shift+Tab).
    // Auto-retrying assertions replace the fixed sleeps that used to sit
    // between every keyboard action above.
    await expect(cells.nth(0)).toContainText('REPLACED');
    await expect(cells.nth(0)).not.toContainText('CELL1');
    await expect(cells.nth(1)).toContainText('CELL2');
  });

  test('should support column resizing', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    const table = await insertTableViaSlashCommand(page, editor);

    // TRO-310: the previous version queried for the resize handle right
    // after the table appeared, behind a soft `isVisible({ timeout })
    // .catch(() => false)` check — which never actually waited, since
    // `isVisible()`'s `timeout` option is ignored by Playwright (deprecated,
    // resolves immediately either way) — so it always read as absent and the
    // whole `if` body never ran. It's absent at that point for a *different*
    // real reason, not a wait-timing one: `prosemirror-tables`'
    // `columnResizing` plugin (`dist/index.cjs`'s `handleMouseMove`/
    // `handleDecorations`) renders `.column-resize-handle` only as a
    // decoration near an active mouse position within `handleWidth` (5px,
    // the plugin's default) of a column border — it is not present in the
    // DOM until the mouse has actually moved there. Move the mouse to the
    // first cell's right edge to trigger it for real, then assert.
    const firstCell = table.locator('td, th').first();
    const cellBox = await firstCell.boundingBox();
    if (!cellBox) {
      throw new Error('first cell should have a bounding box (table is visible, so it must have layout)');
    }
    await page.mouse.move(cellBox.x + cellBox.width - 2, cellBox.y + cellBox.height / 2);

    const resizeHandle = table.locator('[class*="resize"], [class*="column-resize"]').first();
    await expect(resizeHandle).toBeVisible({ timeout: 5000 });

    const initialWidth = await firstCell.evaluate(el => el.offsetWidth);

    // Drag the resize handle
    await page.mouse.down();
    await page.mouse.move(cellBox.x + cellBox.width + 48, cellBox.y + cellBox.height / 2, { steps: 5 });
    await page.mouse.up();

    // Width change follows layout recalculation, not a fixed 300ms guess -
    // poll for it instead.
    await expect
      .poll(() => firstCell.evaluate(el => el.offsetWidth), { timeout: 3000 })
      .not.toBe(initialWidth);
  });
});
