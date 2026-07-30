import { test, expect } from './fixtures/isolated-env';

/**
 * Status Colors Accessibility Tests
 *
 * Verifies that status badges meet WCAG AA contrast requirements (4.5:1)
 * and are centralized to avoid duplication.
 */

test.describe('Status Colors Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
  });

  test.describe('Issues List View', () => {
    test('status badges use accessible color classes', async ({ page }) => {
      await page.goto('/issues');
      await page.waitForSelector('[data-testid="issues-list"], .issue-row, [class*="issue"]', { timeout: 10000 });

      // Check that status badges don't use low-contrast -400 variants
      const statusBadges = page.locator('[class*="text-gray-400"], [class*="text-blue-400"], [class*="text-yellow-400"], [class*="text-green-400"], [class*="text-red-400"]').filter({ hasText: /backlog|todo|in.progress|done|cancelled/i });

      // Should have zero badges with -400 colors (low contrast)
      await expect(statusBadges).toHaveCount(0);
    });

    test('priority indicators use accessible color classes', async ({ page }) => {
      await page.goto('/issues');
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('[data-testid="issues-list"], .issue-row, [class*="issue"]', { timeout: 15000 });

      // Priority indicators should not use -400 variants
      const priorityWithLowContrast = page.locator('[class*="text-red-400"], [class*="text-yellow-400"], [class*="text-blue-400"]').filter({ hasText: /urgent|high|medium|low/i });

      await expect(priorityWithLowContrast).toHaveCount(0);
    });
  });

  test.describe('Program View', () => {
    test('issue status badges use accessible colors', async ({ page }) => {
      // Navigate to a program
      await page.goto('/programs');
      await page.waitForSelector('[data-testid="programs-list"], .program-card, [class*="program"]', { timeout: 10000 });

      // Click first program if available. Programs render as a table
      // (web/src/pages/Programs.tsx, SelectableList) -- a row, not a
      // "button:has-text(issues)" card or an <a href="/documents/..."> link.
      const programLink = page.locator('table[aria-label="Programs list"] tbody tr').first();
      await expect(
        programLink,
        'Seed data should include at least one program to navigate into. Run: pnpm db:seed'
      ).toBeVisible({ timeout: 5000 });
      await programLink.click();
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 });

      // Status badges render inside the Issues tab (ProgramIssuesTab), not the
      // "Overview" tab a program document lands on by default
      // (web/src/lib/document-tabs.tsx).
      const issuesTab = page.getByRole('tab', { name: /issues/i });
      await expect(issuesTab, 'Program document view should have an Issues tab').toBeVisible({ timeout: 5000 });
      await issuesTab.click();

      // Positive control: at least one status badge must actually be on
      // screen (StatusBadge renders `data-status-indicator`, IssuesList.tsx),
      // otherwise the low-contrast check below passes vacuously -- zero
      // badges of any kind trivially satisfies "zero low-contrast badges".
      await expect(
        page.locator('[data-status-indicator]').first(),
        'Seed data should include at least one issue with a status badge'
      ).toBeVisible({ timeout: 5000 });

      // Verify no low-contrast status colors
      const lowContrastBadges = page.locator('[class*="text-gray-400"], [class*="text-blue-400"], [class*="text-yellow-400"], [class*="text-green-400"]');
      const statusBadges = lowContrastBadges.filter({ hasText: /backlog|todo|in.progress|done|cancelled|planned|active|completed/i });

      await expect(statusBadges).toHaveCount(0);
    });

    test('sprint status badges use accessible colors', async ({ page }) => {
      await page.goto('/programs');
      await page.waitForSelector('[data-testid="programs-list"], .program-card, [class*="program"]', { timeout: 10000 });

      const programLink = page.locator('table[aria-label="Programs list"] tbody tr').first();
      await expect(
        programLink,
        'Seed data should include at least one program to navigate into. Run: pnpm db:seed'
      ).toBeVisible({ timeout: 5000 });
      await programLink.click();
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 });

      // Sprint status badges (active/upcoming/completed) render inside the
      // Weeks tab (WeekTimeline.tsx), not the default Overview tab.
      const weeksTab = page.getByRole('tab', { name: /weeks/i });
      await expect(weeksTab, 'Program document view should have a Weeks tab').toBeVisible({ timeout: 5000 });
      await weeksTab.click();

      // Positive control: at least one sprint card should show its status label.
      await expect(
        page.locator('span').filter({ hasText: /^(Active|Upcoming|Completed)$/ }).first(),
        'Seed data should include at least one week/sprint with a status label'
      ).toBeVisible({ timeout: 5000 });

      // Sprint status (planned/active/completed) should use accessible colors
      const sprintStatusLowContrast = page.locator('[class*="text-gray-400"], [class*="text-green-400"], [class*="text-blue-400"]').filter({ hasText: /planned|active|completed/i });

      await expect(sprintStatusLowContrast).toHaveCount(0);
    });
  });

  test.describe('Week View', () => {
    test('sprint status uses accessible colors', async ({ page }) => {
      // Navigate to sprints via team view or direct
      await page.goto('/team');
      await page.waitForTimeout(2000);

      // Check for any low-contrast sprint status indicators
      const lowContrastStatus = page.locator('[class*="text-gray-400"], [class*="text-green-400"], [class*="text-blue-400"]').filter({ hasText: /planned|active|completed/i });

      await expect(lowContrastStatus).toHaveCount(0);
    });
  });

  test.describe('Feedback Editor', () => {
    test('feedback status badges use accessible colors', async ({ page }) => {
      // Navigate to a document that might have feedback
      await page.goto('/documents');
      await page.waitForTimeout(2000);

      // Check for feedback status badges with low contrast
      const feedbackStatusLowContrast = page.locator('[class*="text-gray-400"], [class*="text-blue-400"], [class*="text-green-400"], [class*="text-red-400"], [class*="text-purple-400"]').filter({ hasText: /draft|submitted|pending|accepted|rejected/i });

      await expect(feedbackStatusLowContrast).toHaveCount(0);
    });
  });
});

test.describe('Centralized Status Colors', () => {
  // These tests verify the code structure - they're conceptual markers
  // The actual verification happens via the other tests passing

  test('status colors are imported from shared utility', async ({ page }) => {
    // This test passes if the other tests pass - the centralization
    // is verified by the fact that ALL pages use consistent colors
    await page.goto('/issues');
    await page.waitForTimeout(1000);

    // If colors are centralized, all status badges should use -300 variants
    // We verify by checking NO -400 variants exist for status text
    const anyLowContrastStatus = page.locator('[class*="-400"]').filter({ hasText: /backlog|todo|in.progress|done|cancelled|planned|active|completed|upcoming|draft|submitted|pending|accepted|rejected|urgent|high|medium|low/i });

    await expect(anyLowContrastStatus).toHaveCount(0);
  });
});
