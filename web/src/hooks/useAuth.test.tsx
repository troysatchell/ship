/**
 * TRO-343 (CodeRabbit, PR #120 / TRO-328 "PR-D") — React Query's cache was
 * never cleared on any identity transition. Verified independently before
 * this fix: `grep -rn "queryClient\.(clear|removeQueries|resetQueries)"
 * web/src` (excluding tests) returned zero matches anywhere in the app.
 * Every query-key factory in `web/src/hooks/*.ts` is unscoped by user id, so
 * on a shared/kiosk browser, or during admin impersonation, whoever is
 * logged in next can be served the previous identity's cached query data -
 * association titles, inbox items, etc. - as a stale cache hit instead of a
 * fresh fetch.
 *
 * The fix (`useAuth.tsx`'s `login`, `logout`, `endImpersonation`) calls the
 * app's real `queryClient.clear()` on every identity transition, in one
 * place, rather than requiring every current and future query-key factory
 * to remember to scope itself by user id.
 *
 * These tests drive the REAL `AuthProvider`/`useAuth()` against the app's
 * actual `queryClient` singleton (same pattern as
 * `useDocumentWriteStatus.test.tsx`) and a real data hook (`useInboxQuery`,
 * CodeRabbit's own suggested regression case, and the one described in the
 * ticket as the more severe of the two originally-flagged instances because
 * its cache is additionally `PersistQueryClientProvider`-backed). The proof
 * shape matches the ticket's "how it will be proven" section exactly:
 * populate the cache as one identity, transition to another, and assert a
 * FRESH fetch happens - not a cache hit serving the previous identity's
 * data.
 *
 * `apiGet` is mocked with real `Response` instances, matching
 * `useInboxQuery.test.tsx`'s own pattern.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const apiGet = vi.fn(async (_path: string): Promise<Response> => jsonResponse(200, { items: [] }));
const authMe = vi.fn();
const authLogin = vi.fn();
const authLogout = vi.fn();
const adminEndImpersonation = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    auth: {
      me: () => authMe(),
      login: (email: string, password: string) => authLogin(email, password),
      logout: () => authLogout(),
    },
    admin: {
      endImpersonation: () => adminEndImpersonation(),
    },
  },
  apiGet: (path: string) => apiGet(path),
}));

// Imported after the mock so both hooks hit the stub.
import { useAuth, AuthProvider } from './useAuth';
import { useInboxQuery } from './useInboxQuery';
import { WorkspaceProvider } from '@/contexts/WorkspaceContext';

function authWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider>
        <AuthProvider>{children}</AuthProvider>
      </WorkspaceProvider>
    </QueryClientProvider>
  );
}

function inboxWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function inboxItem(id: string, summary: string) {
  return {
    id,
    type: 'mention' as const,
    summary,
    evidence: {},
    action: { label: 'View', href: `/documents/${id}` },
  };
}

const NO_SESSION = { success: false, error: { code: 'UNAUTHORIZED', message: 'Not logged in' } };

const workspaceA = { id: 'ws-a', name: 'Workspace A', archivedAt: null, createdAt: 't', updatedAt: 't' };
const workspaceB = { id: 'ws-b', name: 'Workspace B', archivedAt: null, createdAt: 't', updatedAt: 't' };

const userA = { id: 'user-a', email: 'a@ship.dev', name: 'User A', isSuperAdmin: false };
const userB = { id: 'user-b', email: 'b@ship.dev', name: 'User B', isSuperAdmin: false };
const admin = { id: 'user-admin', email: 'admin@ship.dev', name: 'Admin', isSuperAdmin: true };

function loginResponse(user: typeof userA, workspace: typeof workspaceA) {
  return { success: true, data: { user, currentWorkspace: workspace, workspaces: [{ ...workspace, role: 'member' as const }] } };
}

beforeEach(() => {
  queryClient.clear();
  // mockReset (not mockClear) - a test whose expected fetch never fires
  // (the exact bug this file exists to catch) leaves a queued
  // mockResolvedValueOnce unconsumed; mockClear only resets call history,
  // so that stale queued response would silently answer the NEXT test's
  // first apiGet call instead. mockReset drains the queue too.
  apiGet.mockReset();
  apiGet.mockResolvedValue(jsonResponse(200, { items: [] }));
  authMe.mockReset();
  authLogin.mockReset();
  authLogout.mockReset();
  adminEndImpersonation.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useAuth — React Query cache cleared on identity transitions (TRO-343)', () => {
  it('does not serve user A\'s cached data after logout + login as user B', async () => {
    authMe.mockResolvedValue(NO_SESSION);
    authLogin.mockResolvedValueOnce(loginResponse(userA, workspaceA));
    authLogout.mockResolvedValue({ success: true });

    const { result: auth } = renderHook(() => useAuth(), { wrapper: authWrapper });
    await waitFor(() => expect(auth.current.loading).toBe(false));

    // --- Populate the cache as user A ---
    await act(async () => {
      const outcome = await auth.current.login('a@ship.dev', 'pw');
      expect(outcome.success).toBe(true);
    });

    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:1', "A's mention")] }));
    const inboxAsA = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxAsA.result.current.isSuccess).toBe(true));
    expect(inboxAsA.result.current.data).toEqual({ status: 'ok', items: [inboxItem('mention:1', "A's mention")] });
    expect(apiGet).toHaveBeenCalledTimes(1);
    inboxAsA.unmount();

    // --- Logout as A, login as B ---
    authLogin.mockResolvedValueOnce(loginResponse(userB, workspaceB));
    await act(async () => {
      await auth.current.logout();
    });
    await act(async () => {
      const outcome = await auth.current.login('b@ship.dev', 'pw');
      expect(outcome.success).toBe(true);
    });

    // --- The previously-cached data must be gone: a fresh fetch fires,
    //     not a cache hit on A's data (staleTime is 30s, well inside the
    //     window this test runs in, so a cache hit is the observable bug). ---
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:2', "B's mention")] }));
    const inboxAsB = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxAsB.result.current.isSuccess).toBe(true));

    expect(apiGet, 'a fresh fetch must fire for the new identity, not a cache hit on A\'s data').toHaveBeenCalledTimes(2);
    expect(
      inboxAsB.result.current.data,
      "B's view must not be served A's previously-cached inbox item"
    ).toEqual({ status: 'ok', items: [inboxItem('mention:2', "B's mention")] });
    inboxAsB.unmount();
  });

  it('clears user A\'s cached data on a direct login as user B with no intervening logout (CodeRabbit, PR #120 follow-up)', async () => {
    // The test above always calls logout() before login(B) - since both now
    // clear the cache, that alone can't tell login()'s own clear apart from
    // logout()'s. This isolates login(): go A -> B by calling login() twice
    // with no logout() in between (e.g. a session that expired server-side
    // and was re-established as a different account), so only login()'s own
    // clear can be responsible for the assertion below.
    authMe.mockResolvedValue(NO_SESSION);
    authLogin.mockResolvedValueOnce(loginResponse(userA, workspaceA));

    const { result: auth } = renderHook(() => useAuth(), { wrapper: authWrapper });
    await waitFor(() => expect(auth.current.loading).toBe(false));

    await act(async () => {
      const outcome = await auth.current.login('a@ship.dev', 'pw');
      expect(outcome.success).toBe(true);
    });

    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:1', "A's mention")] }));
    const inboxAsA = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxAsA.result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledTimes(1);
    inboxAsA.unmount();

    // --- Login directly as user B. No logout() call. ---
    authLogin.mockResolvedValueOnce(loginResponse(userB, workspaceB));
    await act(async () => {
      const outcome = await auth.current.login('b@ship.dev', 'pw');
      expect(outcome.success).toBe(true);
    });

    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:2', "B's mention")] }));
    const inboxAsB = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxAsB.result.current.isSuccess).toBe(true));

    expect(apiGet, 'login() alone must clear the cache - a fresh fetch must fire for B').toHaveBeenCalledTimes(2);
    expect(
      inboxAsB.result.current.data,
      "B's view must not be served A's previously-cached inbox item"
    ).toEqual({ status: 'ok', items: [inboxItem('mention:2', "B's mention")] });
    inboxAsB.unmount();
  });

  it('does not serve the impersonated user\'s cached data once impersonation ends', async () => {
    // First checkSession (on mount) reports the admin currently impersonating
    // userA; the second (post-endImpersonation refresh) reports back to the
    // admin's own identity.
    authMe.mockResolvedValueOnce({
      success: true,
      data: {
        user: userA,
        currentWorkspace: workspaceA,
        workspaces: [{ ...workspaceA, role: 'member' as const }],
        impersonating: { userId: admin.id, userName: admin.name },
      },
    });
    adminEndImpersonation.mockResolvedValue({ success: true });

    const { result: auth } = renderHook(() => useAuth(), { wrapper: authWrapper });
    await waitFor(() => expect(auth.current.loading).toBe(false));
    expect(auth.current.impersonating).toEqual({ userId: admin.id, userName: admin.name });

    // --- Populate the cache while impersonating user A ---
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:1', "A's mention")] }));
    const inboxWhileImpersonating = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxWhileImpersonating.result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledTimes(1);
    inboxWhileImpersonating.unmount();

    // --- End impersonation, back to the admin's own identity ---
    authMe.mockResolvedValueOnce({
      success: true,
      data: { user: admin, currentWorkspace: workspaceB, workspaces: [{ ...workspaceB, role: 'admin' as const }] },
    });
    await act(async () => {
      await auth.current.endImpersonation();
    });
    expect(auth.current.impersonating).toBeNull();

    // --- The admin's own view must not inherit A's cached inbox item ---
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [inboxItem('mention:3', "Admin's own mention")] }));
    const inboxAsAdmin = renderHook(() => useInboxQuery(), { wrapper: inboxWrapper });
    await waitFor(() => expect(inboxAsAdmin.result.current.isSuccess).toBe(true));

    expect(apiGet, 'a fresh fetch must fire after impersonation ends, not a cache hit').toHaveBeenCalledTimes(2);
    expect(
      inboxAsAdmin.result.current.data,
      "the admin's view must not be served the impersonated user's previously-cached inbox item"
    ).toEqual({ status: 'ok', items: [inboxItem('mention:3', "Admin's own mention")] });
    inboxAsAdmin.unmount();
  });
});
