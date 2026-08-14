/**
 * `/api/v1/people` OpenAPI registration — PF-205 (Linear TRO-414).
 *
 * Wires `resources/people.ts`'s existing `ListPeopleQuerySchema` into a
 * `v1Registry.registerPath` call, with a response schema matching
 * `serializePerson()`'s actual output field-for-field (verified by reading
 * that function, `resources/people.ts`, before writing this) — same
 * pattern as `schemas/issues.ts`.
 */

import { ListPeopleQuerySchema } from '../../api/v1/resources/people.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `serializePerson()`'s return shape in
 * `platform/api/v1/resources/people.ts` exactly. */
const PersonResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Person document id.' }),
  name: z.string(),
  document_type: z.literal('person'),
  user_id: z.string().uuid().nullable().openapi({ description: 'Linked users.id, or null for a pending/unlinked person.' }),
  email: z.string().nullable(),
  is_archived: z.boolean(),
  is_pending: z.boolean(),
  reports_to: z.string().uuid().nullable().openapi({ description: "The manager's USER id, or null if none is recorded." }),
  role: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('Person');

v1Registry.register('Person', PersonResponseSchema);

const PersonListResponseSchema = z.object({
  data: z.array(PersonResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('PersonList');

v1Registry.register('PersonList', PersonListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the required scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

v1Registry.registerPath({
  method: 'get',
  path: '/people',
  tags: ['People'],
  summary: 'List people',
  description: 'Cursor-paginated list of person-typed documents (the team directory) in the caller\'s workspace. Requires the documents:read scope — people are documents in Ship\'s unified document model (PLUGFORGE.MD §4 PF-205).',
  security: BEARER_SECURITY,
  request: {
    query: ListPeopleQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of people.',
      content: { 'application/json': { schema: PersonListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});
