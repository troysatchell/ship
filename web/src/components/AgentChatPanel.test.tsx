/**
 * Regression tests for TRO-320 / FG-9: the in-context chat panel.
 *
 * Covers the ticket's own "How it will be proven" list:
 *   1. Opening the panel on a document sends that document's id as the seed
 *      without user input.
 *   2. Cited sources render with their reasons; an answer with no citations
 *      renders as a failure state.
 *   3. Keyboard reachability/operability — asserted structurally, not
 *      inferred from a lint rule (see the "keyboard reachability" describe
 *      block below for exactly what is/isn't claimed and why).
 *   4. Agent-unreachable state renders the degraded message.
 *
 * `apiPost` (web/src/lib/api.ts) is mocked throughout — these are component
 * tests against a stable fake network layer, never a real HTTP call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentChatPanel } from './AgentChatPanel';
import { apiPost } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
}));

const mockApiPost = vi.mocked(apiPost);

// Intentionally a PARTIAL Response — only the three fields AgentChatPanel
// actually reads (`ok`/`status`/`json()`) — not a full Response instance.
// `as Response` (a direct assertion, never `as unknown as Response`, which
// this repo's gate.sh forbids even in tests) is safe here because every
// field the component touches is present with the right shape; anything
// this fake omits (headers, body stream, etc.) is simply never called.
// A real Response instance — no type assertion, and no drift from the
// contract AgentChatPanel actually consumes (`ok`/`status`/`json()`).
// Same helper shape as InboxSidebar.test.tsx / IssueBlockingSection.test.tsx.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /ask fleetgraph/i }));
}

async function askQuestion(text: string) {
  const input = screen.getByRole('textbox', { name: /ask a question about this document/i });
  fireEvent.change(input, { target: { value: text } });
  // The submit handler is async (it awaits apiPost) — flush it inside act()
  // so React's state updates (loading, then resolved) are applied before
  // the next assertion runs, rather than leaking into a later test.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
  });
}

beforeEach(() => {
  mockApiPost.mockReset();
});

describe('AgentChatPanel — seeding (TRO-320 / FG-9, proof 1)', () => {
  it('sends the open document\'s id as seedDocumentId without the user ever supplying it', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, { output: 'answer', citedSources: [{ documentId: 'd1', documentType: 'issue', title: 'X', reason: 'r' }], expansionCapped: false })
    );

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/agent/chat', {
      // The only document-identifying value in the whole request is the
      // `documentId` PROP — never something typed into the question field.
      seedDocumentId: 'issue-42',
      question: 'why is this stalled?',
    });
  });

  it('renders no seed/document picker at all — the component takes no such input', () => {
    render(<AgentChatPanel documentId="issue-42" />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /document/i })).not.toBeInTheDocument();
  });

  it('drops the previous answer/citations when the open document changes — PropertiesPanel re-renders this component with a new documentId rather than remounting it', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, {
        output: 'Issue A is stalled because of AUTH-1.',
        citedSources: [{ documentId: 'a1', documentType: 'issue', title: 'AUTH-1', reason: 'blocks it' }],
        expansionCapped: false,
      })
    );

    const { rerender } = render(<AgentChatPanel documentId="issue-A" />);
    await openPanel();
    await askQuestion('why is this stalled?');
    expect(await screen.findByText('Issue A is stalled because of AUTH-1.')).toBeInTheDocument();

    // The user navigates to a different document — same component instance,
    // new documentId prop (this is what PropertiesPanel actually does; it
    // does not key AgentChatPanel to force a remount).
    rerender(<AgentChatPanel documentId="issue-B" />);

    expect(screen.queryByText('Issue A is stalled because of AUTH-1.')).not.toBeInTheDocument();
    expect(screen.queryByText('AUTH-1')).not.toBeInTheDocument();
  });

  it('discards a response that resolves AFTER the user has already navigated away — an in-flight request for issue A must never populate issue B\'s answer', async () => {
    let resolveFn: (value: Response) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

    const { rerender } = render(<AgentChatPanel documentId="issue-A" />);
    await openPanel();
    await askQuestion('why is this stalled?');
    // Request is now in flight for issue-A, unresolved.

    // Navigate to issue-B WHILE the issue-A request is still pending. The
    // reset effect clears the question/answer state back to idle (proven by
    // the prior test) but does not collapse the panel itself.
    rerender(<AgentChatPanel documentId="issue-B" />);

    // The stale issue-A response now lands.
    await act(async () => {
      resolveFn(jsonResponse(200, {
        output: 'Issue A is stalled because of AUTH-1.',
        citedSources: [{ documentId: 'a1', documentType: 'issue', title: 'AUTH-1', reason: 'blocks it' }],
        expansionCapped: false,
      }));
    });

    // Never rendered anywhere — including inside the now-collapsed panel,
    // which the reset effect already closed when documentId changed.
    expect(screen.queryByText('Issue A is stalled because of AUTH-1.')).not.toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });
});

describe('AgentChatPanel — citations (TRO-320 / FG-9, proof 2)', () => {
  it('renders every cited source together with its reason', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, {
        output: 'It is stalled because AUTH-12 blocks it.',
        citedSources: [
          { documentId: 'week-1', documentType: 'sprint', title: 'Week 12', reason: "the issue's week" },
          { documentId: 'issue-2', documentType: 'issue', title: 'AUTH-12', reason: 'blocks this issue' },
        ],
        expansionCapped: false,
      })
    );

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    expect(await screen.findByText('It is stalled because AUTH-12 blocks it.')).toBeInTheDocument();
    expect(screen.getByText('Week 12')).toBeInTheDocument();
    expect(screen.getByText(/the issue's week/)).toBeInTheDocument();
    expect(screen.getByText('AUTH-12')).toBeInTheDocument();
    expect(screen.getByText(/blocks this issue/)).toBeInTheDocument();
  });

  it('renders an answer with NO cited sources as a failure state, not as a normal answer', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, { output: 'some uncited text', citedSources: [], expansionCapped: false })
    );

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    // The failure state renders in place of the normal answer — the raw
    // (uncited, unverifiable) model text is never shown as though it were
    // a trustworthy answer.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/without pointing to any source documents/i);
    expect(screen.queryByText('some uncited text')).not.toBeInTheDocument();
  });
});

describe('AgentChatPanel — degraded states (TRO-320 / FG-9, proof 4)', () => {
  it('renders a plain degraded message, never an unresolving spinner, when the agent is unreachable (network failure)', async () => {
    mockApiPost.mockRejectedValue(new Error('network error'));

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach the agent right now/i);
    // The loading state must have resolved to the degraded message, not
    // stayed stuck — no lingering "Thinking…" text.
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it('renders a plain degraded message when the proxy reports the agent is not configured (503)', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(503, { error: 'agent_not_configured' }));

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/isn't set up in this environment/i);
  });

  it('renders a plain degraded message when the proxy relays a 502', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach the agent right now/i);
  });

  it('shows a "Thinking…" status while the request is in flight, before it resolves', async () => {
    let resolveFn: (value: Response) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
    // ThinkingOrb renders with role="img" and its own per-state aria-label
    // (thinking-orbs package contract) — matched by accessible name, not
    // just role, so a wrong `state` prop (e.g. a typo) would fail this
    // assertion instead of passing on role alone (CodeRabbit, PR #124).
    expect(screen.getByRole('img', { name: /solv/i })).toBeInTheDocument();

    resolveFn(jsonResponse(200, { output: 'ok', citedSources: [{ documentId: 'd1', documentType: 'issue', title: 'X', reason: 'r' }], expansionCapped: false }));
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('AgentChatPanel — keyboard reachability (TRO-320 / FG-9, proof 3)', () => {
  /**
   * A11Y-1 (this ticket's own cited precedent) was an ARIA role implying
   * interactivity bolted onto a non-interactive element with no `tabIndex`
   * and no `onKeyDown` — unfocusable, and invisible to axe/lint because the
   * role itself looked correct. This component does not repeat that shape:
   * every interactive affordance below is a REAL native element
   * (`<button>`, `<input>`, `<form>`), not a `<div>`/`<li>` with a role
   * bolted on. That is what is asserted here — concretely, per element, not
   * inferred from a lint pass.
   *
   * What this DOES verify (observed, via jsdom's real `HTMLElement.focus`/
   * `document.activeElement`, which jsdom implements faithfully): every
   * control is a real focusable native element with the correct accessible
   * role and name, and none carries `tabIndex="-1"` or any non-native
   * role that would need custom key handling to be reachable at all.
   *
   * What this does NOT claim: that a raw synthetic `keydown` event
   * activates these controls inside this test run. jsdom (unlike a real
   * browser, and unlike `@testing-library/user-event`, which is not a
   * dependency of this package — see web/package.json) does not implement
   * the browser's native "Enter/Space activates a focused button" or
   * "Enter inside a lone text input submits its form" behavior as a
   * side effect of `fireEvent.keyDown`. Because every control here is a
   * REAL `<button>`/`<input type="text">`/`<form>` rather than a div with a
   * click handler, that native activation is guaranteed by the browser
   * itself once shipped — it is not something this test can fabricate
   * evidence for without a real browser, so it is not claimed as observed
   * here. This is the same posture DocumentTreeItem.test.tsx (the actual
   * A11Y-1 regression test) takes: prove native semantics structurally,
   * not a synthetic key event.
   */
  it('the panel toggle is a real, focusable <button> with an accessible name and aria-expanded', () => {
    render(<AgentChatPanel documentId="issue-42" />);

    const toggle = screen.getByRole('button', { name: /ask fleetgraph/i });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).not.toHaveAttribute('tabindex', '-1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('the question field and submit control are a real, focusable <input> and <button> inside a <form>', async () => {
    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();

    const input = screen.getByRole('textbox', { name: /ask a question about this document/i });
    expect(input.tagName).toBe('INPUT');
    expect(input.closest('form')).not.toBeNull();
    expect(input).not.toHaveAttribute('tabindex', '-1');

    input.focus();
    expect(document.activeElement).toBe(input);

    const submit = screen.getByRole('button', { name: /^ask$/i });
    expect(submit.tagName).toBe('BUTTON');
    expect(submit).toHaveAttribute('type', 'submit');
    expect(submit).not.toHaveAttribute('tabindex', '-1');
  });

  it('the answer/degraded region is a live region (role="status" or role="alert") so a screen reader is notified when it changes — verified as ARIA structure, not observed through an actual screen reader', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));

    render(<AgentChatPanel documentId="issue-42" />);
    await openPanel();
    await askQuestion('why is this stalled?');

    // role="alert" carries an implicit assertive live region per the ARIA
    // spec; this asserts the role landed on the element, not that a real
    // AT announced it (this repo's own provenance rule: mark derived vs
    // observed explicitly).
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
