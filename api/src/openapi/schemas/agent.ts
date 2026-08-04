/**
 * Agent chat schema (TRO-320 / FG-9) — the browser's in-context chat panel
 * proxies through this endpoint to the FleetGraph agent service's own
 * `POST /chat` (agent/src/server.ts). See api/src/routes/agent.ts for the
 * full proxy + shared-secret rationale.
 */

import { z, registry } from '../registry.js';
import { UuidSchema } from './common.js';

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
            seedDocumentId: UuidSchema.openapi({ description: 'The document open when the question was asked. Seeds, but does not fence, the expansion walk.' }),
            question: z.string().min(1),
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
      description: 'Missing seedDocumentId or question',
    },
    503: {
      description: 'The agent is not configured — AGENT_INTERNAL_SECRET is unset on this side, so no request was sent',
    },
    502: {
      description: 'The agent service is unreachable, timed out, or returned an error',
    },
  },
});
