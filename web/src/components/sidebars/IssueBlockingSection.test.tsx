/**
 * Regression tests for TRO-334 / FG-16: "Blocks" / "Blocked by" in the issue
 * properties sidebar.
 *
 * Covers the ticket's own "How it will be proven" list:
 *   1. Adding a blocker creates a `blocks` association in the correct
 *      direction (A blocks B, not B blocks A).
 *   2. The "Blocked by" list is populated by the REVERSE query (`GET
 *      /api/documents/:id/reverse-associations?type=blocks`), never a
 *      second stored relationship, and removing the edge from either side
 *      removes exactly one row (one DELETE call, addressed correctly for
 *      that side).
 *   3. A cycle attempt renders a human-readable error, not the raw
 *      `{"error":"Failed to create association"}` body this route actually
 *      returns (confirmed by running the real trigger against a real
 *      Express app + Postgres before writing this component — see
 *      useBlockingAssociations.ts's own docstring for that evidence).
 *   4. Keyboard/screen-reader structure, verified via role queries and real
 *      jsdom focus — not inferred from a lint rule.
 *
 * `apiGet`/`apiPost`/`apiDelete` (web/src/lib/api.ts) are mocked throughout
 * — these are component tests against a stable fake network layer, never a
 * real HTTP call.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { queryClient } from '@/lib/queryClient';
import { IssueBlockingSection } from './IssueBlockingSection';
import { CIRCULAR_BLOCKS_MESSAGE } from '@/hooks/useBlockingAssociations';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);
const mockApiDelete = vi.mocked(apiDelete);

// jsdom implements neither ResizeObserver nor Element.scrollIntoView, both
// used internally by cmdk (the Command palette IssueCombobox renders) —
// unrelated to anything asserted here. Same shim as Combobox.test.tsx /
// CommandPalette.test.tsx.
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

// A real Response instance — same helper shape as agent.test.ts /
// UnifiedDocumentPage.programWeeksNav.test.tsx's own `jsonResponse`/inline
// mocks, rather than a partial object cast `as Response` (a mock/spy fidelity
// gap: a partial object can silently drift from the real Response contract
// the hooks in this file actually depend on).
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ISSUE_A = 'issue-A'; // the document open in the sidebar under test

interface ApiIssueFixture {
  id: string;
  title: string;
  display_id: string;
  ticket_number: number;
}

const ISSUE_C: ApiIssueFixture = { id: 'issue-C', title: 'Issue C', display_id: 'AUTH-3', ticket_number: 3 };
const ISSUE_D: ApiIssueFixture = { id: 'issue-D', title: 'Issue D', display_id: 'AUTH-4', ticket_number: 4 };

function apiIssueList(...issues: ApiIssueFixture[]) {
  return issues.map((i) => ({
    ...i,
    state: 'backlog',
    priority: 'none',
    assignee_id: null,
    assignee_name: null,
    estimate: null,
    belongs_to: [],
    source: 'internal',
    rejection_reason: null,
  }));
}

interface AssociationFixture {
  id: string;
  relatedId: string;
  relatedTitle: string;
}

function forwardAssociations(...rows: AssociationFixture[]) {
  return rows.map((r) => ({
    id: r.id,
    document_id: ISSUE_A,
    related_id: r.relatedId,
    relationship_type: 'blocks',
    created_at: '2026-08-01T00:00:00.000Z',
    metadata: {},
    related_title: r.relatedTitle,
    related_document_type: 'issue',
  }));
}

interface ReverseAssociationFixture {
  id: string;
  documentId: string;
  documentTitle: string;
}

function reverseAssociations(...rows: ReverseAssociationFixture[]) {
  return rows.map((r) => ({
    id: r.id,
    document_id: r.documentId,
    related_id: ISSUE_A,
    relationship_type: 'blocks',
    created_at: '2026-08-01T00:00:00.000Z',
    metadata: {},
    document_title: r.documentTitle,
    document_document_type: 'issue',
  }));
}

/** Route `apiGet` by endpoint — real components hit three distinct GETs. */
function mockGets(opts: {
  issues?: ReturnType<typeof apiIssueList>;
  blocks?: ReturnType<typeof forwardAssociations>;
  blockedBy?: ReturnType<typeof reverseAssociations>;
}) {
  mockApiGet.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/issues') {
      return jsonResponse(200, opts.issues ?? []);
    }
    if (endpoint === `/api/documents/${ISSUE_A}/associations?type=blocks`) {
      return jsonResponse(200, opts.blocks ?? []);
    }
    if (endpoint.startsWith('/api/documents/') && endpoint.endsWith('/reverse-associations?type=blocks')) {
      return jsonResponse(200, opts.blockedBy ?? []);
    }
    throw new Error(`Unexpected apiGet call in test: ${endpoint}`);
  });
}

function renderSection(issueId = ISSUE_A) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IssueBlockingSection issueId={issueId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function openBlocksPicker() {
  const trigger = await screen.findByRole('button', { name: /add issue this blocks/i });
  // The trigger is disabled while useIssuesQuery is still loading (TRO-334
  // follow-up, CodeRabbit review PR #120) — wait for it to become usable,
  // same as a real user would, rather than firing a click Radix ignores.
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
}

async function openBlockedByPicker() {
  const trigger = await screen.findByRole('button', { name: /add issue blocking this/i });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
}

/**
 * Mirrors IssueSidebar.tsx's real usage
 * (`<IssueBlockingSection key={issue.id} issueId={issue.id} />`): a "switch
 * issue" button that changes both `issueId` and `key` together, exactly the
 * way `PropertiesPanel` swapping the open issue does. Used to prove the
 * `key` (CodeRabbit review, PR #120) actually forces a full remount — without
 * it, React would reuse the same component instance across the id change and
 * carry stale local state (a pending mutation's error, a
 * disabled-while-submitting flag) into the new issue's UI.
 */
function IssueSwitcherHarness({ firstId, secondId }: { firstId: string; secondId: string }) {
  const [openIssueId, setOpenIssueId] = useState(firstId);
  return (
    <>
      <button type="button" onClick={() => setOpenIssueId(secondId)}>
        Switch to other issue
      </button>
      <IssueBlockingSection key={openIssueId} issueId={openIssueId} />
    </>
  );
}

function renderSwitcher(firstId: string, secondId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IssueSwitcherHarness firstId={firstId} secondId={secondId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockApiDelete.mockReset();
});

afterEach(() => {
  queryClient.removeQueries({ queryKey: ['issues'] });
  queryClient.removeQueries({ queryKey: ['associations'] });
});

describe('IssueBlockingSection — add direction (TRO-334 / FG-16, proof 1)', () => {
  it('adding a blocker POSTs document_id = this issue, related_id = the selected issue (A blocks B, never the reverse)', async () => {
    mockGets({ issues: apiIssueList(ISSUE_C), blocks: [], blockedBy: [] });
    mockApiPost.mockResolvedValue(jsonResponse(201, { id: 'assoc-1', document_id: ISSUE_A, related_id: ISSUE_C.id, relationship_type: 'blocks' }));

    renderSection();
    await openBlocksPicker();

    const option = await screen.findByRole('option', { name: /issue c/i });
    await act(async () => {
      fireEvent.click(option);
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith(`/api/documents/${ISSUE_A}/associations`, {
      related_id: ISSUE_C.id,
      relationship_type: 'blocks',
    });
  });

  it('adding via "Blocked by" POSTs document_id = the selected issue, related_id = this issue (the selected issue blocks THIS one, not the reverse)', async () => {
    mockGets({ issues: apiIssueList(ISSUE_D), blocks: [], blockedBy: [] });
    mockApiPost.mockResolvedValue(jsonResponse(201, { id: 'assoc-2', document_id: ISSUE_D.id, related_id: ISSUE_A, relationship_type: 'blocks' }));

    renderSection();
    await openBlockedByPicker();

    const option = await screen.findByRole('option', { name: /issue d/i });
    await act(async () => {
      fireEvent.click(option);
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith(`/api/documents/${ISSUE_D.id}/associations`, {
      related_id: ISSUE_A,
      relationship_type: 'blocks',
    });
  });
});

describe('IssueBlockingSection — reverse query + symmetric removal (TRO-334 / FG-16, proof 2)', () => {
  it('populates "Blocked by" from GET /api/documents/:id/reverse-associations?type=blocks — never a separate stored relationship', async () => {
    mockGets({
      issues: [],
      blocks: [],
      blockedBy: reverseAssociations({ id: 'assoc-3', documentId: 'issue-X', documentTitle: 'Issue X' }),
    });

    renderSection();

    expect(await screen.findByText('Issue X')).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith(`/api/documents/${ISSUE_A}/reverse-associations?type=blocks`);
    // Confirms this is the reverse endpoint, not a forward query re-used —
    // the forward "Blocks" list for this same issue is empty in this fixture.
    expect(screen.getByText('Not blocking any issues')).toBeInTheDocument();
  });

  it('removing from the "Blocks" list (this issue is the blocker) DELETEs document_id = this issue, target = the blocked issue — exactly one call', async () => {
    mockGets({
      issues: [],
      blocks: forwardAssociations({ id: 'assoc-4', relatedId: 'issue-B', relatedTitle: 'Issue B' }),
      blockedBy: [],
    });
    mockApiDelete.mockResolvedValue(jsonResponse(200, { deleted: 1, associations: [{ id: 'assoc-4' }] }));

    renderSection();

    const removeButton = await screen.findByRole('button', { name: /remove issue b from blocks/i });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    expect(mockApiDelete).toHaveBeenCalledTimes(1);
    expect(mockApiDelete).toHaveBeenCalledWith(`/api/documents/${ISSUE_A}/associations/issue-B?type=blocks`);
  });

  it('removing from the "Blocked by" list (the OTHER issue is the blocker) DELETEs document_id = the other issue, target = this issue — same edge, exactly one call', async () => {
    mockGets({
      issues: [],
      blocks: [],
      blockedBy: reverseAssociations({ id: 'assoc-5', documentId: 'issue-Y', documentTitle: 'Issue Y' }),
    });
    mockApiDelete.mockResolvedValue(jsonResponse(200, { deleted: 1, associations: [{ id: 'assoc-5' }] }));

    renderSection();

    const removeButton = await screen.findByRole('button', { name: /remove issue y from blocked by/i });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    expect(mockApiDelete).toHaveBeenCalledTimes(1);
    // Note the source in the URL is issue-Y (the blocker), NOT issue-A (the
    // currently-open document) — removing "from the blocked side" still
    // targets the one row that actually represents this edge.
    expect(mockApiDelete).toHaveBeenCalledWith(`/api/documents/issue-Y/associations/${ISSUE_A}?type=blocks`);
  });
});

describe('IssueBlockingSection — circular association error (TRO-334 / FG-16, proof 3)', () => {
  it('translates the 500 this route actually returns for a cycle into a readable message, never the raw body text', async () => {
    mockGets({ issues: apiIssueList(ISSUE_C), blocks: [], blockedBy: [] });
    // The EXACT response observed by running this sequence (A blocks B, then
    // POST B blocks A) against a real Express app + real Postgres trigger —
    // see useBlockingAssociations.ts's docstring. The raw trigger text
    // ("Circular blocks reference detected: ...") never reaches the client;
    // only this generic, uninformative body does.
    mockApiPost.mockResolvedValue(jsonResponse(500, { error: 'Failed to create association' }));

    renderSection();
    await openBlocksPicker();

    const option = await screen.findByRole('option', { name: /issue c/i });
    await act(async () => {
      fireEvent.click(option);
    });

    const alert = await screen.findByText(CIRCULAR_BLOCKS_MESSAGE);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    // The raw, uninformative body text is never shown to the user.
    expect(screen.queryByText('Failed to create association')).not.toBeInTheDocument();
  });
});

describe('IssueBlockingSection — keyboard reachability and screen-reader structure (TRO-334 / FG-16, proof 4)', () => {
  it('every remove control is a real, focusable <button> with a descriptive accessible name and no tabIndex="-1"', async () => {
    mockGets({
      issues: [],
      blocks: forwardAssociations({ id: 'assoc-6', relatedId: 'issue-B', relatedTitle: 'Issue B' }),
      blockedBy: reverseAssociations({ id: 'assoc-7', documentId: 'issue-Y', documentTitle: 'Issue Y' }),
    });

    renderSection();

    const removeBlocks = await screen.findByRole('button', { name: /remove issue b from blocks/i });
    const removeBlockedBy = await screen.findByRole('button', { name: /remove issue y from blocked by/i });

    for (const button of [removeBlocks, removeBlockedBy]) {
      expect(button.tagName).toBe('BUTTON');
      expect(button).not.toHaveAttribute('tabindex', '-1');
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('the "Blocks" and "Blocked by" lists each have a distinct accessible name via aria-label', async () => {
    mockGets({
      issues: [],
      blocks: forwardAssociations({ id: 'assoc-8', relatedId: 'issue-B', relatedTitle: 'Issue B' }),
      blockedBy: reverseAssociations({ id: 'assoc-9', documentId: 'issue-Y', documentTitle: 'Issue Y' }),
    });

    renderSection();

    expect(await screen.findByRole('list', { name: 'Blocks' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Blocked by' })).toBeInTheDocument();
  });

  it('the "Add issue…" trigger is a real, focusable <button> that opens a popover with an accessible name (TRO-218/A11Y-4 — the exact defect PersonCombobox/MultiPersonCombobox still carry, deliberately not reused here)', async () => {
    mockGets({ issues: apiIssueList(ISSUE_C), blocks: [], blockedBy: [] });

    renderSection();

    const trigger = await screen.findByRole('button', { name: /add issue this blocks/i });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).not.toHaveAttribute('tabindex', '-1');
    // Disabled while useIssuesQuery is still loading (TRO-334 follow-up,
    // CodeRabbit review PR #120) — a disabled element cannot take focus.
    await waitFor(() => expect(trigger).not.toBeDisabled());
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName();
  });

  it('renders "Not blocking any issues" / "Not blocked by any issues" as plain text rather than an empty, unlabeled list', async () => {
    mockGets({ issues: [], blocks: [], blockedBy: [] });

    renderSection();

    expect(await screen.findByText('Not blocking any issues')).toBeInTheDocument();
    expect(await screen.findByText('Not blocked by any issues')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Blocks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Blocked by' })).not.toBeInTheDocument();
  });
});

describe('IssueBlockingSection — key resets state across issue switches (CodeRabbit review, PR #120)', () => {
  const OPEN_ISSUE_1 = ISSUE_A;
  const OPEN_ISSUE_2 = 'issue-open-2';

  beforeEach(() => {
    // Both "open issue" ids need their own forward/reverse-association GETs,
    // and the options list is shared — a generic router, unlike `mockGets`
    // (which hardcodes ISSUE_A as the only forward-associations id).
    mockApiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/issues') {
        return jsonResponse(200, apiIssueList(ISSUE_C));
      }
      if (endpoint.startsWith('/api/documents/') && endpoint.endsWith('/associations?type=blocks')) {
        return jsonResponse(200, []);
      }
      if (endpoint.startsWith('/api/documents/') && endpoint.endsWith('/reverse-associations?type=blocks')) {
        return jsonResponse(200, []);
      }
      throw new Error(`Unexpected apiGet call in test: ${endpoint}`);
    });
  });

  it('does not carry an in-flight "adding" state from the previous issue onto the newly-selected one', async () => {
    let resolvePost: (value: Response) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));

    renderSwitcher(OPEN_ISSUE_1, OPEN_ISSUE_2);

    // Start adding a blocker on issue 1 — the mutation never resolves here.
    await openBlocksPicker();
    const option = await screen.findByRole('option', { name: /issue c/i });
    fireEvent.click(option);

    // IssueBlockingSection disables its own "Add issue this blocks" trigger
    // while addingBlocks is true (component's own `disabled={addingBlocks}`).
    const trigger1 = await screen.findByRole('button', { name: /add issue this blocks/i });
    expect(trigger1).toBeDisabled();

    // Switch to issue 2 BEFORE issue 1's mutation resolves.
    fireEvent.click(screen.getByRole('button', { name: /switch to other issue/i }));

    // Issue 2 gets a genuinely fresh IssueBlockingSection instance (the
    // `key` change unmounts/remounts): its own trigger must be enabled,
    // carrying none of issue 1's in-flight "adding" state. Before the fix
    // (no `key`), React would have reused the same instance and this
    // assertion would see the stale `addingBlocks: true` from issue 1.
    const trigger2 = await screen.findByRole('button', { name: /add issue this blocks/i });
    expect(trigger2).not.toBeDisabled();

    // Let the abandoned mutation resolve so it can't leak into another test.
    await act(async () => {
      resolvePost(jsonResponse(201, {
        id: 'assoc-x',
        document_id: OPEN_ISSUE_1,
        related_id: ISSUE_C.id,
        relationship_type: 'blocks',
      }));
    });
  });

  it('does not carry a circular-blocks error message from the previous issue onto the newly-selected one', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(500, { error: 'Failed to create association' }));

    renderSwitcher(OPEN_ISSUE_1, OPEN_ISSUE_2);

    await openBlocksPicker();
    const option = await screen.findByRole('option', { name: /issue c/i });
    await act(async () => {
      fireEvent.click(option);
    });

    expect(await screen.findByText(CIRCULAR_BLOCKS_MESSAGE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /switch to other issue/i }));

    // Issue 2's fresh instance must show no trace of issue 1's error state.
    // Before the fix, the reused instance would still be rendering it.
    expect(screen.queryByText(CIRCULAR_BLOCKS_MESSAGE)).not.toBeInTheDocument();
  });
});

describe('IssueBlockingSection — loading/error states never read as "empty" (CodeRabbit review, PR #120)', () => {
  /**
   * Before this fix, `blocksQuery.data ?? []` / `blockedByQuery.data ?? []`
   * / `allIssues = []` meant a still-LOADING query and a FAILED query both
   * rendered identically to a genuinely empty list — a real network failure
   * looked exactly like "you have no blockers." These tests force each of
   * the three queries (`useBlocksQuery`, `useBlockedByQuery`, the issues
   * query) to reject and assert a visible error renders instead of the
   * empty-list text.
   *
   * The shared `queryClient` (web/src/lib/queryClient.ts) retries a 5xx or a
   * plain thrown `Error` up to 3 times with real exponential backoff
   * (1s/2s/4s) by design (TRO-179's throttle-aware retry policy) — correct
   * for production, but it would make every case below take several seconds
   * to settle into `isError`, past this suite's timeouts. That retry
   * behavior is exercised elsewhere; this block is only about the render
   * logic once a query IS in the error state, so retries are disabled here
   * for the duration of each test and restored immediately after.
   */
  let originalQueryDefaults: ReturnType<typeof queryClient.getDefaultOptions>['queries'];

  beforeEach(() => {
    originalQueryDefaults = queryClient.getDefaultOptions().queries;
    queryClient.setDefaultOptions({ queries: { ...originalQueryDefaults, retry: false } });
  });

  afterEach(() => {
    queryClient.setDefaultOptions({ queries: originalQueryDefaults });
  });

  it('renders a visible error, not "Not blocking any issues", when useBlocksQuery rejects', async () => {
    mockApiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/issues') return jsonResponse(200, []);
      if (endpoint === `/api/documents/${ISSUE_A}/associations?type=blocks`) {
        return jsonResponse(500, { error: 'Internal Server Error' });
      }
      if (endpoint.endsWith('/reverse-associations?type=blocks')) return jsonResponse(200, []);
      throw new Error(`Unexpected apiGet call in test: ${endpoint}`);
    });

    renderSection();

    const message = await screen.findByText(/couldn't load the issues this blocks/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText('Not blocking any issues')).not.toBeInTheDocument();
    // The reverse query succeeded independently — its own empty state is
    // unaffected by the forward query's failure.
    expect(await screen.findByText('Not blocked by any issues')).toBeInTheDocument();
  });

  it('renders a visible error, not "Not blocked by any issues", when useBlockedByQuery rejects', async () => {
    mockApiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/issues') return jsonResponse(200, []);
      if (endpoint === `/api/documents/${ISSUE_A}/associations?type=blocks`) return jsonResponse(200, []);
      if (endpoint.endsWith('/reverse-associations?type=blocks')) {
        return jsonResponse(500, { error: 'Internal Server Error' });
      }
      throw new Error(`Unexpected apiGet call in test: ${endpoint}`);
    });

    renderSection();

    const message = await screen.findByText(/couldn't load the issues blocking this one/i);
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText('Not blocked by any issues')).not.toBeInTheDocument();
    expect(await screen.findByText('Not blocking any issues')).toBeInTheDocument();
  });

  it('renders a visible error and keeps both pickers disabled, not silently empty option lists, when the issues query rejects', async () => {
    mockApiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/issues') return jsonResponse(500, { error: 'Internal Server Error' });
      if (endpoint === `/api/documents/${ISSUE_A}/associations?type=blocks`) return jsonResponse(200, []);
      if (endpoint.endsWith('/reverse-associations?type=blocks')) return jsonResponse(200, []);
      throw new Error(`Unexpected apiGet call in test: ${endpoint}`);
    });

    renderSection();

    const messages = await screen.findAllByText(/couldn't load issues to pick from/i);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const message of messages) {
      expect(message.closest('[role="alert"]')).not.toBeNull();
    }

    // Both "Add issue…" triggers stay disabled — opening either while
    // `allIssues` is unrecoverably empty would show cmdk's own "No matching
    // issues" empty state, which reads as "there really are no other
    // issues" rather than "this failed to load."
    const blocksTrigger = await screen.findByRole('button', { name: /add issue this blocks/i });
    const blockedByTrigger = await screen.findByRole('button', { name: /add issue blocking this/i });
    expect(blocksTrigger).toBeDisabled();
    expect(blockedByTrigger).toBeDisabled();

    // The two association lists themselves are still empty and successful,
    // so their own "not blocking/blocked by" text is correct and expected.
    expect(await screen.findByText('Not blocking any issues')).toBeInTheDocument();
    expect(await screen.findByText('Not blocked by any issues')).toBeInTheDocument();
  });
});
