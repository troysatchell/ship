/**
 * Agent chat proxy (TRO-320 / FG-9), extended with the ranked-inbox proxy
 * (TRO-323 / FG-10).
 *
 * The browser never calls the agent service directly. The agent has no
 * concept of a Ship browser session at all — it authenticates outbound to
 * Ship itself under a real user's API token (FLEETGRAPH.MD: "no service
 * account"), which is a completely different thing from a browser holding a
 * session cookie. Inventing a second trust boundary just for the chat panel
 * would be new complexity for no benefit. Instead the browser authenticates
 * to api/ the exact way every other route already works — session cookie +
 * authMiddleware/authed(), same pattern as api/src/routes/ai.ts — and THIS
 * route forwards to the agent service on the browser's behalf.
 *
 * Security note (read before touching AGENT_INTERNAL_SECRET): the agent
 * service is reachable from the public internet today (a Render service,
 * no private networking configured — FLEETGRAPH.MD's "Deployment model").
 * An unauthenticated agent route would let anyone spend the configured
 * Anthropic API budget and query the graph as an arbitrary askingUserId, or
 * (GET /inbox) read another person's ranked inbox. AGENT_INTERNAL_SECRET
 * (documented in both agent/.env.example and api/.env.example) is what
 * closes that: sent as the X-Internal-Secret header on every outbound call
 * below, and checked by the agent's own POST /chat / GET /inbox BEFORE
 * either ever touches the graph or item store (agent/src/server.ts) — this
 * side fails closed the same way when the secret isn't configured, rather
 * than sending a request the agent is guaranteed to reject anyway.
 *
 * GET /inbox forwards recipientUserId as req.userId — the session's own
 * user, same as POST /chat's askingUserId — never a client-supplied value,
 * so nobody can read anybody else's ranked inbox by editing a query param.
 * The agent's itemStore.list() is already fully ranked (agent/src/
 * itemStore.ts's own docstring, FG-5/FG-6); this route does no ranking of
 * its own, only the same trust-boundary response validation POST /chat
 * already does for citedSources.
 */
import { Router } from 'express';
import { authMiddleware, authed } from '../middleware/auth.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

// Same house convention api/src/index.ts already uses for CORS_ORIGIN: read
// directly from process.env at the point of use, with a documented local-dev
// default (api/.env.example) — this package has no dedicated env-loader
// module the way agent/src/config.ts does.
const AGENT_API_BASE_URL = process.env.AGENT_API_BASE_URL || 'http://localhost:3100';

// How long this proxy waits for the agent before giving up and degrading.
// Shared by both routes below: an on-demand chat answer can walk up to
// ON_DEMAND_DOCUMENT_CAP documents plus a real model call (agent/src/
// config.ts), so this is deliberately generous for /chat — but a request
// that hangs forever is exactly the "unresolving spinner" the ticket
// prohibits, so it is bounded, not open-ended. /inbox does no model call at
// all (itemStore.list() is synchronous, in-memory), so it will never
// actually need this long, but reusing one constant for "how long we wait
// on the agent service" beats maintaining two numbers that mean the same
// thing.
const AGENT_REQUEST_TIMEOUT_MS = 30_000;

// Upper bound on a single question. `express.json()` (app.ts) already caps
// the whole request body, but that limit is generous enough to admit a
// question far larger than any real user would type — and every character
// here becomes input tokens on a paid model call (FLEETGRAPH.MD's own cost
// analysis: on-demand answers are already 64% of projected spend). Matches
// the corresponding OpenAPI schema's `question.max()`
// (api/src/openapi/schemas/agent.ts) — keep both in sync.
const MAX_QUESTION_LENGTH = 4000;

interface AgentChatSuccessBody {
  output: string;
  citedSources: Array<{ documentId: string; documentType: string; title: string; reason: string }>;
  expansionCapped: boolean;
}

function isCitedSource(value: unknown): value is AgentChatSuccessBody['citedSources'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.documentId === 'string' &&
    typeof v.documentType === 'string' &&
    typeof v.title === 'string' &&
    typeof v.reason === 'string'
  );
}

// The response this validates crosses a trust boundary (the agent service,
// even though it's ours) — a shallow `Array.isArray` check on citedSources
// alone would let a malformed element (missing `reason`, wrong type) through
// to the browser, where the chat panel renders `source.reason` directly.
// Every element is validated, not just the array's own shape.
function isAgentChatSuccessBody(value: unknown): value is AgentChatSuccessBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.output === 'string' &&
    Array.isArray(v.citedSources) &&
    v.citedSources.every(isCitedSource) &&
    typeof v.expansionCapped === 'boolean'
  );
}

// POST /api/agent/chat
router.post('/chat', authMiddleware, authed(async (req, res) => {
  const { seedDocumentId, question } = req.body ?? {};

  if (typeof seedDocumentId !== 'string' || seedDocumentId.length === 0) {
    res.status(400).json({ error: 'seedDocumentId is required' });
    return;
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    res.status(400).json({ error: 'question is required' });
    return;
  }
  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` });
    return;
  }

  const internalSecret = process.env.AGENT_INTERNAL_SECRET;
  if (!internalSecret) {
    console.error('[agent-proxy] AGENT_INTERNAL_SECRET is not set — refusing to call the agent service.');
    res.status(503).json({ error: 'agent_not_configured' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);

  try {
    const agentRes = await fetch(`${AGENT_API_BASE_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
      },
      body: JSON.stringify({ seedDocumentId, question: trimmedQuestion, askingUserId: req.userId }),
      signal: controller.signal,
    });

    if (!agentRes.ok) {
      console.error(`[agent-proxy] agent service returned ${agentRes.status}`);
      res.status(502).json({ error: 'agent_unavailable' });
      return;
    }

    const data: unknown = await agentRes.json();
    if (!isAgentChatSuccessBody(data)) {
      console.error('[agent-proxy] agent service returned an unexpected response shape');
      res.status(502).json({ error: 'agent_unavailable' });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    // Covers both a network failure and the abort timeout above — either
    // way, the caller gets one clean degraded shape, never a raw stack
    // trace and never an unresolving request.
    console.error('[agent-proxy] failed to reach agent service:', err);
    res.status(502).json({ error: 'agent_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}));

// ============== Inbox (TRO-323 / FG-10) ==============

// Mirrors agent/src/itemStore.ts's InboxItemType — kept as a separate,
// independently-declared type on this side of the process boundary rather
// than a shared import, the same posture AgentChatSuccessBody already takes
// for citedSources: this package has no build-time dependency on agent/.
type AgentInboxItemType = 'mention' | 'blocking_approval' | 'standup_draft';

interface AgentInboxItem {
  id: string;
  type: AgentInboxItemType;
  summary: string;
  evidence: { documentId?: string; documentType?: string; commentId?: string };
  action: { label: string; href: string };
  // Optional on agent/src/itemStore.ts's own InboxItem — populated for
  // blocking_approval items only. A person with no manager recorded
  // (reports_to unset — the common case, 10 of 20 people in the DB) never
  // touches this field at all; it is unrelated to escalation, only to how
  // many OTHER people are blocked on the same recipient.
  blockedCount?: number;
  blockedSince?: string;
}

interface AgentInboxSuccessBody {
  items: AgentInboxItem[];
}

function isAgentInboxEvidence(value: unknown): value is AgentInboxItem['evidence'] {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.documentId === undefined || typeof v.documentId === 'string') &&
    (v.documentType === undefined || typeof v.documentType === 'string') &&
    (v.commentId === undefined || typeof v.commentId === 'string')
  );
}

function isAgentInboxAction(value: unknown): value is AgentInboxItem['action'] {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.label === 'string' && typeof v.href === 'string';
}

// Same discipline as isAgentChatSuccessBody above: this response crosses a
// trust boundary (the agent service), so every item is validated field by
// field, not just the array's own shape — a malformed action.href would
// otherwise reach the browser and render as a broken (or worse, wrong) link.
function isAgentInboxItem(value: unknown): value is AgentInboxItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.type === 'mention' || v.type === 'blocking_approval' || v.type === 'standup_draft') &&
    typeof v.summary === 'string' &&
    isAgentInboxEvidence(v.evidence) &&
    isAgentInboxAction(v.action) &&
    (v.blockedCount === undefined || typeof v.blockedCount === 'number') &&
    (v.blockedSince === undefined || typeof v.blockedSince === 'string')
  );
}

function isAgentInboxSuccessBody(value: unknown): value is AgentInboxSuccessBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.items) && v.items.every(isAgentInboxItem);
}

// GET /api/agent/inbox
//
// No request body, no query params accepted from the client: recipientUserId
// is always req.userId (the session's own user), exactly like askingUserId
// on POST /chat above — never something a caller could spoof to read
// somebody else's ranked inbox.
router.get('/inbox', authMiddleware, authed(async (req, res) => {
  const internalSecret = process.env.AGENT_INTERNAL_SECRET;
  if (!internalSecret) {
    console.error('[agent-proxy] AGENT_INTERNAL_SECRET is not set — refusing to call the agent service.');
    res.status(503).json({ error: 'agent_not_configured' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);

  try {
    // `new URL('/inbox', AGENT_API_BASE_URL)` (the two-argument form) would
    // resolve the leading-slash path against the base's ORIGIN only,
    // silently discarding any path component AGENT_API_BASE_URL might carry
    // (e.g. `https://agent.example.com/api` -> `/inbox` targets
    // `https://agent.example.com/inbox`, dropping `/api`). Build the full
    // URL string first, matching POST /chat's own
    // `${AGENT_API_BASE_URL}/chat` construction, so both routes behave
    // identically if AGENT_API_BASE_URL ever gains a path prefix.
    const url = new URL(`${AGENT_API_BASE_URL}/inbox`);
    url.searchParams.set('recipientUserId', req.userId);

    const agentRes = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-Secret': internalSecret,
      },
      signal: controller.signal,
    });

    if (!agentRes.ok) {
      console.error(`[agent-proxy] agent service returned ${agentRes.status} for /inbox`);
      res.status(502).json({ error: 'agent_unavailable' });
      return;
    }

    const data: unknown = await agentRes.json();
    if (!isAgentInboxSuccessBody(data)) {
      console.error('[agent-proxy] agent service returned an unexpected response shape for /inbox');
      res.status(502).json({ error: 'agent_unavailable' });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    // Covers both a network failure and the abort timeout above — same
    // posture as POST /chat: one clean degraded shape, never a raw stack
    // trace and never an unresolving request.
    console.error('[agent-proxy] failed to reach agent service for /inbox:', err);
    res.status(502).json({ error: 'agent_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}));

export default router;
