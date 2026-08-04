/**
 * Agent chat schema (TRO-320 / FG-9) — the browser's in-context chat panel
 * proxies through this endpoint to the FleetGraph agent service's own
 * `POST /chat` (agent/src/server.ts). See api/src/routes/agent.ts for the
 * full proxy + shared-secret rationale.
 *
 * Extended with the ranked-inbox schema (TRO-323 / FG-10) — the browser's
 * "what needs you" surface proxies through `GET /agent/inbox` to the same
 * agent service's `GET /inbox`, which relays `itemStore.list()` verbatim
 * (already fully ranked — agent/src/itemStore.ts's own docstring).
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema } from './common.js';

// ============== Cited Sources ==============

export const AgentCitedSourceSchema = z.object({
  documentId: UuidSchema,
  documentType: z.string().openapi({ description: 'Ship document_type of the cited source (e.g. "issue", "sprint", "wiki")' }),
  title: z.string(),
  reason: z.string().openapi({ description: 'Why this document was pulled into the answer — FLEETGRAPH.MD: "It names every document it pulled in and why," the trust mechanism the chat panel renders alongside each source.' }),
}).openapi('AgentCitedSource');

registry.register('AgentCitedSource', AgentCitedSourceSchema);

// ============== Chat ==============

export const AgentChatResponseSchema = z.object({
  output: z.string().openapi({ description: "The agent's answer" }),
  citedSources: z.array(AgentCitedSourceSchema),
  expansionCapped: z.boolean().openapi({ description: 'True if the on-demand expansion hit its document cap before the walk ran out of candidates on its own' }),
}).openapi('AgentChatResponse');

registry.register('AgentChatResponse', AgentChatResponseSchema);

// ============== Register Endpoint ==============

registry.registerPath({
  method: 'post',
  path: '/agent/chat',
  tags: ['Agent'],
  summary: 'Ask the FleetGraph agent a question seeded by an open document',
  description: 'Proxies to the agent service (AGENT_API_BASE_URL) over a shared-secret-authenticated internal call — the browser never calls the agent service directly, since it has no concept of a Ship session. askingUserId is taken from the authenticated session (never from the request body) and forwarded so the agent runs the on-demand expansion walk under that user\'s own visibility, not an elevated one. Returns a clean degraded shape — never a hang — when the agent is unreachable or not configured on either side.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            // Ship document ids are genuinely UUIDs (schema.sql: `documents.id
            // UUID`), so this documents the real contract. The route's own
            // runtime check (api/src/routes/agent.ts) is deliberately looser
            // — a non-empty string, not a UUID-format regex — because a
            // malformed id fails downstream (the agent's own document fetch
            // 404s) rather than being a security or correctness gap; adding
            // duplicate UUID-format validation here would only catch what
            // that 404 already catches.
            seedDocumentId: UuidSchema.openapi({ description: 'The document open when the question was asked. Seeds, but does not fence, the expansion walk.' }),
            // Matches MAX_QUESTION_LENGTH in api/src/routes/agent.ts — keep both in sync.
            question: z.string().min(1).max(4000),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The agent's answer, with every document it pulled in and why",
      content: { 'application/json': { schema: AgentChatResponseSchema } },
    },
    400: {
      description: 'Missing seedDocumentId or question, or question exceeds the max length',
    },
    401: {
      description: 'No valid session — the browser must be signed in (authMiddleware)',
    },
    403: {
      description: 'CSRF token missing or invalid for a session-cookie request (conditionalCsrf)',
    },
    503: {
      description: 'The agent is not configured — AGENT_INTERNAL_SECRET is unset on this side, so no request was sent',
    },
    502: {
      description: 'The agent service is unreachable, timed out, or returned an error',
    },
  },
});

// ============== Inbox ==============

export const AgentInboxItemEvidenceSchema = z.object({
  // Loose string, not UuidSchema — same reasoning as seedDocumentId above:
  // the runtime validator (api/src/routes/agent.ts) only checks typeof
  // string, and a malformed id fails downstream (the document simply isn't
  // found when the link is followed) rather than being a security gap.
  documentId: z.string().optional(),
  documentType: z.string().optional(),
  commentId: z.string().optional(),
}).openapi('AgentInboxItemEvidence');

registry.register('AgentInboxItemEvidence', AgentInboxItemEvidenceSchema);

export const AgentInboxItemActionSchema = z.object({
  label: z.string().openapi({ description: 'Button/link text for the direct action' }),
  href: z.string().openapi({ description: 'Where acting on this item takes the person — a concrete Ship document/route' }),
}).openapi('AgentInboxItemAction');

registry.register('AgentInboxItemAction', AgentInboxItemActionSchema);

export const AgentInboxItemSchema = z.object({
  id: z.string().openapi({ description: 'Stable across polls for the same underlying fact — safe to use as a React key' }),
  type: z.enum(['mention', 'blocking_approval', 'standup_draft']),
  summary: z.string(),
  evidence: AgentInboxItemEvidenceSchema,
  action: AgentInboxItemActionSchema,
  blockedCount: z.number().optional().openapi({ description: 'blocking_approval only: how many OTHER people are currently blocked on this recipient\'s action' }),
  blockedSince: DateTimeSchema.optional().openapi({ description: 'blocking_approval only: when the blocking condition first appeared' }),
}).openapi('AgentInboxItem');

registry.register('AgentInboxItem', AgentInboxItemSchema);

export const AgentInboxResponseSchema = z.object({
  items: z.array(AgentInboxItemSchema).openapi({
    description: 'Already fully ranked by the agent (blocking_approval first, highest blockedCount first within that, ties broken by longest-waiting; then mention oldest-first; then standup_draft oldest-first) — this endpoint does no re-sorting.',
  }),
}).openapi('AgentInboxResponse');

registry.register('AgentInboxResponse', AgentInboxResponseSchema);

registry.registerPath({
  method: 'get',
  path: '/agent/inbox',
  tags: ['Agent'],
  summary: "Get the signed-in user's ranked FleetGraph inbox — mentions, blocking approvals, and standup drafts that need them",
  description: 'Proxies to the agent service (AGENT_API_BASE_URL) over the same shared-secret-authenticated internal call POST /agent/chat uses. recipientUserId is taken from the authenticated session (never from a query param) and forwarded so nobody can read another person\'s inbox by editing the request. Returns a clean degraded shape — never a hang — when the agent is unreachable or not configured on either side.',
  responses: {
    200: {
      description: "The recipient's ranked inbox items, already sorted by the agent",
      content: { 'application/json': { schema: AgentInboxResponseSchema } },
    },
    401: {
      description: 'No valid session — the browser must be signed in (authMiddleware)',
    },
    503: {
      description: 'The agent is not configured — AGENT_INTERNAL_SECRET is unset on this side, so no request was sent',
    },
    502: {
      description: 'The agent service is unreachable, timed out, or returned an error',
    },
  },
});
