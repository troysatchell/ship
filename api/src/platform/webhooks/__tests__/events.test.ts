/**
 * Regression suite for TRO-419 / PF-300 (event registry — 8 event types with Zod schemas).
 *
 * Test design source: Linear TRO-419 comment "Test design (pre-implementation —
 * ship-test-designer, 2026-08-10)". AC-1/AC-2 below map 1:1 onto that comment's numbering.
 *
 * Minimal valid payloads are hand-built per PLUGFORGE.MD §2.6 and this ticket's own discovery
 * findings (recorded in `../events.ts`'s header comment and in the TRO-419 ticket comment):
 * issue state lives at `properties.state`, issue assignee at `properties.assignee_id`, and
 * sprint start/complete are both the same `properties.status` field transitioning
 * `planning -> active` / `-> completed`.
 */

import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { EVENT_TYPES, eventRegistry, type EventType } from '../events.js'

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const DOC_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const CREATED_AT = '2026-08-10T18:00:00.000Z'

/** One minimal, valid payload per event type — envelope + type-specific `data`. */
const VALID_PAYLOADS: Record<EventType, unknown> = {
  'document.created': {
    id: DOC_ID,
    type: 'document.created',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      document_type: 'wiki',
      title: 'Untitled',
      created_by: USER_ID,
    },
  },
  'document.updated': {
    id: DOC_ID,
    type: 'document.updated',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      document_type: 'wiki',
      title: 'Untitled',
      changed_fields: ['title'],
    },
  },
  'document.deleted': {
    id: DOC_ID,
    type: 'document.deleted',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      document_type: 'wiki',
    },
  },
  'issue.created': {
    id: DOC_ID,
    type: 'issue.created',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      title: 'Fix the thing',
      // discovery: properties.state (shared/src/types/document.ts:56,83)
      state: 'backlog',
      priority: 'medium',
      // discovery: properties.assignee_id (shared/src/types/document.ts:85)
      assignee_id: null,
    },
  },
  'issue.assigned': {
    id: DOC_ID,
    type: 'issue.assigned',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      // discovery: properties.assignee_id, mutated at api/src/routes/issues.ts:1049-1051
      assignee_id: USER_ID,
      previous_assignee_id: null,
    },
  },
  'issue.status_changed': {
    id: DOC_ID,
    type: 'issue.status_changed',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      // discovery: properties.state, mutated at api/src/routes/issues.ts:1035
      state: 'in_progress',
      previous_state: 'todo',
    },
  },
  'sprint.started': {
    id: DOC_ID,
    type: 'sprint.started',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      sprint_number: 6,
      // discovery: properties.status 'planning' -> 'active', api/src/routes/weeks.ts:1701-1719
      status: 'active',
      previous_status: 'planning',
    },
  },
  'sprint.completed': {
    id: DOC_ID,
    type: 'sprint.completed',
    created_at: CREATED_AT,
    workspace_id: WORKSPACE_ID,
    data: {
      id: DOC_ID,
      sprint_number: 6,
      // discovery: properties.status -> 'completed', api/src/routes/weeks.ts:1587-1588
      status: 'completed',
      previous_status: 'active',
    },
  },
}

/** One field to delete per type in order to produce a payload missing a required field. */
const REQUIRED_FIELD_TO_DROP: Record<EventType, (payload: Record<string, unknown>) => void> = {
  'document.created': (p) => delete (p.data as Record<string, unknown>).document_type,
  'document.updated': (p) => delete (p.data as Record<string, unknown>).changed_fields,
  'document.deleted': (p) => delete (p.data as Record<string, unknown>).id,
  'issue.created': (p) => delete (p.data as Record<string, unknown>).state,
  'issue.assigned': (p) => delete (p.data as Record<string, unknown>).assignee_id,
  'issue.status_changed': (p) => delete (p.data as Record<string, unknown>).state,
  'sprint.started': (p) => delete (p.data as Record<string, unknown>).status,
  'sprint.completed': (p) => delete (p.data as Record<string, unknown>).status,
}

describe('platform/webhooks/events — registry', () => {
  // AC-2: registry enumerable (portal + docs consume it)
  describe('enumeration', () => {
    it('exposes exactly the 8 named event types, no more/fewer', () => {
      const entries = eventRegistry.list()
      const types = entries.map((e) => e.type).sort()
      expect(types).toEqual([...EVENT_TYPES].sort())
      expect(entries).toHaveLength(8)
    })

    it('each entry exposes at minimum { type: string, schema: ZodSchema }', () => {
      for (const entry of eventRegistry.list()) {
        expect(typeof entry.type).toBe('string')
        expect(entry.schema).toBeDefined()
        expect(typeof entry.schema.parse).toBe('function')
        expect(typeof entry.schema.safeParse).toBe('function')
      }
    })
  })

  // AC-1: schema unit tests (8 event types with Zod payload schemas)
  describe('schemas', () => {
    it.each(EVENT_TYPES)('parses a minimal valid %s payload without throwing', (type) => {
      const payload = VALID_PAYLOADS[type]
      expect(() => eventRegistry.get(type).schema.parse(payload)).not.toThrow()
    })

    it.each(EVENT_TYPES)('throws a ZodError for a %s payload missing a required field', (type) => {
      const payload = structuredClone(VALID_PAYLOADS[type]) as Record<string, unknown>
      REQUIRED_FIELD_TO_DROP[type](payload)

      expect(() => eventRegistry.get(type).schema.parse(payload)).toThrow(ZodError)
    })
  })
})
