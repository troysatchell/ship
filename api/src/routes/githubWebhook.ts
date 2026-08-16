/**
 * GitHub App webhook receiver (PF-804 / TRO-453) — the "GitHub -> Ship" direction.
 *
 * Structurally this is `integrations/slack/src/server.ts`'s exact receiver shape (verify raw-body
 * signature -> parse -> act -> 200/no-op/error), but as a mounted route inside `api/src`, not a
 * standalone satellite package — see migration 052's header for why (this receiver needs direct
 * DB access, which an `integrations/*` package cannot have).
 *
 * `express.raw()`, not `express.json()`, for the exact reason `integrations/slack/src/server.ts`
 * documents: `verifyGithubSignature`'s HMAC is computed over the exact bytes GitHub signed, and a
 * re-serialized JSON body is not guaranteed byte-identical (key order, whitespace). Wired at
 * `app.ts`'s body-parser section, BEFORE the global `express.json()` call — see that file's own
 * comment at the mount point for why order matters here.
 *
 * No `conditionalCsrf`, no session auth: GitHub is an external system, not a Ship browser
 * session — the signature check IS this route's auth, the same way every other webhook
 * receiver in this codebase (and `integrations/slack`) has no CSRF/session layer either.
 *
 * Not registered with OpenAPI / no `ApiError` failure shape / no cursor pagination: this repo's
 * "every new public route" rule (`.claude/CLAUDE.md`, PF-203's fitness walk) targets `/api/v1/*`,
 * Ship's public developer-facing API surface. This route is the opposite direction — a fixed
 * integration endpoint GitHub calls, never a third-party Ship API consumer — the same
 * distinction `integrations/slack/src/server.ts`'s receiver already makes (also outside `/api/v1`,
 * also plain `res.status(...).json({...})` rather than the `ApiError` contract).
 */

import { Router, type Request, type Response } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { pool } from '../db/client.js'
import { verifyGithubSignature } from '../platform/github/verifySignature.js'
import {
  PullRequestEventSchema,
  IssueCommentEventSchema,
  PULL_REQUEST_HANDLED_ACTIONS,
} from '../platform/github/webhookPayloads.js'
import { syncPullRequestLinks } from '../platform/github/linkSyncService.js'

/** Same rationale and default as `integrations/slack/src/server.ts`'s `webhookRateLimiter`
 *  (CodeQL `js/missing-rate-limiting` — a route performing signature verification without a rate
 *  limit invites brute-force/volumetric abuse against the verification step itself). GitHub's own
 *  redelivery behavior is comparably infrequent, so the same 100 req/min default is generous for
 *  legitimate traffic while still bounding a single source hammering the endpoint. */
const DEFAULT_RATE_LIMIT_MAX = 100

function githubWebhookRateLimiter(max: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
  })
}

export interface CreateGithubWebhookRouterOptions {
  /** `GITHUB_WEBHOOK_SECRET` — required. A route constructed without one refuses every request
   *  (401) rather than silently accepting unsigned/unverifiable deliveries; see `app.ts`'s mount
   *  site for how a missing env var is handled at boot (same "fail closed, log loudly" shape
   *  `agent.ts`'s `AGENT_INTERNAL_SECRET` check uses). */
  webhookSecret: string
  /** The single Ship workspace this GitHub App installation is configured for — see migration
   *  052's header for why one installation maps to exactly one workspace in this ticket's scope. */
  shipWorkspaceId: string
  rateLimitMax?: number
}

export function createGithubWebhookRouter(options: CreateGithubWebhookRouterOptions): Router {
  const router = Router()

  router.post(
    '/webhook',
    githubWebhookRateLimiter(options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX),
    async (req: Request, res: Response) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')

      if (!verifyGithubSignature(req.headers, rawBody, options.webhookSecret)) {
        res.status(401).json({ error: 'invalid_signature' })
        return
      }

      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'))
      } catch {
        res.status(400).json({ error: 'invalid_json' })
        return
      }

      // GitHub identifies the event TYPE via a header, not a payload field (unlike Ship's own
      // envelope, which self-describes via `type`) — `X-GitHub-Event`.
      const eventName = req.headers['x-github-event']
      if (typeof eventName !== 'string') {
        res.status(400).json({ error: 'missing_event_header' })
        return
      }

      if (eventName === 'pull_request') {
        const parsed = PullRequestEventSchema.safeParse(parsedBody)
        if (!parsed.success) {
          // Verified (signature checks out) but not the shape this route expects — GitHub sends
          // many pull_request sub-payloads over time; a genuine schema drift is a config problem
          // to fix, not a caller error to reject with a 4xx GitHub would stop retrying.
          console.error('github webhook: pull_request payload failed schema validation', parsed.error)
          res.status(200).json({ status: 'ignored' })
          return
        }
        if (!PULL_REQUEST_HANDLED_ACTIONS.includes(parsed.data.action as (typeof PULL_REQUEST_HANDLED_ACTIONS)[number])) {
          res.status(200).json({ status: 'ignored' })
          return
        }

        const result = await syncPullRequestLinks(pool, parsed.data, options.shipWorkspaceId)
        if (result.unresolvedTicketNumbers.length > 0) {
          console.error(
            `github webhook: PR ${parsed.data.repository.owner.login}/${parsed.data.repository.name}#${parsed.data.pull_request.number} referenced unresolved Ship#<n> ticket number(s): ${result.unresolvedTicketNumbers.join(', ')}`
          )
        }
        res.status(200).json({ status: 'synced', linkedIssueIds: result.linkedIssueIds })
        return
      }

      if (eventName === 'issue_comment') {
        const parsed = IssueCommentEventSchema.safeParse(parsedBody)
        if (!parsed.success) {
          console.error('github webhook: issue_comment payload failed schema validation', parsed.error)
          res.status(200).json({ status: 'ignored' })
          return
        }
        // Only comments on an actual pull request carry a PR to link — see
        // `webhookPayloads.ts`'s own comment on `IssueCommentIssueSchema.pull_request`.
        if (parsed.data.action !== 'created' || !parsed.data.issue.pull_request) {
          res.status(200).json({ status: 'ignored' })
          return
        }

        // issue_comment's payload doesn't carry the PR's own title/body/state/merged fields (only
        // a `pull_request.html_url`) — extracting a reference from the COMMENT text and resolving
        // it against `documents.ticket_number` uses the same lookup `syncPullRequestLinks` does,
        // but this event's shape doesn't map onto that function's `PullRequestEvent` input without
        // fabricating fields GitHub didn't send. Scoped out of this ticket's time-box: see
        // README "What's built vs. what's still needed" — `pull_request` (opened/edited) already
        // covers the primary "PR references a Ship issue" case, since a PR's own title/body is
        // the far more common place a reference lives.
        res.status(200).json({ status: 'ignored' })
        return
      }

      // Any other verified GitHub event type this receiver doesn't act on — a silent no-op, same
      // reasoning as `integrations/slack/src/eventEnvelope.ts`'s `parseHandledEvent` returning
      // `null`: still 200s so GitHub's own redelivery logic doesn't retry a delivery type that was
      // never going to be handled differently.
      res.status(200).json({ status: 'ignored' })
    }
  )

  return router
}
