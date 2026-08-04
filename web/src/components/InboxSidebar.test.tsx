/**
 * Regression tests for TRO-323 / FG-10: the ranked "what needs you" inbox.
 *
 * Covers the ticket's own "How it will be proven" list:
 *   1. FLEETGRAPH.MD Test Case 2's shape — a four-item list, blocking_approval
 *      ranked first — is rendered in the exact order the server returned it,
 *      never re-sorted client-side.
 *   2. Each item renders its action.href/action.label as a real, working
 *      link — not just descriptive text.
 *   3. An item with no blockedCount/blockedSince (the common case — 10 of 20
 *      people in the DB have no manager, and every mention/standup_draft
 *      item never carries these fields at all) still renders without
 *      crashing and without a stray "blocking" line.
 *   4. Keyboard reachability/operability — asserted structurally, not
 *      inferred from a lint rule (same posture as AgentChatPanel.test.tsx /
 *      DocumentTreeItem.test.tsx).
 *
 * `apiGet` (web/src/lib/api.ts) is mocked throughout — these are component
 * tests against a stable fake network layer, never a real HTTP call.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { queryClient } from '@/lib/queryClient';
import { InboxSidebar } from './InboxSidebar';
import { inboxKeys, type InboxItem } from '@/hooks/useInboxQuery';
import { apiGet } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
}));

const mockApiGet = vi.mocked(apiGet);

// A real Response instance — same helper shape as agent.test.ts /
// UnifiedDocumentPage.programWeeksNav.test.tsx's own `jsonResponse`/inline
// mocks, rather than a partial object cast `as Response` (a mock/spy fidelity
// gap: a partial object can silently drift from the real Response contract
// useInboxQuery actually depends on — e.g. `.ok`/`.status` staying in sync,
// or any other Response member a future change starts reading).
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderInbox(onNavigate?: () => void) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InboxSidebar onNavigate={onNavigate} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const BLOCKING_ITEM: InboxItem = {
  id: 'blocking-approval:sprint-1:state',
  type: 'blocking_approval',
  summary: 'AUTH-12 is waiting on your approval',
  evidence: { documentId: 'issue-2', documentType: 'issue' },
  action: { label: 'Review AUTH-12', href: '/documents/issue-2' },
  blockedCount: 3,
  blockedSince: '2026-07-30T12:00:00.000Z',
};

const MENTION_ITEM_A: InboxItem = {
  id: 'mention:doc-9:user-1',
  type: 'mention',
  summary: 'You were mentioned in Week 12 planning',
  evidence: { documentId: 'doc-9', documentType: 'sprint' },
  action: { label: 'View mention', href: '/documents/doc-9' },
};

const MENTION_ITEM_B: InboxItem = {
  id: 'mention:doc-11:user-1',
  type: 'mention',
  summary: 'You were mentioned in a comment on AUTH-3',
  evidence: { documentId: 'doc-11', documentType: 'issue', commentId: 'c-1' },
  action: { label: 'View mention', href: '/documents/doc-11' },
};

const DRAFT_ITEM: InboxItem = {
  id: 'standup_draft:user-1:2026-08-04',
  type: 'standup_draft',
  summary: 'Your standup draft is ready to review',
  evidence: {},
  action: { label: 'Review draft', href: '/documents/standup-1?action=new-standup' },
};

beforeEach(() => {
  mockApiGet.mockReset();
});

afterEach(() => {
  queryClient.removeQueries({ queryKey: inboxKeys.all });
});

describe('InboxSidebar — ranking (TRO-323 / FG-10, proof 1)', () => {
  it('renders FLEETGRAPH.MD Test Case 2\'s four-item shape in the exact order the server returned, blocking_approval first', async () => {
    mockApiGet.mockResolvedValue(
      jsonResponse(200, { items: [BLOCKING_ITEM, MENTION_ITEM_A, MENTION_ITEM_B, DRAFT_ITEM] })
    );

    renderInbox();

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(4);
    // Order preserved verbatim — this component does no re-sorting of its
    // own (itemStore.list() already ranked it: blocking_approval first).
    expect(items[0]).toHaveTextContent('AUTH-12 is waiting on your approval');
    expect(items[1]).toHaveTextContent('Week 12 planning');
    expect(items[2]).toHaveTextContent('comment on AUTH-3');
    expect(items[3]).toHaveTextContent('standup draft is ready');

    expect(screen.getByText('Blocking approval')).toBeInTheDocument();
  });

  it('renders "nothing needs you" rather than an empty list when there are no items', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [] }));

    renderInbox();

    expect(await screen.findByText(/nothing needs you right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('InboxSidebar — direct action links (TRO-323 / FG-10, proof 2)', () => {
  it("renders the item's action.href/action.label as a real, working link — not just descriptive text", async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [BLOCKING_ITEM] }));

    renderInbox();

    const link = await screen.findByRole('link', { name: /AUTH-12 is waiting on your approval.*Review AUTH-12/s });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/documents/issue-2');
  });

  it('calls onNavigate when an item link is followed, so the overlay closes on navigation', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [BLOCKING_ITEM] }));
    const onNavigate = vi.fn();

    renderInbox(onNavigate);

    const link = await screen.findByRole('link', { name: /Review AUTH-12/ });
    link.click();

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('InboxSidebar — defensive rendering with no manager/blocking context (TRO-323 / FG-10, proof 3)', () => {
  it('renders a mention item (no blockedCount/blockedSince at all) without crashing and without a stray "blocking" line', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [MENTION_ITEM_A] }));

    renderInbox();

    expect(await screen.findByText(/Week 12 planning/)).toBeInTheDocument();
    expect(screen.queryByText(/blocking/i)).not.toBeInTheDocument();
  });

  it('renders a blocking_approval item that itself has no blockedCount set — the field is optional even for its own type', async () => {
    const itemWithoutCount: InboxItem = { ...BLOCKING_ITEM, blockedCount: undefined, blockedSince: undefined };
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [itemWithoutCount] }));

    renderInbox();

    expect(await screen.findByText('AUTH-12 is waiting on your approval')).toBeInTheDocument();
    expect(screen.queryByText(/blocking \d/i)).not.toBeInTheDocument();
  });
});

describe('InboxSidebar — degraded states', () => {
  it('renders a plain degraded message, never an unresolving spinner, when the agent is unreachable (network failure)', async () => {
    mockApiGet.mockRejectedValue(new Error('network error'));

    renderInbox();

    // The role="alert" container is present from first render (a live
    // region whose role must stay fixed for the lifetime of the element —
    // see the component's own docstring), so findByRole('alert') alone
    // would resolve before the query settles. Wait for the actual message
    // text instead, then assert it landed inside that live region.
    const message = await screen.findByText(/can't reach the agent right now/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(/loading your inbox/i)).not.toBeInTheDocument();
  });

  it('renders a plain degraded message when the proxy reports the agent is not configured (503)', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(503, { error: 'agent_not_configured' }));

    renderInbox();

    const message = await screen.findByText(/isn't set up in this environment/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
  });

  it('renders a plain degraded message when the proxy relays a 502', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));

    renderInbox();

    const message = await screen.findByText(/can't reach the agent right now/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
  });

  it('shows a loading status while the request is in flight, before it resolves', async () => {
    let resolveFn: (value: Response) => void = () => {};
    mockApiGet.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

    renderInbox();

    expect(await screen.findByText(/loading your inbox/i)).toBeInTheDocument();

    resolveFn(jsonResponse(200, { items: [BLOCKING_ITEM] }));
    expect(await screen.findByText('AUTH-12 is waiting on your approval')).toBeInTheDocument();
    expect(screen.queryByText(/loading your inbox/i)).not.toBeInTheDocument();
  });
});

describe('InboxSidebar — keyboard reachability and screen-reader structure (TRO-323 / FG-10, proof 4)', () => {
  /**
   * Same posture as AgentChatPanel.test.tsx / DocumentTreeItem.test.tsx (the
   * actual A11Y-1 regression test): every item action here is a REAL native
   * `<a href>` (react-router's `Link`), never a `<div>`/`<li>` with an
   * onClick bolted on and no `tabIndex`/`onKeyDown` — the exact shape of
   * A11Y-1. What is asserted below is OBSERVED via jsdom's real
   * `HTMLElement.focus()`/`document.activeElement`: the link is genuinely
   * focusable, carries no `tabIndex="-1"`, and has the correct accessible
   * role/name. Native anchor activation (Enter/click navigating) is
   * guaranteed by the browser itself once shipped, not something a
   * jsdom-only test fabricates evidence for — consistent with this repo's
   * own claim-provenance rule.
   */
  it('every item action is a real, focusable <a href> with no tabIndex="-1"', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [BLOCKING_ITEM, MENTION_ITEM_A] }));

    renderInbox();

    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href');
      expect(link).not.toHaveAttribute('tabindex', '-1');
      link.focus();
      expect(document.activeElement).toBe(link);
    }
  });

  it('the item list has an accessible name via aria-label, so a screen reader announces it as a distinct region', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(200, { items: [BLOCKING_ITEM] }));

    renderInbox();

    expect(await screen.findByRole('list', { name: /inbox/i })).toBeInTheDocument();
  });

  it('the degraded/status regions are live regions (role="status" or role="alert") — verified as ARIA structure, not observed through an actual screen reader', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));

    renderInbox();

    // role="alert" carries an implicit assertive live region per the ARIA
    // spec; this asserts the role landed on the element once the degraded
    // message actually populated it, not that a real AT announced it.
    const message = await screen.findByText(/can't reach the agent right now/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
  });
});
