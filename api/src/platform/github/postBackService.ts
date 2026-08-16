/**
 * "Ship -> GitHub" post-back (PF-804 / TRO-453): given a Ship issue's status change and its
 * already-linked GitHub PRs (`linkSyncService.getLinksForIssue`), posts a comment on each linked
 * PR via GitHub's REST API — the PRD's "a Ship issue's status change posts a comment ... back via
 * the GitHub REST API" half of the sync contract.
 *
 * Comment-only, not label-change: GitHub labels are repo-defined (a label named e.g. `in-review`
 * may not exist on an arbitrary installed repo, and creating one on the caller's behalf is a
 * separate, higher-permission API call this ticket's time-box does not reach) — a comment always
 * succeeds against any repo the App has `pull_requests: write` on, which is exactly the
 * permission this integration's README tells the human installer to grant. Documented as scope,
 * not silently dropped: see README "What's built vs. what's still needed."
 */

import type { Pool } from 'pg'
import { getInstallationAccessToken, signAppJwt, type GithubAppCredentials } from './installationAuth.js'
import { getLinksForIssue } from './linkSyncService.js'

export interface IssueStatusChange {
  issueId: string
  state: string
  previousState: string
}

/**
 * Posts one comment per GitHub PR linked to `change.issueId`. Silently does nothing (returns 0)
 * if no PR is linked — this handler fires on EVERY `issue.status_changed` event workspace-wide
 * (see `wireGithubPostBack` below), and most issues will never have a linked PR; that is the
 * expected common case, not an error.
 *
 * One installation access token per call, per linked PR's own `installation_id` (a workspace can
 * in principle have PRs linked via different installations if the App was reinstalled — each
 * link row carries its own `installation_id` rather than assuming one for the whole workspace, so
 * this reads it per-row rather than caching a single token).
 *
 * Returns the count of PRs a comment was successfully posted to. A single PR's post failing
 * (GitHub unreachable, token exchange failing, the PR since deleted) is logged and skipped rather
 * than aborting the remaining PRs in the same batch — same "one bad item must not take the rest
 * of the batch down" reasoning `deliverer.ts`'s `enqueueEvent` applies per-subscription.
 */
/** Same rationale as `installationAuth.ts`'s `INSTALLATION_TOKEN_TIMEOUT_MS` — an unresponsive
 *  GitHub API must not hang the `issue.status_changed` handler processing the rest of `links`. */
const COMMENT_POST_TIMEOUT_MS = 10_000

export async function postStatusChangeComments(
  pool: Pool,
  credentials: GithubAppCredentials,
  change: IssueStatusChange,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const links = await getLinksForIssue(pool, change.issueId)
  let posted = 0

  for (const link of links) {
    try {
      const installationId = link.installationId
      if (!installationId) {
        console.error(
          `github post-back: link ${link.repoOwner}/${link.repoName}#${link.prNumber} has no installation_id — skipping`
        )
        continue
      }

      const appJwt = signAppJwt(credentials)
      const token = await getInstallationAccessToken(appJwt, installationId, fetchImpl)

      const body = `Ship issue status changed: **${change.previousState}** → **${change.state}**.`
      const response = await fetchImpl(
        `https://api.github.com/repos/${link.repoOwner}/${link.repoName}/issues/${link.prNumber}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(COMMENT_POST_TIMEOUT_MS),
        }
      )
      if (!response.ok) {
        const excerpt = await response.text().catch(() => '')
        console.error(
          `github post-back: comment POST to ${link.repoOwner}/${link.repoName}#${link.prNumber} failed: ${response.status} ${excerpt.slice(0, 500)}`
        )
        continue
      }
      posted++
    } catch (error) {
      console.error(
        `github post-back: failed to post status comment on ${link.repoOwner}/${link.repoName}#${link.prNumber}`,
        error
      )
    }
  }

  return posted
}
