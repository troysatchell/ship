/**
 * `POST /api/github/webhook` (PF-804 / TRO-453) — end-to-end through `createApp()` + supertest,
 * against the real test Postgres pool. Same shape `integrations/slack/src/server.test.ts` uses
 * for its own receiver: real signature computed over the real raw bytes, sent through the real
 * Express app, asserted against a real DB row rather than a mock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { getLinksForIssue } from '../platform/github/linkSyncService.js'

function requireRow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}.`)
  return row
}

const WEBHOOK_SECRET = 'fixture-github-webhook-secret-for-tests'

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`
}

describe('POST /api/github/webhook', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let workspaceId: string
  let issueId: string
  let ticketNumber: number
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`GitHub Webhook Route Test ${testRunId}`]
    )
    workspaceId = workspaceResult.rows[0].id

    const maxResult = await pool.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number FROM documents WHERE workspace_id = $1`,
      [workspaceId]
    )
    ticketNumber = requireRow(maxResult.rows).next_number

    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
       VALUES ($1, 'issue', 'Route test issue', $2, $3) RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'backlog', priority: 'medium' }), ticketNumber]
    )
    issueId = issueResult.rows[0].id

    app = createApp(undefined, { github: { webhookSecret: WEBHOOK_SECRET, shipWorkspaceId: workspaceId } })
  })

  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  function pullRequestPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      action: 'opened',
      number: 55,
      pull_request: {
        number: 55,
        html_url: 'https://github.com/acme/widgets/pull/55',
        title: `Fix login (Ship#${ticketNumber})`,
        body: null,
        state: 'open',
        merged: false,
        head: { ref: 'fix/login' },
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      installation: { id: 7 },
      ...overrides,
    })
  }

  it('404s when the route is not mounted (no github config passed to createApp)', async () => {
    const unconfiguredApp = createApp()
    const body = pullRequestPayload()
    await request(unconfiguredApp)
      .post('/api/github/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(404)
  })

  it('rejects an unsigned delivery with 401 and does not create a link', async () => {
    const body = pullRequestPayload({ number: 9001, pull_request: { number: 9001, html_url: 'x', title: `Ship#${ticketNumber}`, body: null, state: 'open', merged: false, head: { ref: 'x' } } })
    await request(app)
      .post('/api/github/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', 'sha256=' + '0'.repeat(64))
      .send(body)
      .expect(401)

    const links = await getLinksForIssue(pool, issueId)
    expect(links.find((l) => l.prNumber === 9001)).toBeUndefined()
  })

  it('accepts a verified pull_request "opened" delivery and creates the link', async () => {
    const body = pullRequestPayload()
    const res = await request(app)
      .post('/api/github/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)

    expect(res.body.status).toBe('synced')
    expect(res.body.linkedIssueIds).toEqual([issueId])

    const links = await getLinksForIssue(pool, issueId)
    expect(links.some((l) => l.prNumber === 55 && l.prState === 'open')).toBe(true)
  })

  it('200s and ignores a verified delivery of an unhandled pull_request action', async () => {
    const body = pullRequestPayload({ action: 'labeled', number: 56, pull_request: { number: 56, html_url: 'x', title: `Ship#${ticketNumber}`, body: null, state: 'open', merged: false, head: { ref: 'x' } } })
    const res = await request(app)
      .post('/api/github/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)
    expect(res.body.status).toBe('ignored')

    const links = await getLinksForIssue(pool, issueId)
    expect(links.find((l) => l.prNumber === 56)).toBeUndefined()
  })

  it('200s and ignores a verified delivery of an event type this receiver does not act on', async () => {
    const body = JSON.stringify({ zen: 'Responsive is better than fast.' })
    const res = await request(app)
      .post('/api/github/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'ping')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)
    expect(res.body.status).toBe('ignored')
  })
})
