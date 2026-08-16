# Ship GitHub App Integration (PF-804 / TRO-453)

**STRETCH, time-boxed to 1 day** (PLUGFORGE.MD §4). This ticket's investigate-tier scope was
"you decide the concrete design" — the design decisions below (first-party `api/src` module
rather than a satellite `integrations/github` package; the `Ship#<n>` reference convention;
comment-only post-back, no label sync) are this ticket's own calls, documented here and in
migration `052_github_pr_links.sql`'s header rather than handed down from the PRD.

## What's built (Ship-side code, tested against fixtures — no live GitHub App exists)

- **`GitHub -> Ship`**: `POST /api/github/webhook` (`api/src/routes/githubWebhook.ts`) verifies a
  GitHub App webhook delivery's `X-Hub-Signature-256` header (HMAC-SHA256,
  `platform/github/verifySignature.ts`), parses `pull_request` (opened/edited/synchronize/closed)
  and acknowledges `issue_comment` payloads, and — for `pull_request` — resolves every `Ship#<n>`
  reference in the PR's title/body against `documents.ticket_number` in one configured Ship
  workspace, upserting a `github_pr_links` row per (issue, PR) pair
  (`platform/github/linkSyncService.ts`).
- **`Ship -> GitHub`**: `platform/github/wirePostBack.ts` subscribes to Ship's own
  `issue.status_changed` event (the existing `IEventBus`/webhook-registry infrastructure PF-300/
  PF-304 already built — this is the "reuse the pipeline" the ticket asked to investigate: it
  reuses the EVENT side of that pipeline, not `deliverer.ts`'s generic-subscriber HTTP dispatch,
  which is the wrong shape for GitHub's per-endpoint REST API — see "Design decisions" below). On
  a status change, `platform/github/postBackService.ts` looks up any linked PRs
  (`getLinksForIssue`), exchanges the GitHub App's own credentials for a per-installation access
  token (`platform/github/installationAuth.ts` — real RS256 JWT signing + the real
  `POST /app/installations/{id}/access_tokens` exchange, GitHub's documented flow), and posts one
  comment per linked PR via `POST /repos/{owner}/{repo}/issues/{pr}/comments`.
- **Data model**: migration `052_github_pr_links.sql` — one row per (Ship issue, GitHub PR) pair.
- **Tests**: 36 tests across 6 files
  (`api/src/platform/github/__tests__/*`, `api/src/routes/githubWebhook.test.ts`) — real test
  Postgres for every DB-touching path (`linkSyncService`, the route, `postBackService`'s link
  lookups), a real generated RSA keypair verifying `signAppJwt`'s output is a genuine RS256
  signature (not a stub), and injected `fetchImpl` mocks for every outbound GitHub API call (no
  network access, no live GitHub App needed to run `pnpm --filter @ship/api test`).

## What a human still needs to do to make this live

This is the wall only a human can clear (per this ticket's own brief) — none of it can be done
from here:

1. **Register a real GitHub App** at <https://github.com/settings/apps/new>:
   - **Webhook**: enable, URL = `https://<ship-host>/api/github/webhook`, generate a secret ->
     this is `GITHUB_WEBHOOK_SECRET`.
   - **Permissions**: Repository permissions -> `Pull requests: Read & write` (read to receive
     `pull_request`/`issue_comment` events, write to post the status-change comment back),
     `Metadata: Read-only` (required baseline).
   - **Subscribe to events**: `Pull request`, `Issue comment`.
   - After creation, generate a **private key** (downloads a `.pem`) -> `GITHUB_APP_PRIVATE_KEY`
     (the raw PEM contents, newlines included — not a path, not base64-wrapped). Note the **App
     ID** shown on the app's settings page -> `GITHUB_APP_ID`.
2. **Install the App** on the target repo (or org) — this is what mints the `installation.id`
   every inbound webhook payload carries, and what `installationAuth.ts` exchanges for a token.
3. **Set four env vars** on the Ship API deployment (no Terraform variable exists for these yet —
   follow `terraform/render/variables.tf`'s existing pattern for the next PF-900 follow-up, the
   same way `secret_encryption_key`/`fleetgraph_oauth_client_secret` were added there):
   - `GITHUB_WEBHOOK_SECRET` — from step 1.
   - `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` — from step 1.
   - `GITHUB_SHIP_WORKSPACE_ID` — the Ship `workspaces.id` this installation's `Ship#<n>`
     references resolve against (one installation <-> one workspace, this ticket's scope — see
     migration 052's header). Find it via `SELECT id, name FROM workspaces;`.
   Until all of these are set, `index.ts` logs which half is missing and simply does not mount the
   route / wire the subscriber (fails partial, not total — same posture `routes/agent.ts`'s
   `AGENT_INTERNAL_SECRET` check and the `ship_app_fleetgraph` boot check already establish).
4. **Trigger and screenshot a real event** — open a PR whose title/body contains `Ship#<n>` for a
   real issue, confirm the link appears (a future consumer would read
   `linkSyncService.getLinksForIssue` — no portal UI for this was built in this time-box, see
   below), then change that issue's status in Ship and confirm the PR comment appears. Same class
   of gap `integrations/slack/README.md`'s own "Trigger an event" step discloses: this setup path
   is complete and accurate, capturing the screenshot is a step for whoever runs this live.

## What's explicitly NOT built (scoped out by the 1-day time-box, not silently dropped)

- **No portal/UI surface** showing an issue's linked PRs — `getLinksForIssue` exists and is
  tested, but nothing renders it. The natural next step (a small panel on the issue view) is a
  follow-up ticket, not part of this stretch scope.
- **No label sync**, comment-only post-back — see `postBackService.ts`'s own header for why
  (labels are repo-defined; creating one on the installer's behalf needs a permission and a design
  decision — "which label, created when" — this ticket's time-box didn't reach).
- **`issue_comment` events are acknowledged (200) but not acted on** — see `githubWebhook.ts`'s
  own comment on why: that event's payload doesn't carry the PR's title/body, only a comment body
  and the PR's `html_url`, and reference-extraction from arbitrary PR comments (as opposed to the
  PR's own title/body, the primary case) needs a slightly different resolution path this time-box
  didn't reach.
- **No Terraform variables** for the four new env vars (see step 3 above) — declared here as plain
  `process.env` reads, following this ticket's own instruction to read credentials from env vars
  "following this repo's existing pattern," but the IaC-first `terraform/render/variables.tf`
  declaration PF-900 established for every other platform secret is a follow-up, not done here.

## Design decisions (this ticket's own — investigate-tier, no prior precedent to follow verbatim)

- **First-party `api/src/platform/github/` module, not a satellite `integrations/github` package**
  (unlike PF-803's Slack integration). Migration `052_github_pr_links.sql`'s header has the full
  rationale: `integrations/*` packages may declare only `@ship/sdk` as a runtime dependency
  (`scripts/check-integration-deps.mjs`), which structurally forbids direct DB access — and this
  integration's core deliverable (persistent issue<->PR links, surviving separate webhook
  deliveries days apart) genuinely needs that.
- **`Ship#<n>` reference convention** (`webhookPayloads.ts`'s `extractIssueReferences`) — invented
  for this ticket; no prior convention existed in this repo to match. `n` is
  `documents.ticket_number` (the same number Ship's own UI shows as `#<n>` — see
  `api/src/routes/issues.ts`'s `display_id`), prefixed with `Ship` to disambiguate from GitHub's
  own `#<n>` PR/issue-number syntax in the same text.
- **One workspace per GitHub App installation** (`GITHUB_SHIP_WORKSPACE_ID`) — `ticket_number` is
  only unique per-workspace in Ship's schema, and a GitHub App installation is inherently
  per-repo/per-org, not multi-tenant across Ship workspaces — see migration 052's header.
- **"Reuse the webhook delivery pipeline"** (this ticket's own brief suggested investigating this)
  — investigated and NOT reused for the literal HTTP-dispatch leg: `deliverer.ts`'s
  `InMemoryWebhookDeliverer` POSTs a fixed, Ship-signed JSON envelope to one subscriber URL per
  `webhook_subscriptions` row — the right shape for "notify an external system something
  happened," but GitHub's REST API needs a specific endpoint path + Bearer auth + a
  GitHub-shaped JSON body per call, not a generic signed envelope. What IS reused is the *event*
  side of that pipeline — `IEventBus`/`issue.status_changed`, the same registry PF-300 built —
  which `wirePostBack.ts` subscribes to directly, exactly the pattern `wireDelivererToEventBus`
  already establishes for the Slack-adjacent case.
