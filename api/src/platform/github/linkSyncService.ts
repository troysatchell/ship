/**
 * GitHub PR <-> Ship issue link sync (PF-804 / TRO-453).
 *
 * The Ship-side write path for the "GitHub -> Ship" direction: given a verified `pull_request`
 * webhook delivery, resolve every `Ship#<n>` reference in the PR's title+body
 * (`webhookPayloads.ts`'s `extractIssueReferences`) against `documents.ticket_number` in the one
 * workspace this GitHub App installation is configured for, and upsert one `github_pr_links` row
 * per (issue, PR) pair — see migration 052's header for the full design rationale (why this is a
 * first-party `api/src` module rather than a satellite `integrations/github` package, why one row
 * per pair rather than per PR).
 *
 * `pool` is injected (matches `deliverer.ts`/`eventBus.ts`'s own convention throughout
 * `platform/`) so tests run against the real test Postgres pool per this directory's established
 * convention (`deliverer.test.ts`'s own header: "asserting a row's status after a real SELECT is
 * a stronger proof than an in-memory double").
 */

import type { Pool } from 'pg'
import { extractIssueReferences, derivePrState, type PullRequestEvent } from './webhookPayloads.js'

export interface SyncResult {
  /** `documents.id` of every Ship issue this PR was linked/re-linked to. Empty when the PR's
   *  title+body contained no `Ship#<n>` reference matching an existing issue in the configured
   *  workspace — a normal, silent outcome, not an error. */
  linkedIssueIds: string[]
  /** Ticket numbers that were referenced but did not resolve to any issue in the configured
   *  workspace (typo, wrong workspace, or a since-deleted issue) — surfaced so the caller can log
   *  it, never thrown: a malformed reference in a PR description is the PR author's typo, not a
   *  reason to fail an otherwise-valid, signature-verified webhook delivery with a 4xx (GitHub
   *  would then stop retrying it, and there is nothing about retrying that would fix a typo).
   */
  unresolvedTicketNumbers: number[]
}

/**
 * Processes one verified `pull_request` delivery (`action` already filtered to
 * `PULL_REQUEST_HANDLED_ACTIONS` by the caller — see `githubWebhook.ts`).
 *
 * `workspaceId` is the single Ship workspace this GitHub App installation is configured for
 * (`GITHUB_SHIP_WORKSPACE_ID` — see migration 052's header for why one installation maps to
 * exactly one workspace in this ticket's scope).
 */
export async function syncPullRequestLinks(pool: Pool, event: PullRequestEvent, workspaceId: string): Promise<SyncResult> {
  const ticketNumbers = extractIssueReferences(event.pull_request.title, event.pull_request.body)

  const result: SyncResult = { linkedIssueIds: [], unresolvedTicketNumbers: [] }
  if (ticketNumbers.length === 0) return result

  const prState = derivePrState(event.pull_request)
  const repoOwner = event.repository.owner.login
  const repoName = event.repository.name
  const installationId = event.installation?.id ?? null

  for (const ticketNumber of ticketNumbers) {
    const issueRow = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE ticket_number = $1 AND workspace_id = $2 AND document_type = 'issue'`,
      [ticketNumber, workspaceId]
    )
    const issue = issueRow.rows[0]
    if (!issue) {
      result.unresolvedTicketNumbers.push(ticketNumber)
      continue
    }

    await pool.query(
      `INSERT INTO github_pr_links
         (issue_id, workspace_id, repo_owner, repo_name, pr_number, pr_url, pr_state, installation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (issue_id, repo_owner, repo_name, pr_number)
       DO UPDATE SET pr_state = EXCLUDED.pr_state, installation_id = EXCLUDED.installation_id, updated_at = now()`,
      [issue.id, workspaceId, repoOwner, repoName, event.pull_request.number, event.pull_request.html_url, prState, installationId]
    )
    result.linkedIssueIds.push(issue.id)
  }

  return result
}

/** Returns every `github_pr_links` row for a given Ship issue — the read path a future portal
 *  page/API endpoint would use to show "linked PRs" on an issue (not built by this ticket; see
 *  README "What's built vs. what's still needed"). Exported now so it has one real caller
 *  (`linkSyncService.test.ts`) proving the schema round-trips, rather than sitting untested until
 *  that future consumer lands. */
export async function getLinksForIssue(pool: Pool, issueId: string): Promise<
  Array<{ repoOwner: string; repoName: string; prNumber: number; prUrl: string; prState: string }>
> {
  const result = await pool.query<{ repo_owner: string; repo_name: string; pr_number: number; pr_url: string; pr_state: string }>(
    `SELECT repo_owner, repo_name, pr_number, pr_url, pr_state FROM github_pr_links WHERE issue_id = $1 ORDER BY created_at ASC`,
    [issueId]
  )
  return result.rows.map((row) => ({
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prState: row.pr_state,
  }))
}
