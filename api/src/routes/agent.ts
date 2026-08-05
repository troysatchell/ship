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
 * TRO-342 (`services/agentTokens.ts`): POST /chat mints a short-lived Ship
 * API token for `req.userId`/`req.workspaceId` — reusing the same
 * `api_tokens` mechanism `routes/api-tokens.ts`'s self-service flow uses,
 * called server-side instead of through a form — and sends it to the agent
 * as `askingUserToken`. Before this, the "authenticates outbound to Ship
 * itself under a real user's API token" claim two sentences up was true of
 * the WRITE path (FG-8's gate, `agent/src/gate.ts`) but not the READ path:
 * every on-demand expansion walk ran under the agent process's own single
 * `SHIP_API_TOKEN`, regardless of who asked. The minted token is revoked
 * (`finally`, below) once the agent call it was minted for has settled —
 * see `agentTokens.ts`'s own docstring for the full lifecycle, including
 * why a fixed token name would collide across a user's own successive
 * requests.
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
import { mintEphemeralAgentToken, revokeAgentToken, type MintedAgentToken } from '../services/agentTokens.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

// Same house convention api/src/index.ts already uses for CORS_ORIGIN: read
// directly from process.env at the point of use, with a documented local-dev
// default (api/.env.example) — this package has no dedicated env-loader
// module the way agent/src/config.ts does.
const AGENT_API_BASE_URL = process.env.AGENT_API_BASE_URL || 'http://localhost:3100';

// CWE-319 (cleartext transmission of a security-sensitive header): nothing
// upstream stops AGENT_API_BASE_URL from being configured as a non-loopback
// `http://` URL in a real deployment (it is read straight from process.env,
// same house convention as CORS_ORIGIN above), which would send
// X-Internal-Secret in cleartext over the network. Loopback http
// (localhost/127.0.0.1/::1) is fine — that traffic never leaves the
// machine, matching the default above and every existing dev/test setup.
// `https:` is allowed unconditionally; any other `http:` host is rejected.
// One shared check, called by both routes below before either ever makes
// the outbound fetch. `URL#hostname` renders an IPv6 literal WITH its
// brackets (`new URL('http://[::1]:3100').hostname === '[::1]'`, confirmed
// directly against the WHATWG URL implementation Node uses) — `::1` alone
// would never match.
const AGENT_LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Exported for direct unit testing (api/src/routes/agent.test.ts) — the
// routes below also exercise it indirectly through the full request/response
// cycle, but testing the predicate itself directly is cheaper and pins the
// exact hostname/scheme rules without needing a module reload per case.
export function isAgentBaseUrlSecure(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // An unparseable base URL can't be trusted either — fail closed, same
    // posture as every other degradation path in this file.
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return AGENT_LOOPBACK_HOSTNAMES.has(parsed.hostname);
  return false;
}

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

  if (!isAgentBaseUrlSecure(AGENT_API_BASE_URL)) {
    console.error(`[agent-proxy] AGENT_API_BASE_URL (${AGENT_API_BASE_URL}) is a non-loopback http: URL — refusing to send X-Internal-Secret in cleartext.`);
    res.status(503).json({ error: 'agent_not_configured' });
    return;
  }

  // TRO-342: mint AFTER the two checks above (no point spending a real
  // api_tokens row on a request that's about to be refused anyway), BEFORE
  // the outbound fetch — the agent's on-demand expansion walk needs this to
  // authenticate every Ship read it makes for this answer as `req.userId`
  // themselves, never the agent's own shared identity. See
  // `services/agentTokens.ts` for the full rationale, including why minting
  // (not looking up an existing token) is required: most users have never
  // generated one via the self-service flow.
  let minted: MintedAgentToken;
  try {
    minted = await mintEphemeralAgentToken(req.userId, req.workspaceId);
  } catch (err) {
    console.error('[agent-proxy] failed to mint a per-user Ship API token for the agent:', err);
    res.status(502).json({ error: 'agent_unavailable' });
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
      body: JSON.stringify({
        seedDocumentId,
        question: trimmedQuestion,
        askingUserId: req.userId,
        // TRO-342: the actual authentication for the walk's outbound Ship
        // reads — askingUserId alone is only a visibility-check label
        // (expansion.ts's passesAskerVisibility), never a credential.
        askingUserToken: minted.token,
      }),
      signal: controller.signal,
      // CWE-522 (insufficiently protected credentials): `fetch` defaults to
      // `redirect: 'follow'`, and a cross-origin redirect strips
      // `Authorization` but NOT arbitrary headers like `X-Internal-Secret`
      // (or the `askingUserToken` sitting in the body) — an unexpected
      // redirect from a misconfigured/compromised AGENT_API_BASE_URL would
      // silently forward both to whatever host it points at. Fail loudly
      // instead: a redirect here is always a configuration error, never a
      // legitimate response.
      redirect: 'error',
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

    // CWE-524 (sensitive data exposure via caching): this is a per-user,
    // per-question answer. Even though CloudFront's own edge policy already
    // treats /api/* as no-cache, that says nothing about a browser's own
    // HTTP cache — an explicit no-store is the only thing that actually
    // controls that.
    res.set('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (err) {
    // Covers both a network failure and the abort timeout above — either
    // way, the caller gets one clean degraded shape, never a raw stack
    // trace and never an unresolving request.
    console.error('[agent-proxy] failed to reach agent service:', err);
    res.status(502).json({ error: 'agent_unreachable' });
  } finally {
    clearTimeout(timer);
    // TRO-342: AWAITED (not fire-and-forget) — bounds this token's real
    // exposure window as tightly as this process can: by the time this
    // handler returns, the token minted for it is already revoked, not
    // "revoked eventually, sometime after the response was already sent."
    // Wrapped so a revoke failure (e.g. a pool hiccup) can never override
    // the response already decided above — the token's own short expiry
    // (agentTokens.ts) is the fallback guarantee if this itself fails.
    try {
      await revokeAgentToken(minted.id);
    } catch (err) {
      console.error('[agent-proxy] failed to revoke ephemeral agent token:', err);
    }
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

  if (!isAgentBaseUrlSecure(AGENT_API_BASE_URL)) {
    console.error(`[agent-proxy] AGENT_API_BASE_URL (${AGENT_API_BASE_URL}) is a non-loopback http: URL — refusing to send X-Internal-Secret in cleartext.`);
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
      // CWE-522: same posture as POST /chat above — an unexpected redirect
      // from AGENT_API_BASE_URL must never silently forward
      // X-Internal-Secret to a different host.
      redirect: 'error',
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

    // CWE-524: this is one person's ranked inbox — a browser-cached copy
    // served back after a logout/login (or account switch on a shared
    // machine) would leak it to whoever is using the browser next.
    res.set('Cache-Control', 'no-store');
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
