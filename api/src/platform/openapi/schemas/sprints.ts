/**
 * `/api/v1/sprints` OpenAPI registration — PF-203 (Linear TRO-404).
 *
 * Closes the same class of gap as `schemas/issues.ts` (see that file's
 * header for the fuller rationale): `sprintsRouter` (PF-201, Linear TRO-400)
 * predates PF-202 and was never retrofitted. Wires PF-201's existing
 * exported `ListSprintsQuerySchema` (`platform/api/v1/resources/sprints.ts`)
 * into a `v1Registry.registerPath` call, with a response schema matching
 * `serializeSprint()`'s actual output field-for-field (verified by reading
 * that function, `resources/sprints.ts:54-63`, before writing this) — it is
 * structurally identical to `schemas/documents.ts`'s `DocumentResponseSchema`
 * (id/title/document_type/properties/created_at/updated_at), which matches
 * `resources/sprints.ts`'s own header comment: this list is deliberately
 * un-typed beyond the generic `documents` envelope, unlike issues.
 */

import { ListSprintsQuerySchema } from '../../api/v1/resources/sprints.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `serializeSprint()`'s return shape in
 * `platform/api/v1/resources/sprints.ts` exactly. */
const SprintResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Document id.' }),
  title: z.string(),
  document_type: z.literal('sprint'),
  properties: z.record(z.unknown()),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 creation timestamp.' }),
  updated_at: z.string().datetime().openapi({ description: 'ISO 8601 last-updated timestamp.' }),
}).openapi('Sprint');

v1Registry.register('Sprint', SprintResponseSchema);

/** Matches `GET /` handler's `res.status(200).json({ data, next_cursor })`
 * body exactly (`resources/sprints.ts`). */
const SprintListResponseSchema = z.object({
  data: z.array(SprintResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('SprintList');

v1Registry.register('SprintList', SprintListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the required scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

// ─── GET /sprints ────────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/sprints',
  tags: ['Sprints'],
  summary: 'List sprints',
  description: 'Cursor-paginated list of sprint-typed documents in the caller\'s workspace (PF-201). Requires the sprints:read scope.',
  security: BEARER_SECURITY,
  request: {
    query: ListSprintsQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of sprints.',
      content: { 'application/json': { schema: SprintListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── GET /sprints/{id} ───────────────────────────────────────────────────
//
// PF-205 (Linear TRO-414) — see `resources/sprints.ts`'s own route header
// for the claim-provenance note that this route did not already exist
// before this ticket, despite the PRD block's "already exists, extend the
// response" phrasing. Response extends `SprintResponseSchema` with the
// cadence/week-dates fields the PRD asks for.

const SprintDetailResponseSchema = SprintResponseSchema.extend({
  sprint_number: z.number().int(),
  owner_id: z.string().uuid().nullable(),
  status: z.string().nullable(),
  workspace_sprint_start_date: z.string().openapi({ description: 'YYYY-MM-DD — the workspace\'s sprint-cadence anchor date.' }),
  start_date: z.string().openapi({ description: 'YYYY-MM-DD — this sprint\'s own computed calendar start date.' }),
  end_date: z.string().openapi({ description: 'YYYY-MM-DD — this sprint\'s own computed calendar end date (inclusive).' }),
}).openapi('SprintDetail');

v1Registry.register('SprintDetail', SprintDetailResponseSchema);

v1Registry.registerPath({
  method: 'get',
  path: '/sprints/{id}',
  tags: ['Sprints'],
  summary: 'Get a sprint by id, with cadence/week-dates',
  description: 'Fetch a single sprint-typed document by id, extended with sprint_number/owner_id/status and the computed start_date/end_date calendar window (from the workspace\'s sprint_start_date anchor). A malformed or non-existent id both produce a not_found error, matching resources/documents.ts\'s GET /:id convention. Requires the sprints:read scope.',
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Sprint document id. A non-UUID value 404s rather than validation-failing.' }),
    }),
  },
  responses: {
    200: {
      description: 'The sprint, with cadence/week-dates.',
      content: { 'application/json': { schema: SprintDetailResponseSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: {
      description: 'No sprint with this id exists in the caller\'s workspace, or the id is malformed.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});
