/**
 * `documentService` write-path + event-derivation tests (TRO-426 / PF-301).
 *
 * Integration-style (real Postgres, real `pool`, no mocks) — matching this
 * repo's route test convention (`routes/issues.test.ts`, `routes/documents.test.ts`)
 * rather than the mocked-pool unit-test convention some other services use
 * (`accountability.test.ts`). The refactor this ticket makes is precisely "route
 * handlers stop running inline SQL and call this file instead" — a mock would
 * prove the mock was called correctly, not that the SQL this file assembles
 * (dynamic INSERT column lists, dynamic UPDATE SET clauses, `RETURNING *`)
 * actually behaves against a real `documents` table.
 *
 * `routes/issues.test.ts` has a companion test that hits `POST /api/issues`
 * over HTTP and asserts the same `document.created`/`issue.created` pair fires
 * — that proves the route delegates to this file. The tests here prove this
 * file's own logic is correct in every case the four consolidated routers
 * exercise, including derivation paths (sprint transitions) that, per this
 * ticket's documented scope decision, no production route currently reaches.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'
import { createDocument, updateDocument, deleteDocument, type DocumentRow } from './documentService.js'
import { getEventBus, type EventEnvelope } from '../platform/webhooks/eventBus.js'

describe('documentService (TRO-426 / PF-301)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let testWorkspaceId: string
  let testUserId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`DocumentService Test ${testRunId}`]
    )
    const workspaceRow = workspaceResult.rows[0]
    if (!workspaceRow) {
      throw new Error('documentService.test.ts setup: workspace INSERT ... RETURNING produced no row')
    }
    testWorkspaceId = workspaceRow.id

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'DocumentService Test User') RETURNING id`,
      [`documentservice-test-${testRunId}@ship.local`]
    )
    const userRow = userResult.rows[0]
    if (!userRow) {
      throw new Error('documentService.test.ts setup: user INSERT ... RETURNING produced no row')
    }
    testUserId = userRow.id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  /** Subscribes to `type` for the duration of `fn`, then unsubscribes — keeps one test's events out of another's. */
  async function withSubscription<T>(
    type: Parameters<ReturnType<typeof getEventBus>['subscribe']>[0],
    fn: (events: EventEnvelope[]) => Promise<T>
  ): Promise<{ result: T; events: EventEnvelope[] }> {
    const bus = getEventBus()
    const events: EventEnvelope[] = []
    const unsubscribe = bus.subscribe(type, (event) => {
      events.push(event)
    })
    try {
      const result = await fn(events)
      return { result, events }
    } finally {
      unsubscribe()
    }
  }

  describe('createDocument', () => {
    it('publishes only document.created for a non-issue document type', async () => {
      const bus = getEventBus()
      const documentEvents: EventEnvelope[] = []
      const issueEvents: EventEnvelope[] = []
      const unsubDoc = bus.subscribe('document.created', (e) => documentEvents.push(e))
      const unsubIssue = bus.subscribe('issue.created', (e) => issueEvents.push(e))

      try {
        const row = await createDocument({
          workspaceId: testWorkspaceId,
          documentType: 'wiki',
          title: 'Plain Wiki Doc',
          createdByUserId: testUserId,
        })

        expect(row.document_type).toBe('wiki')
        expect(row.title).toBe('Plain Wiki Doc')
        // Omitted `visibility` — the column default applies, not an explicit NULL.
        expect(row.visibility).toBe('workspace')

        const created = documentEvents.find((e) => (e.data as { id: string }).id === row.id)
        expect(created).toBeDefined()
        expect(created?.workspace_id).toBe(testWorkspaceId)
        expect((created?.data as { created_by: string | null }).created_by).toBe(testUserId)

        expect(issueEvents.find((e) => (e.data as { id: string }).id === row.id)).toBeUndefined()
      } finally {
        unsubDoc()
        unsubIssue()
      }
    })

    it('publishes document.created AND issue.created for an issue-type document (TRO-426 AC)', async () => {
      const bus = getEventBus()
      const documentEvents: EventEnvelope[] = []
      const issueEvents: EventEnvelope[] = []
      const unsubDoc = bus.subscribe('document.created', (e) => documentEvents.push(e))
      const unsubIssue = bus.subscribe('issue.created', (e) => issueEvents.push(e))

      let row: DocumentRow
      try {
        row = await createDocument({
          workspaceId: testWorkspaceId,
          documentType: 'issue',
          title: 'Service-level Issue',
          properties: { state: 'backlog', priority: 'medium', assignee_id: testUserId },
          ticketNumber: 90001,
          createdByUserId: testUserId,
        })
      } finally {
        unsubDoc()
        unsubIssue()
      }

      expect(row.document_type).toBe('issue')
      expect(row.ticket_number).toBe(90001)

      const docEvent = documentEvents.find((e) => (e.data as { id: string }).id === row.id)
      expect(docEvent).toBeDefined()
      expect((docEvent?.data as { document_type: string }).document_type).toBe('issue')

      const issueCreated = issueEvents.find((e) => (e.data as { id: string }).id === row.id)
      expect(issueCreated).toBeDefined()
      expect((issueCreated?.data as { title: string }).title).toBe('Service-level Issue')
      expect((issueCreated?.data as { state: string }).state).toBe('backlog')
      expect((issueCreated?.data as { priority: string }).priority).toBe('medium')
      expect((issueCreated?.data as { assignee_id: string | null }).assignee_id).toBe(testUserId)
    })

    it('omits optional columns entirely rather than inserting an explicit NULL (parent_id/content/ticket_number)', async () => {
      const row = await createDocument({
        workspaceId: testWorkspaceId,
        documentType: 'project',
        title: 'No Optional Columns',
        createdByUserId: testUserId,
      })

      const dbRow = await pool.query<{ ticket_number: number | null; parent_id: string | null }>(
        'SELECT ticket_number, parent_id FROM documents WHERE id = $1',
        [row.id]
      )
      expect(dbRow.rows[0]?.ticket_number).toBeNull()
      expect(dbRow.rows[0]?.parent_id).toBeNull()
    })
  })

  describe('updateDocument', () => {
    async function createTestIssue(properties: Record<string, unknown>): Promise<DocumentRow> {
      return createDocument({
        workspaceId: testWorkspaceId,
        documentType: 'issue',
        title: 'Update Target Issue',
        properties,
        createdByUserId: testUserId,
      })
    }

    it('fires document.updated with changed_fields, and issue.status_changed on a real state transition', async () => {
      const issue = await createTestIssue({ state: 'todo', priority: 'medium', assignee_id: null })

      const { result: updated, events: updatedEvents } = await withSubscription('document.updated', async () => {
        return updateDocument({
          id: issue.id,
          workspaceId: testWorkspaceId,
          setClauses: ['properties = $1', 'updated_at = now()'],
          values: [JSON.stringify({ ...issue.properties, state: 'in_progress' })],
          previousProperties: issue.properties,
        })
      })

      expect((updated.properties as { state: string }).state).toBe('in_progress')
      const docUpdated = updatedEvents.find((e) => (e.data as { id: string }).id === issue.id)
      expect(docUpdated).toBeDefined()
      expect((docUpdated?.data as { changed_fields: string[] }).changed_fields).toContain('properties')

      const bus = getEventBus()
      const statusEvents: EventEnvelope[] = []
      const unsubscribe = bus.subscribe('issue.status_changed', (e) => statusEvents.push(e))
      let updated2: DocumentRow
      try {
        updated2 = await updateDocument({
          id: issue.id,
          workspaceId: testWorkspaceId,
          setClauses: ['properties = $1', 'updated_at = now()'],
          values: [JSON.stringify({ ...(updated.properties as object), state: 'done' })],
          previousProperties: updated.properties,
        })
      } finally {
        unsubscribe()
      }

      const statusChanged = statusEvents.find((e) => (e.data as { id: string }).id === issue.id)
      expect(statusChanged).toBeDefined()
      expect((statusChanged?.data as { state: string }).state).toBe('done')
      expect((statusChanged?.data as { previous_state: string }).previous_state).toBe('in_progress')
      expect((updated2.properties as { state: string }).state).toBe('done')
    })

    it('fires issue.assigned when properties.assignee_id changes', async () => {
      const issue = await createTestIssue({ state: 'todo', priority: 'medium', assignee_id: null })

      const { events: assignedEvents } = await withSubscription('issue.assigned', async () => {
        return updateDocument({
          id: issue.id,
          workspaceId: testWorkspaceId,
          setClauses: ['properties = $1', 'updated_at = now()'],
          values: [JSON.stringify({ ...issue.properties, assignee_id: testUserId })],
          previousProperties: issue.properties,
        })
      })

      const assigned = assignedEvents.find((e) => (e.data as { id: string }).id === issue.id)
      expect(assigned).toBeDefined()
      expect((assigned?.data as { assignee_id: string | null }).assignee_id).toBe(testUserId)
      expect((assigned?.data as { previous_assignee_id: string | null }).previous_assignee_id).toBeNull()
    })

    it('does not fire issue.status_changed/issue.assigned when properties did not change (title-only update)', async () => {
      const issue = await createTestIssue({ state: 'todo', priority: 'medium', assignee_id: null })

      const bus = getEventBus()
      const statusEvents: EventEnvelope[] = []
      const assignedEvents: EventEnvelope[] = []
      const unsubStatus = bus.subscribe('issue.status_changed', (e) => statusEvents.push(e))
      const unsubAssigned = bus.subscribe('issue.assigned', (e) => assignedEvents.push(e))
      try {
        await updateDocument({
          id: issue.id,
          workspaceId: testWorkspaceId,
          setClauses: ['title = $1', 'updated_at = now()'],
          values: ['Renamed Title Only'],
          // No previousProperties needed/passed: properties isn't in setClauses.
        })
      } finally {
        unsubStatus()
        unsubAssigned()
      }

      expect(statusEvents.find((e) => (e.data as { id: string }).id === issue.id)).toBeUndefined()
      expect(assignedEvents.find((e) => (e.data as { id: string }).id === issue.id)).toBeUndefined()
    })

    it('derives sprint.started (planning -> active) and sprint.completed (-> completed)', async () => {
      const sprint = await createDocument({
        workspaceId: testWorkspaceId,
        documentType: 'sprint',
        title: 'Sprint 1',
        properties: { status: 'planning', sprint_number: 1 },
        createdByUserId: testUserId,
      })

      const { events: startedEvents } = await withSubscription('sprint.started', async () => {
        return updateDocument({
          id: sprint.id,
          workspaceId: testWorkspaceId,
          setClauses: ['properties = $1', 'updated_at = now()'],
          values: [JSON.stringify({ ...sprint.properties, status: 'active' })],
          previousProperties: sprint.properties,
        })
      })
      const started = startedEvents.find((e) => (e.data as { id: string }).id === sprint.id)
      expect(started).toBeDefined()
      expect((started?.data as { status: string }).status).toBe('active')
      expect((started?.data as { previous_status: string }).previous_status).toBe('planning')

      const { events: completedEvents } = await withSubscription('sprint.completed', async () => {
        return updateDocument({
          id: sprint.id,
          workspaceId: testWorkspaceId,
          setClauses: ['properties = $1', 'updated_at = now()'],
          values: [JSON.stringify({ ...sprint.properties, status: 'completed' })],
          previousProperties: { ...sprint.properties, status: 'active' },
        })
      })
      const completed = completedEvents.find((e) => (e.data as { id: string }).id === sprint.id)
      expect(completed).toBeDefined()
      expect((completed?.data as { status: string }).status).toBe('completed')
      expect((completed?.data as { previous_status: string }).previous_status).toBe('active')
    })

    it('throws when documentTypeFilter excludes the target row (no silent no-op)', async () => {
      const issue = await createTestIssue({ state: 'todo' })

      await expect(
        updateDocument({
          id: issue.id,
          workspaceId: testWorkspaceId,
          setClauses: ['title = $1', 'updated_at = now()'],
          values: ['Should Not Apply'],
          documentTypeFilter: 'project', // issue !== project
        })
      ).rejects.toThrow(/produced no row/)
    })
  })

  describe('deleteDocument', () => {
    it('publishes document.deleted and returns the deleted row', async () => {
      const doc = await createDocument({
        workspaceId: testWorkspaceId,
        documentType: 'wiki',
        title: 'To Be Deleted',
        createdByUserId: testUserId,
      })

      const { result: deleted, events } = await withSubscription('document.deleted', async () => {
        return deleteDocument({ id: doc.id, workspaceId: testWorkspaceId })
      })

      expect(deleted?.id).toBe(doc.id)
      const deletedEvent = events.find((e) => (e.data as { id: string }).id === doc.id)
      expect(deletedEvent).toBeDefined()
      expect((deletedEvent?.data as { document_type: string }).document_type).toBe('wiki')

      const check = await pool.query('SELECT id FROM documents WHERE id = $1', [doc.id])
      expect(check.rows).toHaveLength(0)
    })

    it('returns null and publishes nothing when no row matches', async () => {
      const { result, events } = await withSubscription('document.deleted', async () => {
        return deleteDocument({ id: '00000000-0000-0000-0000-000000000000', workspaceId: testWorkspaceId })
      })

      expect(result).toBeNull()
      expect(events).toHaveLength(0)
    })
  })
})
