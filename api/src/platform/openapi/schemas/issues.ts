/**
 * `/api/v1/issues` OpenAPI registration — PF-203 (Linear TRO-404).
 *
 * Closes a real registration gap PF-203's own brief flagged: `issuesRouter`
 * (PF-201, Linear TRO-400) predates PF-202's v1 OpenAPI registry landing and
 * was never retrofitted with a `registerPath` call — confirmed by this
 * ticket's own route-fitness test failing against the real route before
 * this file existed (see `route-fitness.test.ts`'s DRIFT message and the
 * PR's captured evidence). Follows `schemas/documents.ts`'s exact pattern:
 * wires PF-201's existing exported `ListIssuesQuerySchema`
 * (`platform/api/v1/resources/issues.ts`) into a `v1Registry.registerPath`
 * call, and adds a response Zod schema matching `serializeIssue()`'s actual
 * output field-for-field (verified by reading that function,
 * `resources/issues.ts:90-102`, before writing this).
 */

import { ListIssuesQuerySchema, UpdateIssueRequestSchema } from '../../api/v1/resources/issues.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** `shared/src/types/document.ts`'s `IssueState`/`IssuePriority` unions,
 * verbatim — the same source `resources/issues.ts`'s own header comment
 * cites as this resource's property-name provenance. `IssuePriority`
 * includes `'none'` ("No Priority" — TRO-501): `serializeIssue()` can
 * return it for any issue whose `properties.priority` is `'none'`, so the
 * documented response shape has to allow it too. */
const IssueStateSchema = z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
const IssuePrioritySchema = z.enum(['low', 'medium', 'high', 'urgent', 'none']);

/** Matches `serializeIssue()`'s return shape in
 * `platform/api/v1/resources/issues.ts` exactly. */
const IssueResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Document id.' }),
  title: z.string(),
  document_type: z.literal('issue'),
  state: IssueStateSchema,
  priority: IssuePrioritySchema,
  assignee_id: z.string().uuid().nullable(),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 creation timestamp.' }),
  updated_at: z.string().datetime().openapi({ description: 'ISO 8601 last-updated timestamp.' }),
}).openapi('Issue');

v1Registry.register('Issue', IssueResponseSchema);

/** Matches `GET /` handler's `res.status(200).json({ data, next_cursor })`
 * body exactly (`resources/issues.ts`). */
const IssueListResponseSchema = z.object({
  data: z.array(IssueResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('IssueList');

v1Registry.register('IssueList', IssueListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the required scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

// ─── GET /issues ─────────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/issues',
  tags: ['Issues'],
  summary: 'List issues',
  description: 'Cursor-paginated list of issue-typed documents in the caller\'s workspace (PF-201), with state/priority/assignee_id lifted to top-level typed fields. Optionally filtered by ?assignee_id= (PF-205, TRO-414). Requires the issues:read scope.',
  security: BEARER_SECURITY,
  request: {
    query: ListIssuesQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of issues.',
      content: { 'application/json': { schema: IssueListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── PATCH /issues/{id} ─────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'patch',
  path: '/issues/{id}',
  tags: ['Issues'],
  summary: 'Apply a state transition to an issue',
  description: 'Updates an issue\'s state field (PF-703, TRO-435) — a deliberately narrow update surface (state only; no title/priority/assignee_id/belongs_to, no "incomplete children" confirmation gate — see UpdateIssueRequestSchema\'s own doc comment). Built for the agent gate\'s sdk-mode write path (GateShipClient.applyIssueTransition). Requires the issues:write scope.',
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Document id. A non-UUID value 404s rather than validation-failing.' }),
    }),
    body: {
      content: { 'application/json': { schema: UpdateIssueRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The updated issue.',
      content: { 'application/json': { schema: IssueResponseSchema } },
    },
    400: {
      description: 'Invalid request body.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: {
      description: 'No issue with this id exists in the caller\'s workspace, or the id is malformed.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});
