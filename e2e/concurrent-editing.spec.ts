import { test, expect, Page } from './fixtures/isolated-env'

/**
 * TRO-226 / TEST-4 — concurrent multi-client editing, in real browsers.
 *
 * ============================================================================
 * THIS FILE IS NOT EXECUTED BY CI OR BY THE FACTORY GATE.
 *
 * `.github/workflows/ci.yml` has no Playwright job, and
 * `scripts/factory/gate.sh` runs only the two vitest projects — `api`'s config
 * pins `include: ['src/**\/*.test.ts']` and `web`'s resolves from `web/`, so
 * neither can reach `e2e/`. The gate's regression-test check counts added cases
 * in `*.spec.ts` and would be satisfied by this file alone, which is exactly the
 * TEST-2 failure mode: coverage that is advertised and never runs.
 *
 * The EXECUTING proof for this ticket is
 * `api/src/collaboration/__tests__/concurrent-merge.test.ts`, which the gate
 * does run. This file is additive, and it earns its place by covering the one
 * thing that test cannot reach: the real client — TipTap, `y-websocket`,
 * IndexedDB persistence, two separate browser contexts with separate sessions —
 * instead of a hand-rolled protocol client in Node.
 *
 * Run it deliberately:
 *   pnpm build && npx playwright test e2e/concurrent-editing.spec.ts --workers=1
 * (see the `/e2e-test-runner` skill; never run the full suite in the foreground)
 * ============================================================================
 *
 * `browser.newContext()`, not `browser.newPage()`. Separate contexts mean
 * separate cookie jars, separate sessions and separate IndexedDB — two real
 * collaborators. `e2e/mentions.spec.ts:374`, the only pre-existing two-client
 * test, used `newPage()` on one context and typed sequentially.
 *
 * No `waitForTimeout` anywhere: every wait is an auto-retrying assertion on the
 * condition actually being waited for (`e2e/AGENTS.md`, TEST-11 / TRO-233).
 */

const PASSWORD = 'admin123'
const ADMIN_EMAIL = 'dev@ship.local'
const MEMBER_EMAIL = 'bob.martinez@ship.local'

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 15000 })
}

async function getCsrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/csrf-token')
  expect(response.ok(), 'CSRF token request must succeed').toBe(true)
  const data = await response.json()
  return data.token
}

async function createDocument(page: Page, title: string): Promise<string> {
  const csrfToken = await getCsrfToken(page)
  const response = await page.request.post('/api/documents', {
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    data: { title, document_type: 'wiki', visibility: 'workspace', parent_id: null },
  })
  expect(
    response.ok(),
    `document creation must succeed or nothing below is under test (status ${response.status()})`
  ).toBe(true)
  const doc = await response.json()
  return doc.id
}

/**
 * Close the overdue-accountability dialog if it opened.
 *
 * `web/src/components/ActionItemsModal.tsx` is a Radix `Dialog`, so while it is
 * open it BOTH covers the editor and traps focus — `locator.click()` never passes
 * hit-testing and `document.activeElement` can never become the editor. The
 * seeded workspace has 32 overdue items, so it opens on load. Any e2e test that
 * drives the editor after a direct `page.goto('/documents/:id')` has to deal with
 * it; this is very likely a contributor to existing editor-spec flakiness.
 *
 * Conditional on purpose, and this is NOT a skipped assertion: dismissing chrome
 * is not the thing under test, and the precondition that actually matters — the
 * editor holding the caret — is asserted hard in focusEditor() immediately after.
 */
async function dismissActionItemsDialog(page: Page) {
  const dialog = page.getByRole('dialog')
  if ((await dialog.count()) === 0) return
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0, { timeout: 20000 })
}

/** Open the document and wait until the collaborative editor is actually editable. */
async function openEditor(page: Page, docId: string) {
  await page.goto(`/documents/${docId}`)
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible({ timeout: 20000 })
  await dismissActionItemsDialog(page)
  // contenteditable flips to true only once TipTap is mounted; typing before
  // that silently goes nowhere.
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 20000 })
  return editor
}

/**
 * Put the caret in the editor without clicking it.
 *
 * `locator.click()` hangs here: the seeded workspace has 32 overdue
 * accountability items, whose banner and expanded panel sit over the editor, so
 * Playwright's hit-target check never passes and the test dies as a bare 60s
 * timeout with no assertion. `focus()` waits for the element and then focuses it,
 * which is what we actually want — we are testing merge, not the banner's
 * z-index.
 *
 * The check is `document.activeElement`, not `toBeFocused()`: with two browser
 * contexts open only one window is OS-active, and `toBeFocused()` reports the
 * inactive one as "inactive" even though the editor holds the caret and CDP
 * keystrokes reach it. `activeElement` is the property we actually depend on.
 */
async function focusEditor(editor: import('@playwright/test').Locator) {
  await editor.focus()
  await expect
    .poll(() => editor.evaluate((el) => el.ownerDocument.activeElement === el), {
      message: 'the editor must hold the caret before typing, or keystrokes go nowhere',
      timeout: 20000,
    })
    .toBe(true)
}

/** The document's content as stored by the server, via the REST API. */
async function storedText(page: Page, docId: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${docId}`)
  expect(response.ok(), 'document fetch must succeed').toBe(true)
  const data = await response.json()
  return JSON.stringify(data.content ?? '')
}

test.describe('Concurrent multi-client editing (TRO-226 / TEST-4, additive — not run by CI)', () => {
  // Two browser contexts, two logins, a WebSocket handshake each and a debounced
  // server-side persist. That does not fit the 60s default, and a test that runs
  // out of budget reports as a timeout with no assertion, which is unreadable.
  test.describe.configure({ timeout: 240_000 })

  test('two browser contexts editing different regions both keep their edits', async ({
    browser,
    baseURL,
  }) => {
    const contextA = await browser.newContext({ baseURL })
    const contextB = await browser.newContext({ baseURL })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      await login(pageA, ADMIN_EMAIL)
      await login(pageB, MEMBER_EMAIL)

      const docId = await createDocument(pageA, 'Concurrent Edit Doc')

      const editorA = await openEditor(pageA, docId)
      const editorB = await openEditor(pageB, docId)

      const markerA = `AAA-${Date.now()}`
      const markerB = `BBB-${Date.now()}`

      await focusEditor(editorA)
      await focusEditor(editorB)

      // Concurrent, not sequential: both keystroke streams are in flight at the
      // same time. Each client presses Enter first so the two edits land in
      // different paragraphs.
      await Promise.all([
        (async () => {
          await pageA.keyboard.press('Enter')
          await pageA.keyboard.type(markerA)
        })(),
        (async () => {
          await pageB.keyboard.press('Enter')
          await pageB.keyboard.type(markerB)
        })(),
      ])

      // Each client must end up seeing BOTH edits — that is the merge.
      await expect(editorA, "clientA lost clientB's concurrent edit").toContainText(markerB, {
        timeout: 30000,
      })
      await expect(editorB, "clientB lost clientA's concurrent edit").toContainText(markerA, {
        timeout: 30000,
      })
      await expect(editorA).toContainText(markerA)
      await expect(editorB).toContainText(markerB)

      // And the merged result must be what the server stored, not just what the
      // two browsers happen to be showing.
      await expect
        .poll(() => storedText(pageA, docId), {
          message: 'the merged content must reach the server, not just the two browsers',
          timeout: 30000,
        })
        .toContain(markerA)
      expect(await storedText(pageA, docId)).toContain(markerB)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  test('two browser contexts typing into the same paragraph both keep their edits', async ({
    browser,
    baseURL,
  }) => {
    const contextA = await browser.newContext({ baseURL })
    const contextB = await browser.newContext({ baseURL })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      await login(pageA, ADMIN_EMAIL)
      await login(pageB, MEMBER_EMAIL)

      const docId = await createDocument(pageA, 'Same Paragraph Doc')

      const editorA = await openEditor(pageA, docId)
      const editorB = await openEditor(pageB, docId)

      // Seed the contested paragraph from one client and wait for the other to
      // actually have it, so "same paragraph" is true rather than assumed.
      const seed = `SEED-${Date.now()}`
      await focusEditor(editorA)
      await pageA.keyboard.type(seed)
      await expect(editorB, 'clientB never received the seeded paragraph').toContainText(seed, {
        timeout: 30000,
      })

      // Both carets to the end of that same paragraph, then type concurrently.
      const markerA = `-XA-`
      const markerB = `-XB-`
      await focusEditor(editorA)
      await pageA.keyboard.press('End')
      await focusEditor(editorB)
      await pageB.keyboard.press('End')

      await Promise.all([pageA.keyboard.type(markerA), pageB.keyboard.type(markerB)])

      await expect(editorA, "clientA lost clientB's same-paragraph insert").toContainText(markerB, {
        timeout: 30000,
      })
      await expect(editorB, "clientB lost clientA's same-paragraph insert").toContainText(markerA, {
        timeout: 30000,
      })
      await expect(editorA, 'the seeded text must survive both concurrent inserts').toContainText(
        seed
      )

      await expect
        .poll(() => storedText(pageA, docId), {
          message: 'the same-paragraph merge must reach the server',
          timeout: 30000,
        })
        .toContain(markerA)
      expect(await storedText(pageA, docId)).toContain(markerB)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })
})
