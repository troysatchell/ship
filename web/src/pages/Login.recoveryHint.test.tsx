/**
 * Regression test for TRO-291 / WCAG 3.3.3 (Error Suggestions).
 *
 * `api/src/routes/auth.ts` (lines 54, 89) deliberately returns the exact
 * same message — "Invalid email or password" — whether the account doesn't
 * exist or the password is wrong, so a failed login can't be used to
 * enumerate accounts. That message was rendered verbatim in the
 * `role="alert"` div with zero recovery affordance anywhere on the page
 * (confirmed by grep: no "forgot", "reset password", or "recovery" text
 * existed in `web/src/` or `api/src/routes/` before this fix) — the error
 * was announced, but nothing told the user what to do next.
 *
 * Fix: Login.tsx now renders an additive recovery line inside the same
 * alert, scoped to exactly that message string, pointing users at their
 * workspace admin (the only real recovery path — this app has no
 * self-service password-reset flow).
 *
 * This test pins that the hint appears for the invalid-credentials case
 * and is not spuriously attached to unrelated errors like client-side
 * required-field validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './Login';

const mockLogin = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    login: mockLogin,
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
  mockLogin.mockReset();

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

describe('LoginPage — recovery guidance for invalid credentials (WCAG 3.3.3 / TRO-291)', () => {
  it('shows the unchanged API message plus a recovery hint when the server rejects credentials', async () => {
    mockLogin.mockResolvedValue({ success: false, error: 'Invalid email or password' });
    await renderLogin();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'nobody@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');

    // The security-sensitive API string must still render verbatim —
    // this fix is additive, not a rewrite of that message.
    expect(alert).toHaveTextContent('Invalid email or password');

    // New recovery affordance: points at the one real recovery path
    // (there is no self-service password reset in this app).
    expect(alert).toHaveTextContent(/workspace admin/i);
  });

  it('does not attach the recovery hint to client-side required-field validation errors', async () => {
    await renderLogin();

    // Login.tsx pre-fills dev credentials when import.meta.env.DEV is true
    // (true under vitest) and the client isn't flagged as automated -
    // explicitly clear the email field so the empty-field branch fires
    // instead of a real login attempt.
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: '' } });

    // Submit with both fields empty - Login.tsx's own validation fires
    // before login() is ever called.
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email address is required');
    expect(alert).not.toHaveTextContent(/workspace admin/i);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('does not attach the recovery hint to a network-failure error', async () => {
    mockLogin.mockRejectedValue(new Error('network down'));
    await renderLogin();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'nobody@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'whatever' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failed to sign in/i);
    expect(alert).not.toHaveTextContent(/workspace admin/i);
  });
});
