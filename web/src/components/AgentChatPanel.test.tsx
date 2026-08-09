/**
 * Regression tests for TRO-320 / FG-9's chat surface, reshaped by the
 * 2026-08-05 agent-pill design (docs/superpowers/specs/).
 *
 * Covers the ticket's original "How it will be proven" list, adapted to the
 * history-list shape:
 *   1. Every question sends the open document's id as the seed without user
 *      input; with no document open the input is disabled with a hint.
 *   2. Cited sources render with their reasons; an answer with no citations
 *      renders as a failure state.
 *   3. Keyboard reachability/operability — asserted structurally, not
 *      inferred from a lint rule (see the "keyboard reachability" describe
 *      block below for exactly what is/isn't claimed and why).
 *   4. Agent-unreachable state renders the degraded message.
 * Plus the pill design's history semantics: exchanges survive navigation,
 * tagged with the document they were asked about; a response landing after
 * navigation is appended under its own tag, never the current document's.
 *
 * `apiPost` (web/src/lib/api.ts) is mocked throughout — these are component
 * tests against a stable fake network layer, never a real HTTP call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { AgentChatPanel } from './AgentChatPanel';
import { apiPost } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
}));

const mockApiPost = vi.mocked(apiPost);

// A real Response instance — no type assertion, and no drift from the
// contract AgentChatPanel actually consumes (`ok`/`status`/`json()`).
// Same helper shape as InboxSidebar.test.tsx / IssueBlockingSection.test.tsx.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  it("sends the open document's id as seedDocumentId without the user ever supplying it", async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, { output: 'answer', citedSources: [{ documentId: 'd1', documentType: 'issue', title: 'X', reason: 'r' }], expansionCapped: false })
    );

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/agent/chat', {
      // The only document-identifying value in the whole request is the
      // `documentId` PROP — never something typed into the question field.
      seedDocumentId: 'issue-42',
      question: 'why is this stalled?',
    });
  });

  it('renders no seed/document picker at all — the question field is the only textbox, and no combobox exists', () => {
    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('disables the input with a hint when no document is open — the API requires a seed document', () => {
    render(<AgentChatPanel documentId={null} />);

    const input = screen.getByRole('textbox', { name: /ask a question about this document/i });
    expect(input).toBeDisabled();
    expect(screen.getByText(/open a document to ask about it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ask$/i })).toBeDisabled();
  });

  // TRO-363: the disabled state above existed but was invisible in practice —
  // a 50%-opacity placeholder and an 11px muted hint were quiet enough that a
  // real user (the maintainer, during demo prep) read the whole chat as
  // broken. The empty panel must now say loudly WHY the input is disabled and
  // WHAT to do about it.
  it('renders a prominent explanation of the disabled state when no document is open (TRO-363)', () => {
    render(<AgentChatPanel documentId={null} />);

    expect(screen.getByText(/open a document to start/i)).toBeInTheDocument();
    expect(screen.getByText(/open an issue, project, or doc/i)).toBeInTheDocument();
  });

  it('does not render the no-document callout once a document is open (TRO-363)', () => {
    render(<AgentChatPanel documentId="doc-1" documentTitle="Some issue" />);

    expect(screen.queryByText(/open a document to start/i)).not.toBeInTheDocument();
    // The document-open empty state keeps its original copy.
    expect(screen.getByText(/every answer names the documents/i)).toBeInTheDocument();
  });
});

describe('AgentChatPanel — history survives navigation (agent-pill design)', () => {
  it('keeps a previous answer visible when the open document changes, tagged with the document it was asked about', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, {
        output: 'Issue A is stalled because of AUTH-1.',
        citedSources: [{ documentId: 'a1', documentType: 'issue', title: 'AUTH-1', reason: 'blocks it' }],
        expansionCapped: false,
      })
    );

    const { rerender } = render(<AgentChatPanel documentId="issue-A" documentTitle="Issue A" />);
    await askQuestion('why is this stalled?');
    expect(await screen.findByText('Issue A is stalled because of AUTH-1.')).toBeInTheDocument();

    // The user navigates to a different document — same component instance,
    // new documentId prop (AgentPill does not key this component).
    rerender(<AgentChatPanel documentId="issue-B" documentTitle="Issue B" />);

    // The exchange is still there, and its tag pins it to the document it
    // was actually asked about — never the newly opened one.
    expect(screen.getByText('Issue A is stalled because of AUTH-1.')).toBeInTheDocument();
    expect(screen.getByText(/asked about: issue a/i)).toBeInTheDocument();
    // The NEXT question would seed from issue-B, shown in the context chip.
    expect(screen.getByText(/asking about:/i)).toBeInTheDocument();
    expect(screen.getByText('Issue B')).toBeInTheDocument();
  });

  it("appends a response that resolves AFTER navigation under the ORIGINAL document's tag — an in-flight request for issue A must never read as issue B's answer", async () => {
    let resolveFn: (value: Response) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

    const { rerender } = render(<AgentChatPanel documentId="issue-A" documentTitle="Issue A" />);
    await askQuestion('why is this stalled?');
    // Request is now in flight for issue-A, unresolved.

    // Navigate to issue-B WHILE the issue-A request is still pending.
    rerender(<AgentChatPanel documentId="issue-B" documentTitle="Issue B" />);

    // The issue-A response now lands.
    await act(async () => {
      resolveFn(jsonResponse(200, {
        output: 'Issue A is stalled because of AUTH-1.',
        citedSources: [{ documentId: 'a1', documentType: 'issue', title: 'AUTH-1', reason: 'blocks it' }],
        expansionCapped: false,
      }));
    });

    // Rendered — but pinned to the document it was asked about, and the
    // loading state fully resolved. (findBy: the answer streams in word by
    // word before settling into a single text node.)
    const answer = await screen.findByText('Issue A is stalled because of AUTH-1.');
    expect(answer).toBeInTheDocument();
    const exchange = answer.closest('div[class*="space-y"]');
    expect(exchange).not.toBeNull();
    expect(within(exchange as HTMLElement).queryByText(/asked about: issue b/i)).not.toBeInTheDocument();
    expect(screen.getByText(/asked about: issue a/i)).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });
});

describe('AgentChatPanel — streaming presentation', () => {
  it('reveals the answer word by word rather than all at once, then settles into a single text node', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, {
        output: 'Pistachio is your fastest growing flavor this month.',
        citedSources: [{ documentId: 'd1', documentType: 'wiki', title: 'Sales', reason: 'source of the numbers' }],
        expansionCapped: false,
      })
    );

    render(<AgentChatPanel documentId="doc-1" documentTitle="Flavors" />);
    await askQuestion('what is growing?');

    // The response has resolved, but the full sentence must NOT be present
    // as one text node yet — it is still being revealed. (getByText matches
    // per-node, so the word-span phase cannot satisfy it.)
    expect(screen.queryByText('Pistachio is your fastest growing flavor this month.')).not.toBeInTheDocument();

    // The sources block waits for the text to finish — reading order is top
    // to bottom, nothing below the text appears before the text is done.
    expect(screen.queryByText('Sales')).not.toBeInTheDocument();

    // Streaming completes: whole answer as one node, sources now shown.
    expect(await screen.findByText('Pistachio is your fastest growing flavor this month.')).toBeInTheDocument();
    expect(await screen.findByText('Sales')).toBeInTheDocument();
  });
});

describe('AgentChatPanel — markdown rendering', () => {
  it('renders **bold** as styled text with the star markers never on screen, and [n] refs as citation markers', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(200, {
        output: 'This belongs to the **Ship Core - Bug Fixes** project [3].',
        citedSources: [{ documentId: 'd1', documentType: 'project', title: 'Ship Core - Bug Fixes', reason: 'the project it belongs to' }],
        expansionCapped: false,
      })
    );

    render(<AgentChatPanel documentId="doc-1" documentTitle="Capacity planning" />);
    await askQuestion('what project is this a part of?');

    // The sources block only appears once the stream completes — awaiting
    // it synchronizes every assertion below with the finished answer.
    expect(await screen.findByText(/the project it belongs to/)).toBeInTheDocument();

    // Bold text lands styled (the segment carries the bold class; the
    // selector also disambiguates from the sources-list title, which shows
    // the same string)...
    expect(screen.getByText('Ship Core - Bug Fixes', { selector: 'span.font-semibold' })).toBeInTheDocument();
    // ...and raw markdown markers never appear anywhere in the answer.
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();

    // The [3] citation ref renders as a styled marker, not stripped — it
    // indexes into the numbered sources list below the answer.
    expect(screen.getByText('[3]')).toBeInTheDocument();
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

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
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

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
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

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach the agent right now/i);
    // The loading state must have resolved to the degraded message, not
    // stayed stuck — no lingering "Thinking…" text.
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it('renders a plain degraded message when the proxy reports the agent is not configured (503)', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(503, { error: 'agent_not_configured' }));

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/isn't set up in this environment/i);
  });

  it('renders a plain degraded message when the proxy relays a 502', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach the agent right now/i);
  });

  it('shows a "Thinking…" status while the request is in flight, before it resolves', async () => {
    let resolveFn: (value: Response) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
    // ThinkingOrb renders with role="img" and its own per-state aria-label
    // (thinking-orbs package contract) — matched by accessible name, not
    // just role, so a wrong `state` prop (e.g. a typo) would fail this
    // assertion instead of passing on role alone (CodeRabbit, PR #124).
    expect(screen.getByRole('img', { name: /solv/i })).toBeInTheDocument();
    // A second question cannot be fired while one is in flight.
    expect(screen.getByRole('textbox', { name: /ask a question/i })).toBeDisabled();

    await act(async () => {
      resolveFn(jsonResponse(200, { output: 'ok', citedSources: [{ documentId: 'd1', documentType: 'issue', title: 'X', reason: 'r' }], expansionCapped: false }));
    });
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
   * What this does NOT claim: that a raw synthetic `keydown` activates these
   * controls inside this test run — jsdom does not implement the browser's
   * native key-activation side effects, and `@testing-library/user-event`
   * is not a dependency of this package. Because every control is a REAL
   * native element, that activation is guaranteed by the browser itself
   * once shipped. Same posture as DocumentTreeItem.test.tsx (the actual
   * A11Y-1 regression test): prove native semantics structurally.
   */
  it('the question field and submit control are a real, focusable <input> and <button> inside a <form>', () => {
    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);

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

    render(<AgentChatPanel documentId="issue-42" documentTitle="Fix login" />);
    await askQuestion('why is this stalled?');

    // role="alert" carries an implicit assertive live region per the ARIA
    // spec; this asserts the role landed on the element, not that a real
    // AT announced it (this repo's own provenance rule: mark derived vs
    // observed explicitly).
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
