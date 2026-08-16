-- Migration 053: github_pr_links (PF-804 / TRO-453)
--
-- Originally written as 052 (the next free slot when this ticket started);
-- renumbered to 053 during merge-forward after `main` landed
-- 052_documents_workspace_type_created_at_index.sql first — same renumbering
-- situation 047/048's own headers document for PF-302/PF-304 (two branches
-- claiming the same next-available number is expected in a fast-moving
-- multi-session sprint, not a mistake to avoid, just one to resolve on merge).
--
-- STRETCH, time-boxed ticket (PLUGFORGE.MD §4: "Attempt only after PF-800-803
-- are gated ... time-box 1 day, then stop and report regardless of state").
-- This table is the "data model linking a Ship issue to a GitHub PR" the
-- ticket text asks for.
--
-- Design decision (documented here since this ticket is investigate-tier —
-- "you decide the concrete design"): this table lives in Ship's own database
-- (api/src/db), NOT inside a satellite `integrations/github` package the way
-- PF-803's Slack integration is structured. `integrations/*` packages may
-- declare only `@ship/sdk` as a runtime dependency
-- (`scripts/check-integration-deps.mjs`, PF-003) — no direct DB access is
-- possible from there by construction. Slack's integration works as a
-- satellite because it holds no state of its own (every inbound Ship webhook
-- is stateless-translated straight into one Slack API call). A GitHub
-- issue<->PR link is genuinely persistent Ship-side state that must survive
-- across separate webhook deliveries (a PR is opened, then later merged —
-- two different deliveries, days apart, that must resolve to the same row),
-- so it is modeled as a first-party feature instead, the same way
-- `webhook_subscriptions`/`oauth_apps` are first-party rather than satellite
-- packages.
--
-- One row per (issue, PR) pair — deliberately NOT one row per PR: a single
-- PR's title/body can reference more than one Ship issue (see
-- `api/src/platform/github/extractIssueReferences.ts`), and a single Ship
-- issue can legitimately be worked across more than one PR (a revert, a
-- follow-up). The UNIQUE constraint is therefore on the full
-- (issue_id, repo_owner, repo_name, pr_number) tuple, not on the PR alone.
--
-- `ticket_number`-based reference convention: GitHub has no knowledge of
-- Ship's UUIDs, so a PR references a Ship issue by writing `Ship#<n>` in its
-- title/body (`n` matching `documents.ticket_number`, migration 038's
-- indexed column) — see `extractIssueReferences.ts`'s own header for the
-- exact regex and `platform/github/README.md` for the human-facing
-- convention writeup. `ticket_number` is only unique PER WORKSPACE
-- (`api/src/routes/issues.ts`'s `MAX(ticket_number)+1` scoping), so resolving
-- a `Ship#<n>` reference to one `documents.id` requires knowing which
-- workspace the receiving GitHub App installation maps to — this ticket
-- assumes one GitHub App installation <-> one Ship workspace (the
-- `GITHUB_SHIP_WORKSPACE_ID` env var — see `platform/github/README.md`),
-- consistent with the PRD's "webhook + GitHub App" framing (a GitHub App is
-- installed per-repo/per-org, not multi-tenant across Ship workspaces).
--
-- `installation_id` is nullable and captured from the inbound webhook
-- payload (`installation.id`, present on every GitHub App webhook delivery)
-- — it is what a future outbound call (posting a status comment back)
-- exchanges for a short-lived installation access token via
-- `platform/github/installationAuth.ts`. Nullable because a row could in
-- principle be created by a path that doesn't have it (none exists yet in
-- this ticket's code, but the column should not force a fabricated value).

CREATE TABLE IF NOT EXISTS github_pr_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  -- Mirrors GitHub's own pull_request.state values plus the synthetic
  -- 'merged' this table distinguishes explicitly (GitHub represents "merged"
  -- as state='closed' + merged=true on the wire, not a third state string —
  -- collapsing that here means a caller never has to re-derive it from two
  -- fields).
  pr_state TEXT NOT NULL DEFAULT 'open' CHECK (pr_state IN ('open', 'closed', 'merged')),
  installation_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, repo_owner, repo_name, pr_number)
);

-- The lookup direction `linkSyncService.ts` actually queries: "given this
-- repo+PR, which link rows (if any) already exist" — upsert-on-delivery reads
-- by this tuple, not by issue_id.
CREATE INDEX IF NOT EXISTS idx_github_pr_links_repo_pr
  ON github_pr_links (repo_owner, repo_name, pr_number);

CREATE INDEX IF NOT EXISTS idx_github_pr_links_workspace
  ON github_pr_links (workspace_id);

-- `getLinksForIssue`'s own query: `WHERE issue_id = $1 ORDER BY created_at
-- ASC`. The UNIQUE constraint above already gives `issue_id` an indexed
-- equality lookup (it's the leading column), but not the ORDER BY —
-- Postgres would still sort the matched rows separately. This composite
-- index covers both the filter and the sort in one index scan.
CREATE INDEX IF NOT EXISTS idx_github_pr_links_issue_created
  ON github_pr_links (issue_id, created_at);
