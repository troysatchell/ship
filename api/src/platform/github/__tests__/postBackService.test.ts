import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { pool } from '../../../db/client.js'
import { postStatusChangeComments } from '../postBackService.js'

function requireRow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}.`)
  return row
}

describe('postStatusChangeComments', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let workspaceId: string
  let issueId: string
  let privateKey: string

  beforeAll(async () => {
    const keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    privateKey = keyPair.privateKey

    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`GitHub Post-back Test ${testRunId}`]
    )
    workspaceId = workspaceResult.rows[0].id

    const maxResult = await pool.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number FROM documents WHERE workspace_id = $1`,
      [workspaceId]
    )
    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
       VALUES ($1, 'issue', 'Post-back test issue', $2, $3) RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'in_progress', priority: 'medium' }), requireRow(maxResult.rows).next_number]
    )
    issueId = issueResult.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  it('returns 0 and makes no HTTP call when the issue has no linked PR', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const posted = await postStatusChangeComments(
      pool,
      { appId: '1', privateKey },
      { issueId, state: 'done', previousState: 'in_progress' },
      fetchMock
    )
    expect(posted).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exchanges an installation token then posts a comment on every linked PR', async () => {
    await pool.query(
      `INSERT INTO github_pr_links (issue_id, workspace_id, repo_owner, repo_name, pr_number, pr_url, pr_state, installation_id)
       VALUES ($1, $2, 'acme', 'widgets', 77, 'https://github.com/acme/widgets/pull/77', 'open', 555)`,
      [issueId, workspaceId]
    )

    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: url.toString(), method: init?.method, body: init?.body })
      if (url.toString().includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_fake_token' }), { status: 201 })
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 })
    })

    const posted = await postStatusChangeComments(
      pool,
      { appId: '1', privateKey },
      { issueId, state: 'done', previousState: 'in_progress' },
      fetchMock
    )

    expect(posted).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/555/access_tokens')
    expect(calls[1]?.url).toBe('https://api.github.com/repos/acme/widgets/issues/77/comments')
    const commentBody = JSON.parse(calls[1]?.body as string)
    expect(commentBody.body).toContain('in_progress')
    expect(commentBody.body).toContain('done')
  })

  it('skips (does not throw) a PR whose comment POST fails, logging rather than aborting', async () => {
    const secondIssue = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
       VALUES ($1, 'issue', 'Second post-back issue', $2, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM documents WHERE workspace_id = $1))
       RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'done', priority: 'medium' })]
    )
    const secondIssueId = secondIssue.rows[0].id
    await pool.query(
      `INSERT INTO github_pr_links (issue_id, workspace_id, repo_owner, repo_name, pr_number, pr_url, pr_state, installation_id)
       VALUES ($1, $2, 'acme', 'widgets', 88, 'https://github.com/acme/widgets/pull/88', 'open', 556)`,
      [secondIssueId, workspaceId]
    )

    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url.toString().includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_fake_token' }), { status: 201 })
      }
      return new Response('forbidden', { status: 403 })
    })

    const posted = await postStatusChangeComments(
      pool,
      { appId: '1', privateKey },
      { issueId: secondIssueId, state: 'done', previousState: 'todo' },
      fetchMock
    )
    expect(posted).toBe(0)
  })
})
