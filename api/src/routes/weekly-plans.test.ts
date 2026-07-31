import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'

describe('Weekly Plans API', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `weekly-plans-${testRunId}@ship.local`
  const testWorkspaceName = `Weekly Plans Test ${testRunId}`

  let sessionCookie: string
  let csrfToken: string
  let testWorkspaceId: string
  let testUserId: string
  let personId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Test User')
       RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    )
    sessionCookie = `session_id=${sessionId}`

    const csrfRes = await request(app)
      .get('/api/csrf-token')
      .set('Cookie', sessionCookie)
    csrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }

    // Person document representing the test user (mirrors what onboarding creates)
    const personResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
       VALUES ($1, 'person', 'Test Person', $2, 'workspace', $3)
       RETURNING id`,
      [testWorkspaceId, testUserId, JSON.stringify({ user_id: testUserId })]
    )
    personId = personResult.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [testWorkspaceId])
  })

  describe('GET /api/weekly-plans/project-allocation-grid/:projectId — TRO-228', () => {
    let projectId: string

    beforeEach(async () => {
      await pool.query(
        `DELETE FROM documents WHERE workspace_id = $1 AND document_type IN ('project', 'sprint', 'weekly_plan', 'issue')`,
        [testWorkspaceId]
      )

      const projectResult = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
         VALUES ($1, 'project', 'Test Project', $2, 'workspace')
         RETURNING id`,
        [testWorkspaceId, testUserId]
      )
      projectId = projectResult.rows[0].id

      // A sprint that allocates the person to this project for week 1 — the
      // allocation grid's `allocatedPeopleResult` query keys off
      // sprint.properties.project_id / assignee_ids / sprint_number.
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
         VALUES ($1, 'sprint', 'Test Sprint', $2, 'workspace', $3)`,
        [
          testWorkspaceId,
          testUserId,
          JSON.stringify({ project_id: projectId, assignee_ids: [personId], sprint_number: 1 }),
        ]
      )
    })

    it('shows the plan in the grid immediately after POST /api/weekly-plans creates it', async () => {
      const planResponse = await request(app)
        .post('/api/weekly-plans')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ person_id: personId, project_id: projectId, week_number: 1 })

      expect(planResponse.status).toBe(201)
      const plan = planResponse.body

      const gridResponse = await request(app)
        .get(`/api/weekly-plans/project-allocation-grid/${projectId}`)
        .set('Cookie', sessionCookie)

      expect(gridResponse.status).toBe(200)
      const grid = gridResponse.body

      const personInGrid = grid.people.find((p: { id: string }) => p.id === personId)
      expect(personInGrid, 'Person should appear in allocation grid').toBeTruthy()

      const week1Data = personInGrid.weeks[1]
      expect(week1Data, 'Week 1 data should exist for the allocated person').toBeTruthy()
      expect(week1Data.isAllocated).toBe(true)
      expect(week1Data.planId, 'Grid should reflect the plan that was just committed').toBe(plan.id)
    })

    // TRO-228 root cause: this is NOT a read-after-write race. POST
    // /weekly-plans dedupes a weekly_plan document strictly on
    // (person_id, week_number) — `project_id` is documented in
    // weeklyPlanSchema as "legacy field, not used for uniqueness". So a
    // person who already has a week-N plan tagged with a DIFFERENT project's
    // id gets that same document handed back (200, not 201) when they
    // request a week-N plan for a new project — and the old grid query's
    // `(properties->>'project_id') = $2` filter would then never find it,
    // permanently showing `planId: null` even though the plan exists and is
    // reachable by GET /weekly-plans/:id. This reproduces deterministically:
    // no timing, no sleep, just the two writes in the order a real multi-
    // project user would produce them.
    it('finds a person’s existing week-N plan on a second project’s grid, even though the plan is tagged with the first project (dedup is person+week only, not per-project)', async () => {
      const firstProjectResult = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
         VALUES ($1, 'project', 'Other Project', $2, 'workspace')
         RETURNING id`,
        [testWorkspaceId, testUserId]
      )
      const firstProjectId = firstProjectResult.rows[0].id

      // Person already has a week 1 plan, created against a different project.
      const firstPlanResponse = await request(app)
        .post('/api/weekly-plans')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ person_id: personId, project_id: firstProjectId, week_number: 1 })
      expect(firstPlanResponse.status).toBe(201)
      const firstPlan = firstPlanResponse.body

      // Same person, same week, but THIS project — the idempotent dedup
      // means this returns the existing (firstProjectId-tagged) document.
      const secondPlanResponse = await request(app)
        .post('/api/weekly-plans')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ person_id: personId, project_id: projectId, week_number: 1 })
      expect(secondPlanResponse.status).toBe(200)
      expect(secondPlanResponse.body.id).toBe(firstPlan.id)

      const gridResponse = await request(app)
        .get(`/api/weekly-plans/project-allocation-grid/${projectId}`)
        .set('Cookie', sessionCookie)
      expect(gridResponse.status).toBe(200)
      const grid = gridResponse.body

      const personInGrid = grid.people.find((p: { id: string }) => p.id === personId)
      expect(personInGrid, 'Person should appear in allocation grid').toBeTruthy()

      const week1Data = personInGrid.weeks[1]
      expect(week1Data, 'Week 1 data should exist for the allocated person').toBeTruthy()
      expect(week1Data.isAllocated).toBe(true)
      expect(
        week1Data.planId,
        'The person’s week-1 plan exists (POST returned it, 200) — the grid must not hide it just because its properties.project_id belongs to the project that first created it'
      ).toBe(firstPlan.id)
    })
  })
})
