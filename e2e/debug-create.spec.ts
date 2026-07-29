import { test, expect } from './fixtures/isolated-env'

test('debug document creation', async ({ page }) => {
  // Capture console messages
  const consoleMessages: string[] = [];
  page.on('console', msg => {
    const msgType = msg.type();
    if (msgType === 'log' || msgType === 'error') {
      consoleMessages.push('[' + msgType + '] ' + msg.text());
    }
  });

  // Login
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });

  // Go to docs
  await page.goto('/docs');
  await page.waitForLoadState('networkidle');

  // Count initial documents
  const initialCount = await page.locator('aside ul[aria-label*="documents"] [data-testid="doc-item"]').count();
  console.log('Initial document count:', initialCount);

  // Get the button - should match the sidebar "New document" button
  const createButton = page.locator('aside').getByRole('button', { name: /new document/i }).first();
  const isVisible = await createButton.isVisible();
  console.log('Sidebar create button visible:', isVisible);

  // Click the button
  if (isVisible) {
    await createButton.click();
    console.log('Clicked sidebar button');
  } else {
    await page.getByRole('button', { name: 'New Document', exact: true }).click();
    console.log('Clicked main button');
  }

  // Wait a bit for the async operation
  await page.waitForTimeout(3000);

  // Check URL
  const currentUrl = page.url();
  console.log('Current URL after click:', currentUrl);

  // Check document count
  const newCount = await page.locator('aside ul[aria-label*="documents"] [data-testid="doc-item"]').count();
  console.log('New document count:', newCount);

  // Dump console messages
  console.log('\n=== Browser console messages ===');
  for (const msg of consoleMessages) {
    console.log(msg);
  }
  console.log('=== End console messages ===\n');

  // This test is just for debugging - check if URL changed
  expect(currentUrl).toMatch(/\/documents\/[a-f0-9-]+/);
});
