/**
 * PF-502 (TRO-436) — Developer > Apps e2e: register → shown-once secret →
 * detail → rotate → revoke, plus an axe pass on the Apps list.
 *
 * ADDITIVE coverage per this repo's `/ship-qa` convention (see
 * oauth-authorize.spec.ts's header for the full rationale): `e2e/*.spec.ts`
 * is outside both vitest configs, so `gate.sh` never executes this file. The
 * real proof is the vitest suite (DeveloperApps.test.tsx,
 * DeveloperAppDetail.test.tsx, ShownOnceSecretModal.test.tsx,
 * DeveloperPortalContext.test.tsx — all red-before-green, see CHANGES.md).
 * This spec exists because PF-502's own AC names "Playwright flow; a11y
 * (axe) pass" explicitly, and because it exercises a real browser session
 * the mocked vitest suite structurally cannot: the actual clipboard write,
 * the actual Radix Dialog focus trap, and the actual portal-token mint
 * against a real running server (proving DeveloperPortalContext's
 * `POST /api/api-tokens` → `GET /api/v1/me` round trip really works, not
 * just that the mocked calls were made with the right arguments).
 */
import { test, expect } from './fixtures/isolated-env'
import AxeBuilder from '@axe-core/playwright'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

test.describe('Developer portal — OAuth app registration', () => {
  test('register, view shown-once secret, rotate, and revoke', async ({ page }) => {
    await login(page)
    await page.goto('/developer/apps')
    await expect(page.getByRole('heading', { name: 'OAuth apps' })).toBeVisible()

    // Register a confidential app.
    await page.getByRole('button', { name: 'New app' }).click()
    const appName = `E2E Test App ${Date.now()}`
    await page.getByLabel('Name').fill(appName)
    await page.getByLabel(/redirect uris/i).fill('https://example.com/oauth/callback')
    await page.getByRole('checkbox', { name: /documents:read/ }).check()
    await page.getByRole('button', { name: 'Register app' }).click()

    // Shown-once secret modal. Scoped to the dialog — the Apps page's own
    // description text ("documented at /api/v1/openapi.json") also renders
    // a <code> tag, so an unscoped `page.locator('code')` is ambiguous.
    const dialog = page.getByRole('dialog')
    await expect(page.getByText('Save your client secret')).toBeVisible()
    const secretCode = dialog.locator('code')
    const secretText = await secretCode.textContent()
    expect(secretText).toMatch(/^\S+$/)

    // Escape must NOT dismiss without confirmation (the AC's "warn before close").
    await page.keyboard.press('Escape')
    await expect(page.getByText('Close without saving?')).toBeVisible()
    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(page.getByText('Save your client secret')).toBeVisible()

    // Now actually close.
    await page.getByRole('button', { name: "I've saved it — close" }).click()
    await expect(page.getByText('Close without saving?')).toBeVisible()
    await page.getByRole('button', { name: 'Close anyway' }).click()

    // Back on the list — the new app appears, secret never shown again.
    await expect(page.getByText(appName)).toBeVisible()
    await expect(page.getByText('Save your client secret')).not.toBeVisible()

    // Into the detail page.
    await page.getByText(appName).click()
    await expect(page.getByRole('heading', { name: appName })).toBeVisible()
    await expect(page.getByText('https://example.com/oauth/callback')).toBeVisible()

    // Rotate — a new secret, distinct from the first.
    await page.getByRole('button', { name: 'Rotate secret' }).click()
    await expect(page.getByText('Save your new client secret')).toBeVisible()
    const rotatedText = await page.getByRole('dialog').locator('code').textContent()
    expect(rotatedText).not.toEqual(secretText)
    await page.getByRole('button', { name: "I've saved it — close" }).click()
    await page.getByRole('button', { name: 'Close anyway' }).click()

    // Revoke — requires confirmation, then returns to the list.
    await page.getByRole('button', { name: 'Revoke app' }).click()
    await expect(page.getByText('Revoke this app?')).toBeVisible()
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(page).toHaveURL(/\/developer\/apps$/)
  })

  test('Developer > Apps has no critical accessibility violations', async ({ page }) => {
    await login(page)
    await page.goto('/developer/apps')
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    )

    if (criticalViolations.length > 0) {
      console.log('Critical violations:', JSON.stringify(criticalViolations, null, 2))
    }

    expect(criticalViolations).toHaveLength(0)
  })

  test('portal calls hit the real /api/v1 surface (network-tab evidence, PF-502 AC)', async ({ page }) => {
    await login(page)

    const v1Requests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/')) v1Requests.push(req.url())
    })

    await page.goto('/developer/apps')
    await page.waitForLoadState('networkidle')

    expect(v1Requests.some((url) => url.includes('/api/v1/me'))).toBe(true)
  })

  test('Developer > Audit lists public_api_audit rows via GET /api/v1/audit (TRO-616)', async ({ page }) => {
    await login(page)

    // Sync on the real /api/v1/audit response, not networkidle (the portal's
    // token mint + /me identity check make networkidle a poor signal here).
    const auditResponse = page.waitForResponse((res) => /\/api\/v1\/audit/.test(res.url()))
    await page.goto('/developer/audit')
    const first = await auditResponse
    expect(first.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible()

    // The portal's own `GET /api/v1/me` on mount is itself audited (fire-and-
    // forget INSERT in platform/audit/middleware.ts), so at least one row
    // exists — but that INSERT can land a beat after this page's first query.
    // One reload closes the race without a networkidle wait.
    if ((await page.getByTestId('audit-row').count()) === 0) {
      const again = page.waitForResponse((res) => /\/api\/v1\/audit/.test(res.url()))
      await page.reload()
      await again
    }
    await expect(page.getByTestId('audit-row').first()).toBeVisible()
    await expect(page.getByRole('table', { name: /public api audit log/i })).toBeVisible()
  })
})
