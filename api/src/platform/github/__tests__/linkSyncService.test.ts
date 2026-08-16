/**
 * `syncPullRequestLinks` / `getLinksForIssue` (PF-804 / TRO-453) — real test Postgres pool, same
 * convention `deliverer.test.ts`'s own header documents ("asserting a row's status after a real
 * SELECT is a stronger proof than an in-memory double").
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../../db/client.js'
import { syncPullRequestLinks, getLinksForIssue } from '../linkSyncService.js'
import type { PullRequestEvent } from '../webhookPayloads.js'

function requireRow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}.`)
  return row
}

function pullRequestEvent(overrides: Partial<PullRequestEvent['pull_request']> = {}): PullRequestEvent {
  return {
    action: 'opened',
    number: 17,
    pull_request: {
      number: 17,
      html_url: 'https://github.com/acme/widgets/pull/17',
      title: 'Fix login bug',
      body: null,
      state: 'open',
      merged: false,
      head: { ref: 'fix/login-bug' },
      ...overrides,
    },
    repository: { name: 'widgets', owner: { login: 'acme' } },
    installation: { id: 42424242 },
  }
}

describe('syncPullRequestLinks', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let workspaceId: string
  let issueId: string
  let ticketNumber: number

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`GitHub Sync Test ${testRunId}`]
    )
    workspaceId = workspaceResult.rows[0].id

    const maxResult = await pool.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number FROM documents WHERE workspace_id = $1`,
      [workspaceId]
    )
    ticketNumber = requireRow(maxResult.rows).next_number

    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
       VALUES ($1, 'issue', 'Login is broken', $2, $3)
       RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'backlog', priority: 'medium' }), ticketNumber]
    )
    issueId = issueResult.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  it('does nothing when the PR has no Ship#<n> reference', async () => {
    const result = await syncPullRequestLinks(pool, pullRequestEvent({ title: 'no reference here' }), workspaceId)
    expect(result.linkedIssueIds).toEqual([])
    expect(result.unresolvedTicketNumbers).toEqual([])
  })

  it('creates a link row when the PR title references a real issue in the configured workspace', async () => {
    const event = pullRequestEvent({ title: `Fix login (Ship#${ticketNumber})` })
    const result = await syncPullRequestLinks(pool, event, workspaceId)
    expect(result.linkedIssueIds).toEqual([issueId])
    expect(result.unresolvedTicketNumbers).toEqual([])

    const links = await getLinksForIssue(pool, issueId)
    expect(links).toEqual([
      {
        repoOwner: 'acme',
        repoName: 'widgets',
        prNumber: 17,
        prUrl: 'https://github.com/acme/widgets/pull/17',
        prState: 'open',
        // BIGINT column read back via node-postgres as a string, not a number — see
        // linkSyncService.ts's getLinksForIssue for why.
        installationId: '42424242',
      },
    ])
  })

  it('reports a referenced-but-nonexistent ticket number as unresolved, not an error', async () => {
    const bogusNumber = 999999999
    const event = pullRequestEvent({ title: `Ship#${bogusNumber}`, body: null })
    const result = await syncPullRequestLinks(pool, event, workspaceId)
    expect(result.linkedIssueIds).toEqual([])
    expect(result.unresolvedTicketNumbers).toEqual([bogusNumber])
  })

  it('upserts pr_state on a redelivery for the same (issue, PR) rather than duplicating rows', async () => {
    const opened = pullRequestEvent({ title: `Ship#${ticketNumber}`, state: 'open', merged: false })
    await syncPullRequestLinks(pool, opened, workspaceId)

    const merged = pullRequestEvent({ title: `Ship#${ticketNumber}`, state: 'closed', merged: true })
    await syncPullRequestLinks(pool, merged, workspaceId)

    const links = await getLinksForIssue(pool, issueId)
    // Same (issue, PR#17) pair both times -> exactly one row, now 'merged'.
    expect(links).toHaveLength(1)
    expect(links[0]?.prState).toBe('merged')
  })

  it('a redelivery with no installation on the payload does not wipe out a previously-recorded installation_id', async () => {
    const withInstallation = pullRequestEvent({ title: `Ship#${ticketNumber}`, state: 'open', merged: false })
    await syncPullRequestLinks(pool, withInstallation, workspaceId)
    const afterFirst = await getLinksForIssue(pool, issueId)
    expect(afterFirst[0]?.installationId).toBe('42424242')

    const withoutInstallation: PullRequestEvent = { ...withInstallation, installation: undefined }
    await syncPullRequestLinks(pool, withoutInstallation, workspaceId)
    const afterSecond = await getLinksForIssue(pool, issueId)
    expect(afterSecond[0]?.installationId).toBe('42424242')
  })

  it('links to multiple issues when the PR body references more than one', async () => {
    const secondMax = await pool.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number FROM documents WHERE workspace_id = $1`,
      [workspaceId]
    )
    const secondTicketNumber = requireRow(secondMax.rows).next_number
    const secondIssue = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number)
       VALUES ($1, 'issue', 'Second issue', $2, $3) RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'backlog', priority: 'medium' }), secondTicketNumber]
    )
    const secondIssueId = secondIssue.rows[0].id

    const event = pullRequestEvent({
      number: 900,
      html_url: 'https://github.com/acme/widgets/pull/900',
      title: 'multi-issue PR',
      body: `Closes Ship#${ticketNumber} and Ship#${secondTicketNumber}`,
    })
    const result = await syncPullRequestLinks(pool, event, workspaceId)
    expect(new Set(result.linkedIssueIds)).toEqual(new Set([issueId, secondIssueId]))
  })
})
