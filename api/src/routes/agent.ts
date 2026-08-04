/**
 * Agent chat proxy (TRO-320 / FG-9).
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
 * Anthropic API budget and query the graph as an arbitrary askingUserId.
 * AGENT_INTERNAL_SECRET (documented in both agent/.env.example and
 * api/.env.example) is what closes that: sent as the X-Internal-Secret
 * header on every outbound call below, and checked by the agent's own
 * POST /chat BEFORE it ever touches the graph (agent/src/server.ts) — this
 * side fails closed the same way when the secret isn't configured, rather
 * than sending a request the agent is guaranteed to reject anyway.
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
// An on-demand answer can walk up to ON_DEMAND_DOCUMENT_CAP documents plus a
// real model call (agent/src/config.ts), so this is deliberately generous —
// but a request that hangs forever is exactly the "unresolving spinner" the
// ticket prohibits, so it is bounded, not open-ended.
const AGENT_CHAT_TIMEOUT_MS = 30_000;

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

function isAgentChatSuccessBody(value: unknown): value is AgentChatSuccessBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.output === 'string' &&
    Array.isArray(v.citedSources) &&
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
  const timer = setTimeout(() => controller.abort(), AGENT_CHAT_TIMEOUT_MS);

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

export default router;
