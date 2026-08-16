/**
 * Event registry (TRO-419 / PF-300).
 *
 * PLUGFORGE.MD §2.6, verbatim: "Event registry (8 types, each with a Zod schema): ...
 * Because issues/sprints *are* documents, issue/sprint events are derived in the domain
 * write path from `document_type` + property transitions (PF-300 includes a discovery
 * task to pin the exact property names against `shared/src/types`)."
 *
 * This module is **events as data**: a single enumerable map from event type to its Zod
 * payload schema, not a switch statement scattered across call sites. `eventRegistry.list()`
 * is what the developer portal (§2.9) and any docs/spec generator walk to enumerate the 8
 * types; `eventRegistry.get(type)` is what the (later, PF-301/PF-304) publish/deliver path
 * uses to validate a payload before it goes on the wire.
 *
 * Dependency-free by design (only `zod`, already a dependency of `api`) and does not import
 * from anywhere else under `api/src/platform/` or `api/src/routes/` — same isolation
 * rationale as `platform/webhooks/signer.ts` (TRO-433): this file must build and test
 * regardless of merge order against sibling E2/E3 branches.
 *
 * ---------------------------------------------------------------------------------------
 * Discovery task (PF-300's own AC): pin exact `properties` field names for issue
 * state/assignee and sprint start/complete transitions against `shared/src/types` and the
 * sprint_iterations model. Findings (verified 2026-08-10, recorded here so the schemas below
 * are traceable to the exact fields they encode — also posted as a TRO-419 ticket comment):
 *
 * - Issue state:      `properties.state`, type `IssueState`
 *                      (`shared/src/types/document.ts:56` for the union, `:83` for the
 *                      field on `IssueProperties`). Mutated at
 *                      `api/src/routes/issues.ts:1035` (`newProps.state = data.state`).
 * - Issue assignee:    `properties.assignee_id`, type `string | null`
 *                      (`shared/src/types/document.ts:85`). Mutated at
 *                      `api/src/routes/issues.ts:1049-1051`
 *                      (`newProps.assignee_id = data.assignee_id`).
 * - Sprint start:      `properties.status`, transition `'planning' -> 'active'`.
 *                      Field type is `WeekProperties.status?: 'planning' | 'active' |
 *                      'completed'` (`shared/src/types/document.ts:166`; document_type
 *                      `'sprint'` maps to `WeekProperties` via `WeekDocument`,
 *                      `shared/src/types/document.ts:298-301`). Read/guarded at
 *                      `api/src/routes/weeks.ts:1701-1711` ("Only allow starting a sprint
 *                      that's in planning status"), written at `weeks.ts:1719`
 *                      (`newProps.status = 'active'`), inside `POST /:id/start`
 *                      (route registered at `weeks.ts:1674`).
 * - Sprint complete:   same field, `properties.status -> 'completed'`. There is no
 *                      dedicated "/complete" route — completion happens generically via
 *                      `PATCH /api/weeks/:id` (`weeks.ts:1467`), applied at
 *                      `weeks.ts:1587-1588` (`if (data.status !== undefined) { newProps.status
 *                      = data.status; }`), validated by the
 *                      `z.enum(['planning','active','completed'])` schema at `weeks.ts:480`
 *                      (the generic `PATCH /api/documents/:id` path accepts the same
 *                      top-level `status` field into `properties`, per the identical enum at
 *                      `api/src/routes/documents.ts:156`).
 * - **Not to be confused with:** `sprint_iterations.status` (`api/src/db/schema.sql:268-278`)
 *   is a `CHECK (status IN ('pass','fail','in_progress'))` column on a *different table* —
 *   a per-iteration work-progress log row, unrelated to the sprint document's own lifecycle
 *   status this registry's `sprint.started`/`sprint.completed` events encode. Same trap
 *   `.claude/CLAUDE.md` already documents for `sprint_iterations.sprint_id` vs the dropped
 *   `documents.sprint_id` — same table, adjacent but distinct column.
 * - **Correction (TRO-501, verified 2026-08-16 — the note below was wrong):** the note this
 *   replaced claimed `IssuePrioritySchema` at `api/src/openapi/schemas/issues.ts:26-34` did
 *   not include `'none'`. `git blame` on that file shows `'none'` has been in that exact enum
 *   since the OpenAPI docs were first added (`adf72f9d`) — the OpenAPI schema and the
 *   route-level `createIssueSchema` already agreed. TRO-501's own investigation also found
 *   real product code depending on `'none'` as a first-class "No Priority" state (the web
 *   Properties Panel dropdown, `IssueSidebar.tsx`, offers it explicitly; `KanbanBoard.tsx` /
 *   `IssuesList.tsx` already render a dedicated color for it) — not an edge case to reject.
 *   TRO-501 widened `shared/src/types/document.ts`'s `IssuePriority` union to include
 *   `'none'`, so this registry's `IssuePrioritySchema` below now matches it, rather than
 *   the reverse. Confirmed live before the fix (`api/src/routes/issues.test.ts`'s TRO-501
 *   test, red before this change): creating an issue via `POST /api/issues` with
 *   `priority: 'none'` committed successfully (201) but silently dropped the derived
 *   `issue.created` webhook event — `InProcessEventBus.publish()` threw on the mismatch,
 *   and `documentService.ts`'s `safeDispatch` catches+`console.error`s a dispatch throw
 *   rather than failing the request, so nothing surfaced to the API caller.
 * ---------------------------------------------------------------------------------------
 */

import { z } from 'zod'

// ============== Shared field schemas (mirror shared/src/types/document.ts) ==============

const UuidSchema = z.string().uuid()
const IsoDateTimeSchema = z.string().datetime()

/** Mirrors `DocumentType` (`shared/src/types/document.ts:43-53`). */
const DocumentTypeSchema = z.enum([
  'wiki',
  'issue',
  'program',
  'project',
  'sprint',
  'person',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
])

/** Mirrors `IssueState` (`shared/src/types/document.ts:56`). */
const IssueStateSchema = z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'])

/** Mirrors `IssuePriority` (`shared/src/types/document.ts:59`), including `'none'`
 *  ("No Priority" — TRO-501; see this file's header comment for the correction). */
const IssuePrioritySchema = z.enum(['low', 'medium', 'high', 'urgent', 'none'])

/** Mirrors `WeekProperties.status` (`shared/src/types/document.ts:166`). */
const SprintStatusSchema = z.enum(['planning', 'active', 'completed'])

// ============== The 8 event types ==============

export const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * Common envelope every event payload shares, wrapping a type-specific `data` shape.
 * `type` is a literal matching the registry key it is filed under, so a payload is
 * self-describing even once it has left the registry (e.g. after landing in
 * `webhook_deliveries` or on the wire to a subscriber).
 */
function eventSchema<TType extends EventType, TData extends z.ZodTypeAny>(type: TType, data: TData) {
  return z.object({
    id: UuidSchema,
    type: z.literal(type),
    created_at: IsoDateTimeSchema,
    workspace_id: UuidSchema,
    data,
  })
}

// ============== Per-type `data` payload schemas ==============

const documentCreatedData = z.object({
  id: UuidSchema,
  document_type: DocumentTypeSchema,
  title: z.string(),
  created_by: UuidSchema.nullable(),
})

const documentUpdatedData = z.object({
  id: UuidSchema,
  document_type: DocumentTypeSchema,
  title: z.string(),
  /** Field names that changed on this write, e.g. `['title']` or `['properties.state']`. */
  changed_fields: z.array(z.string()).min(1),
})

const documentDeletedData = z.object({
  id: UuidSchema,
  document_type: DocumentTypeSchema,
})

const issueCreatedData = z.object({
  id: UuidSchema,
  title: z.string(),
  state: IssueStateSchema,
  priority: IssuePrioritySchema,
  assignee_id: UuidSchema.nullable(),
})

/**
 * `assignee_id` / `previous_assignee_id` per the discovery finding: `properties.assignee_id`.
 * `.refine()` rejects no-op payloads (CodeRabbit PR #180 MAJOR finding) where
 * `assignee_id === previous_assignee_id` — including both `null` — since that is not an
 * assignment transition at all.
 */
const issueAssignedData = z
  .object({
    id: UuidSchema,
    assignee_id: UuidSchema.nullable(),
    previous_assignee_id: UuidSchema.nullable(),
  })
  .refine((data) => data.assignee_id !== data.previous_assignee_id, {
    message: 'issue.assigned payload is a no-op: assignee_id equals previous_assignee_id',
    path: ['assignee_id'],
  })

/**
 * `state` / `previous_state` per the discovery finding: `properties.state`. `.refine()` rejects
 * no-op payloads (CodeRabbit PR #180 MAJOR finding) where `state === previous_state`, since that
 * is not a status transition at all.
 */
const issueStatusChangedData = z
  .object({
    id: UuidSchema,
    state: IssueStateSchema,
    previous_state: IssueStateSchema,
  })
  .refine((data) => data.state !== data.previous_state, {
    message: 'issue.status_changed payload is a no-op: state equals previous_state',
    path: ['state'],
  })

/**
 * `status` fixed to `'active'` per the discovery finding: the `planning -> active` transition.
 * No no-op `.refine()` here (unlike `sprintCompletedData` below): `status`/`previous_status` are
 * both fixed zod literals (`'active'` / `'planning'`) that can never be equal, so a no-op payload
 * is already structurally unrepresentable — field-level validation rejects it before any
 * object-level refinement would run.
 */
const sprintStartedData = z.object({
  id: UuidSchema,
  sprint_number: z.number().int(),
  status: z.literal('active'),
  previous_status: z.literal('planning'),
})

/**
 * `status` fixed to `'completed'` per the discovery finding: `properties.status -> 'completed'`.
 * `.refine()` rejects no-op payloads (CodeRabbit PR #180 MAJOR finding) where `previous_status`
 * is already `'completed'` — unlike `sprintStartedData`, `previous_status` here is the open
 * `SprintStatusSchema` enum (not a fixed literal), so `previous_status === status` is otherwise
 * representable and must be rejected explicitly.
 */
const sprintCompletedData = z
  .object({
    id: UuidSchema,
    sprint_number: z.number().int(),
    status: z.literal('completed'),
    previous_status: SprintStatusSchema,
  })
  .refine((data) => data.previous_status !== data.status, {
    message: 'sprint.completed payload is a no-op: previous_status is already completed',
    path: ['previous_status'],
  })

// ============== The registry itself ==============

export interface EventDefinition<T = unknown> {
  readonly type: EventType
  readonly schema: z.ZodType<T>
}

/**
 * `type` -> `EventDefinition`. A plain object keyed by the literal union, not a switch
 * statement — this is the "events as data" requirement from PLUGFORGE.MD §2.6 / this
 * ticket's AC. Adding a 9th event type is adding one entry here, never a new branch
 * anywhere else.
 */
const EVENT_DEFINITIONS: { [K in EventType]: EventDefinition } = {
  'document.created': { type: 'document.created', schema: eventSchema('document.created', documentCreatedData) },
  'document.updated': { type: 'document.updated', schema: eventSchema('document.updated', documentUpdatedData) },
  'document.deleted': { type: 'document.deleted', schema: eventSchema('document.deleted', documentDeletedData) },
  'issue.created': { type: 'issue.created', schema: eventSchema('issue.created', issueCreatedData) },
  'issue.assigned': { type: 'issue.assigned', schema: eventSchema('issue.assigned', issueAssignedData) },
  'issue.status_changed': {
    type: 'issue.status_changed',
    schema: eventSchema('issue.status_changed', issueStatusChangedData),
  },
  'sprint.started': { type: 'sprint.started', schema: eventSchema('sprint.started', sprintStartedData) },
  'sprint.completed': { type: 'sprint.completed', schema: eventSchema('sprint.completed', sprintCompletedData) },
}

/**
 * The event registry: `get` for a single type's definition, `list` for the full enumerable
 * set (what the developer portal and a docs generator walk — PF-300's AC).
 */
export const eventRegistry = {
  get(type: EventType): EventDefinition {
    const definition = EVENT_DEFINITIONS[type]
    if (!definition) {
      // Unreachable for any value typed as `EventType`; guards a non-TS or `as`-cast caller.
      throw new Error(`Unknown event type: ${String(type)}`)
    }
    return definition
  },
  list(): EventDefinition[] {
    return EVENT_TYPES.map((type) => EVENT_DEFINITIONS[type])
  },
}
