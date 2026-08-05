# FleetGraph Agent Panel — Design

**Date:** 2026-08-05
**Status:** Approved (Troy, in-session)
**Scope:** `web/` only. No API or schema changes.

## Problem

The agent barely registers as an agent interface. Its two surfaces are:

- **"Ask FleetGraph" chat** — a collapsed accordion row at the bottom of the right
  Properties Sidebar (`PropertiesPanel.tsx:618-620` mounting `AgentChatPanel.tsx`),
  inside a sidebar hard-fixed at 256px (`Editor.tsx:1157,1160` — `w-64`).
- **Agent Inbox** — `InboxSidebar.tsx`, rendered as an overlay in the left contextual
  sidebar (`App.tsx:584-585`), hard-fixed at 224px (`w-56`, `App.tsx:504,508`).

Both are cramped, visually anonymous, and split across opposite sides of the screen.
Sidebars are not resizable anywhere in the app.

## Design

### 1. Placement & entry point

New `AgentPanel` component, owned by `App.tsx`, rendered as a right-side panel that
**replaces the Properties sidebar while open**. Mechanism: the properties portal
target (`<aside id="properties-portal">`, `App.tsx:657`) is hidden via CSS while the
agent panel is open — it stays mounted so `Editor.tsx`'s `createPortal` keeps working,
and Editor's own `rightSidebarCollapsed` state (`Editor.tsx:309-310`, Editor-local,
separately persisted) is not touched.

- The existing Inbox rail button becomes the **agent button**: orb icon, keeps the
  unread badge, toggles the panel. `aria-expanded` preserved. Opening restores the
  **last-used tab** (persisted; Chat on first ever open).
- The left-sidebar inbox overlay (`inboxOpen` state and its rendering) and the
  "Ask FleetGraph" accordion in `PropertiesPanel` are **removed**. The panel is the
  single home for agent surfaces.
- Persisted to localStorage (matching the `ship:leftSidebarCollapsed` pattern):
  `ship:agentPanelOpen`, `ship:agentPanelTab`, `ship:agentPanelWidth`.

### 2. Panel anatomy

- **Header:** ThinkingOrb + "FleetGraph" title + close button. The orb animates
  (`state="solving"`) while a chat request is in flight; idle otherwise.
- **Tabs:** `Chat` | `Inbox`. Inbox tab shows the badge count. Inbox tab renders the
  existing `InboxSidebar` component unchanged (it already takes only an `onNavigate`
  callback).
- **Chat tab:** scrollable conversation history; input pinned at the bottom with a
  context chip — "Asking about: *{document title}*" — showing which document seeds
  the question. On routes with no open document the input is disabled with the hint
  "Open a document to ask about it."

**Constraint preserved:** FG-9 / TRO-320's "chat must be embedded in context — no
standalone chatbot pages." The panel is in-context (seeded by the open document;
`POST /api/agent/chat` requires `seedDocumentId`, verified `agent.ts:139-141`), not a
standalone page.

### 3. Chat history semantics

- Client-side, session-only. **No backend change** — the API stays single-turn; the
  panel renders an append-only list of exchanges.
- History **survives document navigation**. Each exchange is tagged with the title of
  the document it was seeded on.
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

### 4. Resizing

New reusable `useResizablePanel(key, { default, min, max })` hook + `PanelResizeHandle`
component:

- Pointer-drag on the panel edge; double-click resets to default; width persisted to
  localStorage under `key`.
- Accessible per this repo's Section 508 bar: handle is `role="separator"` with
  `aria-orientation="vertical"`, focusable, arrow keys adjust width in 16px steps.

Applied to three panels:

| Panel | Default | Min | Max |
|---|---|---|---|
| Agent panel (new) | 384px | 300 | 640 |
| Properties sidebar | 256px (unchanged) | 220 | 480 |
| Left contextual sidebar | 224px (unchanged) | 180 | 400 |

The fixed `w-64` / `w-56` classes at `Editor.tsx:1157,1160` and `App.tsx:504,508`
become inline widths driven by the hook.

### 5. Component boundaries

- `web/src/components/agent/AgentPanel.tsx` — panel shell: header, tabs, resize.
  Depends on `AgentChatPanel` (refactored), `InboxSidebar` (unchanged),
  `useResizablePanel`.
- `web/src/components/AgentChatPanel.tsx` — refactored from accordion-with-one-answer
  to history list + seeded input. Same API client (`apiPost`), same degradation
  states. Props: `documentId: string | null`, `documentTitle: string | null`.
- `web/src/hooks/useResizablePanel.ts` + `web/src/components/PanelResizeHandle.tsx` —
  shared by all three panels.
- `App.tsx` — replaces `inboxOpen` with `agentPanelOpen`/`agentPanelTab`; rail button
  rewired; renders `AgentPanel` beside the properties portal target.

### 6. Testing

- `App.inboxOverlay.test.tsx` → retargeted: rail button opens the panel on the
  last-used tab; inbox content reachable via the Inbox tab.
- `AgentChatPanel.test.tsx` → extended: history accumulates, exchanges tagged across
  `documentId` change, late response appends under original tag, degraded states,
  disabled-input state without a document.
- New: panel toggle from rail, tab switching, width persistence, keyboard resize.
- Untouched: `InboxSidebar.test.tsx`, `InboxSidebar.contrast.test.tsx` (component
  reused as-is).

## Non-goals

- No backend/API changes; no multi-turn agent memory server-side.
- No persistence of chat history across reloads.
- No standalone agent page or route.
- No change to inbox ranking or data fetching (`useInboxQuery` stays).
