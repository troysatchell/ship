/**
 * Tests for the floating FleetGraph agent pill (2026-08-05 agent-pill
 * design — docs/superpowers/specs/). The pill is the agent's one visible
 * home on every screen: a persistent toggle button that expands a chat card
 * upward and hands focus around correctly.
 *
 * AgentChatPanel renders inside the card for real (its network layer,
 * `apiPost`, is mocked) — the pill's own behavior is what's under test:
 * expand/collapse, persistence, and focus movement. Focus assertions use
 * jsdom's real `HTMLElement.focus`/`document.activeElement`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentPill } from './AgentPill';

vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
}));

const STORAGE_KEY = 'ship:agentPillExpanded';

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe('AgentPill — presence and expand/collapse', () => {
  it('renders as a real <button> named FleetGraph with aria-expanded, on screens with no document open', () => {
    render(<AgentPill documentId={null} documentTitle={null} />);

    const pill = screen.getByRole('button', { name: /fleetgraph/i });
    expect(pill.tagName).toBe('BUTTON');
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    // Collapsed: the chat region is hidden from the accessibility tree.
    expect(screen.queryByRole('region', { name: /fleetgraph chat/i })).not.toBeInTheDocument();
  });

  it('expands into the chat card on click and collapses on a second click', () => {
    render(<AgentPill documentId="doc-1" documentTitle="Rollout plan" />);

    const pill = screen.getByRole('button', { name: /fleetgraph/i });
    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: /fleetgraph chat/i })).toBeInTheDocument();

    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: /fleetgraph chat/i })).not.toBeInTheDocument();
  });

  it('with no document open, the expanded card disables the input and shows the hint', () => {
    render(<AgentPill documentId={null} documentTitle={null} />);
    fireEvent.click(screen.getByRole('button', { name: /fleetgraph/i }));

    expect(screen.getByRole('textbox', { name: /ask a question/i })).toBeDisabled();
    expect(screen.getAllByText(/open a document to ask about it/i).length).toBeGreaterThan(0);
  });
});

describe('AgentPill — persistence', () => {
  it('persists the expanded state to localStorage and restores it on mount', () => {
    const { unmount } = render(<AgentPill documentId="doc-1" documentTitle="Rollout plan" />);
    fireEvent.click(screen.getByRole('button', { name: /fleetgraph/i }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    unmount();

    render(<AgentPill documentId="doc-1" documentTitle="Rollout plan" />);
    // Restored expanded — no click needed.
    expect(screen.getByRole('button', { name: /fleetgraph/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: /fleetgraph chat/i })).toBeInTheDocument();
  });
});

describe('AgentPill — focus movement', () => {
  it('moves focus to the question input on expand when a document is open', () => {
    render(<AgentPill documentId="doc-1" documentTitle="Rollout plan" />);
    fireEvent.click(screen.getByRole('button', { name: /fleetgraph/i }));

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: /ask a question/i })
    );
  });

  it('Escape inside the card collapses it and returns focus to the pill', () => {
    render(<AgentPill documentId="doc-1" documentTitle="Rollout plan" />);
    const pill = screen.getByRole('button', { name: /fleetgraph/i });
    fireEvent.click(pill);

    const card = screen.getByRole('region', { name: /fleetgraph chat/i });
    act(() => {
      fireEvent.keyDown(card, { key: 'Escape' });
    });

    expect(pill).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(pill);
  });
});
