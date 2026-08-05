# FleetGraph Agent Pill — Design

**Date:** 2026-08-05
**Status:** Approved (Troy, in-session). Revised same day: originally a docked
right-side panel with Chat/Inbox tabs; Troy redirected to a floating pill with the
Inbox left untouched — "our agent makes sense to be available on every screen, since
it can read every screen, floating pill at the bottom that we can click on and
expand and keep inbox separate."
**Scope:** `web/` only. No API or schema changes.

## Problem

The agent barely registers as an agent interface. The "Ask FleetGraph" chat is a
collapsed accordion row at the bottom of the right Properties Sidebar
(`PropertiesPanel.tsx:618-620` mounting `AgentChatPanel.tsx`), inside a sidebar
hard-fixed at 256px (`Editor.tsx:1157,1160` — `w-64`). It is cramped, visually
anonymous, and only exists on document screens.

## Design

### 1. Floating agent pill, available everywhere

New `AgentPill` component, owned by `App.tsx` (inside the main-content wrapper), so
it renders on **every screen** — dashboard, lists, editors. Two states:

- **Collapsed:** a floating pill centered at the bottom of the **main content area**
  (never overlapping the icon rail, left sidebar, or properties sidebar): ThinkingOrb
  icon + "FleetGraph". Subtle elevation; does not scroll with content.
- **Expanded:** clicking the pill expands it upward into a chat card (~440px wide,
  max-height ~60vh) anchored bottom-center. Esc or the card's close affordance
  collapses it. Expanded/collapsed state persists (`ship:agentPillExpanded`,
  matching the `ship:leftSidebarCollapsed` localStorage pattern).

**What this replaces:** the "Ask FleetGraph" accordion is removed from
`PropertiesPanel.tsx`. **The Inbox is deliberately untouched** — rail button, badge,
left-sidebar overlay (`App.tsx:584-585`) all stay exactly as they are.

**Constraint preserved:** FG-9 / TRO-320's "chat must be embedded in context — no
standalone chatbot pages." The pill expands in place over the current screen, seeded
by the open document (`POST /api/agent/chat` requires `seedDocumentId`, verified
`agent.ts:139-141`); it is not a page or route.

### 2. Chat card anatomy

- **Header:** ThinkingOrb + "FleetGraph" title + collapse button. The orb animates
  (`state="solving"`) while a request is in flight; idle otherwise.
- **History:** scrollable conversation; input pinned at the bottom with a context
  chip — "Asking about: *{document title}*" — showing which document seeds the
  question. On screens with no open document the input is disabled with the hint
  "Open a document to ask about it."

### 3. Chat history semantics

- Client-side, session-only. **No backend change** — the API stays single-turn; the
  card renders an append-only list of exchanges.
- History **survives navigation and collapse/expand**. Each exchange is tagged with
  the title of the document it was seeded on.
- This replaces the current stale-response discard guard
  (`AgentChatPanel.tsx:94-106`): a response landing after navigation is appended
  under its own document tag instead of being thrown away. The guard's original
  purpose (never show an answer under the wrong document's context) is preserved by
  the tag.
- Degradation contract unchanged from today (`AgentChatPanel.tsx:50-53,125-140`):
  503 → "not set up here", network/error → "can't reach", answer with zero cited
  sources → rendered as a distrust failure state, never as a normal answer. All
  degraded states render inline in the history. Live-region roles (separate fixed
  `role="alert"` / `role="status"` siblings) carry over.

### 4. Accessibility

- Pill button: `aria-expanded`, accessible name "FleetGraph".
- Expanded card: focus moves to the question input on expand; Esc collapses and
  returns focus to the pill; card is a labelled region.
- Existing live-region pattern for answers/errors carries over unchanged.

### 5. Component boundaries

- `web/src/components/agent/AgentPill.tsx` — pill + expand/collapse shell,
  positioning, focus management, persistence.
- `web/src/components/AgentChatPanel.tsx` — refactored from accordion-with-one-answer
  to history list + seeded input, rendered inside the card. Same API client
  (`apiPost`), same degradation states. Props: `documentId: string | null`,
  `documentTitle: string | null`.
- `App.tsx` — mounts `AgentPill` in the main-content wrapper; passes the active
  document id/title (it already derives `activeDocumentId`, `App.tsx:223`).
- `PropertiesPanel.tsx` — accordion mount removed (`:613-620`).

Descoped from the earlier revision: sidebar drag-to-resize (the pill removes the
cramped-agent motivation; may return as its own follow-up), Inbox-as-tab, the
docked panel.

### 6. Testing

- `AgentChatPanel.test.tsx` → extended: history accumulates, exchanges tagged across
  `documentId` change, late response appends under original tag, degraded states,
  disabled-input state without a document.
- New `AgentPill` tests: renders on non-document screens, expand/collapse +
  persistence, focus moves to input on expand and back to pill on Esc,
  `aria-expanded`.
- Untouched: all Inbox tests (`InboxSidebar.test.tsx`,
  `InboxSidebar.contrast.test.tsx`, `App.inboxOverlay.test.tsx`) — the Inbox is not
  part of this change.

## Non-goals

- No Inbox changes of any kind.
- No backend/API changes; no multi-turn agent memory server-side.
- No persistence of chat history across reloads.
- No standalone agent page or route.
- No sidebar resizing.
