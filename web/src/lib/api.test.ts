/**
 * TRO-210 / audit finding TS-5 — the `shared/` contract is bypassed.
 *
 * `web/src/lib/api.ts` used to redeclare its own `interface ApiResponse<T>`
 * even though `shared/src/types/api.ts` already exports `ApiResponse<T = unknown>`
 * with a proper `ApiError` (`code`, `message`, and an optional `details` bag
 * the local copy never had). Two independent, hand-maintained guesses at the
 * same wire contract is exactly the drift TS-5 is about: nothing stopped them
 * from silently diverging.
 *
 * These are *source* assertions, not (only) runtime ones, and that is
 * deliberate: vitest transpiles TypeScript without type-checking (no
 * `--typecheck` in this repo's gate), so a test that merely calls a function
 * cannot fail differently before/after a type-only fix — the local interface
 * and the shared one were structurally identical at the field level the code
 * actually reads, so nothing observable changes at runtime. The defect is a
 * "which type declaration are we trusting" property, and the way it comes
 * back is someone re-adding a local `interface ApiResponse` because it's the
 * shorter thing to type. A source-text guard is the only thing that would
 * catch that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { api } from './api';

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(resolve(here, 'api.ts'), 'utf8');

describe('web/src/lib/api.ts imports ApiResponse from @ship/shared (TRO-210 / TS-5)', () => {
  it('does not declare its own ApiResponse interface', () => {
    // Before the fix this file contained:
    //   interface ApiResponse<T> { success: boolean; data?: T; error?: { code: string; message: string } }
    // That private redeclaration is the bug: it can drift from shared/ silently.
    expect(apiSource).not.toMatch(/\binterface\s+ApiResponse\b/);
  });

  it('imports ApiResponse from the shared package', () => {
    expect(apiSource).toMatch(/import\s+type\s*\{[^}]*\bApiResponse\b[^}]*\}\s*from\s*['"]@ship\/shared['"]/);
  });
});

/**
 * Runtime companion: `request<T>()` (internal to api.ts) is what actually
 * consumes the `ApiResponse<T>` type, via the exported `api.*` functions. This
 * exercises `api.auth.me()` end to end and confirms the error branch carries
 * `@ship/shared`'s `ApiError.details` bag through untouched — the field the
 * old local, hand-rolled error shape never declared.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api.auth.me() surfaces the full @ship/shared ApiError shape', () => {
  beforeEach(() => {
    // vi.stubGlobal (not a direct `global.fetch = ...` assignment) so
    // vi.unstubAllGlobals in afterEach actually restores the original —
    // a plain assignment survives restoreAllMocks/restoreAllMocks only
    // undoes vi.spyOn spies, not raw property writes, and would leak this
    // hard-coded 400 response into any later test file run with --no-isolate.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/api/csrf-token')) {
        return jsonResponse({ token: 'test-csrf-token' });
      }
      return jsonResponse(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Bad request',
            details: { field: 'email' },
          },
        },
        400
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes through the ApiError.details bag unchanged', async () => {
    const result = await api.auth.me();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.details).toEqual({ field: 'email' });
  });
});
