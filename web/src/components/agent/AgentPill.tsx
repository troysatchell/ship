import { useCallback, useEffect, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { AgentChatPanel } from '@/components/AgentChatPanel';

/**
 * The FleetGraph agent's one visible home: a floating pill at the bottom
 * center of the main content area, on every screen (2026-08-05 agent-pill
 * design — docs/superpowers/specs/). Clicking it expands a chat card upward;
 * the pill stays put as the always-mounted toggle, so `aria-expanded` lives
 * on one persistent control and collapse can hand focus straight back to it.
 *
 * The Inbox is deliberately NOT here — it keeps its rail button and left
 * sidebar overlay (the design's "keep inbox separate" call).
 *
 * Expansion state persists per the same localStorage pattern as
 * `ship:leftSidebarCollapsed` (App.tsx). Chat history lives inside
 * AgentChatPanel's own state and survives collapse because the card is
 * hidden, not unmounted.
 */

const STORAGE_KEY = 'ship:agentPillExpanded';

interface AgentPillProps {
  /** The document currently open, or null on screens without one. */
  documentId: string | null;
  /** Its title, for the chat's context chip and exchange tags. */
  documentTitle: string | null;
}

export function AgentPill({ documentId, documentTitle }: AgentPillProps) {
  const [expanded, setExpanded] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [busy, setBusy] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(expanded));
  }, [expanded]);

  // Focus lands in the question input when the card opens (the card itself
  // is the fallback when the input is disabled — no document open), and
  // returns to the pill on collapse, so keyboard position is never dropped.
  useEffect(() => {
    if (!expanded) return;
    const input = cardRef.current?.querySelector<HTMLInputElement>('#agent-chat-question');
    if (input && !input.disabled) {
      input.focus();
    } else {
      cardRef.current?.focus();
    }
  }, [expanded]);

  const collapse = useCallback(() => {
    setExpanded(false);
    pillRef.current?.focus();
  }, []);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-4">
      {/* pointer-events re-enabled ONLY on the card and the pill themselves —
        * the invisible column around them must never swallow clicks meant
        * for the page underneath. */}
      <div className="flex w-full max-w-[440px] flex-col items-stretch">
        {/* Hidden (not unmounted) while collapsed so chat history survives. */}
        <div
          ref={cardRef}
          role="region"
          aria-label="FleetGraph chat"
          tabIndex={-1}
          hidden={!expanded}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              collapse();
            }
          }}
          className="pointer-events-auto mb-2 flex h-[min(480px,60vh)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <AgentChatPanel
            documentId={documentId}
            documentTitle={documentTitle}
            onBusyChange={setBusy}
          />
        </div>

        <button
          ref={pillRef}
          type="button"
          onClick={() => (expanded ? collapse() : setExpanded(true))}
          aria-expanded={expanded}
          className="pointer-events-auto mx-auto flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-lg transition-colors hover:border-accent hover:text-accent"
        >
          <ThinkingOrb state={busy ? 'solving' : 'breathing'} size={20} />
          <span>FleetGraph</span>
        </button>
      </div>
    </div>
  );
}
