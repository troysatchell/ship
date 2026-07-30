import { test, expect } from './fixtures/isolated-env';

/**
 * E2E tests for AI Analysis API endpoints.
 *
 * Tests:
 * 1. GET /api/ai/status — returns { available: boolean }
 * 2. POST /api/ai/analyze-plan — requires content field (400 if missing)
 * 3. POST /api/ai/analyze-retro — requires retro_content and plan_content fields
 * 4. Rate limiting: endpoint returns 429 after 10 requests
 *
 * Note: Actual Bedrock calls will return { error: 'ai_unavailable' } in test env
 * since there are no AWS credentials. These tests verify endpoint structure and
 * validation, not the AI output.
 */

// Helper to get CSRF token for API requests
async function getCsrfToken(page: import('@playwright/test').Page, apiUrl: string): Promise<string> {
  const response = await page.request.get(`${apiUrl}/api/csrf-token`);
  expect(response.ok()).toBe(true);
  const { token } = await response.json();
  return token;
}

// Helper to login as default admin user
async function loginAsAdmin(page: import('@playwright/test').Page, apiUrl: string) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });

  const csrfToken = await getCsrfToken(page, apiUrl);
  return { csrfToken };
}

// Sample TipTap JSON content for testing
const samplePlanContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Complete the API integration and write unit tests for the auth module.' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Deploy staging environment and verify monitoring dashboards.' }],
    },
  ],
};

const sampleRetroContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Completed the API integration. Tests pass at 95% coverage.' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Staging deploy delayed due to infrastructure issues. Moved to next week.' }],
    },
  ],
};

test.describe('AI Status API', () => {
  test('GET /api/ai/status returns availability object', async ({ page, apiServer }) => {
    await loginAsAdmin(page, apiServer.url);

    const response = await page.request.get(`${apiServer.url}/api/ai/status`);
    expect(response.ok(), 'AI status endpoint should return 200').toBe(true);

    const data = await response.json();
    expect(data, 'Response should have available property').toHaveProperty('available');
    expect(typeof data.available, 'available should be a boolean').toBe('boolean');
  });

  test('GET /api/ai/status requires authentication', async ({ page, apiServer }) => {
    // Do NOT login — request without auth
    const response = await page.request.get(`${apiServer.url}/api/ai/status`);
    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Analyze Plan API', () => {
  test('POST /api/ai/analyze-plan returns 400 when content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {},
    });

    expect(response.status(), 'Should return 400 when content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention content').toContain('content');
  });

  test('POST /api/ai/analyze-plan accepts valid content', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { content: samplePlanContent },
    });

    // In test env without AWS credentials, we expect either:
    // - 200 with { error: 'ai_unavailable' } (Bedrock not configured)
    // - 200 with analysis result (if somehow AI is available)
    // Either way, the endpoint should not return 400/500
    expect(response.ok(), 'Endpoint should return 200 even if AI is unavailable').toBe(true);

    const result = await response.json();
    // The response should be either a valid analysis or an error indicator
    const isAnalysis = result.overall_score !== undefined;
    const isUnavailable = result.error === 'ai_unavailable';
    expect(
      isAnalysis || isUnavailable,
      'Response should be either an analysis result or ai_unavailable error'
    ).toBe(true);
  });

  test('POST /api/ai/analyze-plan requires authentication', async ({ page, apiServer }) => {
    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      data: { content: samplePlanContent },
    });

    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Analyze Retro API', () => {
  test('POST /api/ai/analyze-retro returns 400 when retro_content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { plan_content: samplePlanContent },
    });

    expect(response.status(), 'Should return 400 when retro_content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention retro_content').toContain('retro_content');
  });

  test('POST /api/ai/analyze-retro returns 400 when plan_content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { retro_content: sampleRetroContent },
    });

    expect(response.status(), 'Should return 400 when plan_content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention plan_content').toContain('plan_content');
  });

  test('POST /api/ai/analyze-retro returns 400 when both fields are missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {},
    });

    expect(response.status(), 'Should return 400 when both fields are missing').toBe(400);
  });

  test('POST /api/ai/analyze-retro accepts valid content', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {
        retro_content: sampleRetroContent,
        plan_content: samplePlanContent,
      },
    });

    // Same as analyze-plan: expect 200 with either result or ai_unavailable
    expect(response.ok(), 'Endpoint should return 200 even if AI is unavailable').toBe(true);

    const result = await response.json();
    const isAnalysis = result.overall_score !== undefined;
    const isUnavailable = result.error === 'ai_unavailable';
    expect(
      isAnalysis || isUnavailable,
      'Response should be either an analysis result or ai_unavailable error'
    ).toBe(true);
  });

  test('POST /api/ai/analyze-retro requires authentication', async ({ page, apiServer }) => {
    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      data: {
        retro_content: sampleRetroContent,
        plan_content: samplePlanContent,
      },
    });

    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Rate Limiting', () => {
  /**
   * Deliberately left as test.fixme() -- TRO-286 (TEST-14) Part 2.
   *
   * This test's premise was never true: it sent 11 rapid requests expecting a
   * 429, but api/src/services/ai-analysis.ts:39 enforces RATE_LIMIT = 120/hour,
   * not 10. Observed: 200 x 11, no 429 at all. The `if (!allSucceeded)` guard
   * around the one meaningful assertion meant that observation still reported
   * green -- exactly the vacuous-test pattern this ticket exists to remove.
   *
   * The user-facing copy that inspired "10" was itself a bug (fixed in this same
   * ticket: api/src/routes/ai.ts said "Max 10 analysis requests per hour" against
   * a real limit of 120; see api/src/routes/ai.test.ts for the corrected,
   * non-vacuous regression coverage of that fix, run by the factory gate).
   *
   * Asserting the *real* 429 truthfully from here needs one of:
   *   1. 121 rapid requests, 120 of which would each attempt a real AWS Bedrock
   *      call (analyzePlan() runs before the limiter rejects a request) --
   *      likely blowing this suite's 60s test timeout and flaking on network
   *      variance, or
   *   2. An injectable/configurable rate limit (e.g. an env var or test-only
   *      override) added to production code purely so this test can exercise
   *      it quickly.
   *
   * Both are product/architecture decisions, not test-authoring ones -- (2) in
   * particular adds a seam to production code to serve a test, which this
   * factory run is not authorized to add unilaterally. TRO-224 reached the same
   * conclusion and reverted its attempt here rather than ship a test that lies.
   * This entry remains a written, reasoned deferral rather than a silent one;
   * see CHANGES.md (TRO-286) for the recommendation to a maintainer.
   */
  test.fixme('POST /api/ai/analyze-plan returns 429 after exceeding the real rate limit', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const requests = [];
    for (let i = 0; i < 11; i++) {
      requests.push(
        page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
          headers: { 'x-csrf-token': csrfToken },
          data: { content: samplePlanContent },
        })
      );
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status());
    const has429 = statuses.some(s => s === 429);

    expect(has429, 'At least one request should be rate-limited (429)').toBe(true);
  });
});
