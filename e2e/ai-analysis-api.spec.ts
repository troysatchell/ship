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
   * Rewritten for audit finding TEST-2 (TRO-224).
   *
   * Both assertions used to be conditional. `if (!allSucceeded)` meant that if
   * every request returned 200 — i.e. **if the rate limiter did nothing at all**
   * — the test passed. The second assertion sat inside `if
   * (rateLimitedResponse)`, so it only ran when a 429 already existed. The one
   * outcome the test existed to catch was the one outcome it excused.
   *
   * The limit is not timing-dependent: `api/src/routes/ai.ts:33` calls
   * `checkRateLimit(userId)`, an in-process per-user counter capped at 10 per
   * hour. Sending 11 requests must therefore produce at least one 429 whether
   * or not Bedrock is reachable — an AI outage returns 200 with
   * `{ error: 'ai_unavailable' }` from the route's catch, and never bypasses the
   * limiter, which runs first.
   */
  test('POST /api/ai/analyze-plan returns 429 after 10 rapid requests', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const ANALYSES_PER_HOUR = 10;
    const attempts = ANALYSES_PER_HOUR + 1;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
          headers: { 'x-csrf-token': csrfToken },
          data: { content: samplePlanContent },
        })
      )
    );
    const statuses = responses.map(r => r.status());

    // Unconditional: the limiter runs before the AI call, so its behaviour does
    // not depend on Bedrock being reachable.
    expect(
      statuses.filter(s => s === 429).length,
      `Sending ${attempts} requests against a ${ANALYSES_PER_HOUR}/hour limit must ` +
        `produce at least one 429. Got: ${statuses.join(', ')}`
    ).toBeGreaterThanOrEqual(1);

    // ...and it must not refuse everything either, or the limit is misconfigured
    // rather than working.
    expect(
      statuses.filter(s => s !== 429).length,
      `The first ${ANALYSES_PER_HOUR} requests should be admitted. Got: ${statuses.join(', ')}`
    ).toBeGreaterThanOrEqual(1);

    const rateLimited = responses.find(r => r.status() === 429);
    expect(rateLimited, 'a 429 response must exist to inspect').toBeTruthy();
    const body = await (rateLimited ?? responses[0]).json();
    expect(body.error, 'Rate limit error should mention rate limit').toContain('Rate limit');
  });
});
