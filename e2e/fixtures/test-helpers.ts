/**
 * Reusable test helpers for flaky-resistant E2E test patterns.
 *
 * These helpers encapsulate retry logic for common interactions that
 * fail under parallel test load due to timing issues.
 */
import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Trigger the TipTap mention autocomplete popup by typing '@' in the editor.
 *
 * Under parallel load, the '@' keystroke may not trigger the mention popup
 * on the first attempt — the editor may not be focused, the mention extension
 * may not be initialized, or the keystroke may be swallowed. This helper
 * retries by re-clicking the editor, clearing content, and retyping '@'
 * until the popup appears.
 *
 * @param page - The Playwright page (or second page in multi-context tests)
 * @param editor - Locator for the .ProseMirror editor element
 * @returns Locator for the mention popup listbox (already confirmed visible)
 *
 * @example
 * const editor = page.locator('.ProseMirror')
 * await triggerMentionPopup(page, editor)
 * await page.keyboard.type('Document Name')
 * const option = page.locator('[role="option"]').filter({ hasText: 'Document Name' })
 * await option.click()
 */
export async function triggerMentionPopup(page: Page, editor: Locator): Promise<Locator> {
  const mentionPopup = page.locator('[role="listbox"]');
  await expect(async () => {
    await editor.click();
    await expect(editor).toBeFocused({ timeout: 3000 });
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    await page.keyboard.type('@');
    await expect(mentionPopup).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30000, intervals: [1000, 2000, 3000, 4000, 5000] });
  return mentionPopup;
}

/**
 * Hover over an element and verify an assertion, with retry.
 *
 * Under parallel load, Playwright's hover() may not trigger the expected
 * React state update (e.g., onMouseEnter setting focus or revealing a checkbox).
 * This can happen when the DOM shifts due to late-loading data, or when the
 * hover event fires on a stale element reference. This helper retries the
 * hover + assertion until it succeeds.
 *
 * @param target - The element to hover over
 * @param assertion - An async function containing the expect assertion to verify after hover
 *
 * @example
 * // Verify focus ring appears on hover
 * await hoverWithRetry(rows.nth(2), async () => {
 *   await expect(rows.nth(2)).toHaveAttribute('data-focused', 'true', { timeout: 3000 })
 * })
 *
 * // Verify checkbox becomes visible on hover
 * await hoverWithRetry(firstRow, async () => {
 *   await expect(checkboxContainer).toHaveCSS('opacity', '1', { timeout: 3000 })
 * })
 */
export async function hoverWithRetry(
  target: Locator,
  assertion: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await target.hover();
    await assertion();
  }).toPass({ timeout: 10000, intervals: [500, 1000, 2000] });
}

/**
 * Wait for a data table to be fully loaded and stable before interacting.
 *
 * Under parallel load, tables may render incrementally — the first few rows
 * appear, then more data arrives causing re-renders that shift row positions.
 * Interacting with rows during this unstable period causes hover/click to
 * target the wrong element. This helper waits for both the first row to
 * render AND network activity to settle.
 *
 * @param page - The Playwright page
 * @param tableSelector - CSS selector for the table body rows (default: 'table tbody tr')
 *
 * @example
 * await waitForTableData(page)
 * // Table is now stable — safe to hover, click, or count rows
 * const rows = page.locator('tbody tr')
 * await hoverWithRetry(rows.first(), async () => { ... })
 */
export async function waitForTableData(
  page: Page,
  tableSelector = 'table tbody tr',
): Promise<void> {
  await expect(page.locator(tableSelector).first()).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

/** True for an object with the string `id`/`title` fields a doc summary needs. */
function isDocSummary(d: unknown): d is { id: string; title: string } {
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof (d as { id?: unknown }).id === 'string' &&
    typeof (d as { title?: unknown }).title === 'string'
  );
}

/**
 * Open a seeded fixture document by its exact title and wait for the editor.
 *
 * Added for audit finding TEST-2 (TRO-224). Specs that need to assert on
 * *rendered content* were previously typing that content into a new document,
 * which meant a failure to type produced an empty page — and an empty page made
 * every loop-and-assert-inside body pass. Reading a seeded document instead
 * gives the spec a positive control it can insist on.
 *
 * Resolves the id through `GET /api/documents` rather than clicking the sidebar,
 * because sidebar ordering and overflow ("N more...") are not this spec's
 * subject and would reintroduce a conditional.
 *
 * @param page - The Playwright page, already logged in
 * @param title - Exact document title, e.g. `FIXTURE_DOC_LINK_SANITIZATION`
 * @returns The document id
 */
/**
 * Insert a 3x3 table via the `/table` slash command.
 *
 * Added for TRO-310 (TEST-11 batch 2). Replaces the blind
 * click-sleep-type-sleep-click sequence `tables.spec.ts` used at every call
 * site: the slash-command menu filters synchronously
 * (`SlashCommands.tsx`'s `items()` does no async work beyond wrapping a
 * `Promise`), so the only real conditions worth waiting for are the editor
 * actually receiving focus before typing, and the filtered "Table" option
 * rendering before it's clicked — both auto-retrying assertions rather than
 * guessed durations.
 *
 * @param page - The Playwright page
 * @param editor - Locator for the .ProseMirror editor element (already visible)
 * @returns Locator for the inserted `<table>` element (already confirmed visible)
 */
export async function insertTableViaSlashCommand(page: Page, editor: Locator): Promise<Locator> {
  await editor.click();
  await expect(editor).toBeFocused({ timeout: 3000 });

  await page.keyboard.type('/table');
  const tableOption = page.getByRole('button', { name: /^Table Insert a table/i });
  await expect(tableOption).toBeVisible({ timeout: 5000 });
  await tableOption.click();

  const table = editor.locator('table');
  await expect(table).toBeVisible({ timeout: 3000 });
  return table;
}

export async function openFixtureDocument(page: Page, title: string): Promise<string> {
  const res = await page.request.get('/api/documents?type=wiki');
  expect(
    res.status(),
    `GET /api/documents?type=wiki must succeed to locate the "${title}" fixture`,
  ).toBe(200);

  const body: unknown = await res.json();
  const rawList: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : [];
  // Narrow with a runtime guard rather than casting the parsed JSON straight
  // to the expected shape — a cast here would decouple this helper from the
  // API response it claims to read, the same defect class TEST-2 exists to
  // remove, just moved into test infrastructure instead of a test body.
  const docs = rawList.filter(isDocSummary);
  const id = docs.find((d) => d.title === title)?.id ?? '';
  expect(
    id,
    `Seed data should provide a wiki document titled "${title}". ` +
      `Add it to e2e/fixtures/isolated-env.ts (seedRenderingFixtures). ` +
      `Got: ${docs.map((d) => d.title).join(', ') || '<none>'}`,
  ).not.toBe('');

  await page.goto(`/documents/${id}`);
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15000 });
  return id;
}
