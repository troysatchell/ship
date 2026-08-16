/**
 * GitHub App webhook payload schemas (PF-804 / TRO-453) — the subset of two documented event
 * types this receiver acts on: `pull_request`
 * (https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) and
 * `issue_comment`
 * (https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment).
 *
 * Hand-built against GitHub's documented JSON shape (no live GitHub App exists to record a real
 * delivery against — see this package's README "What's built vs. what a human still needs to
 * do"). Deliberately narrow: only the fields the sync logic below actually reads, not a full
 * mirror of GitHub's payload (which is large and mostly irrelevant here) — same "only what the
 * code reads" scoping `integrations/slack/src/eventEnvelope.ts` uses for Ship's own webhook
 * envelope.
 *
 * `.passthrough()` on every object schema: GitHub's payloads carry many more fields than this
 * file models, and `zod`'s default `.strict()`-adjacent behavior for `z.object()` already allows
 * unknown keys, but `.passthrough()` states that intentionally rather than leaving it implicit —
 * a schema here rejecting a real GitHub payload for containing a field this file didn't happen to
 * enumerate would be a self-inflicted receiver outage.
 */

import { z } from 'zod'

const RepositorySchema = z
  .object({
    name: z.string(),
    owner: z.object({ login: z.string() }).passthrough(),
  })
  .passthrough()

const InstallationSchema = z.object({ id: z.number().int() }).passthrough()

const PullRequestSchema = z
  .object({
    number: z.number().int(),
    html_url: z.string(),
    title: z.string(),
    // GitHub allows a null body (no description entered) — never omitted.
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    merged: z.boolean(),
    head: z.object({ ref: z.string() }).passthrough(),
  })
  .passthrough()

/**
 * The four `pull_request` actions this receiver cares about (PLUGFORGE.MD's "PR opened/updated" —
 * GitHub's own vocabulary splits "updated" into several distinct actions). Any other action
 * (`labeled`, `review_requested`, ...) parses successfully (the schema doesn't reject it) but
 * `githubWebhook.ts`'s route treats it as a verified no-op, same as
 * `integrations/slack/src/eventEnvelope.ts`'s `parseHandledEvent` returning `null` for an
 * unhandled Ship event type.
 */
export const PULL_REQUEST_HANDLED_ACTIONS = ['opened', 'edited', 'synchronize', 'closed'] as const

export const PullRequestEventSchema = z
  .object({
    action: z.string(),
    number: z.number().int(),
    pull_request: PullRequestSchema,
    repository: RepositorySchema,
    installation: InstallationSchema.optional(),
  })
  .passthrough()

export type PullRequestEvent = z.infer<typeof PullRequestEventSchema>

const IssueCommentIssueSchema = z
  .object({
    number: z.number().int(),
    // GitHub's `issue_comment` event fires for comments on both issues AND
    // pull requests (a PR IS an issue in GitHub's data model) — `pull_request`
    // is present only in the latter case. This receiver only acts on PR
    // comments (a Ship-issue reference in a comment on an actual GitHub
    // issue has no PR to link), so this field's presence is the discriminator
    // `githubWebhook.ts` checks.
    pull_request: z.object({ html_url: z.string() }).passthrough().optional(),
    html_url: z.string(),
  })
  .passthrough()

export const IssueCommentEventSchema = z
  .object({
    action: z.string(),
    issue: IssueCommentIssueSchema,
    comment: z.object({ body: z.string() }).passthrough(),
    repository: RepositorySchema,
    installation: InstallationSchema.optional(),
  })
  .passthrough()

export type IssueCommentEvent = z.infer<typeof IssueCommentEventSchema>

/**
 * `Ship#<n>` reference convention (this ticket's own design decision — no prior convention
 * existed to match; documented in `README.md` as the human-facing contract). Case-insensitive,
 * word-bounded so `Ship#123` inside a longer token (`xShip#123`) does not falsely match.
 * `ticket_number` is a positive integer (`documents.ticket_number`, `INTEGER` — migration
 * 038) — `\d+` with no leading-zero handling needed since ticket numbers are assigned via
 * `MAX(ticket_number)+1`, never user-typed into the column.
 */
const ISSUE_REFERENCE_PATTERN = /\bship#(\d+)\b/gi

/**
 * Extracts every distinct `Ship#<n>` ticket-number reference from one or more text fields (a
 * PR's title + body, or a PR comment body), returning them as a de-duplicated array of numbers in
 * first-seen order. Case-insensitive; a text with no references returns `[]`, never `null` — a
 * PR/comment with no Ship reference is the normal case, not an error (same "absence is a plain
 * value, not a special case" shape `eventEnvelope.ts`'s `parseHandledEvent` returning `null`
 * follows, but this returns an array so callers never need a null-check before iterating).
 */
export function extractIssueReferences(...texts: Array<string | null | undefined>): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(ISSUE_REFERENCE_PATTERN)) {
      const ticketNumber = Number(match[1])
      if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) continue
      if (seen.has(ticketNumber)) continue
      seen.add(ticketNumber)
      result.push(ticketNumber)
    }
  }
  return result
}

/** Collapses GitHub's `state`/`merged` pair into this table's single `pr_state` column — see
 *  migration 052's header for why. */
export function derivePrState(pullRequest: Pick<PullRequestEvent['pull_request'], 'state' | 'merged'>): 'open' | 'closed' | 'merged' {
  if (pullRequest.state === 'open') return 'open'
  return pullRequest.merged ? 'merged' : 'closed'
}
