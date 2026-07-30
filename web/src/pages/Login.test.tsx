/**
 * Regression test for TRO-221 / audit finding A11Y-7.
 *
 * The login page rendered its logo, form, and dev-credentials hint directly
 * inside a plain `<div>` with no `<main>` anywhere on the page. axe reported
 * Moderate `landmark-one-main` (target `html`) and `region` (five separate
 * un-landmarked content blocks, including both form field wrappers) —
 * `audit/a11y/axe/login_unauth.json`. The repo's own critical-only e2e specs
 * (`e2e/accessibility.spec.ts`) never caught this because they filter to
 * `impact === 'critical'`; Moderate violations pass those specs by
 * construction.
 *
 * Fix: wrap the page content in a real `<main>` landmark (Login.tsx). This
 * test pins that structure so it can't quietly regress back to a bare `<div>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './Login';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    login: vi.fn(async () => ({ success: true })),
  }),
}));

const realFetch = global.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  // Login.tsx checks setup/CAIA status on mount before rendering the form.
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/setup/status')) {
      return jsonResponse({ success: true, data: { needsSetup: false } });
    }
    if (url.includes('/api/auth/caia/status')) {
      return jsonResponse({ success: true, data: { available: false } });
    }
    return jsonResponse({ success: false });
  });
  global.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

async function renderLogin() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage />
    </MemoryRouter>
  );
  // Wait past the setup/CAIA status checks so the real form is on screen.
  await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
}

describe('LoginPage — landmark structure (A11Y-7 / TRO-221)', () => {
  it('contains the sign-in form inside a single <main> landmark', async () => {
    await renderLogin();

    const main = screen.getByRole('main');
    const form = main.querySelector('form');
    expect(form).not.toBeNull();

    // The email/password inputs and submit button must all be reachable
    // inside that landmark, not floating in unlandmarked page content.
    expect(within(main).getByLabelText(/email address/i)).toBeInTheDocument();
    expect(within(main).getByLabelText(/password/i)).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('exposes exactly one <main> on the page', async () => {
    await renderLogin();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});
