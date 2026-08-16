/**
 * Regression test for TRO-550 — OAuth consent screen app-name spoofing.
 *
 * Background: `/oauth-consent` is a client-side SPA route reachable
 * directly with attacker-chosen query params (it does no server-side
 * re-validation of its own — see OAuthConsent.tsx's header comment). An
 * interim fix (PR #183, TRO-412) stopped trusting a query-string `app_name`
 * at all and showed generic "This application" copy instead. This ticket
 * restores the real name via a server-verified lookup (`GET
 * /oauth/app-info`, keyed only on `client_id`) rather than ever reading
 * `app_name` from the URL again.
 *
 * The property under test is exactly the one the ticket exists to prove: a
 * spoofed `app_name` query param must NEVER influence what's rendered —
 * neither by appearing verbatim, nor by suppressing the real, server-
 * verified name that `GET /oauth/app-info` returns.
 *
 * Red-before-green: run against the pre-TRO-550 component (the one that
 * hardcoded `const appName = 'This application'` and never called
 * `fetch()` at all), the first test below fails — the heading never
 * becomes "Authorize Real Trusted App" because nothing ever fetches
 * `/oauth/app-info`; it stays stuck on the interim generic copy forever.
 * The second test would have passed against that old code by accident (it
 * never rendered `app_name` either), but is the direct proof against the
 * regression this fix could otherwise reintroduce: restoring `app_name`
 * straight from the query string on a lookup failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OAuthConsentPage } from './OAuthConsent';

const realFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const SPOOFED_NAME = 'Totally Legit Corp';
const BASE_PARAMS =
  'client_id=ship_app_real123&redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback&code_challenge=abc123&code_challenge_method=S256';

function consentUrl(): string {
  return `/oauth-consent?${BASE_PARAMS}&app_name=${encodeURIComponent(SPOOFED_NAME)}`;
}

describe('OAuthConsentPage — app name is server-verified, never query-string-controlled (TRO-550)', () => {
  it('renders the name GET /oauth/app-info returns for client_id, ignoring a spoofed app_name entirely', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/oauth/app-info');
      expect(url).toContain('client_id=ship_app_real123');
      // The spoofed app_name must never even be forwarded to the lookup.
      expect(url).not.toContain('app_name');
      return jsonResponse({ name: 'Real Trusted App' });
    });
    global.fetch = fetchMock as typeof fetch;

    render(
      <MemoryRouter initialEntries={[consentUrl()]}>
        <OAuthConsentPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Authorize Real Trusted App/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SPOOFED_NAME, 'i'))).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to generic copy — never the spoofed app_name — when the client_id lookup fails', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'invalid_client', error_description: 'Unknown or revoked client_id.' }, 404)
    );
    global.fetch = fetchMock as typeof fetch;

    render(
      <MemoryRouter initialEntries={[consentUrl()]}>
        <OAuthConsentPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Authorize This application/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SPOOFED_NAME, 'i'))).not.toBeInTheDocument();
  });

  it('falls back to generic copy on a network failure too, never the spoofed app_name', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as typeof fetch;

    render(
      <MemoryRouter initialEntries={[consentUrl()]}>
        <OAuthConsentPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Authorize This application/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SPOOFED_NAME, 'i'))).not.toBeInTheDocument();
  });
});
