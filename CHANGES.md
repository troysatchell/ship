# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

**The `audit-baseline` tag.** Points at `149873a` — verified with `git rev-list -n1 audit-baseline`
and confirmed as the commit immediately before Phase 2 fixes started landing (it is `bace770`'s
first parent per `git show bace770 --stat`, and `bace770` is TRO-242 below, the first Phase 2 merge).
It marks the Phase 1 (audit-only) state so it stays a fixed reference once Phase 2 starts changing
the source it measured. Every category audit skill's "compare mode" (`/<category>-audit compare
<label>`) re-measures against this tag under identical conditions to prove a fix's effect —
documented in `.claude/skills/ship-factory/references/evals.md`; this file's own entries lean on it
directly (see TRO-174's compression note further down, which warns that a compare-mode run against
`audit-baseline` looks flat or worse over loopback for a fix that is real). Not itself a ticket, so
it has no rollback entry of its own — `git tag -d audit-baseline` removes the **local** tag, which
leaves compare mode with no fixed reference point; a tag already pushed also needs
`git push origin :refs/tags/audit-baseline` to remove it from the remote.

---

## TRO-341 — [FG-23] The graded demo's environment — topology named, deploy gap found, 403 root-caused, real token minted

**What was missing.** Nobody owned the environment the grader actually touches. FG-3 (TRO-314)
seeds a local scratch database; FG-11 (TRO-316)'s scope was the agent service alone. Nothing named
which Ship the deployed agent points at, whether merged code actually reaches it, or how FG-3's
fixture states get into that database rather than a developer's local one.

**Topology — settled, matching this ticket's own recommendation, no deviation.** Ship-on-Render
(`ship-rr6m.onrender.com`) + agent-on-Render (`ship-agent-t0zy.onrender.com`, current URL) + the
Render Postgres `ship-db` as the graded database. No AWS credentials have existed in this
environment all sprint (re-verified: no `aws` CLI, no `AWS_*` env vars), so there was never a
competing option to weigh.

**Finding #1 — the live `ship` service has not redeployed since 2026-07-30, despite `auto_deploy`
being correctly configured for `main`.** PR-A (merged `2f198f6`, 2026-08-03 20:07 EDT) and PR-B
(merged `0db1fd0`, 2026-08-03 21:54 EDT) are both on `main`; neither has reached
`ship-rr6m.onrender.com`. Verified three ways, not inferred from one: Render's own
`/deploys`/`/events` API shows the last successful deploy at `2026-07-30T22:00:22Z` (commit
`09a6895a`) and zero deploy events since; the live `GET /`'s `last-modified` header matches that
same date; `GET /api/change-feed` (a PR-A route) returns a bare `404`, not an auth error — the code
isn't running, not merely unreachable. `GET /v1/services/{id}` confirms `autoDeploy: yes,
branch: main` — the config is right, the trigger isn't firing. Root cause not fully diagnosed
(`gh api repos/troysatchell/ship/hooks` returns `[]`, suggestive but not conclusive since Render
commonly integrates via a GitHub App rather than a classic webhook, and this session's `gh` token
can't list App installations). **Remediation is a single Render API call
(`POST /v1/services/{id}/deploys`) — not run by this ticket**, flagged for the orchestrator; see
FLEETGRAPH.MD "Deployment model" for the exact command and how to confirm it worked.

**Finding #2 — the reported login `403 Forbidden` root-caused: application CSRF protection, not a
WAF.** Two prior curl attempts against `POST /api/auth/login` returned a platform-looking `403`
(generic HTML, `ratelimit-*` headers, `server: cloudflare`). Traced to source: `ratelimit-*` is
`loginLimiter`'s own headers (`api/src/app.ts:88-101`); `app.use('/api/auth', conditionalCsrf,
authRoutes)` (`app.ts:371`) applies CSRF sync protection to login itself for any non-`Bearer`
request, and an uncaught `csrf-sync` rejection falls through to Express's default `finalhandler` —
that's where the generic `<pre>Forbidden</pre>` body comes from. Cloudflare/Render headers are
present on every response from this host, 200 or 403 alike (verified) — infrastructure, not the
actor. Proven by fixing it: `GET /api/csrf-token` (cookie) → `POST /api/auth/login` (that cookie +
`x-csrf-token`) → `200`, real `dev@ship.local` session. No code change — this is expected CSRF
behavior working as designed against a client that skips the handshake, not a bug.

**A real per-user API token was minted** through that session (`POST /api/api-tokens`, name
`fleetgraph-agent-tro-341`, no expiry) and verified working via `Authorization: Bearer` against
both a plain route and a `conditionalCsrf`-guarded one. The raw value is not in this repo's history:
it lives in a gitignored `terraform/render/terraform.tfvars` in the FG-23 worktree, staged for a
human to fold into the real `terraform.tfvars` and apply — not applied by this ticket.

**What changed.** `FLEETGRAPH.MD` "Deployment model" — topology named explicitly; the stale
"`terraform apply` ... pending" language corrected to reflect TRO-316's now-completed
destroy-and-redeploy proof; two new subsections ("Confirmed: which branch Render deploys, and
whether merged code actually reaches it" and "Login and the 403") plus a full seeding-plan
subsection with exact, not-yet-run commands for getting FG-3's fixture states into `ship-db`
(temporary `ipAllowList` PATCH, `NODE_ENV=production` requirement, `pnpm db:migrate && pnpm
db:seed`, and where the resulting Test Case document ids get recorded).

**Deliberately NOT done, per this ticket's own stop conditions (live production/graded
infrastructure, explicit human sign-off required):**
- `pnpm db:seed` was not run against `ship-db` — the fixture states described in FLEETGRAPH.MD's
  Test Cases table are not yet in the graded database, and its `Trace Link` column still reads
  `Pending`, honestly, because they still are.
- `terraform apply` was not run — the real `ship_api_token` is minted and staged, not wired into
  the live agent's environment.
- The redeploy of `ship` (Finding #1's remediation) was not triggered — PR-A/PR-D are on `main` but
  not yet live.

**How to run it.** Nothing to run — this ticket's committed change is documentation
(`FLEETGRAPH.MD`) plus this entry. The three deliberately-undone actions above are each a single
command, captured in full in FLEETGRAPH.MD's "Deployment model", ready for the orchestrator to run
or explicitly bless.

**How to roll it back.** Revert this commit — it only touches `FLEETGRAPH.MD` and `CHANGES.md`, no
application or infrastructure code. The minted API token is a live side effect independent of git:
revoking it is `DELETE /api/api-tokens/{id}` against `ship-rr6m.onrender.com` (token id
`54a7fb2d-94f3-4619-8c93-8fa7512d059b`), or via the admin UI, if the token should not be used going
forward.

---

## TRO-316 — [FG-11] Terraform for the agent service — Render docker web service, `/health` health-check-gated deploy, plan captured and annotated

**Part of bundle `TRO-326` ([PR-B] EPIC: Agent service foundation) — third and final sub-issue** on
this branch, after `TRO-313` (FG-2) and `TRO-315` (FG-4). See those entries below for the rest of
the bundle.

**What was missing.** No deployment existed for the agent service FG-2/FG-4 built. The MVP
requires it "deployed and publicly accessible via Terraform" with `/health`/`/ready`, a captured
and annotated `terraform plan`, and (separately, not in this PR — see below) a destroy-and-redeploy
proof.

**Target platform decision: Render, not AWS — decided out loud, not silently.** This ticket's own
text says "Choose the target platform accordingly; do not assume an AWS apply will work." Verified
again while doing this work: no `aws` CLI installed, no `AWS_*` env vars, matching
`memory-bank/activeContext.md`'s standing note that no AWS credentials have existed all sprint.
`memory-bank/activeContext.md`'s PM review (2026-08-03, TRO-341) independently names the same
target ("Render Ship + agent + seeded Render Postgres"). Extended the existing, already-provably-
plannable `terraform/render/` root (TF-10 / TRO-299) with a new `agent_service.tf`, rather than the
large AWS root in `terraform/` (which has never had a successful `plan` in this environment either)
or a second Terraform root.

**Deviation from the literal dispatch brief, disclosed:** told to model secrets on "the existing
`terraform/ssm.tf` / `.tfvars.example` pattern" — `ssm.tf` is AWS SSM Parameter Store, unusable by
non-AWS compute. Followed the same **discipline** (sensitive variables, no defaults, gitignored
`terraform.tfvars`, nothing committed) via Render's `env_vars` mechanism instead, which
`web_service.tf` already uses for `SESSION_SECRET` in this same root.

**What changed.**
- `terraform/render/agent_service.tf` (new) — `render_web_service.agent`: Render docker runtime
  pointed at `agent/Dockerfile` (also new — see below), `health_check_path = /health`,
  `SHIP_API_BASE_URL` derived from `render_web_service.ship.url` (never hardcoded), five more env
  vars for the model provider and LangSmith tracing, all sourced from sensitive input variables.
- `terraform/render/variables.tf` — 11 new variables for the agent service, all documented; the
  three secrets (`anthropic_api_key`, `langsmith_api_key`, `ship_api_token`) have no default.
- `terraform/render/outputs.tf` — `agent_service_url`/`agent_service_id`, non-sensitive only.
- `terraform/render/terraform.tfvars.example` — placeholders for the three new secrets plus
  commented overrides for the non-secret agent variables.
- `agent/Dockerfile` (new) — mirrors the root Dockerfile's build/runtime split (build stage
  compiles from source since `dist/`/`node_modules/` are gitignored; runtime stage carries only
  `agent/dist` + prod deps). **Built and run in this session, not just written**: `docker build -f
  agent/Dockerfile .` from the repo root succeeded; the resulting container served `GET /health` →
  `200 {"status":"ok"}` and `GET /ready` → `503 {"status":"not_ready","reason":"config_incomplete"}`
  with no config supplied — the exact FG-2/FG-4 contract, running inside the real image Render
  would build.
- `FLEETGRAPH.MD` "Deployment model" — the rollback trigger/procedure the brief requires documented:
  (1) CI gates *merge*, so a failing CI run never reaches the branch Render watches in the first
  place (`.github/workflows/ci.yml`'s own header: "the merge gate the ticket factory depends on");
  (2) Render's own health-check-gated deploy promotion is a **liveness** safety net, not a readiness
  one: `/health` (what `health_check_path` points at) returns 200 whenever the process is up, with
  no config or Ship-dependency check (`agent/src/server.ts`) — so it only catches a process that
  fails to boot or hangs, never a missing secret or an unreachable Ship. A new deploy that never
  passes `/health` never receives traffic, and the previous good deploy keeps serving; a deploy that
  boots fine but is missing `ANTHROPIC_API_KEY`/`SHIP_API_TOKEN`, or can't reach Ship, is still
  promoted and still receives traffic — `/ready` reports that as `503`, but `/ready` is deliberately
  NOT what Render's platform check points at (no separate readiness check is configured for that
  purpose), and it can also legitimately be false on a freshly-promoted, healthy instance if Ship is
  briefly down.

**`terraform plan` — captured and annotated in full: `terraform/render/plan/tro-316-agent-plan-annotated.md`.**
Two captures: (1) with `RENDER_API_KEY` unset (this environment's real, unmodified state) — fails
immediately with "Missing Render API Key," proving the provider requires a credential this agent
was not given (deliberately, matching the bundle's "no `terraform apply`" hard stop); (2) with a
non-empty placeholder key (still not a real credential) — the plan completes in full, "3 to add, 0
to change, 0 to destroy," because every resource here is a `create` against genuinely empty state
and nothing requires a live API round-trip merely to plan. Every secret-shaped value renders as
`(sensitive value)`. `terraform fmt -check -recursive .` clean; `terraform validate`: Success (2
pre-existing deprecation warnings, identical pattern already in `web_service.tf`, not new).

**Deliberately NOT done, per this bundle's hard stop (escalation gate #2 — irreversible/outward-
facing infrastructure, human confirmation required every time):** `terraform apply` was never run;
the destroy-and-redeploy proof was never attempted. See the annotated plan file's "What a human
needs to finish this" section for the exact remaining steps (a real `RENDER_API_KEY`, a decision on
the pre-existing `ship`/`ship-db` import-vs-create gap this root already carried before this
ticket, real secret values, and explicit sign-off to `apply`).

**How to run it.** `cd terraform/render && terraform init && terraform plan -var-file=terraform.tfvars`
(after copying `terraform.tfvars.example` and filling in real values, and exporting `RENDER_API_KEY`).
`docker build -f agent/Dockerfile -t ship-agent .` from the repo root to build the image standalone.

**How to roll it back.** Two different procedures, depending on whether `apply` has run.
- **Now (pre-apply, plan-only — this PR's actual state):** revert this commit. No resource here has
  ever been applied, so there is nothing live to tear down — reverting only removes the Terraform
  config and the Dockerfile.
- **After a human runs `terraform apply` (not done in this PR):** reverting the commit alone does
  NOT remove the live Render service — git history and live infrastructure are independent once
  `apply` has run. Removing `render_web_service.agent` for real requires a subsequent `terraform
  plan`/`apply` (either after reverting `agent_service.tf` in a new commit, or via `terraform destroy
  -target=render_web_service.agent`) so Terraform actually issues the delete against Render's API.
  Until that apply runs, the service — and its billing — stays live regardless of what git shows.
  This is exactly the kind of irreversible, outward-facing infrastructure action this bundle's
  escalation gate #2 requires explicit human confirmation for, the same as the original `apply`.
  If the intent is to restore a prior good deploy rather than delete the resource entirely, that is
  a Render-side deploy rollback, not a Terraform one — Terraform manages the resource's existence
  and config, not its deploy history.

---

## TRO-315 — [FG-4] Resilient client for every outbound call — timeouts, backoff, circuit breaker, self-throttle, graceful degradation

**What was missing.** FG-2 (TRO-313)'s `/ready` check used a bare `fetch` with a timeout — correct
for that ticket's narrower scope, but it retried nothing, remembered nothing across polls, and had
no notion of Ship's own rate limits. The brief's Engineering Requirements are graded alongside the
agent: outbound calls need explicit timeouts and retry with exponential backoff, and the agent must
degrade gracefully (no crash, no indefinite hang) if Ship is unreachable. FLEETGRAPH.MD also
verifies both of Ship's own rate limiters fail OPEN on a cache outage — the agent cannot lean on
Ship's ceiling as a safety net and must throttle itself below it.

**What changed.** A single client layer, `agent/src/resilientClient.ts`, used by every outbound
call this package makes:
- `agent/src/circuitBreaker.ts` — copied, not reinvented, from `api/src/utils/circuitBreaker.ts`
  (TRO-311 / RULE-7) **starting from its fixed version** (`273f058`): the first version had a real
  half-open concurrency race (a second concurrent call arriving while a trial call's `await fn()`
  was in flight fell through the `state === 'open'` check and called `fn()` itself). `agent/` does
  not depend on `api/`, so this is a deliberate duplication of a verified-correct ~100-line class,
  with the corresponding regression test carried over unchanged (TRO-315's own proof #3 names this
  exact race).
- `agent/src/rateLimiter.ts` — a sliding-window self-throttle (`RateLimiter`), default 500 req/min,
  configurable via `SHIP_SELF_THROTTLE_RPM` — well under Ship's shared ~6,000 req/min per-IP ceiling.
- `agent/src/resilientClient.ts` — `ResilientClient.get()` (idempotent reads: timeout, retry with
  exponential backoff + full jitter, circuit breaker, self-throttle) and `.request()` (non-idempotent:
  timeout + breaker, no retry). Design point: the breaker wraps each individual HTTP attempt, not
  the whole retry sequence — so a call that retries into an already-tripped breaker fails fast
  instead of backing off pointlessly. Every failure mode normalizes to `ShipUnreachableError`
  ("I can't reach Ship right now.") — the plain, user-safe message the degradation contract requires;
  no raw stack trace or error type leaks past this layer.
- `agent/src/health.ts` / `server.ts` — `/ready` now goes through a `ResilientClient` built once per
  server (`buildShipClient`) and reused across every poll, so the breaker's state — the whole point
  of a breaker — actually persists between requests instead of being rebuilt fresh each time.
- `agent/src/config.ts` — four new env-driven knobs: `SHIP_BREAKER_FAILURE_THRESHOLD` (default 5),
  `SHIP_BREAKER_COOLDOWN_MS` (30000), `SHIP_RETRY_MAX_ATTEMPTS` (3), `SHIP_SELF_THROTTLE_RPM` (500).

**Regression tests — stable fakes only, timers/sleep/clock all injected, zero real wait (40 total
cases across the package now; 23 new/changed for this ticket).** Confirmed red for the right reason
before the corresponding implementation line (see PR body for transcripts):
- `agent/src/__tests__/resilientClient.test.ts` (9 cases) — the four proofs named in the ticket:
  (1) Ship returning 503 → 3 attempts with growing delays (100ms, 200ms, no jitter), breaker opens
  on the 3rd consecutive failure, caller gets `ShipUnreachableError` with the plain message — process
  never throws uncaught; (2) a fetch that never resolves → the call rejects at exactly the configured
  timeout bound (a fake `setTimeoutImpl` proves the exact ms scheduled and fires it deterministically
  — no real elapsed time); (3) half-open admits exactly one concurrent trial (a gated fetch proves it
  is still in flight when concurrent callers arrive; they get `CircuitOpenError`→`ShipUnreachableError`
  without ever reaching `fetch`); (4) a successful call after the cooldown closes the breaker and the
  next call needs no retry. Plus: self-throttle rejects over-ceiling calls without ever reaching
  fetch; `.request()` never retries.
- `agent/src/__tests__/circuitBreaker.test.ts` (10 cases) — carried over from TRO-311's file
  verbatim in substance, including the half-open concurrency regression.
- `agent/src/__tests__/rateLimiter.test.ts` (4 cases) — ceiling enforcement, rejected calls not
  counted, sliding-window expiry.
- `agent/src/__tests__/health.test.ts` / `server.test.ts` — rewritten against the new
  `ShipReadClient` interface; added a case proving the same client (and breaker) instance is reused
  across three `/ready` polls, not rebuilt per request.

**How to run it.** `pnpm --filter @ship/agent test`

**How to roll it back.** Revert this commit. `health.ts`/`server.ts` fall back to FG-2's bare-fetch
`/ready` check (still correct, just without retry/breaker/throttle); nothing outside `agent/` is
affected.

---

## TRO-313 — [FG-2] There is no agent service — new `agent/` package, LangGraph + LangSmith, `/health` + `/ready`

**What was missing.** No agent service existed at all: `pnpm-workspace.yaml` listed only `api`,
`web`, `shared`; no `langgraph`/`langsmith`/`@langchain/*`/`@anthropic-ai/sdk` dependency existed
anywhere; the only model access in the repo was AWS Bedrock (`api/src/services/ai-analysis.ts`),
and this environment has never had AWS credentials this sprint. Six MVP requirements (graph
running, LangSmith traces, HITL gate, real Ship data, UI surfaces, Terraform deploy) all assume a
service that did not exist.

**Model provider decision (the "one decision still open" in this ticket): Anthropic API directly**,
via `@langchain/anthropic` — not Bedrock. Confirmed by the maintainer 2026-08-03. Reasons: no AWS
credentials have existed in this environment all sprint (so Bedrock cannot be assumed to work
locally or in whatever deploy target FG-11 lands on), and the brief's "Claude API costs" accounting
matches billing through the Anthropic API directly, not Bedrock's per-inference-profile pricing.

**What changed.** New `agent/` workspace package (added to `pnpm-workspace.yaml`, matching
build/type-check/lint/test scripts to the sibling packages):
- `agent/src/graph.ts` — a compiled LangGraph `StateGraph` (`ingest` → `respond`, `START`/`END`).
  Phase 2 (the six-use-case node design — FLEETGRAPH.MD "Node design rationale", marked Pending) is
  explicitly out of scope for this ticket; this proves a real, compiled, traced graph exists. The
  model is injected (`AnthropicModel` interface — just `.invoke(input)`), so every automated test
  uses a stable fake and the production wiring (`index.ts`) is the only place a real `ChatAnthropic`
  is constructed.
- `agent/src/server.ts` + `index.ts` — Express app: `GET /health` (200 always, process alive, no
  dependency check — this is what Terraform/FG-11 points its platform health check at) and
  `GET /ready` (503 if config is incomplete OR Ship is unreachable via a single timed fetch; 200
  otherwise). `/ready`'s Ship check is deliberately a bare `fetch` with a timeout here, not the full
  resilient client — FG-4 (TRO-315) is the ticket that gives every outbound call retry/backoff/
  circuit-breaker treatment; doing that here would be doing FG-4's work under FG-2's ticket.
- `agent/src/config.ts` — env-only config, no secrets hardcoded, no defaults on secrets.
- `agent/.env.example` — documents every var, including the FG-4 client knobs that don't exist yet
  (so the file doesn't need a second pass when FG-4 lands).
- `agent/src/scripts/trace-invoke.ts` — a one-off manual utility (NOT a test, not run by `pnpm
  test`) that makes the one real, live call this ticket's proof requires.

**LangSmith trace — real invocation, captured via the LangSmith API, not the console:**
- Trace: `https://smith.langchain.com/o/827be0c8-ee40-4854-9d37-e82820ec9263/projects/p/c1e38b67-b458-4e8b-a680-be74ece5e1a6/r/a43f52ee-ea08-459d-bfa2-ece414797759`
- Project `fleetgraph-agent`, run type `chain`, status `success`, 9 child runs (the graph's own
  node/model spans), 71 total tokens (33 prompt / 38 completion), $0.000223 total cost — all read
  directly from `GET /runs/{id}` on the LangSmith API (`total_tokens`/`total_cost`/`child_run_ids`
  fields), not estimated.
- Model used for the trace: `claude-haiku-4-5-20251001` — the cheapest model available to this API
  key (confirmed via `GET /v1/models`; `claude-3-5-haiku-latest` 404s against this key's model
  list, so the first attempt is also on record as an **error** trace in the same LangSmith project).

**Regression tests (stable fake — no live call in any of these; `pnpm test` never spends money or
depends on network availability).** All confirmed red for the right reason before the corresponding
implementation line, green after — see PR body for the exact before/after transcripts:
- `agent/src/__tests__/graph.test.ts` (4 cases) — the compiled graph's node set contains every name
  in `NODE_NAMES`; `ingest` trims input before `respond` ever sees it; array-shaped model content is
  joined into a string; a model rejection propagates rather than being swallowed.
- `agent/src/__tests__/health.test.ts` (4 cases) + `agent/src/__tests__/server.test.ts` (4 cases) —
  `/health` always 200; `/ready` 503 on incomplete config (no network call made) and on Ship
  unreachable, 200 once both are satisfied — exactly FG-2's "how it will be proven" clause.
- `agent/src/__tests__/config.test.ts` (5 cases) — defaults, full env read, non-numeric fallback.

**How to run it.** `pnpm --filter @ship/agent test` · `pnpm --filter @ship/agent dev` (serves on
`:3100` by default) · `set -a; source .env.local; set +a && pnpm --filter @ship/agent trace:invoke`
for a fresh live trace.

**How to roll it back.** Not independent of the other two tickets in this bundle. `TRO-315`
(`c1f8b09`) and `TRO-316` (`cbee4ae`) are later commits on this same branch that both consume the
`agent/` package this commit creates: TRO-315 adds `resilientClient.ts`/`circuitBreaker.ts`/
`rateLimiter.ts` into `agent/src/` and rewires `health.ts`/`server.ts`/`config.ts` to use them, and
TRO-316 adds `agent/Dockerfile` plus a Terraform plan (`terraform/render/agent_service.tf`,
un-applied) that builds and deploys the package this commit creates. Reverting *this* commit alone
while those two remain breaks the build — files they add or edit import things this commit created.
- **To fully undo the agent service:** revert newest-first — `cbee4ae` (TRO-316), then `c1f8b09`
  (TRO-315), then this commit — and only as the last step, once all three are gone, remove `'agent'`
  from `pnpm-workspace.yaml`. Doing that removal any earlier is the under-scoped version of this
  rollback and will break whichever of TRO-315/TRO-316 is still present.
- **To roll back only this ticket while TRO-315/TRO-316 stay:** not possible as a plain revert —
  both later commits depend on files this one adds. Re-implementing FG-2's narrower scope (a bare
  `fetch`-based `/ready`, no resilient client, no deploy) on top of what TRO-315/TRO-316 built would
  be a forward fix, not a revert.

---

## TRO-325 — [PR-A] EPIC: Ship-side API foundations (change feed, blocks relationship, fixtures)

Bundle epic, one branch (`feat/pr-a-ship-api-foundations`) / one PR covering four sub-issues that
ship together because they share a surface (`api/`, `shared/`, `db/`), not a root cause. Each
sub-issue has its own entry below (this file lists newest-first, so look for the ticket ID): TRO-312
[FG-1] change-feed endpoint, TRO-314 [FG-3] seed/fixture trigger-state work, TRO-332 [FG-14] cycle
protection on `document_associations` (landed first per the epic's stated internal order — cycle
protection must guard the new relationship before it exists), TRO-333 [FG-15] the `blocks`
relationship. See each sub-issue's own entry for what was broken, what changed, how to run/test it,
and how to roll it back individually.

**Rollback (whole bundle).** Revert the branch's merge commit, or cherry-pick-revert each
sub-issue's own commit individually — every sub-issue below is its own commit and its own change,
not one undifferentiated diff.

---

## TRO-332 — [FG-14] Cycle protection on `document_associations` (A-blocks-B-blocks-A was insertable)

**What was broken.** `document_associations` (`api/src/db/schema.sql:209-222`) had zero cycle
protection. `prevent_circular_parent()` (`schema.sql:165`) only guards the single-valued
`documents.parent_id` column; the junction table has no trigger, no depth cap, nothing. A caller
could `POST /api/documents/:id/associations` A→B and then B→A (or the equivalent for any
relationship_type) and both would succeed. That is latent in Ship today, independent of any agent
code — the moment anything walks the association graph outward (the existing `/:id/context`
ancestors CTE in `associations.ts`, and FleetGraph's planned traversal) it loops until something
times out or the heap runs out.

**What changed.** `api/src/db/migrations/040_prevent_circular_associations.sql` (new) adds
`prevent_circular_association()` + `prevent_circular_association_trigger`
(`BEFORE INSERT OR UPDATE ON document_associations`). Adapted from `prevent_circular_parent()` but
generalized to a visited-set BFS (not a linear walk) because this table is not single-valued — a
document can hold multiple outgoing edges of the same `relationship_type` (see
"Multi-parent associations" in `associations-regression.test.ts`), so the association graph can
fan out. Capped at 100 visited nodes so a pathological graph fails fast rather than hanging the
insert.

**Scope decision, recorded in the migration's own comment:** the cycle check is scoped **per
`relationship_type`**, not across all types combined. A `parent` cycle and a `blocks` cycle (landing
in TRO-333, migration 041) are different problems, and containment types are expected to legitimately
co-exist with a `blocks` edge in the reverse direction — checking across types would reject that
coexistence as a false-positive cycle.

**Concurrency caveat, also recorded in the migration comment (PM review 2026-08-03):** a `BEFORE`
trigger cannot guarantee acyclicity under concurrency — two edges that each close no cycle alone but
together form one can both commit, since neither transaction's walk sees the other's uncommitted
row. Not worth a `SERIALIZABLE` transaction or an advisory lock at this write volume (association
writes are low-frequency, interactive edits, not a hot path); this trigger guards the common case and
is explicitly not a proof of acyclicity. FG-7's future traversal must carry its own hard document cap
and its own visited-set regardless of what the database promises here.

**CodeRabbit triage: advisory-lock suggestion dismissed, not overlooked.** CodeRabbit flagged the
trigger's BFS as needing a transaction-scoped advisory lock to close the concurrent-insert race.
This is exactly the tradeoff the PM review already evaluated and declined two paragraphs above,
in the migration's own comment, before CodeRabbit ever saw the diff — applying the suggestion here
would silently reverse a recorded product decision, not fix an overlooked bug. Left as-is.

**Migration numbering note:** TRO-333's own ticket body names `040_add_blocks_relationship.sql` as
"the next free number." This ticket (TRO-332) landed first per the bundle epic's stated internal
order ("FG-14 before FG-15 — cycle protection guards the new relationship"), so it claims migration
040 and TRO-333's blocks migration is renumbered to 041. Recorded here explicitly since it deviates
from TRO-333's literal filename instruction — the deviation preserves the epic's own ordering
requirement rather than violating it silently.

**Regression test.** `api/src/routes/association-cycle-protection.test.ts` (new, 5 cases): confirms
the trigger actually exists on a migrated database (not assumed from the file — DB-1 means
`pnpm db:migrate` can silently under-apply); rejects a 2-node cycle; rejects a 3-node cycle; allows a
legitimate chain within the depth cap; confirms a same-pair edge of a *different* relationship_type
does not cross-contaminate the check. Confirmed red first: ran against the unmigrated database (no
040 applied) — 4 of 5 cases failed, the cycle-forming inserts succeeding silently and the
"trigger exists" check finding zero rows in `pg_trigger`. After `pnpm db:migrate`, all 5 pass.
Existing `circular-reference.test.ts` (parent_id trigger) and `associations-regression.test.ts` (12
cases) both still pass unmodified — proof item 3 (existing association behavior unchanged).

**How to run it.** `source .factory-env && pnpm db:migrate && pnpm --filter @ship/api exec vitest run src/routes/association-cycle-protection.test.ts src/routes/circular-reference.test.ts src/routes/associations-regression.test.ts`

**How to roll it back.** Revert this commit (or `DROP TRIGGER prevent_circular_association_trigger ON document_associations; DROP FUNCTION prevent_circular_association();` directly). No data migration involved — the trigger only affects future INSERT/UPDATE, so rollback is safe on a database that already has non-cyclic data (the only kind this trigger ever allowed to be written).

---

## TRO-333 — [FG-15] `blocks` relationship: Ship can now express "issue A blocks issue B"

**What was broken.** Ship's `relationship_type` enum was only containment
(`parent | project | sprint | program`) — there was no way to express a dependency between two
documents, and `document_links` (backlinks) had 0 rows. FG-19 (tracing a blocker whose impact
crosses reporting lines) had no Ship view that could show it.

**What changed.** Five edits, per the ticket's own PM-review scope amendment (2026-08-03), which
supersedes the original edit #2:
1. `api/src/db/migrations/041_add_blocks_relationship.sql` (new) — `ALTER TYPE relationship_type
   ADD VALUE IF NOT EXISTS 'blocks'`, pattern copied from migration 017. Numbered 041, not 040 as
   the ticket names — TRO-332 (FG-14, cycle protection) claimed 040 to land first per the bundle's
   internal order; see TRO-332's CHANGES.md entry.
2. `shared/src/types/document.ts` — **did not** add `'blocks'` to `BelongsToType` (the amendment).
   Added `export type RelationshipType = BelongsToType | 'blocks'` alongside it for the API layer.
3. `api/src/routes/associations.ts` — `'blocks'` added to `createAssociationSchema`'s zod enum and
   to the `validTypes` runtime array (both call sites the ticket names).
4. `api/src/utils/document-crud.ts` — the amendment's actual teeth. `getBelongsToAssociations`,
   `getBelongsToAssociationsBatch`, and `syncBelongsToAssociations`'s DELETE are now all scoped to
   `relationship_type IN ('parent','project','sprint','program')`. Without this, a `blocks` edge
   would have appeared in every document's `belongs_to` array — consumed unfiltered by 10+ web
   components (`ContextTreeNav`, `PropertiesPanel`, `IssuesList`, `UnifiedEditor`, the week tabs) —
   rendering a blocking issue as if it were a parent/project, and `syncBelongsToAssociations` would
   have silently deleted any `blocks` edges on a future caller that uses it for a "save" flow
   (verified uncalled from any route today, but the DELETE was previously unscoped).
5. **OpenAPI** (`/ship-openapi-endpoints`, verified in Swagger, not assumed): `common.ts` gets a new
   `RelationshipTypeSchema` (the full 5-value enum) kept separate from `BelongsToTypeSchema` (still
   4 values, containment only) for the same reason as edit #2. `backlinks.ts`'s `AssociationSchema`
   and the `POST /documents/{id}/associations` body now use `RelationshipTypeSchema`. Confirmed by
   running `pnpm openapi:generate` and inspecting `openapi.json`: both the `Association` component
   schema and the POST body's inline enum list `"blocks"` alongside the four containment types.

**Regression test.** `api/src/routes/blocks-relationship.test.ts` (new, 5 cases), covering the
ticket's stated proof items: POST + GET round-trip; the reverse ("blocked by") query; FG-14's cycle
trigger rejecting a `blocks`-specific cycle (not just the containment types it was built and tested
against); the scope-amendment proof that a `blocks` edge does not leak into `belongs_to` while the
generic associations GET still returns it; and a live call to `generateOpenAPIDocument()` asserting
`'blocks'` appears in the generated spec (protects the Swagger registration itself, not just the
route behavior). Confirmed red first: reverted `associations.ts`, `document-crud.ts`,
`shared/src/types/document.ts`, and the two openapi schema files to their pre-fix HEAD versions
(migrations 040/041 stayed applied), reran — all 5 cases failed, proof 1 with `expected 400 to be
201` (the zod layer rejecting `'blocks'`, exactly as the ticket describes). Restored the fix, all 5
pass, plus `associations-regression.test.ts` (12), `circular-reference.test.ts` (5),
`association-cycle-protection.test.ts` (5), and `issues.test.ts` (27) all still pass unmodified.

**How to run it.** `source .factory-env && pnpm db:migrate && pnpm build:shared && pnpm --filter @ship/api exec vitest run src/routes/blocks-relationship.test.ts`

**How to roll it back.** Revert this commit. The enum value migration is additive (no data migration,
nothing else references `'blocks'` yet outside this branch), so a rollback is safe — existing
containment associations are completely unaffected either way.

---

## TRO-312 — [FG-1] `GET /api/change-feed` — "what changed since a cursor"

**What was broken.** FleetGraph's proactive mode is defined as "observe state changes since a
cursor." Ship's API had no way to ask that question: zero occurrences of `since`/`updated_since`
as a query parameter anywhere in `api/src/routes/`, `GET /api/documents` sorts by
`position, created_at` (recently-updated documents never surface at the head), and the endpoints
that do sort `updated_at DESC` (two dashboard widgets, search, one week lookup) take no time
filter. The proactive half of the agent's MVP had no input.

**What changed.** `GET /api/change-feed?since=<iso>&limit=<n>` (new route,
`api/src/routes/change-feed.ts`, mounted read-only/no-CSRF in `app.ts` next to `dashboard`/
`activity`). Workspace-scoped and permission-filtered as the calling user (reuses
`getVisibilityContext`/`VISIBILITY_FILTER_SQL` from `middleware/visibility.ts` — the same pattern
`documents.ts`'s list route uses — joined onto `document_history`/`comments` since neither has its
own visibility column). Returns three arrays — `documents`, `history` (from `document_history`),
`comments` — each item carrying a `dedupe_key`.

**Did not ship the naive version, per the ticket's explicit warning.** A high-water mark on
`updated_at` (or on `document_history.id`, a `SERIAL` — same flaw, handed out pre-commit)
*permanently* misses a row whose transaction commits after the cursor has already advanced past its
timestamp: a slower transaction with an earlier timestamp can commit after a faster, later-stamped
one a poll already saw and advanced past. The fix: the returned `next_cursor` is never advanced to
"now" — it lags `Date.now()` by a fixed `CHANGE_FEED_LAG_MS` (5s, exported for tests). A change more
recent than that safe cutoff is deliberately withheld and left for a later poll, once enough
wall-clock time has passed that its transaction (and any earlier-timestamped sibling still in
flight) is guaranteed to have committed. Stated plainly: this is a tunable safety margin, not a
proof — it holds as long as `CHANGE_FEED_LAG_MS` exceeds the longest write transaction's duration.
The cursor is also clamped to never regress behind a caller's own `since` (a caller polling faster
than the lag window elapses would otherwise move its own cursor backwards).

**A second permanent-miss path, found in CodeRabbit triage and fixed before merge: pagination could
skip rows the same way the naive timestamp cursor could.** If any of the three categories hit
`limit` (truncated), the original code still advanced the shared `next_cursor` all the way to
`safeCutoff` — silently skipping every row of that category between the last one actually returned
and `safeCutoff`, forever, the exact failure class this endpoint exists to prevent, just moved from
the timestamp layer to the pagination layer. Fixed: when a category is truncated, `next_cursor` is
capped at that category's last-returned row's timestamp instead, so the next poll re-covers the gap.
A non-truncated category may then re-deliver a few already-seen rows in that re-covered window —
expected and handled by `dedupe_key`, not a new bug. Also added: `since` in the future now 400s
(previously silently accepted, producing an inverted or empty window with no error).

**OpenAPI** (`/ship-openapi-endpoints`, verified in Swagger, not assumed):
`api/src/openapi/schemas/change-feed.ts` (new) registers `GET /change-feed` with
`ChangeFeedResponseSchema` (`ChangedDocument`/`ChangedHistoryEntry`/`ChangedComment`, each with
`dedupe_key`) and is wired into `schemas/index.ts`. Confirmed by running `pnpm openapi:generate` and
inspecting `openapi.json`: `paths['/change-feed'].get` is present with `since` (required) and
`limit` (optional) query params and a `$ref` to `ChangeFeedResponse`.

**Regression test.** `api/src/routes/change-feed.test.ts` (new, 5 cases): (1) a change committing
inside the lag window is deferred from the first poll, then returned once the window elapses —
proven with `vi.useFakeTimers({ toFake: ['Date'] })` advancing only the `Date` global (not
`setTimeout`, so the real HTTP/DB round trips inside the test still run on real timers) rather than
an actual sleep; (2) never returns a private document owned by another user, or any document in a
different workspace; (3) the same change carries an identical `dedupe_key` across two polls with
the same (overlapping) `since`; plus coverage that `document_history` and `comments` both appear
with their own `dedupe_key` shapes, and that a missing/malformed `since` 400s. Confirmed red first:
temporarily reverted `app.ts`'s mount (`git checkout HEAD -- api/src/app.ts`, restored after) so
`/api/change-feed` 404s — all 5 cases failed with `expected 200 to be 404` / `expected 400 to be
404`, i.e. the route did not exist yet, which is the correct "before" state for a brand-new
endpoint. Restored the mount, all 5 pass.

**How to run it.** `source .factory-env && pnpm --filter @ship/api exec vitest run src/routes/change-feed.test.ts`

**How to roll it back.** Revert this commit. No migration, no schema change — the endpoint is
purely additive (a new read-only route), so rollback removes the endpoint and nothing else.

**Not verified:** whether `CHANGE_FEED_LAG_MS = 5000` is the right value for this deployment's
actual longest write-transaction duration — chosen as a reasonable default, not measured against
production transaction timing. If a transaction can genuinely run longer than 5s, the row it writes
can still be permanently missed; this is the tunable margin the design accepts, not a guarantee.

---

## TRO-314 — [FG-3] Seed fixture work: the trigger states four FleetGraph use cases had no reachable input for

**What was broken.** The agent drafts from observed Ship activity. The dev-database seed was a Week
4 load-testing fixture built to a volume spec ("500+ documents, 100+ issues, 20+ users, 10+
sprints") that never recorded any of that activity: `document_history` and `comments` were both
always 0 rows, no issue ever had `started_at`/`completed_at` set (including ones marked `done`), and
no week ever had `plan_approval` set. Verified directly against this worktree's own database before
any change: `document_history=0`, `comments=0`, `issues_done_with_started_at=0`,
`weeks_with_plan_approval=0` on a fresh `pnpm db:seed` run — matching the ticket's own baseline
exactly. The code that writes all of these exists and runs in normal use (state-transition timestamps
in `document-crud.ts`'s `getTimestampUpdates`, the `changed_since_approved` transition in
`documents.ts:1074`/`projects.ts:864`); the seed simply never exercised any of it, so four of six
FleetGraph use cases (`FLEETGRAPH.MD` Test Cases 1-4) had no reachable trigger state.

**What changed.** `api/src/db/seed.ts` gets one new block (gated on `document_history` being empty,
so a re-run against an already-fixtured database is a no-op — there is no natural unique key for a
`document_history` row, a comment, or a `plan_approval` transition to `ON CONFLICT` against):

- **`started_at`/`completed_at`** backfilled on every `done` issue: most spread across the last ~5
  weeks (so "sitting for N days" has a realistic distribution), every 4th one closing inside the
  current week (computed from the same `sprint_start_date` + `currentSprintNumber` the rest of the
  file already uses for "current sprint" — not a separate day-count guess).
- **`document_history`**: a state-change entry (an issue moved `in_progress` → `in_review`) and a
  content-edit entry on a current-week `weekly_plan` — the ticket's Scope item 1 names "issues AND
  weekly plans" explicitly, not issues alone.
- **`comments`**: at least two carrying a literal `@Full Name` mention. Confirmed the actual
  convention first rather than assuming a structured TipTap mark: `comments.content` is plain
  `TEXT` (`schema.sql:325`) and `CommentDisplay.tsx` renders comment input as a bare
  `<input type="text">` — there is no mention *node* on this column, so `@Name` literal text is the
  real convention, not a gap in this fix.
- **`plan_approval`** set on several weeks (4 total): one `changes_requested`, one
  `changed_since_approved` (the "approved, then edited" transition), two plain `approved`.
- **`reports_to`**: verified still 10 of 11 people (root `dev@ship.local` deliberately has none) —
  not re-seeded, so the escalation-degrades path stays exercised.

**Also constructs concrete document ids for `FLEETGRAPH.MD` Test Cases 1-4**, per the ticket's own
proof requirement ("those ids go into the ticket" — posted as a comment on TRO-314):
- **Case 1** (engineer, 3 assigned issues, activity since last standup): picks the current-sprint
  engineer with the most non-`done` assigned issues, moves one to `in_review` with history, comments
  on a second, backdates the third's `updated_at` 7 days, and creates a standup from 3 days ago as
  the "since" anchor.
- **Case 2** (person mentioned in 2 docs they don't own, blocking someone else's week): 2 mentions of
  Alice Chen on issues she neither created nor is assigned to, plus Emma Johnson's week (Emma reports
  to Alice per the existing `reportingHierarchy`) set to `changes_requested` with Alice as
  `approved_by`.
- **Case 3** (week with 4 success criteria, 3 issues closed mapping to 2): current Ship Core week's
  `success_criteria` overwritten to a real 4-item array (the pre-existing per-sprint value was a
  single string, not an array, at every other week — left alone everywhere else, only overwritten
  for this one week), its 3 already-`done` current-sprint issues closing within the week's actual
  Mon-Sun boundary.
- **Case 4** (plan approved at version N, then edited to remove one criterion): the prior completed
  week's `plan_history` captures an original 4-criterion version, `success_criteria` shrunk to 3, and
  `plan_approval.state = 'changed_since_approved'`.

**A bug found and fixed while building this** (not shipped, caught before commit): Test Case 3's
block re-sets `completed_at` on the same 3 issues the backfill loop already touched, without
re-deriving `started_at` — an earlier draft left the stale `started_at` in place, which could land
*after* the newly-assigned `completed_at`, violating "coherently populated". Fixed by having Test
Case 3 derive its own `started_at` from its own `completed_at` rather than trusting the earlier
loop's value. Caught by the regression test itself (see below), not by inspection.

**Regression test.** `api/src/db/__tests__/seedFixtures.test.ts` (new, 6 cases). Per this ticket's
own hazard note ("do not point the test suite at the development database — running Ship's tests
wipes whatever database they are aimed at"), this test creates a throwaway scratch database
(`randomBytes`-named, same pattern as `migrationRunner.test.ts`), runs the full migration set against
it via `runMigrations()` (so it matches what `pnpm dev`'s migrate-then-seed actually produces, not
just `seed.ts`'s own internal `schema.sql` re-application), then spawns the real
`tsx src/db/seed.ts` CLI against it — never `DATABASE_URL` itself. Asserts: `document_history`
non-empty and covers both `issue` and `weekly_plan`; `comments` non-empty with ≥2 mentions;
`started_at`/`completed_at` set and coherent (`started_at <= completed_at`) on every `done` issue,
with at least one closing in the last 7 days; `plan_approval` set on ≥3 weeks including one
`changed_since_approved`; at least one person with no `reports_to` and at least one with; and a
second seed run against the same database is a clean no-op. Confirmed red first: ran the pre-fix
`seed.ts` against a fresh scratch database and queried directly —
`document_history=0, comments=0, issues_done_with_started_at=0, weeks_with_plan_approval=0`,
matching the ticket's own baseline exactly. After the fix, all 6 cases pass, confirmed stable across
4 consecutive runs (the block uses `Math.random()` for date offsets, so repeat runs were checked
deliberately for boundary-condition flakiness — none observed).

**How to run it.** `source .factory-env && pnpm --filter @ship/api exec vitest run src/db/__tests__/seedFixtures.test.ts`

**How to roll it back.** Revert this commit. `seed.ts`'s new block is additive and gated on
`document_history` being empty, so reverting it only stops *future* `pnpm db:seed` runs on a fresh
database from populating these fields — it does not delete rows from a database that already ran
the fixed version (the seed script itself is never destructive).

**Not verified:** whether the exact narrative match to each `FLEETGRAPH.MD` test case row (e.g.
"mapping to 2 of them" in Case 3) will read correctly once FleetGraph's own drafting logic exists —
this ticket constructs the Ship-side *state*, not the agent's interpretation of it, which is Phase 2
and out of scope here.

---

## GitLab CI — shared runners were never enabled; every pipeline on `main` had been stuck or failing since `.gitlab-ci.yml` was added

**What was broken.** `.gitlab-ci.yml` (added 2026-07-30, `3563fa3`) mirrors `.github/workflows/ci.yml`
so the same gate runs on GitLab — the actual submission target per the assignment's "GitLab
Repository" deliverable. It had never once succeeded: `glab ci list --ref main` showed every
pipeline on `main`, this entire sprint, as either `canceled` (superseded by the next rapid push
before finding a runner) or `failed`. The failure reason on every non-canceled run was
`stuck_pending_no_matching_runners` — the jobs never started at all. Root cause: the project had
`shared_runners_enabled: false` (confirmed via `GET /projects/troysatchell%2Fship`), so GitLab had
no runner to assign the jobs to, ever — unrelated to any code change, including this one. This was
invisible all sprint because every merge this session gated on GitHub Actions status only; nobody
checked the actual graded platform's pipeline until a GitLab failure notification surfaced it.

**What changed.**
1. `PUT /projects/troysatchell%2Fship` with `shared_runners_enabled=true` — the instance's shared
   runner ("Snapshot pipeline runner", online, previously invisible to this project) is now
   assigned jobs. Retried the failing pipeline (#17513): `verify` and `inventory` — the jobs that
   actually cover assignment Rule 4's required checks (build, lint, type-check, test, coverage,
   `pnpm audit`, security posture) — both passed for real for the first time this sprint.
2. `PUT /projects/troysatchell%2Fship` with `only_allow_merge_if_pipeline_succeeds=true` — this
   project's actual merge workflow has always been GitHub PRs fanned out to both remotes via a
   direct push, not GitLab merge requests, so this setting doesn't change day-to-day behavior, but
   it matches the assignment's literal "all checks must pass before a PR can merge" wording on the
   platform that's actually graded, at zero cost.
3. `.gitlab-ci.yml`'s `image-build` job: added `allow_failure: true`. Once a runner was finally
   available, this job (proves the root Dockerfile still builds — not the artifact-provenance path,
   which is GitHub's `build-image` job pushing to GHCR, and not one of Rule 4's named checks) failed
   for a second, unrelated reason: the shared runner cannot start `docker:27-dind` as a genuinely
   privileged service (`mount: permission denied (are you root?)` in the service's own startup log,
   then a 30s health-check timeout dialing `docker:2375`/`2376`). That is a runner-registration
   setting (`privileged = true` in the runner's own `config.toml`) this project cannot change via
   the GitLab API — it needs whoever registered the shared runner. Not blocking the pipeline on an
   infra capability gap outside this project's control; the job still runs and still reports its
   real result, it just can't fail the overall pipeline.

**Not verified:** whether `privileged = true` could be requested for the shared runner from an
instance admin — out of reach here; `allow_failure: true` is the correct project-side response
either way, not a workaround pending a fix.

**How to run it.** `glab ci list --ref main -R troysatchell/ship` to see pipeline history;
`glab ci status --branch main -R troysatchell/ship` for the latest.

**How to roll it back.** `PUT /projects/troysatchell%2Fship` with `shared_runners_enabled=false`
restores the broken state (not recommended). Reverting the `.gitlab-ci.yml` commit removes
`allow_failure: true` from `image-build`, which would make the pipeline red again on every commit
until the runner's own privileged-mode capability changes.

---

## TRO-311 — RULE-7 follow-up: a real circuit breaker for the Redis rate-limit store

**What was broken.** `TRO-248` (RULE-7) assessed the codebase for missing retry logic, hardcoded
timeouts, and missing circuit-breaker patterns, and fixed real gaps in the first two categories
(`api/src/db/poolConfig.ts`, `api/src/config/ssm.ts`). Its circuit-breaker investigation concluded,
correctly, that the strongest candidate — the collaboration WebSocket — already had equivalent
protection (`y-websocket`'s exponential-backoff reconnect + `Editor.tsx`'s permanent-failure
`shouldConnect = false` gating, ERR-1/ERR-2) and that building a second breaker there would
duplicate existing work. That was the right call, but it left no code anywhere in the repo
literally named or structured as a circuit breaker — `grep -ri circuitbreaker api/src` returned
zero hits despite the retry/timeout half of the rule being genuinely well covered.

**What changed.** `api/src/utils/circuitBreaker.ts` (new) — a generic, reusable `CircuitBreaker`
class: CLOSED (calls go through) → OPEN after `failureThreshold` consecutive failures (calls fail
immediately with `CircuitOpenError`, the wrapped function is never invoked) → HALF_OPEN after
`cooldownMs` (exactly one trial call) → CLOSED on trial success / OPEN again (cooldown restarted)
on trial failure. Wired into `api/src/middleware/redis-rate-limit-store.ts`'s `sendRedisCommand` —
the single choke point every limiter's Redis traffic already funnels through — one breaker per
underlying `Redis` client instance (a `WeakMap`, since `app.ts` shares one client across every
limiter it builds). Threshold 3 consecutive failures, 10s cooldown
(`REDIS_CIRCUIT_FAILURE_THRESHOLD`/`REDIS_CIRCUIT_COOLDOWN_MS`, exported for tests).

**Why this doesn't duplicate TRO-248's existing protection.** TRO-280's retry/timeout tuning
(`maxRetriesPerRequest: 1`, `connectTimeout: 2000`, `passOnStoreError: true`) bounds the cost of
any ONE failed Redis call. It does nothing to stop every subsequent request from paying that same
bounded cost again during a sustained outage — 1,000 requests against a Redis that has been down
for five minutes previously meant 1,000 doomed connection attempts, each adding latency. The
breaker adds memory: once an outage is established, stop trying entirely (near-zero cost per
request) until a cooldown-gated trial confirms recovery. A `CircuitOpenError` is just another
rejection from the store's perspective, so it flows into the exact same `passOnStoreError`
fail-open path as any other Redis error — every user-facing behavior (requests still served,
errors still logged) is unchanged; only the number of real Redis calls during a sustained outage
drops.

**Regression tests.**
- `api/src/utils/__tests__/circuitBreaker.test.ts` (new, 9 cases) — the state machine itself, all
  timing driven by an injectable `now` (a plain counter advanced manually in tests, never a real
  sleep): closed→open on threshold, open skips the wrapped function entirely, half-open allows
  exactly one trial, trial success closes and resets the failure count, trial failure reopens and
  restarts the cooldown from the trial's own time (not the original open time), and a success
  before threshold resets the consecutive-failure count.
- `api/src/middleware/__tests__/redis-rate-limit-store.test.ts` — one new case proving the actual
  integration, not just the unit in isolation: spies on `client.call` against a real (but
  unreachable) ioredis client, sends `REDIS_CIRCUIT_FAILURE_THRESHOLD` requests (each calls Redis,
  fails, fails open — 3 calls observed), then sends one more and asserts the call count does NOT
  increase — Redis is genuinely not contacted once the breaker is open — while confirming every
  request throughout, including the one after the breaker trips, still gets a 200.

**Observed, not assumed:** confirmed this test fails for the right reason on the pre-fix code
(copied `redis-rate-limit-store.ts` aside — `lessons.md` documents `refs/stash` as shared across
every worktree in this repo, so never `git stash` here — reverted `sendRedisCommand` to call
`client.call` directly, reran: `expected "Mock" to be called undefined times, but got 2 times`
against the same assertion, i.e. 5 real Redis calls across 4 requests instead of the fixed
version's 3 across 4 — restored the fix afterward).

**How to run it.** `pnpm --filter @ship/api exec vitest run src/utils/__tests__/circuitBreaker.test.ts src/middleware/__tests__/redis-rate-limit-store.test.ts`

**How to roll it back.** Revert this commit. `sendRedisCommand` returns to calling `client.call`
directly; `passOnStoreError`'s existing fail-open behavior is unaffected either way, so a rollback
changes only latency/load during a sustained Redis outage, not correctness.

**CodeRabbit review triage (post-gate, before merge):**
- **Critical, fixed.** `execute()` only intercepted calls when `state === 'open'`; once a trial call
  set `state = 'half-open'` and started `await fn()`, a second concurrent call reads
  `state === 'half-open'`, doesn't match `if (state === 'open')`, and falls straight through to
  calling `fn()` itself — breaking the documented "exactly one trial call" invariant under real
  concurrent request load, exactly when it matters (many requests arrive at once right as a
  cooldown elapses). Fixed with an `else if (state === 'half-open') throw new CircuitOpenError()`
  guard. Confirmed red-before-green: reverted to the pre-fix code, the new concurrent-call test
  failed with "promise resolved 'should not run' instead of rejecting" (the second caller's function
  really did run); restored the fix, 20/20 tests pass. New regression test uses a manually-releasable
  promise so the trial call is provably still in flight when the concurrent calls arrive, rather than
  relying on timing.
- **Trivial, dismissed with a reason.** CodeRabbit asked whether the new integration test (using a
  real unreachable `redis://127.0.0.1:1` connection rather than mocking `client.call`) was the source
  of this gate run's reported `tests:api` flake. Checked directly: `.factory/api-standalone.txt`
  names `weekly-plans.test.ts` as the flaked-then-passed-standalone file — the pre-existing
  TRO-277/`session-activity-race` load-sensitive mechanism, unrelated to this PR's diff. The new test
  also follows the exact same real-unreachable-connection pattern this file's own pre-existing
  fail-open tests already use deliberately (see the file's top-of-file docstring: "fails fast and
  deterministically with ECONNREFUSED"), so switching to a mock here would be inconsistent with an
  established, intentional convention in this file for a benefit (avoiding a flake that provably
  didn't happen) that doesn't apply.

---

## TRO-233 — [TEST-11] 619 fixed sleeps across 49 spec files — the mechanism behind the flakes (batch 1: TEST-3-connected files)

**Scope.** The ticket's own fix direction: "Don't attempt all 619 at once — start with the spec
files that appear on the TEST-3 (TRO-225) flake list, where the connection between sleep and flake
is already demonstrated." TEST-3's flake list
(`audit/test-quality/runs/e2e-flake-union.txt`) names 11 flaky tests across 10 spec files. Re-measured
live rather than trusting the ticket's filed number (619, from 2026-07-28, since drifted as other
tickets touched some of these files): `git grep -c waitForTimeout -- 'e2e/*.spec.ts'` found **590**
sites across 49 files at the time this ticket started. This batch is the 7 of those 10 flake-list
files that had real `waitForTimeout` sites:

| File | `waitForTimeout` before | after |
|---|---|---|
| `performance.spec.ts` | 22 | 0 |
| `bulk-selection.spec.ts` | 16 | 0 |
| `inline-comments.spec.ts` | 15 | 0 |
| `team-mode.spec.ts` | 10 | 0 |
| `mentions.spec.ts` | 8 | 0 |
| `programs.spec.ts` | 4 | 0 |
| `my-week-stale-data.spec.ts` | 1 (see below) | 0 |
| `weekly-accountability.spec.ts` | 0 | — (skipped, see below) |
| `project-weeks.spec.ts` | 0 | — (skipped, see below) |
| `status-overview-heatmap.spec.ts` | 0 | — (skipped, see below) |

`my-week-stale-data.spec.ts`'s "1" was a false positive: the only match is inside a comment
documenting a fix TRO-225 already made (line 41, `` `page.waitForTimeout(3000)` — a guess at how
long persistence takes — is replaced by polling the API ``); there was no actual `waitForTimeout(`
call in the file's code. The last three files in the table have zero `waitForTimeout` sites of any
kind (confirmed by grepping for `sleep`/`setTimeout`/`delay`/bare `wait...(` patterns beyond the
sanctioned `waitForSelector`/`waitForLoadState`/`waitForResponse`/`waitForURL`/`waitForFunction`/
`waitForEvent` — nothing found); TEST-3's own flake entries for these three name the
shared-database-state root cause, not a fixed sleep, so there was no sleep-removal work to do here
— skipped rather than invented.

**75 real sites fixed across 6 files with real work (22+16+15+10+8+4; the 7th file,
`my-week-stale-data.spec.ts`, had 0 real sites — see above), replaced per-site with the primitive
the wait was actually standing in for** (`e2e/AGENTS.md` anti-patterns 1–3):

- **Waiting for a UI change**: `await page.waitForTimeout(N)` before a `.toBeVisible()`/`.count()`/
  `.toHaveText()` check → the auto-retrying assertion itself, with the fixed guess deleted (most
  sites — the assertion right after the sleep already retried, so the sleep was pure dead time).
- **Waiting for persistence/sync**: replaced with `page.getByTestId('sync-status').getByText('Saved',
  { exact: true })` — "Saved" requires a live, completed Yjs sync handshake with no in-flight write
  (`SyncStatusIndicator.tsx` `deriveSyncIndicator`), the strongest client-observable proxy for "the
  server actually has this." Used before every `page.reload()` that used to be preceded by a blind
  wait (`performance.spec.ts`, `inline-comments.spec.ts`, `mentions.spec.ts`), since reloading before
  a write is confirmed persisted can race an in-flight request.
- **Waiting for an unreliable retry loop**: `programs.spec.ts`, `team-mode.spec.ts`, and
  `performance.spec.ts`'s image-upload tests had hand-rolled "try N times with a fixed sleep between"
  loops — replaced with `expect(async () => {...}).toPass({...})`, this repo's sanctioned retry
  construct (`e2e/AGENTS.md` guideline 2).
- **Genuine CSS-transition timing** (the one legitimate stability-poll case, `lessons.md` #17):
  `inline-comments.spec.ts`'s resolved/un-resolved highlight color checks read a computed
  `background-color` that CSS-transitions over 150ms (`index.css` `.comment-highlight`). Replaced
  the fixed 1500ms sleep-then-read with `expect.poll(() => highlight.evaluate(...)).toBe(...)`/
  `.toContain(...)`, tied to that real 150ms constant with headroom, not a round number.
- **Dead waits with nothing downstream**: two sites in `mentions.spec.ts` slept after a mention-click
  navigation with no assertion following (`// Navigation behavior depends on implementation`) —
  deleted outright; nothing was reading state after them.
- **A synchronous DOM write mistaken for async**: `team-mode.spec.ts`'s scroll test waited 100ms
  after each `scrollLeft` assignment; this container has no `scroll-behavior: smooth`, so the
  assignment is already applied by the time `evaluate()` returns. Removed — this also stopped the
  sleep from padding the very `scrollDuration` the test measures (it was being counted *inside* the
  timed window).

**Two real, pre-existing bugs found and fixed while replacing sleeps with real assertions** (both
were previously invisible because the sleep-based versions never actually checked what they claimed
to check):

1. **`performance.spec.ts` "memory is released after deleting content"**: `page.keyboard.press('Control+a')`
   never selected anything. TipTap/ProseMirror's default keymap binds `Mod-a` to `selectAll`
   (`@tiptap/core` `dist/index.js` ~line 4017), and ProseMirror's `Mod` resolves to `Meta` on a
   Mac-reporting browser, not `Control` — this Chromium runs on macOS, so `Control+a` never reached
   `selectAll()`, instead falling through to macOS's native "move to start of line" binding; the
   `Backspace` that followed then had nothing before the caret to delete. The original
   `page.waitForTimeout(1000)` never verified the delete had happened, so `afterDelete` memory was
   silently ≈ `beforeDelete` either way, comfortably under the 20MB growth threshold regardless.
   Fixed with `ControlOrMeta+a` (Playwright's cross-platform modifier alias) wrapped in a `toPass`
   retry.
2. **`performance.spec.ts` "many images do not crash the editor"**: the slash-command's "Image
   Upload" menu item becoming DOM-visible does not mean the menu's internal keyboard-selection state
   has caught up — pressing `Enter` immediately after `toBeVisible()` resolved could select nothing,
   leaving `page.waitForEvent('filechooser')` to time out at 45s. Confirmed by isolating the test:
   with the original unmodified code, `--repeat-each=2 --workers=1` passed 2/2; with the sleep
   replaced by a real wait but still using `Enter`, the same harness failed 3/3, always with the
   `filechooser` timeout. The file's second image-upload test already avoided this by clicking the
   option directly ("more reliable than keyboard.press" — its own pre-existing comment). Matched
   that pattern in the first test; the `filechooser` timeout did not reproduce again afterward.

**Known residual flakiness, not fixed, explicitly not claimed fixed.** Even after both bugs above,
`performance.spec.ts`'s "many images do not crash the editor" still intermittently gets stuck at 2
images instead of 3 in repeated local runs — the file chooser fires and `setFiles()` resolves
without error, but no third `<img>` lands within 15s. Ruled out: click-position drift (added
`Control+End` before each iteration's caption to remove ambiguity — no change) and the Enter-vs-click
race above (confirmed fixed independently). This matches this describe block's own pre-existing
top-of-file comment — `// FIXME: Slash command dropdown inconsistent + filechooser event not firing
reliably // Same issue as images.spec.ts and data-integrity.spec.ts` — predates this ticket and
names other files with the same symptom. Left as a real wait (`toHaveCount` with a 15s timeout, not
a blind sleep) with a `TODO(TRO-233)` comment at the site rather than guessing further; a
live-debugging session on `SlashCommands.tsx`'s image-upload path is out of this ticket's scope.

**`playwright.config.ts:76`** — the `[1/641]` example in the reporter comment was stale. Re-ran
`playwright test --list` (870 tests in 72 files as of 2026-07-31, not the ticket-cited "869") and
updated the comment to `[1/870]`, with a note to re-run the list command rather than trust the
number, since it drifts.

**Regression test.** None added — per `/ship-qa`, this ticket hardens existing e2e tests rather than
fixing an application defect; the regression test **is** the 76 hardened sites themselves passing
reliably. (Two of the app-code findings above — the `Mod-a` platform bug and the Enter-vs-click
race — are arguably real product/test-integration bugs, but both live entirely inside spec files
already in scope; no `api/` or `web/` source changed.)

**Verified (multi-run, not a single pass — see caveats):**
- All 7 files together, twice: 162/162 tests, first run 158/162 clean + 4 recovered on retry, second
  run 158/162 clean + 4 recovered on retry + 1 hard failure (the known "many images" residual,
  documented above). `team-mode.spec.ts`, `bulk-selection.spec.ts`, `programs.spec.ts`,
  `my-week-stale-data.spec.ts`: **zero failures across both combined runs.**
- `team-mode.spec.ts` alone (20 tests): 19/20 clean, 1 failure traced to a pre-existing cross-test
  shared-state dependency on the file's "Unassigned" group (unrelated to any sleep — the failing
  locator line is unchanged from the original file). The specific flake-listed test
  ("clicking collapsed header expands the group") run in isolation, `--repeat-each=5 --retries=0`:
  **5/5 clean**, confirming the fix itself is correct and the residual failure is cross-test state,
  not this ticket's substrate.
- `performance.spec.ts` alone, single pass (14 tests): 13/14 clean, 1 failure (the documented "many
  images" residual). The other 3 tests that showed transient `sync-status "Saved"` timeouts when run
  as part of the full 162-test combined batch passed cleanly every time they were run in isolation —
  derived conclusion: that flakiness is resource contention from running all 7 files' 162 tests
  simultaneously (several are collaboration/large-document/multi-tab heavy), not a defect in the
  `Saved`-wait replacement pattern itself.
- Vitest tiers unaffected (no `api/`/`web/` source touched): `pnpm --filter @ship/api test` →
  725/725 passed; `pnpm --filter @ship/web test -- --run` → 495/495 passed.

**Not verified / explicitly out of scope for this claim:** a full TEST-3-style reproduction (3×
complete 870-test suite runs under load) was not attempted — this ticket's evidence is the above
multi-run, file-scoped local verification, not that methodology. "Less flaky" is not claimed as a
blanket statement; per-file/per-test results are reported above as observed, not inferred.

**Follow-up scope (not attempted here).** ~514 sites across the other 42 files remain, matching this
ticket's own "don't attempt all at once" direction and the same scoped-batch pattern as
TS-10/TRO-306. The next-highest-density files, all needing their own ticket: `tables.spec.ts` (52),
`file-attachments.spec.ts` (37), `features-real.spec.ts` (36), `backlinks.spec.ts` (34),
`drag-handle.spec.ts` (33), `data-integrity.spec.ts` (33).

**How to run it.**
```bash
source .factory-env
# via /e2e-test-runner, never `pnpm test:e2e` directly:
pnpm exec playwright test e2e/performance.spec.ts e2e/bulk-selection.spec.ts \
  e2e/inline-comments.spec.ts e2e/team-mode.spec.ts e2e/mentions.spec.ts \
  e2e/programs.spec.ts e2e/my-week-stale-data.spec.ts
```

**How to roll it back.** Revert this commit. The actual diff is confined to 6 of the 7 spec files
in the command above (`my-week-stale-data.spec.ts` has zero real changes — its one `grep` hit was
a comment, not a call site, so it's unmodified; listed in the command only so the verification run
covers the full flake-list cohort) plus the one-line `playwright.config.ts` comment; nothing outside
`e2e/` was touched, and no migration, schema, or `api`/`web` source file is affected.

---

## TRO-213 — [TS-8] Typed mock factories replace `as any` in the six test files where it was concentrated

**Re-measured count, not the filing-time number.** The ticket's own text warns the 155/176 figure
is stale (dated 2026-07-28) because TS-1/TS-2/TS-3/TS-4/TS-7/TS-10 touched adjacent code since. A
plain `grep -rn 'as any' api/src --include='*.test.ts'` still returns 128 raw hits across 9 files,
but several of those are prose, not casts — e.g. `db/__tests__/ssl.test.ts`'s two hits are a comment
explaining the ban (`// type assertion ("as any" / "as unknown as" are both banned here...`), and
`__tests__/auth.test.ts`'s one hit is a comment noting the file *used to* be `as any` (it was already
converted to a typed mock, apparently by TS-4/TRO-209 — the `pgResult` helper this ticket reuses
already carries a TS-4/TS-8 dual-attribution comment). Filtering to lines that survive stripping
`//`-comments (`awk '{ sub(/\/\/.*/, ""); if ($0 ~ /as any/) print }'` per file) gives the real,
actionable count: **124 sites in exactly 6 files** — the same 6 the ticket named, all still
concentrated there, `iterations.test.ts` newly appearing (not in the filing-time list) and
`auth.test.ts` dropping out (fixed by a prior ticket):

| File | Sites (re-measured 2026-07-31) |
|---|---|
| `api/src/services/accountability.test.ts` | 32 |
| `api/src/__tests__/transformIssueLinks.test.ts` | 28 |
| `api/src/__tests__/activity.test.ts` | 20 |
| `api/src/routes/issues-history.test.ts` | 18 |
| `api/src/routes/projects.test.ts` | 17 |
| `api/src/routes/iterations.test.ts` | 9 |

All 124 converted. Post-fix `grep -rn 'as any' api/src --include='*.test.ts'` returns 5 hits, all
prose (the two `ssl.test.ts` ban-comment lines, the one pre-existing `auth.test.ts` comment, and two
new doc-comment lines in `transformIssueLinks.test.ts` that discuss `as any`/`as unknown as` by
name while explaining why neither is used) — zero real casts remain, verified by re-running the
same comment-stripped `awk` filter, which reports 0 across every `*.test.ts` file.

**Why a naive fix would have been cosmetic.** The ticket's own risk warning: swapping `as any` for
`as unknown as X` "retires the count without restoring any protection." Two separate traps made a
naive per-site retype insufficient here, both found by actually trying it and reading the compiler
output rather than assuming:

1. **`vi.mocked(pool.query).mockResolvedValueOnce(...)` doesn't typecheck at all**, `as any` or not.
   `pg`'s `Pool.query` is overloaded, including a callback-style signature returning `void`; `vi.mocked()`
   resolves the mock's type against that overload, so `.mockResolvedValueOnce(anyRealQueryResult)`
   fails with `TS2345: ... not assignable to parameter of type 'void'` — reproduced directly against
   this repo's `tsc` on `iterations.test.ts` before any other change, not inferred from the pattern.
   This is exactly why `pgResult`'s own doc comment and two already-existing test files
   (`middleware/__tests__/session-activity-throttle.test.ts`,
   `middleware/__tests__/named-prepared-statements.test.ts`, both pre-existing, not touched by this
   ticket) already used a `vi.hoisted(() => ({ queryMock: vi.fn<(text, values?) => Promise<QueryResult>>() }))`
   pattern instead of `vi.mocked(pool.query)`. All 6 files converted to this same pattern.
2. **`transformIssueLinks` genuinely returns `Promise<unknown>`** (`api/src/utils/transformIssueLinks.ts:206`,
   application code, not touched) because it accepts arbitrary TipTap JSON — so the test's `as any`
   on the result wasn't masking a real declared type, it was standing in for a type the source
   deliberately doesn't export. A local `TransformedNode`/`TransformedDoc` interface (test-file-only,
   mirrors the shapes the file's own assertions already relied on) plus a single `as TransformedDoc`
   off of `unknown` restores real checking without inventing `as unknown as` — asserting directly off
   `unknown` needs no intermediate hop, so the ticket's own banned pattern was never necessary here.

**What changed — infrastructure (reused, not duplicated).** `api/src/test/pg-result.ts`'s `pgResult<T
extends QueryResultRow>(rows: T[]): QueryResult<T>` and `api/src/test/sql-of.ts`'s `sqlOf` already
existed (built by an earlier ticket per their doc comments' TS-4/TRO-180 attribution) — reused as-is,
not duplicated with a differently-named helper, per the ticket's own instruction to check for and
extend existing mock helpers first. `pgResult` had no test of its own; added one
(`api/src/__tests__/pg-result.test.ts`, new — deliberately NOT under `api/src/test/`, which
`api/tsconfig.json` excludes from compile roots, so a `@ts-expect-error` placed there would never
actually be evaluated by `type-check`).

**What changed — the 6 files.** Same two-part pattern applied everywhere:

- `vi.mock('../db/client.js', ...)`'s `query: vi.fn()` replaced with a `vi.hoisted` typed `queryMock:
  vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>()`; all `vi.mocked(pool.query)`
  call sites (including bare `pool.query` assertion targets like `expect(pool.query).toHaveBeenCalledWith`)
  replaced with the typed `queryMock` directly.
- Every `{ rows: [...] } as any` / `{ rows: [...], rowCount: N } as any` mock result replaced with
  `pgResult([...])` (verified case-by-case that `rowCount` always equaled `rows.length` in every
  site that specified it, e.g. `activity.test.ts` — `pgResult` derives `rowCount` from the array it's
  given, so this is a like-for-like replacement, not a behavior change).
- `issues-history.test.ts`'s `mockClient` (a hand-rolled `pool.connect()` stand-in, not the real
  `pg.PoolClient` type) had its `query` field's untyped `vi.fn(async () => ({ rows: [] }))` — which
  infers `rows: never[]` from the bare literal — retyped the same way as `queryMock`.
- `transformIssueLinks.test.ts`'s `vi.mocked(pool.query).mock.calls[0]![1] as any[]` became
  `queryMock.mock.calls[0]![1]` (typed `unknown[] | undefined` from the mock's declared signature)
  read via `?.[1]`, no cast needed. The `(n: any) =>` callback-parameter annotations on `.find`/`.some`
  over the now-typed `TransformedNode[]` were also removed (inferred instead) since they became
  redundant once the array they iterate stopped being `any[]`.
- `noUncheckedIndexedAccess` (root `tsconfig.json:14`) means every array index into the new typed
  `TransformedDoc`/`TransformedNode` shape in `transformIssueLinks.test.ts` is `T | undefined` — this
  surfaced ~26 real possibly-undefined accesses that `as any` had been silently hiding all along (not
  new problems this ticket introduced; pre-existing gaps `as any` made invisible). Fixed with optional
  chaining (`result.content[0]?.content?.[0]`) and `?? []` fallbacks on arrays consumed by
  `.find`/`.some` — no `!` added anywhere, per rule 16.

**Regression test proving this restores real protection, verified by actually breaking it (not just
asserted).** `api/src/__tests__/pg-result.test.ts` has two tests: a normal runtime test that `pgResult`
builds a correct `QueryResult` (rows/rowCount/command/oid/fields), and a `@ts-expect-error` test
asserting `pgResult({ id: 'not-an-array' })` — the exact "forgot to wrap the row in an array" mistake
`{ rows: mockIteration } as any` used to accept silently — fails to compile. Verified three separate
ways during development, each confirmed by actually running `tsc`, not inferred:
1. Broke `iterations.test.ts` directly: changed `pgResult([mockIteration])` to `pgResult(mockIteration)`
   and ran `npx tsc --noEmit -p api` — got `TS2345: ... not assignable to parameter of type 'any[]'`.
   Reverted before committing.
2. Removed the `@ts-expect-error` directive from `pg-result.test.ts` itself and re-ran `tsc` — got a
   real error (`TS2353: Object literal may only specify known properties... does not exist in type
   'QueryResultRow[]'`), confirming the directive is matching a genuine failure, not sitting there
   unused. Restored the directive before committing.
3. With the directive restored, `tsc --noEmit -p api` reports zero errors for this file, and
   `vitest run src/__tests__/pg-result.test.ts` passes both tests (2/2).

**How to run it.**

```bash
pnpm --filter @ship/api type-check   # confirms all 6 files + the new test compile clean
pnpm --filter @ship/api test         # or: source .factory-env && pnpm test (root runs api, then web)
```

Full api suite after this change: 65 files, 725 tests, all passing (no new failures vs. baseline).

**Files covered vs. left.** All 6 dominant files fully converted, 0 real `as any` remaining in any
`api/src/**/*.test.ts`. Not touched: `db/__tests__/ssl.test.ts` and `__tests__/auth.test.ts` (their
`as any` hits are comments only, not casts — confirmed above) and `collaboration/__tests__/concurrent-doc-load.test.ts`
(one raw grep hit, also a comment, not a cast). No production source file was touched — every change
is inside `*.test.ts` files plus the one new test-helper test file.

**Rollback.** Revert this commit. Restores the `as any` casts in all 6 files and removes
`api/src/__tests__/pg-result.test.ts`. No schema, API, or runtime behavior change — test-only and one
new test-helper test.

---

## TRO-308 — CodeQL js/missing-rate-limiting follow-up: SPA catch-all gap + admin.ts polynomial-redos

**Three sub-items; only two needed code.** TRO-307 fixed a CodeQL legibility problem in
`app.ts`'s `/api/` rate-limiter mounting (two explicit `app.use()` calls instead of a spread) and
left three things for follow-up: (1) 254 of 352 open `js/missing-rate-limiting` alerts, unverified
whether the app.ts fix actually cleared them once CodeQL re-scanned; (2) the SPA static-file
catch-all, flagged separately and named at the time as a genuinely different, unprotected route;
(3) `admin.ts:929`'s separate `js/polynomial-redos` alert.

**Item 1 — confirmed resolved, no code change.** Re-queried live CodeQL alerts immediately before
starting work:
```
gh api repos/troysatchell/ship/code-scanning/alerts --paginate \
  -q '.[] | select(.state=="open") | select(.rule.id=="js/missing-rate-limiting" or .rule.id=="js/polynomial-redos") | "\(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
```
Result: **`js/missing-rate-limiting` has exactly one open alert**, at `api/src/app.ts:440` (the SPA
catch-all — item 2, below). The 254 alerts across other route files are gone. This is OBSERVED
from the live query above at the time this ticket started, not inferred from TRO-307's own
(explicitly labeled DERIVED) prediction that its fix would clear them — TRO-307's app-level mount
fix did clear them once CI's CodeQL job re-scanned the merged change. No route file needed a
per-file fix; nothing in this ticket touches `api/src/routes/` route-mounting.

**Item 2 — the SPA static-file catch-all had zero rate-limit coverage. Fixed.**
`api/src/app.ts`'s "Static SPA (single-origin deployments)" section
(`express.static(webDist, ...)` + `app.get('*', ...)`, only active when `web/dist` exists on disk —
single-origin/single-service deployments, never local dev/test) is registered after every
`/api/*` route, outside the `/api/` prefix `perSourceIpLimiter`/`perIdentityLimiter` match. It had
no rate-limit coverage of its own — a real gap, not a CodeQL-legibility issue like item 1.

Fix: a new, separate per-source-IP-only limiter, `createSpaStaticLimiter`
(`api/src/middleware/rate-limit.ts`), mounted via `app.use(spaStaticLimiter)` immediately before
`express.static`/the catch-all in `app.ts`. Design choices, reasoned from
`rate-limit.ts`'s existing NAT-egress/audit-measurement doc:
- **Per-source-IP only, not per-identity.** This route serves anonymous page loads (`index.html`,
  JS/CSS bundles) — most requests carry no session cookie or bearer token — so
  `perIdentityLimiter`'s session/token-keyed shape doesn't apply; `perSourceIpLimiter`'s per-IP
  flood-ceiling shape does.
- **A separate bucket, not a reuse of `perSourceIpLimiter` itself** (own Redis key prefix,
  `rl:spa:`, added in `redis-rate-limit-store.ts`): a static-asset flood (e.g. a stuck client retry
  loop re-fetching `index.html`) and an `/api/*` flood from the same source IP would otherwise be
  able to exhaust each other's budget. Verified independent in the new test suite (see below).
  Same Redis-shared-store treatment as `perSourceIpLimiter` (`REDIS_URL`-conditional,
  `passOnStoreError: true`) for the same reason TRO-280/API-7 required it: a per-process
  `MemoryStore` ceiling silently multiplies by instance count under Elastic Beanstalk autoscaling.
- **Limits:** production/dev tiers reuse `perSourceIpLimiter`'s own numbers (6,000/min prod,
  10,000/min dev) — same traffic-order-of-magnitude reasoning documented in `rate-limit.ts`'s
  top-of-file doc. The test tier is a separate, deliberately small number (25) so a real
  "hit the limit, get a 429" regression test needs tens of requests, not 100,000 — safe because no
  other test file in this suite exercises a non-`/api/`, non-`/collaboration` path through a real
  built `web/dist` (grepped for `.get('/')`-shaped requests across `api/src/**/*.test.ts`: none).

**Item 3 — `admin.ts:929`'s invite-email regex had real, measured quadratic backtracking. Fixed.**
The flagged pattern, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (used by `POST
/api/admin/workspaces/:id/invites` to validate an admin-supplied invite email), has two adjacent
`[^\s@]+` groups in the domain portion, separated only by a required literal `.` that neither class
excludes — so a rejected input with a long run of dots in that region has many ways to split across
the two groups, and the engine retries all of them before giving up.

**Correction to this ticket's own description, and to an earlier draft comment on this same
regex in `CHANGES.md`'s TRO-307 entry above (which had it right) versus this ticket's brief (which
did not):** measured directly (`node --eval`, this machine, this run — see the timing table in the
`isValidInviteEmail` doc comment in `admin.ts`), the pathological input is many dots **after** the
`@` (inside the ambiguous domain-vs-domain split), not before it. `".".repeat(n) + "@" + " "` (dots
before `@`) stayed O(n) — 0.06ms at n=40,000. `"a@" + ".".repeat(n) + " "` (dots after `@`) scaled
roughly with n²: 0.6ms at n=1,000, up to 886ms at n=40,000 (each 2x in `n` costing ~4x in time).
That is CodeQL's literal rule name — "polynomial", not "exponential" — for exactly this reason: two
adjacent unbounded groups over the same overlapping character set produce quadratic blowup, not the
classic `(a+)+` exponential shape.

Fix: split the string on `@` in code first (reject anything but exactly one `@`, both sides
non-empty), then validate each side with a regex that has only one unbounded quantifier live over
any given substring — `EMAIL_LOCAL_PART_REGEX = /^[^\s@]+$/` and `EMAIL_DOMAIN_REGEX =
/^[^\s@.]+(?:\.[^\s@.]+)+$/` (domain labels exclude `.`, so the boundary between them is the literal
dot itself, not two groups negotiating where it falls) — exported as `isValidInviteEmail` from
`admin.ts`. Compared systematically against the old regex across 17 representative cases while
designing the fix: identical accept/reject behavior except one case, `user@example..com` (a domain
with an empty label between two dots), which the old regex accepted and the new one correctly
rejects — a tightening, not a regression, of what a legitimate email/hostname looks like. Dotted
local parts (`first.last@...`) and multi-label domains (`sub.example.co.uk`) are still accepted;
verified in the new test suite.

**Regression coverage.**
- `api/src/app.spa-static-rate-limit.test.ts` (item 2, new file): builds a minimal fake `web/dist`
  (directory + `index.html`) in `beforeAll` so `createApp()`'s static-file branch actually
  activates (cleans up only what it created, in `afterAll`), then: confirms the fixture works,
  drives requests until the configured test-tier limit (25) is exceeded and asserts 429 on request
  #26 with a `statuses.slice(0, 25)` check that nothing before it was already wrong, and confirms
  exhausting the static-file budget does not throttle `/api/csrf-token` from the same source IP
  (proves the separate-bucket design). RED BEFORE / GREEN AFTER, verified directly: with
  `app.use(spaStaticLimiter)` temporarily commented out, the 429 assertion failed with "never saw a
  429 in 30 requests" and the bucket-isolation test's own setup assertion failed too (429
  expected, got 200) — both for the expected reason, both pass again with the line restored.
- `api/src/routes/admin.test.ts` (item 3, new file — no test file previously existed for
  `admin.ts`): 6 valid-email cases, 9 malformed-email cases (including the deliberate
  `example..com` tightening), and two timing-bounded ReDoS assertions. The primary one drives
  `isValidInviteEmail` with `"a@" + ".".repeat(200_000) + " "` and asserts completion under 500ms;
  RED BEFORE (verified separately): the OLD regex on the same 200,000-dot input took **20,798ms** on
  this machine, ~42x the ceiling — confirming this is a real fix, not a redundant test. A second
  assertion covers the "before the `@`" shape the ticket's brief originally named, which was already
  fast on the old code (a pin, included because the brief called it out, not because it was ever
  broken). EMPIRICAL CAVEAT: both timing ceilings are measured on this machine, in this run — a
  heavily loaded CI box could push the absolute numbers up, though the margin (500ms ceiling vs. an
  old-code baseline of ~20.8s at the same input size) is generous enough to absorb realistic
  machine-load variance.

**How to run it.**
```bash
cd api && source ../.factory-env
npx vitest run src/app.spa-static-rate-limit.test.ts src/routes/admin.test.ts
npx vitest run src/middleware/__tests__/rate-limit.test.ts src/middleware/__tests__/rate-limit-coverage.test.ts src/app.test.ts  # unchanged-behavior proof
```

**Rollback.** Revert the commit(s) on `fix/tro-308-codeql-followup` touching `api/src/app.ts`,
`api/src/middleware/rate-limit.ts`, `api/src/middleware/redis-rate-limit-store.ts`, and
`api/src/routes/admin.ts`. Restores the unprotected SPA catch-all (real gap — CodeQL will re-flag
`js/missing-rate-limiting` at `app.ts:440`) and the single-regex, quadratic-backtracking email
validator (real gap — CodeQL will re-flag `js/polynomial-redos` at `admin.ts:929`, and the crafted
pathological input can again cost ~20s of single-threaded event-loop time on this size of input, a
real DoS surface on an authenticated but not privileged-in-any-stronger-sense admin endpoint).
Neither rollback affects item 1 (no code changed for it).

---

## TRO-295 (TF-7 follow-up) — ALB security group split in two to keep the CloudFront-prefix-list rule expansion under AWS's rules-per-group quota

**The finding.** `terraform/security-groups.tf`'s single `aws_security_group.alb` carried both of
TF-7/TRO-278's CloudFront-only ingress rules (port 80 and port 443), each referencing
`data.aws_ec2_managed_prefix_list.cloudfront_origin_facing`. AWS counts a security-group rule that
references a prefix list against the "Rules per security group" quota as though expanded to one
rule per prefix-list entry, not as a single rule — TF-7's own CAUTION comment (already in the file,
above the two rules) already documented this and named two possible mitigations: (1) check the
account's live quota before `apply`, or (2) split the rules across separate security groups. This
ticket implements mitigation 2; mitigation 1 needs live AWS credentials this environment doesn't
have and is still a human's job (unchanged from TF-7).

**Premise check: the "two rules on one group" framing held.** Read the file before changing
anything, per standing rule — confirmed exactly two ingress rules on `aws_security_group.alb`
(ports 80 and 443), both referencing the one prefix list, nothing else referencing it anywhere else
in `terraform/`. `terraform/modules/security-groups/main.tf` (the separate module used by
`environments/dev` and `environments/shadow`) has its own `alb` security group but still uses
`cidr_blocks = ["0.0.0.0/0"]`, not the prefix list — TF-7's restriction was never ported there, so
it carries no quota-expansion risk and is out of this ticket's scope (a pre-existing inconsistency,
not touched here).

**What changed — `terraform/security-groups.tf`.**

- `aws_security_group.alb` now holds only the port-443 (HTTPS) ingress rule, plus its own egress
  rule (`Allow all outbound`) and a doc comment explaining the split.
- A new `aws_security_group.alb_http` holds the port-80 (HTTP) ingress rule, moved verbatim from
  the old `alb` resource, plus its own copy of the egress rule (duplicated rather than relied on
  via the ALB's shared-ENI rule union, so this group is self-contained). Both groups reference the
  same `data.aws_ec2_managed_prefix_list.cloudfront_origin_facing` — the split changes which quota
  bucket each rule's expansion counts against, not which traffic is allowed.
- **Note on naming vs. traffic reality:** despite the `_http` suffix suggesting a secondary
  redirect listener, port 80 is the port that actually carries CloudFront's origin traffic today
  (the `EB-API` custom origin's `origin_protocol_policy` is `http-only`, per `s3-cloudfront.tf`);
  443 is reserved for a possible future switch. Documented in both resources' comments so a future
  reader doesn't assume `alb_http` is the low-priority one.
- `aws_security_group.eb_instance`'s existing ingress-from-ALB rule still references only
  `aws_security_group.alb.id` (not both). Left as-is with a new comment explaining why: AWS's
  security-group-reference matching keys off the *source ENI's* group membership, not which group
  a rule names, so once the ALB's ENI carries both `alb` and `alb_http`, a rule naming either one
  still matches ALB-originated traffic. Verified against AWS's documented security-group-reference
  semantics, not run against live infrastructure (no credentials here).
- The CAUTION comment above the two (now split) resources is narrowed, not removed: it now states
  the split is done (mitigation 2) and still flags mitigation 1 (the live quota + prefix-list
  `max_entries` check) as unverified and still a human's job before any real `apply`.

**What changed — `terraform/elastic-beanstalk.tf`.** The `aws:elbv2:loadbalancer` / `SecurityGroups`
EB option setting (previously `value = aws_security_group.alb.id`) now lists both groups:
`value = join(",", [aws_security_group.alb.id, aws_security_group.alb_http.id])`. **Syntax
confirmed against this repo's own precedent, not invented:** this file already uses
`join(",", ...)` for other multi-value EB option settings on the same resource —
`aws:ec2:vpc`/`Subnets` (line ~112) and `aws:ec2:vpc`/`ELBSubnets` (line ~118) both build
comma-separated values the same way, and AWS's own docs for `aws:elbv2:loadbalancer`/`SecurityGroups`
describe it as accepting a comma-separated list of security group IDs. Also added
`output "eb_alb_http_security_group"` alongside the existing `eb_alb_security_group` output, and
added `alb_http_security_group` to the `eb_config_summary` map in `terraform/outputs.tf`, for parity
with the existing single-group outputs.

**How to run it.** Nothing to `terraform apply` — per this project's Terraform-ticket precedent
(TF-1/TF-3/TF-4/TF-5/TF-6/TF-8/TF-9/TF-10, TRO-303) and the explicit instruction for this ticket,
this is a code-only change; the AWS blueprint in this repo is not planned to be applied (see
TF-7/TRO-278's CHANGES.md entry). **Verification performed here:** downloaded Terraform v1.9.8
(darwin_arm64, matching TF-7's own precedent of a temp binary since none is installed in this
environment) and ran, from `terraform/`, with no backend/credentials involved:
- `terraform fmt -check -diff -recursive .` — clean, no diff.
- `terraform init -backend=false -input=false` then `terraform validate` — `Success! The
  configuration is valid.`
No `plan`/`apply`/`import` run against any real state, per the hard rule for this ticket.

**Regression test: inapplicable, same precedent as every other terraform-only ticket in this
project** (TF-1/TF-3/TF-4/TF-5/TF-6/TF-8/TF-9/TF-10, TRO-303) — this is an unapplied infrastructure
blueprint with no runtime code path to exercise.

**NOT verified (unchanged from TF-7, still a human's job before any real `apply`):**
- The account's actual "Rules per security group" quota (VPC section of Service Quotas console, or
  `aws service-quotas list-service-quotas --service-code vpc`).
- The prefix list's live `data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.max_entries`
  value, and therefore whether even the *split* per-group rule count (not just the pre-split
  combined count) stays under quota. The split narrows the risk; it does not by itself prove either
  group is now under the limit.
- Whether AWS's EB `SecurityGroups` option setting is additive (adds these groups alongside one EB
  creates) or replaces the group list outright — inferred from this repo's own multi-value-setting
  convention (`Subnets`/`ELBSubnets` above) and AWS's documented comma-separated-list format for
  this option, not confirmed against a live `apply`/`describe-environments`.

**Rollback.** Revert this commit (or the branch's merge commit) — the split is additive/mechanical
(new resource + a widened setting value), with no schema or state-destructive change, so a plain
`git revert` restores the single-`alb`-group shape TF-7 shipped. No state exists to reconcile today:
this blueprint has never been `apply`'d (per TF-7/TRO-278).

**If this has since been `apply`'d to a live account, a plain `git revert` is not safe by itself.**
`git revert` alone reverts `security-groups.tf` (removing `aws_security_group.alb_http` and its
port-80 rule) and `elastic-beanstalk.tf` (narrowing `SecurityGroups` back to one group) in the same
commit, so a subsequent `apply` of the reverted code removes both halves together and restores the
pre-split shape correctly. The danger is a **partial** revert — reverting only one of the two files
(e.g. removing `alb_http` from `security-groups.tf` while leaving the widened `SecurityGroups`
setting in `elastic-beanstalk.tf`, or the reverse) would either dangle a security-group reference to
a resource Terraform is about to destroy, or silently drop port-80 ingress while
`aws_security_group.alb_http` still exists unattached. Revert both files together in one `apply`,
never one at a time against live state.

---

## TRO-293 — three e2e tests asserted a per-row issue quick-menu that IssuesList does not render — deleted, not built

**Decision: dead/speculative tests (path b), not a missing feature.** TRO-286 (TEST-14) Part 1
tightened a vacuous conditional guard in `e2e/program-mode-week-ux.spec.ts` into a real assertion
and, in doing so, surfaced that the assertion targets UI that has never existed. Filed as this
follow-up to decide feature-vs-dead-test rather than build UI unilaterally.

**What was checked, not just what was read.** The tests' own `test.fixme()` docstring (added in
`2a97a2ad`) already named the root cause; this ticket verified it against the current tree rather
than trusting the comment:
- `grep -rn "⋮" web/src/` returns nothing anywhere in the frontend.
- `web/src/components/IssuesList.tsx`'s `renderIssueRow` → `IssueRowContent` renders only data
  columns (id, title, status, source, program, sprint, priority, assignee, updated) — no actions
  column, no hover-revealed button, no `aria-label` containing "menu" or "actions" on the row.
- The only per-row interaction on this component is right-click (`onContextMenu` →
  `handleContextMenu`, `IssuesList.tsx:986`), which opens a `ContextMenu` with a "Move to Week"
  submenu (`IssuesList.tsx:1281-1283`) — real, but reached by right-click, not a hover ⋮ button.
- **Equivalent-affordance check (not skipped):** a hover-revealed three-dot "Actions for {title}"
  button *does* exist elsewhere in the app — `web/src/pages/App.tsx:1141-1153`, a locally-scoped
  `IssuesList` component rendering the sidebar tree's issue rows. It is a different component in a
  different part of the 4-panel layout (contextual sidebar, not the Program-mode Issues tab table
  under test), and its menu (Change Status + Archive, `App.tsx:1160-1184`) has no "Assign to Week"
  option — the exact capability these tests required. So the closest real analog does not actually
  satisfy what the tests assert; it's not a case of "the tests just found it in the wrong place."
- The underlying capability the tests wanted (assign an issue to a sprint/week per row) is already
  real, already exercised, and does not need a quick-menu: `enableInlineSprintAssignment` renders an
  `InlineWeekSelector` dropdown directly in the sprint column (used by `WeekPlanningTab.tsx`, though
  not wired into `ProgramIssuesTab.tsx`, which is the tab these tests target), the right-click
  context menu's "Move to Week" submenu is available unconditionally, and bulk selection + toolbar
  "Move to Week" is covered by four passing tests in the same file/describe block (`issues table has
  checkbox column for bulk selection`, `selecting issues shows bulk action bar`, `bulk action bar has
  "Move to Week" dropdown`, `bulk "Move to Week" updates issues` — `program-mode-week-ux.spec.ts:679-773`).
- `git log --all --oneline -- '**/IssuesList*'` and `git log --all --oneline` for "quick menu" /
  "quick-menu" show no commit that ever added, then removed, a per-row quick-menu — this was never
  built and then cut, it was asserted without having been built. No mention in `docs/` or elsewhere
  in `CHANGES.md` of it as a planned feature; the only prior references are TRO-286's own note about
  this same gap.

**Derived-claim correction.** The ticket brief (based on the fixme docstring's own wording, "these
three tests") said three tests. Reading the file directly found **four** `test.fixme()` blocks
sharing that one docstring: `issue row has quick menu (⋮) button`, `quick menu has "Assign to Week"
option`, `quick menu "Assign to Week" shows available sprints`, and `quick menu can assign issue to
a sprint (full flow)` — all four define the identical `menuButton` locator and would fail on it
identically. The docstring undercounted its own scope by one. Deleted all four, per this ticket's
own "no `test.fixme()` left behind for this either way" done-criterion — stopping at three because
the brief said three would have been trusting the brief's count over the file itself.

**What changed.** Deleted the four `test.fixme()` blocks and their shared docstring comment from
`e2e/program-mode-week-ux.spec.ts` (`Phase 4: Issues Tab Filtering` describe block, was lines
775-885). The describe block is not empty — it retains 12 other real tests, including the four
"Move to Week" tests listed above that already cover the underlying capability. No other test in the
file was touched.

**Out of scope, left alone.** `e2e/context-menus.spec.ts:151` (`three-dot menu on team member row
opens context menu`) is the "same class of gap" the fixme docstring cross-references, but targets a
different component (`web/src/pages/TeamDirectory.tsx`, not `IssuesList.tsx`) and a different
feature (team directory, not issues). TRO-293's brief scopes to the per-row *issue* quick-menu only;
that finding is a separate decision for its own ticket.

**No new regression test.** This removes assertions that never described real behavior — there is
no defect to lock in a test against. Adding a test here would either re-assert the same nonexistent
UI (pointless) or test that the button is absent (untestable-as-a-regression: absence-of-a-feature
isn't a regression surface, and a `not.toBeVisible()` assertion would silently stop meaning anything
the moment any unrelated button was added to the row). The four real "Move to Week" tests already
in the file are the regression coverage for the capability these dead tests gestured at.

**Rollback.** `git log --oneline -- e2e/program-mode-week-ux.spec.ts` then check out `2a97a2ad`'s
version of the file (or `git show 2a97a2ad:e2e/program-mode-week-ux.spec.ts`) to restore the four
`test.fixme()` tests and their docstring verbatim, if the quick-menu is ever actually built.

---

## TRO-239 — [TF-6] Secret generators have no `keepers` — regeneration would silently log out every user and rotate the live DB password

**What was broken.** `random_password.db_password` and `random_password.session_secret` had no
`keepers` argument in either place they're declared:

- `terraform/database.tf:1` (flat root — the authoritative prod config per `terraform/README.md`'s
  TF-2 resolution) and `terraform/ssm.tf:129`.
- `terraform/modules/aurora/main.tf:1` and `terraform/modules/ssm/main.tf:112` — the module
  counterparts consumed by `terraform/environments/dev` and `terraform/environments/shadow`
  (shadow is the UAT stack per `.claude/CLAUDE.md`). Found by `grep -rn "random_password"
  terraform/` while scoping the fix — same defect, same finding, second location, same pattern TF-1
  hit (flat root fixed under TRO-234, module gap closed later under TRO-303). Fixed both in this
  pass rather than filing a follow-up.

`random_password` only regenerates when its `keepers` change or Terraform state is lost — so this
was not active churn — but with no `keepers` argument at all, nothing on the resource records that
the empty trigger set is deliberate. An accidental state loss (bad `terraform state rm`/reimport) or
an explicit `-replace`/`taint` on either resource would silently rotate the live secret as a side
effect of an ordinary-looking apply:

- `random_password.db_password` regenerating rotates the live Aurora master password
  (`master_password` on `aws_rds_cluster.aurora`, mirrored into the `DATABASE_URL`/`DB_PASSWORD` SSM
  parameters the API reads at boot).
- `random_password.session_secret` regenerating changes the key that signs every `express-session`
  cookie (`SESSION_SECRET`, read by `api/src/config/ssm.ts:150` and set into `process.env` at line
  157) — every existing session's signature check fails on its next request, logging out every
  active user simultaneously, with no warning.

**What changed.** Four resources, four files — a comment plus `keepers = {}` on each, no other
argument touched:

- `terraform/database.tf:1-22` (`random_password.db_password`)
- `terraform/ssm.tf:128-149` (`random_password.session_secret`)
- `terraform/modules/aurora/main.tf:1-23` (`random_password.db_password`, dev/shadow)
- `terraform/modules/ssm/main.tf:111-132` (`random_password.session_secret`, dev/shadow)

Each comment records the specific blast radius for that resource (quoted above) and states that
`keepers = {}` is deliberate — nothing currently triggers rotation — with a note on where a real
trigger value would go if intentional rotation is ever wanted. The `session_secret` comments also
record the ticket's second consideration: rotating that secret on purpose should be an announced,
documented operation (a runbook/maintenance window), not something that rides along as a Terraform
side effect — not implemented here, just decided against building a rotation mechanism that itself
becomes a new footgun.

**Verified `keepers = {}` does not itself trigger rotation.** This was the load-bearing risk in this
change — if adding the argument forced a replace, the fix would cause exactly the incident it's
meant to prevent. Tested empirically in a throwaway local-backend config (not this repo's state,
`hashicorp/random` 3.9.0 — same version pinned in `terraform/.terraform.lock.hcl`): created a
`random_password` with no `keepers`, applied it, then added `keepers = {}` and re-planned/applied.

```
$ terraform plan   # after adding keepers = {} to an already-applied resource
  # random_password.test_secret will be updated in-place
  ~ resource "random_password" "test_secret" {
        id          = "none"
      + keepers     = {}
        # (12 unchanged attributes hidden)
    }
Plan: 0 to add, 1 to change, 0 to destroy.
```

`0 to add, 1 to change, 0 to destroy` — an in-place update, not a replace. Applied it and compared
the `result` attribute before and after: byte-identical. Going from "no `keepers` argument" to
`keepers = {}` is a metadata-only change to the resource; it does not read as a keeper-value change
and does not force new.

**How to run it / verify it.** There is nothing to "run" — this is a documentation and
default-safety change to existing resource declarations, not new infrastructure. What was actually
run, using a Terraform binary from a prior job's scratch cache (v1.9.8, satisfies this repo's
`required_version >= 1.6.0`; not committed to the repo):

```bash
cd terraform && terraform fmt -check -recursive .   # exit 0, no diff, before and after
cd terraform && terraform init -backend=false -input=false && terraform validate   # Success!
cd terraform/environments/dev && terraform init -backend=false -input=false && terraform validate   # Success!
cd terraform/environments/shadow && terraform init -backend=false -input=false && terraform validate   # Success!
```

All three consuming roots (flat prod root, `environments/dev`, `environments/shadow`) report
`Success! The configuration is valid.` with 0 errors and 0 warnings, both before and after this
change. **No `terraform plan` or `terraform apply` was run against any real backend or AWS
credentials** — there are none available in this environment (same documented gap as
TF-1/TF-2/TF-3/TRO-303), and this ticket explicitly prohibits it regardless. The `terraform plan`
shown above ran against a disposable scratch config to answer one narrow question (does `keepers =
{}` force-replace an existing resource); it never touched this repo's Terraform state or any live
credential.

**No vitest regression test applies.** Same precedent as TF-1/TF-3/TF-4/TF-5/TF-9/TRO-303: this is a
Terraform-only comment-and-argument change with no application code path for vitest to exercise. The
evidence is the `fmt`/`validate` output above (clean before and after) plus the local `keepers = {}`
in-place-update proof. `gate.sh`'s `regression-test` check is expected to fail honestly here rather
than have a fake test manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf-6-secret-keepers`. This removes the four
comments and the `keepers = {}` line from all four files, returning the resources to their
pre-TRO-239 state (no `keepers` argument, no blast-radius comment). No live AWS state or credential
is touched either way, since no `apply` was ever run — and per the verified test above, the revert
itself is also a no-op update in place, not a rotation.

---

## TRO-307 — [SECURITY] CodeQL: missing rate limiting across api/src/routes

**What CodeQL reported.** `js/missing-rate-limiting` (High) has 352 open alerts as of 2026-07-31
(`gh api repos/troysatchell/ship/code-scanning/alerts`), spread across nearly every file in
`api/src/routes/` — 50 in `weeks.ts`, 33 in `workspaces.ts`, 30 in `issues.ts`, 24 in `admin.ts`, 18
in `weekly-plans.ts`, 6 in `search.ts`, and ~25 more files. This ticket's brief named
`weekly-plans.ts`, `weeks.ts`, `admin.ts`, `search.ts` (98 of the 352) as the confirmed-pre-existing
subset to fix.

**What did NOT reproduce, checked against the specific case rather than assumed from the alert
text.** Every one of those routes is mounted under `/api/` in `api/src/app.ts`, and `app.ts` has
applied `createApiRateLimiters()`'s two limiters (`perSourceIpLimiter`, `perIdentityLimiter`) to
every `/api/*` request since TRO-172 (commit `9aa2d1c`) — before any of these alerts existed.
OBSERVED, not inferred: forcing `NODE_ENV=production` and hammering `GET /api/weekly-plans` (one of
the exact CodeQL-flagged lines, `weekly-plans.ts:329`) 601 times on one session returns HTTP 429 at
request #601, exactly matching the documented production `identityLimit` of 600
(`rate-limit.ts:118`) — with **zero code changes**. Repeated for one representative route in each of
the other three named files (`weeks.ts:587`, `admin.ts:14`, `search.ts:17`) with the identical
result. So "these routes previously had no rate limiting" does not hold as a runtime claim; the
route-level DoS protection the alert cares about was already there.

**What the actual fix is, and its confidence level.** DERIVED, not CodeQL-confirmed — this sandbox
has no `codeql` CLI to test the query directly. The most likely reason CodeQL still flags routes
that are, in practice, already protected: `app.ts` built the limiter array in a different file
(`middleware/rate-limit.ts`, via `createApiRateLimiters()`) and mounted it by **spreading** that
returned array into one `app.use('/api/', ...)` call — an interprocedural array-return, then a
spread into a variadic call, one file removed from the `rateLimit()` calls that produced it. That
indirection is a known-plausible blind spot for static rate-limiter detection. The fix removes it
without changing behavior:
- `api/src/middleware/rate-limit.ts`: `createApiRateLimiters`'s return type changed from
  `RequestHandler[]` to the 2-tuple `[RequestHandler, RequestHandler]`, so destructuring it is fully
  typed (no `undefined`, no `!`, no `as` needed).
- `api/src/app.ts`: `const [perSourceIpLimiter, perIdentityLimiter] = createApiRateLimiters(...)`,
  then two explicit calls — `app.use('/api/', perSourceIpLimiter);` /
  `app.use('/api/', perIdentityLimiter);` — replacing the single
  `app.use('/api/', ...apiLimiters)` spread. Same two middleware functions, same path, same order;
  Express creates one layer per handler function either way. Confirmed behavior-identical: the full
  pre-existing `rate-limit.test.ts` and `app.test.ts` suites (23 tests) pass unchanged.

**Behavior change for real users, stated plainly.** None from this specific diff — the protection
already existed and already returns 429 past the documented limits (production: 600 req/min per
identity, 6,000 req/min per source IP). This ticket does not raise or lower either ceiling.

**Scope not covered — filed as follow-up.** 254 of the 352 open alerts are in route files this
ticket did not name (`workspaces.ts`, `issues.ts`, `projects.ts`, `programs.ts`, `documents.ts`, and
~20 others) — same mechanism, same already-covered status expected (all mount under `/api/` after
the same `app.ts` chain), not independently re-verified per file. A candidate follow-up ticket: audit
whether the app.ts fix here closes some/all of the 352 once CodeQL re-scans the PR, and only chase
per-route fixes for whatever, if anything, remains open — do not assume a per-file fix is needed
before that evidence exists.
`api/src/app.ts:424-446` (the SPA static-file catch-all, `js/missing-rate-limiting` alert #7) is a
**genuinely different, unprotected** route — it is registered outside the `/api/` prefix the limiter
chain matches, so it gets none of this protection. Different root cause (a real gap, not a
CodeQL-legibility issue) and only reachable when `web/dist` exists (production/deployed builds, not
local dev/test), so exercising it needs test infrastructure this ticket didn't build. Left for a
separate ticket.
`api/src/routes/admin.ts:929`'s separate `js/polynomial-redos` alert (different rule, different root
cause) was confirmed real by reading the code — `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` doesn't exclude `.`
from either `[^\s@]+` group, so a string with repeated `.` after the `@` has many ways to split
across the two groups and the literal `\.`, which is polynomial-time backtracking-prone in a
backtracking regex engine. Not touched — explicitly out of scope per this ticket's brief.

**Regression coverage — `api/src/middleware/__tests__/rate-limit-coverage.test.ts`.** Two kinds,
labeled distinctly because only one is red-before-green:
- *Red-before-green* (`app.ts mounts via explicit non-spread app.use calls`): reads `app.ts`'s
  source and asserts the `/api/` mount does not spread an array into `app.use`, and that both named
  limiters are mounted individually. Verified failing for the right reason on unfixed code (`git
  stash` the `app.ts` edit, rerun — both assertions fail on the spread and the missing explicit
  calls; `git stash pop` restores the fix, both pass).
- *Pin, not red-before-green* (`production ceiling already covers the routes CodeQL flagged`):
  `it.each` over one route per named file (`/api/weekly-plans`, `/api/weeks`,
  `/api/admin/workspaces`, `/api/search/mentions`), each hammered to 601 requests under
  `NODE_ENV=production`, asserting 429 at exactly request 601. These already passed on `main` before
  this ticket's code change — same category as the TRO-302 tests in `rate-limit.test.ts` — and exist
  so a future change (narrowing the `/api/` mount, or reintroducing a spread that happens to also
  break coverage) cannot silently remove protection CodeQL is watching for.

**How to run it.**
```bash
cd api && source ../.factory-env
npx vitest run src/middleware/__tests__/rate-limit-coverage.test.ts
npx vitest run src/middleware/__tests__/rate-limit.test.ts src/app.test.ts  # unchanged-behavior proof
```

**Rollback.** Revert the commit(s) on `fix/tro-307-rate-limiting` touching `api/src/app.ts` and
`api/src/middleware/rate-limit.ts`. Restores the single spread-based `app.use('/api/', ...apiLimiters)`
call and the `RequestHandler[]` return type — functionally identical to the fixed state (both were
proven behavior-equivalent above), so rollback carries no functional risk; it only returns the code
to being static-analysis-illegible in the same way it was before this ticket.

---

## TRO-291 — Login error offered no recovery guidance for invalid credentials (WCAG 3.3.3)

**What was broken.** `api/src/routes/auth.ts:54,89` deliberately returns the exact same message —
`"Invalid email or password"` — for both "no such account" and "wrong password," a security choice
against account enumeration that is correct and **unchanged by this ticket**. `web/src/pages/
Login.tsx` rendered that string verbatim inside a `role="alert"` div and offered zero recovery
affordance anywhere on the page. Confirmed by grep rather than assumed: `grep -rni "forgot"
web/src api/src` matched one unrelated code comment (a CLI test docstring, "caller that forgot
the..."); `grep -rni "reset.password\|reset_password\|resetpassword" web/src api/src` matched
nothing; `grep -rni "recovery" web/src api/src` matched only unrelated usages (cache-corruption
recovery in `queryClient.ts`, error-logging-recovery comments in `BacklinksPanel.*`, a DB-recovery
test in `ensureDatabase.test.ts`) — none about account/password recovery. Listing every admin/
invite/password-adjacent endpoint (`grep -n "router\.\(get\|post\|put\|patch\|delete\)"
api/src/routes/admin.ts api/src/routes/admin-credentials.ts api/src/routes/invites.ts`) shows no
`/password/reset` or `/forgot-password` route, and `web/src` has no forgot-password page or link.
That's the WCAG 3.3.3 (Error Suggestions) gap: the error was shown, but nothing told the user what
to do next.

**What changed.** `web/src/pages/Login.tsx`'s existing error `<div role="alert">` still renders
`{error}` completely unmodified — the security-sensitive API string is untouched. A new line is
appended inside the same alert, scoped by an exact string match (`error === 'Invalid email or
password'`) so it only appears for the credential-failure case and not for client-side validation
errors ("Email address is required") or network failures ("Failed to sign in..."):

> Don't have an account, or can't remember your password? Contact your workspace admin for help.

This app has no self-service password-reset flow (confirmed by the grep above, and by `grep -n
"router\.\(get\|post\|put\|patch\|delete\)" api/src/routes/admin.ts api/src/routes/admin-credentials.ts
api/src/routes/invites.ts`, which lists every admin/invite endpoint and none of them reset an
existing user's password) — so "contact your workspace admin" is the one real recovery path today,
not an invented one. `web/src/pages/InviteAccept.tsx:173` already uses the same "contact your
workspace admin" pattern for its own expired-invite state, so this isn't a new UI idiom for the app.

Also tightened `e2e/accessibility-remediation.spec.ts`'s `'login errors provide recovery
suggestions'` test (WCAG 3.3.3 describe block), which previously only asserted the error text was
longer than 10 characters — a proxy weak enough that `"Invalid email or password"` alone (the
pre-fix, no-guidance state) already satisfied it. It now asserts the alert both still contains
`'Invalid email or password'` verbatim and matches `/workspace admin/i`.

**Not verified.** Screen-reader announcement of the new text was not checked with an actual screen
reader (no VoiceOver/NVDA session was run against this change) — this is engineering judgment that
the added text satisfies WCAG 3.3.3's "suggestion is provided" requirement, not a confirmed
announcement result. Per the A11Y-1 lesson elsewhere in this file, that gap is real: axe/lint-level
checks cannot confirm what assistive technology actually speaks.

**How to run it.**

```bash
pnpm --filter @ship/web test -- src/pages/Login.recoveryHint.test.tsx   # 3/3 pass (new)
pnpm --filter @ship/web test -- src/pages/Login.test.tsx                # 2/2 pass (unaffected)
pnpm exec playwright test e2e/accessibility-remediation.spec.ts -g "login errors provide recovery suggestions"
```

**How to roll it back.** `git revert <this commit>` removes the `Login.tsx` recovery line, the new
`web/src/pages/Login.recoveryHint.test.tsx` regression test, the tightened e2e assertion, and this
entry. If reverting by hand: restore `Login.tsx`'s error `<div role="alert">{error}</div>` to have
no additional child content, `git rm web/src/pages/Login.recoveryHint.test.tsx`, revert the e2e
assertion in `accessibility-remediation.spec.ts` back to the length-only check (or leave the
stronger version — reverting it is not required for the app to keep working), and delete this
entry. No API or database change was made — `api/src/routes/auth.ts` is untouched.

---

## TRO-205 — [BUN-9] First paint blocks on a third-party Google Fonts stylesheet

**What was broken.** `web/index.html` carried two `<link rel="preconnect">`s to
`fonts.googleapis.com`/`fonts.gstatic.com` plus a render-blocking
`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">`
ahead of the entry script — Vite/Tailwind starter boilerplate that survived into production. Ship is
deployed at `ship.awsdev.treasury.gov` and is otherwise fully self-hosted (own icons, own CSS, own
PWA manifest); this was the one remaining third-party runtime dependency on the first-paint critical
path — a cross-origin round trip to Google from a `.treasury.gov` domain before the browser could
even start fetching the font.

**What changed.**
- Added `@fontsource/inter` (^5.3.0, MIT-licensed) as a `web` dependency. It ships the actual woff2/
  woff files plus pre-written `@font-face` CSS, split one file per weight — the standard way to
  self-host a Google Font in a Vite app without hand-rolling subsetting.
- `web/src/index.css` now imports `@fontsource/inter/400.css`, `/500.css`, `/600.css` — the same
  three weights the removed Google Fonts URL requested (`wght@400;500;600`, no `ital` axis, so
  normal style only) — ahead of the `@tailwind base/components/utilities` directives, so the
  `@font-face` rules land ahead of Tailwind's generated layers in the cascade.
- Removed the two `preconnect` links and the stylesheet `<link>` from `web/index.html`, replacing
  them with a comment pointing at this ticket and at `src/index.css`.
- No change needed to `tailwind.config.js` or `body`'s `font-family` in `index.css` — both already
  named the bare family `'Inter'`, which now resolves to the self-hosted `@font-face` instead of the
  Google-served one.
- `@fontsource/inter`'s per-weight CSS files bundle one `@font-face` block per Unicode-range subset
  (latin, latin-ext, cyrillic, cyrillic-ext, greek, greek-ext, vietnamese) — the same structure
  Google's own `css2` endpoint returns by default for a `family=Inter` request with no `text=`
  parameter. Kept that full set rather than switching to the `latin`-only variant: this is a project
  and issue tracker where user-entered names/content can contain non-Latin-1 characters, and each
  `@font-face` block is scoped by `unicode-range`, so a browser only downloads the woff2 subset that
  actually matches the text on the page — derived from standard `unicode-range` browser behavior,
  not measured with a network trace in this session.

**Evidence.**
- Regression test: `web/src/selfHostedFonts.test.ts` (6 assertions). Confirmed red first by
  `git stash push -- web/index.html web/src/index.css` (reverting to the pre-fix state while keeping
  the new test and the installed `@fontsource/inter` dependency), then
  `npx vitest run src/selfHostedFonts.test.ts` from `web/`: 4 of 6 failed for the expected reasons
  (`index.html` still matched `fonts.googleapis.com`/`fonts.gstatic.com`; a `<link>` tag still
  pointed at `https://fonts.googleapis.com`; `index.css` had no `@fontsource/inter` imports; the
  cascade-order check had nothing to find). Restored the fix with `git stash pop`; the same command
  then passed 6/6.
- Built output: `cd web && pnpm build`, then `grep -rn "fonts.googleapis\|fonts.gstatic" dist/`
  returned no matches (grep exit code 1). `dist/assets/index-*.css` contains `@font-face` rules
  referencing content-hashed local files (`inter-latin-400-normal-*.woff2`, etc.), and those files
  are present under `dist/assets/`.
- `pnpm --filter @ship/web test`: 66 test files / 492 tests passed (no new failures against the
  known-empty quarantine in `audit/factory/quarantine.json`).
- `pnpm --filter @ship/web type-check`: clean.

**How to run it.**

```bash
pnpm --filter @ship/web build
grep -rn "fonts.googleapis\|fonts.gstatic" web/dist/   # expect no matches
pnpm --filter @ship/web test -- src/selfHostedFonts.test.ts
```

**Not verified.** Actual visual rendering of Inter in a browser, and an observed (vs. derived)
browser network trace confirming only the `latin` woff2 subset is fetched for English-only content —
no browser is available in this environment. The regression test and the `dist/` grep are static/
build-output checks, not a rendered-page observation.

**Rollback.** Revert `web/index.html` (restore the two `preconnect` links and the
`fonts.googleapis.com/css2?family=Inter...` stylesheet link), revert `web/src/index.css` (remove the
three `@fontsource/inter` `@import`s), remove `web/src/selfHostedFonts.test.ts`, and run
`pnpm --filter @ship/web remove @fontsource/inter` to drop the dependency and its lockfile entry.

---

## TRO-214 — [TS-9] web build and script files are never type-checked

**What was broken.** `web/tsconfig.json`'s `include` is `["src"]` only, and `web/tsconfig.node.json`
— the Vite companion config that would cover build tooling — did not exist. Neither
`pnpm --filter @ship/web type-check` nor the `tsc && vite build` step in `web/package.json`'s
`build` script ever type-checked `web/vite.config.ts` or `web/scripts/generate-icon-types.ts` (the
latter generates the `IconName` union type the rest of `web` depends on, per TRO-201/BUN-5). Effort
is XS and, per the finding, retires 0 violations — the point is closing the coverage gap, not fixing
bugs the gap hid.

**What changed.**
- Added `web/tsconfig.node.json`, extending `../tsconfig.json` like the existing `web/tsconfig.json`
  does, but targeting Node instead of the browser: `module: "ESNext"`/`moduleResolution: "bundler"`
  (required for `generate-icon-types.ts`'s `import.meta.url`), `types: ["node"]`, `noEmit: true`.
  `include` is `["vite.config.ts", "scripts/**/*.ts"]` — exactly the two files/dirs the finding
  named. Deliberately did **not** add a `references` array to `web/tsconfig.json` — that requires
  `tsc --build` semantics to actually invoke the referenced project, which `tsc --noEmit` (what
  `type-check` runs) does not do on its own; verified this empirically before picking the approach
  below.
- Changed `web/package.json`'s `type-check` script from `"tsc --noEmit"` to
  `"tsc --noEmit && tsc --noEmit -p tsconfig.node.json"` — two explicit invocations, so both configs
  are actually exercised by `pnpm --filter @ship/web type-check` (and by root `pnpm type-check`,
  which runs it via `pnpm --recursive run type-check`).
- The new coverage surfaced one real, pre-existing type error (in scope by the ticket's own terms:
  "if adding type-checking surfaces a real type error... fix it as part of this ticket"):
  `vite.config.ts:18` called `parseInt(match[1], 10)` where `match[1]` types as `string | undefined`
  under the root `tsconfig.json`'s `noUncheckedIndexedAccess: true` (inherited by `web/tsconfig.json`
  and now by `tsconfig.node.json`). The regex's capture group (`(\d+)`) is mandatory, so `match[1]`
  is always defined whenever `match` itself is truthy — a real latent gap in the compiler's
  visibility, not a runtime bug. Fixed by binding the captured group to a variable and narrowing
  with a plain truthy check (no `!`, no `as`):
  `const capturedPort = match?.[1]; if (capturedPort) return parseInt(capturedPort, 10);`
- `web/scripts/generate-icon-types.ts` type-checked clean under the new config with no changes — its
  behavior (the BUN-5 icon-glob generator logic) was not touched.

**Regression proof — procedural, not a vitest file.** This is a build-tooling change with no
application code path a vitest test could assert against (same class as TRO-292/TRO-294 above, both
of which used procedural proof for the same reason: no test paths for `.gitignore` rules or Markdown
strings either). `scripts/factory/gate.sh`'s G6 (regression-test present) is expected to fail on this
branch for that reason — the evidence is the command sequence below, run against this exact
worktree:

```bash
# 1. BEFORE the fix (web/tsconfig.node.json absent), a deliberate type error
#    injected into vite.config.ts's getApiPort() (string assigned to number) —
#    proves the gap:
pnpm --filter @ship/web type-check
# > tsc --noEmit
# (exit 0 — the deliberate error is NOT caught; vite.config.ts isn't included
# by any tsconfig `tsc --noEmit` reads)

# 2. AFTER adding web/tsconfig.node.json and updating the type-check script,
#    with the SAME deliberate error still in place:
pnpm --filter @ship/web type-check
# > tsc --noEmit && tsc --noEmit -p tsconfig.node.json
# vite.config.ts(11,9): error TS2322: Type 'string' is not assignable to type 'number'.
# vite.config.ts(21,32): error TS2345: Argument of type 'string | undefined' is not
#   assignable to parameter of type 'string'.
# (exit 2 — now caught, plus the real pre-existing `match[1]` error above)

# 3. Removed the deliberate error, fixed the real one, reran:
pnpm --filter @ship/web type-check
# (exit 0 — clean)
```

`git diff` against `web/vite.config.ts` at each step confirms the deliberate error left no residue
(the file matches its pre-ticket content except for the `capturedPort` fix).

**How to run it.**

```bash
pnpm --filter @ship/web type-check   # now runs both tsconfig.json (src) and tsconfig.node.json
pnpm type-check                       # root, runs it for all packages via --recursive
pnpm build                            # unaffected — build's own `tsc` step still targets src only
```

**Rollback.** Revert `web/tsconfig.node.json` (delete it) and `web/package.json`'s `type-check`
script back to `"tsc --noEmit"`. Also revert the `match[1]` → `capturedPort` change in
`web/vite.config.ts:14-18` if desired, though that portion is a correctness fix independent of the
config change and safe to keep either way.

---

## TRO-230 — [TEST-8] Landing page and org chart had zero test coverage; org chart was the real gap

**Scope correction to the ticket brief (verified, not assumed).** TEST-8 names two zero-coverage
routes: `/dashboard` and `/team/org-chart`. The `/dashboard` half is already closed —
`web/src/pages/Dashboard.test.tsx` exists, and TEST-1/TRO-223 fixed the root `pnpm test` invocation
that used to skip the whole `web/` package. Ran it directly to confirm rather than take the ticket
text on faith: `npx vitest run src/pages/Dashboard.test.tsx` from `web/` → **7/7 pass**. `web/
vitest.config.ts` has no `include` restriction, so `pnpm --filter @ship/web test` already picks this
file up today, with no change needed. This ticket's entire scope is therefore
`web/src/pages/OrgChartPage.tsx`, which genuinely had none: `find web/src -iname '*orgchart*'`
returned only the page component itself, and `grep -rEl 'org-chart|orgchart' e2e/` returned nothing
(basic `grep` treats `|` literally rather than as alternation; `-E` is required for this command to
actually search for either term rather than the single literal string `org-chart|orgchart`).
`/my-week` (the actual `/` redirect target, flagged separately in TEST-8 for flaky e2e coverage) is
explicitly out of scope here — that's TEST-3, a separate open ticket.

**What was added.** `web/src/pages/OrgChartPage.test.tsx` — 5 tests, Vitest + Testing Library,
`@/lib/api`'s `apiGet`/`apiPatch` mocked via `vi.mock` (real `Response` instances built with
`new Response(...)`, per the TS-8 lesson against `as any`-shaped mocks) and `@/contexts/
WorkspaceContext`'s `useWorkspace` mocked to `isWorkspaceAdmin: false` (keeps the drag-and-drop
`DndContext` branch out of scope — that's a separate interaction surface from "does the hierarchy
render," left uncovered here).

What each test actually asserts, and why it's meaningful rather than vacuous:
- **Loading → populated transition.** Holds the mocked fetch open, asserts the `Loading...` text and
  absence of `role="tree"` synchronously, resolves it, then `findByRole('tree', { name:
  'Organization chart' })` — exercises the real async data flow with Testing Library's polling
  `findBy*`, no fixed sleep.
- **Hierarchy correctness.** Three people (two roots, one report), queried by `getByRole('treeitem',
  { name: /.../  })` — not by class or test id. Asserts `aria-level="1"` on both roots and
  `aria-level="2"` on the report, which only passes if `buildTree`'s `user_id`-keyed parent lookup
  actually nests the child under the right parent. Also asserts the role/email text renders inside
  each person's own `treeitem` (via `within(...)`) and that the header's `"3 people"` count reflects
  the fetched data.
- **Empty state.** Empty array from the mocked fetch → asserts `"No reporting hierarchy configured"`
  and the absence of `role="tree"`.
- **Error states (two).** A rejected fetch promise, and a resolved-but-non-`ok` (403) response — both
  assert the page falls back to the same empty-hierarchy message rather than hanging on `Loading...`
  forever or throwing. This is the component's actual behavior: `OrgChartPage.tsx` has no dedicated
  error UI, only a `console.error` and a `finally` that clears `loading`; the test locks in that the
  `finally` still runs on the error path, which is exactly the kind of regression ("someone drops the
  `finally`, the page spins forever") a from-scratch coverage ticket should catch.

**Red-before-green proof (from-scratch ticket, no existing bug to reproduce).** Wrote the test file
first and confirmed the intended-passing state, then broke real component logic to prove the
hierarchy assertion isn't vacuous: temporarily changed `OrgChartPage.tsx`'s `buildTree` parent-lookup
condition from `if (p.reportsTo)` to `if (false && p.reportsTo)` (every person becomes a root,
`reportsTo` is ignored). Re-ran the suite — the hierarchy test failed for the right reason
(`expected aria-level "2", received "1"`), all 4 others still passed. Reverted the change (`git diff`
confirmed clean) and re-ran — 5/5 green again. This is the red/green evidence for a ticket whose
"bug" is the absence of any test, not a defect to fix: it demonstrates the new assertion actually
exercises the tree-nesting logic rather than just checking the container rendered.

**How to run it.**

```bash
pnpm --filter @ship/web test -- src/pages/OrgChartPage.test.tsx   # 5/5 pass
pnpm --filter @ship/web test                                      # picked up automatically, no include restriction
```

**Not covered by this ticket (noted, not fixed).** No bug was found in `OrgChartPage.tsx` while
writing these tests. Drag-and-drop reassignment (`handleDragEnd`, the `DndContext` branch gated on
`isWorkspaceAdmin`) and the search/debounce/auto-expand-ancestors behavior are real, more complex
interaction surfaces in this component that remain untested after this ticket — left out
deliberately to keep this fix scoped to closing TEST-8's "zero coverage" finding (render/populated/
empty/error), not to reach full component coverage in one pass.

**How to roll it back.** `git revert <this commit>` removes the new test file, this `CHANGES.md`
entry, and this ticket's `audit/factory/review-findings.jsonl` records — the complete rollback. If
reverting by hand instead, `git rm web/src/pages/OrgChartPage.test.tsx`, delete this entry (a manual
removal that leaves this entry in place would describe a test file that no longer exists), and
remove or explicitly retain the TRO-230 lines in `review-findings.jsonl` (that file is an append-only
audit log by design — retaining it and just noting the ticket rolled back is also a legitimate
choice; `git revert` is the version that keeps this decision consistent automatically). No
production code was changed either way (the `buildTree` edit used for the red/green proof was
reverted before committing and never shipped). Reverting returns `OrgChartPage` to zero test
coverage — TEST-8 reopened for the org-chart half only, since the `/dashboard` half's fix (TRO-223)
lives on a separate commit untouched by this one.

---

## TRO-232 — [TEST-10] E2E worker auto-sizing collapses to 1 worker on macOS

**What was broken.** `playwright.config.ts`'s `getWorkerCount()` derived local worker count from
`os.freemem()`. macOS deliberately keeps reported free memory near zero — spare RAM goes to
filesystem cache and memory compression instead of being reported "free" — so `os.freemem()` is not
a meaningful "available memory" signal there. The audit measured this directly on a 24GB/14-core Mac:
`os.totalmem()` 24.0GB, `os.freemem()` **0.3GB**, giving `memoryBasedLimit =
floor((0.3 − 2) / 0.5) = −4`, clamped to `Math.max(1, Math.min(-4, 14))` = **1 worker** — a ~4x
slowdown (measured suite time was ~9 minutes at `PLAYWRIGHT_WORKERS=4`, the value every audit
measurement pinned) with no error or warning. Re-ran the exact numbers against this worktree's own
machine (also a 24GB/14-core Mac, `os.freemem()` measured at 0.35GB during this fix) and got the same
collapse from the old logic — this is not a one-machine anecdote.

**CI is unaffected — observed, not inferred.** `getWorkerCount()` (now `computeE2eWorkerCount()`,
see below) checks `if (isCI) return 4;` *before* the memory calculation runs at all
(`playwright.config.ts`'s call site passes `isCI: !!process.env.CI`, matching the original
`if (process.env.CI)` short-circuit at old `playwright.config.ts:31-33`). CI never reaches the
buggy code path, with or without this fix. This ticket is a local-developer-experience fix only —
it does not change, and was never going to change, anything about CI's worker count. A developer who
already sets `PLAYWRIGHT_WORKERS` explicitly was also unaffected before this fix (that override wins
over everything, both before and after) and remains unaffected now.

**What changed.** Extracted the calculation out of `playwright.config.ts` into a new pure, exported
function, `computeE2eWorkerCount()` in `web/src/lib/computeE2eWorkerCount.ts` — chosen over the other
two ticket-sanctioned approaches (a universal `Math.max(4, ...)` floor, or leaving the calculation
inline) because a `totalmem()`-based fraction applied only on `darwin` fixes the actual mechanism
(macOS hides "free" memory, not "total" memory) without hardcoding a fixed worker count that would
over-provision a genuinely small/low-memory Mac. Non-Darwin platforms (Linux, CI) keep the original
`os.freemem()`-based math byte-for-byte unchanged — the audit's own text calls that heuristic "sound
on Linux and wrong on Darwin," so only the wrong half changes.

- On `platform === 'darwin'`: `memoryBasedLimit = floor((totalMemGB * 0.5 − 2) / 0.5)` instead of
  `floor((freeMemGB − 2) / 0.5)`. On the audit's measured machine this now computes 14 (capped at
  `cpuCores`), not 1.
- Every other platform: identical freemem-based formula as before.
- For the automatic (non-override, non-CI) path, the result is clamped to
  `Math.max(1, Math.min(memoryBasedLimit, cpuCores))` — never 0/negative, never more than
  `cpuCores` — preserving the file's documented memory-safety intent (the header comment's
  8-workers-vs-vite-dev crash history is about `vite dev` vs `vite preview`, unrelated to and
  unchanged by this fix; the config already uses `vite preview`). A valid `PLAYWRIGHT_WORKERS`
  override is checked first and bypasses both this clamp and the CI short-circuit.
- `playwright.config.ts`'s `getWorkerCount()` is now a 9-line wrapper that gathers real `os`/
  `process.env` values and calls the extracted function; behavior for the `PLAYWRIGHT_WORKERS`
  override and the CI short-circuit is unchanged, including override precedence over CI.

**Why the extraction, not just a fix in place.** `scripts/factory/gate.sh`'s unit-test gate only
executes `api/src/**/*.test.ts` and `web/src/**/*.test.ts(x)` — `playwright.config.ts` itself (repo
root, no workspace `tsconfig`/vitest project covers it) is never exercised by any test runner the
gate calls. Moving the pure calculation to `web/src/lib/computeE2eWorkerCount.ts` (picked up by
`web/vitest.config.ts`, which has no `include` restriction) gives it real, gate-executed regression
coverage. The function takes `platform`/`totalMemGB`/`freeMemGB`/`cpuCores`/`isCI`/
`explicitOverride` as plain parameters rather than reading `os`/`process.env` itself, so tests need
no mocking.

**Regression test — `web/src/lib/computeE2eWorkerCount.test.ts`.** Includes a verbatim copy of the
pre-fix freemem-only formula (`oldBuggyCalculation`, not a re-derivation) and asserts it collapses to
1 on the audit's exact measured Darwin scenario (24GB total / 0.3GB free / 14 cores) — proving the
bug independently of today's fix. Separately confirmed red-for-the-right-reason before committing:
temporarily replaced `computeE2eWorkerCount`'s Darwin branch with the old freemem-only formula and
re-ran the suite — the two Darwin-collapse assertions (`toBeGreaterThanOrEqual(2)`) failed with
`expected 1 to be greater than or equal to 2`, then restored the fix and re-ran to 9/9 green. Other
cases cover: never exceeds `cpuCores` on Darwin with abundant memory; never returns 0/negative on a
low-memory Darwin machine; Linux/freemem-based path numerically unchanged (including a genuinely
low-freemem Linux case, which correctly still collapses toward 1 — that heuristic is sound there and
deliberately untouched); `isCI` returns 4 regardless of platform/memory; an explicit
`PLAYWRIGHT_WORKERS` override wins over everything; a garbage override string falls through to the
normal calculation.

**How to verify locally.**

```bash
pnpm --filter @ship/web run type-check
cd web && npx vitest run src/lib/computeE2eWorkerCount.test.ts
cd .. && npx playwright test --list   # confirms the relative import resolves under Playwright's own loader
node -e "const os=require('os'); console.log({platform:os.platform(), totalMemGB:os.totalmem()/2**30, freeMemGB:os.freemem()/2**30, cpuCores:os.cpus().length})"
```

**NOT verified.** Did not run the full `pnpm test:e2e` suite end-to-end at the new higher worker
count on this machine (out of scope for a config-calculation fix, and the existing suite's own
flake/timing issues are tracked separately under TEST-3/TEST-11) — verification here is limited to
the calculation itself (unit-tested) and confirming Playwright successfully loads the config and
lists all 874 tests with the new import in place.

**Roll back.** Revert this ticket's commits. The change is confined to `playwright.config.ts` (one
function body replaced by a 9-line wrapper plus one new import) and two new files under
`web/src/lib/`; no schema, API, or CI change to undo. Reverting restores the original inline
freemem-only calculation and its macOS behavior exactly as it was.

---

## TRO-228 (TEST-6) — Allocation grid showed `planId: null` right after the plan was created — not a race, a mis-scoped lookup key

**The audit's hypothesis did not hold — traced and overturned, not assumed.** TEST-6 escalated
`e2e/weekly-accountability.spec.ts:469` as "a real race candidate": `GET
/api/weekly-plans/project-allocation-grid/:projectId` returned `planId: null` immediately after a
`POST /api/weekly-plans` that should have created it, reproducibly on the first attempt. The
hypothesis was that plan creation and its "week assignment" were two separate statements, so a read
racing the write could observe the plan but not its assignment.

Traced the actual code before touching anything (`api/src/routes/weekly-plans.ts:183-301`):
`POST /weekly-plans` already inserts the `documents` row and its `document_associations` project
link inside **one transaction** (`BEGIN` at line 250, `COMMIT` at line 281, both queries in between
run on the same pooled client), and the `201` response is only written after `COMMIT` resolves.
Proved this is not a timing issue by reproducing the exact e2e sequence as a single supertest
request against the real Express app (`api/src/routes/weekly-plans.test.ts`) — it passed cleanly,
every time, 3/3 runs. There is no window here where the write is half-visible.

**What is actually broken (observed, file:line).** `POST /weekly-plans` deliberately dedupes a
`weekly_plan` document on `(person_id, week_number)` **only** — `project_id` is documented in the
route's own `weeklyPlanSchema` comment as "Optional - legacy field, not used for uniqueness"
(`weekly-plans.ts:143`), and the same person+week-only lookup is reused, unchanged, by the
`weekly_retro` POST handler when it auto-populates a retro from that week's plan
(`weekly-plans.ts:642-650`). But the allocation-grid handler's plan/retro lookups
(`weekly-plans.ts:990-999`, pre-fix) filtered by `(properties->>'project_id') = $2` — treating
`project_id` as if it reliably scoped a plan to one project, when the create endpoint explicitly
does not guarantee that.

The failure is deterministic, not probabilistic: a person's first weekly-plan POST for week *N*,
on *any* project, permanently "claims" that (person, week) pair — its `properties.project_id` is
whatever project happened to ask first. A **later** POST for the same person+week from a
**different** project correctly returns that same existing document (`200`, not `201` — idempotent
by design), but the grid's old `= $2` filter then can never find it for the second project, because
the document's stored `project_id` still points at the first project. `e2e/weekly-accountability.spec.ts`
triggers this because every test in the file logs in as the same seeded user (same `person_id`) and
an earlier test in file order (`weekly-accountability.spec.ts:78`, `week_number: 1`) already claims
week 1 for a different project before the allocation-grid test (`:469`, also `week_number: 1`) runs
— but the same shape occurs for a real user assigned to two concurrent projects in the same
sprint, which is a real (if narrow) production scenario, not just a test-ordering artifact.

**Cross-file note per the ticket's own instruction:** this is query-shaped, not a
concurrency/transaction bug — flagging plainly rather than forcing a `BEGIN`/`COMMIT` onto a
mechanism that was already atomic. No `db-query`/`api-perf` action needed beyond what this fix
already does (see below).

**CodeQL finding, triaged, filed as a new ticket, not fixed here.** PR #94's CodeQL security-scan
check reported a High-severity "new" `js/missing-rate-limiting` alert at the
`/project-allocation-grid/:projectId` handler this ticket touches. Verified it is **not new**:
`git show main:api/src/routes/weekly-plans.ts` shows the same handler already lacked rate-limiting
middleware before this diff — the `PlanOrRetroRow` interface insertion above it shifted every
subsequent line number, and CodeQL's PR-vs-base diffing appears to treat the shifted registration as
newly-introduced code. The repo-wide alert list shows **18 open instances of this same rule in
`weekly-plans.ts` alone**, plus more in `weeks.ts`, `admin.ts`, and `search.ts` — a systemic gap in
how `api/src/middleware/rate-limit.ts` (TRO-280) is *applied*, not a defect in this handler
specifically or something this ticket's narrow query fix should absorb as a drive-by. Filed as
`TRO-307`, recorded in `audit/factory/review-findings.jsonl` with disposition `new-ticket`.

**The fix — `api/src/routes/weekly-plans.ts`, `project-allocation-grid/:projectId` handler only.**
Changed the plan/retro lookup queries to filter by `(properties->>'person_id') = ANY($2::text[])`,
where `$2` is the list of person IDs already allocated to this project (from the preceding
`allocatedPeopleResult` query), instead of filtering by `project_id`. This matches the actual
identity model the create endpoints use and enforce elsewhere in this same file, so a person's
week-*N* plan is found for every project's grid it is relevant to, regardless of which project's
request happened to create the underlying document first. Also typed the two queries' rows
(`PlanOrRetroRow`, `weekly-plans.ts:910-916`) instead of leaving `.rows` implicitly `any`.

**Second correction (CodeRabbit, PR #94).** Both queries filtered `deleted_at IS NULL` but not
`archived_at IS NULL` — pre-existing on `main` before this ticket, not introduced by it, but the
exact two queries this fix already touches. An archived `weekly_plan`/`weekly_retro` document would
still populate `planId`/`retroId` in the grid. Added `AND archived_at IS NULL` to both.

**Regression test — `api/src/routes/weekly-plans.test.ts` (new file, 3 cases).** Supertest cases
against the real Express app:
1. The straightforward path — POST creates a plan, GET the grid immediately, `planId` matches.
   This alone does **not** reproduce the bug (confirmed above — it passes against the unfixed code
   too, because there is no race), which is itself evidence the audit's race hypothesis was wrong.
2. The actual bug, reproduced deterministically and structurally (no sleep, no timing dependency):
   POST a week-1 plan for "Other Project", then POST a week-1 plan for the project under test for
   the **same person** (asserts the idempotent `200` + same `id` first, proving the dedup-by-
   person+week behavior itself), then GET that project's allocation grid and assert `planId` is the
   existing plan's id. Confirmed **red before the fix** —
   `expected null to be '<plan-id>'` — and green after, 3/3 runs.
3. **Added per CodeRabbit review (PR #94):** the mirror-image case for `weekly_retro`/`retroId`,
   identical shape to case 2 but through `POST /api/weekly-retros`. The allocation grid applies the
   same person_id-scoped fix to both lookups, so both need independent coverage — a regression that
   broke only the retro side would otherwise pass unnoticed.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/routes/weekly-plans.test.ts
```

**How to roll it back.** Revert this commit. `api/src/routes/weekly-plans.ts`'s
`project-allocation-grid` handler returns to filtering plan/retro lookups by `project_id`, and
`api/src/routes/weekly-plans.test.ts` is removed. No schema or migration changes were needed or
made.

---

## TRO-306 (TS-10 follow-up, batch 1) — `web/src/pages/*`'s 188 floating/misused-promise sites fixed, both rules promoted to `error` for `web/src/pages/**`

**Scope.** TRO-297's own "what's still open" note recommended splitting web's promise-safety
cleanup into a few `web/src/pages/*` batches rather than one mega-ticket. This ticket is that
first (and, since every file reached zero, only needed) batch: all 21 files directly under
`web/src/pages/` that had violations. `web/src/components/**` and `web/src/lib/**` are a separate,
still-open, uncounted-by-this-ticket population — explicitly out of scope, noted below.

**Live count re-derived, not trusted from the ticket's cache.** The ticket's own text cited "~389"
sites for web overall (from TRO-297's rough estimate of all of `web/src`, not specifically
`web/src/pages`). The actual live count, from the command below, was **188 errors across 21
files** (plus 16 unrelated pre-existing `no-explicit-any`/`no-non-null-assertion` warnings from
other files, untouched, out of scope).

```bash
source .factory-env
pnpm --filter @ship/web exec eslint src/pages --rule \
  '{"@typescript-eslint/no-floating-promises":"error","@typescript-eslint/no-misused-promises":"error"}'
```
**Before:** `✖ 204 problems (188 errors, 16 warnings)`.
**After (same command):** `✖ 16 problems (0 errors, 16 warnings)` — the 16 remaining warnings are
all pre-existing `no-explicit-any`/`no-non-null-assertion` (TS-1/TS-2/TS-4/TS-8, untouched).

**Per-file breakdown (all 21 reached zero):**

| File | Violations fixed |
|---|---|
| App.tsx | 44 |
| UnifiedDocumentPage.tsx | 19 |
| Projects.tsx | 13 |
| WorkspaceSettings.tsx | 13 |
| AdminWorkspaceDetail.tsx | 11 |
| PersonEditor.tsx | 10 |
| ReviewsPage.tsx | 10 |
| AdminDashboard.tsx | 8 |
| Documents.tsx | 8 |
| Programs.tsx | 8 |
| MyWeekPage.tsx | 7 |
| TeamMode.tsx | 7 |
| Login.tsx | 6 |
| OrgChartPage.tsx | 6 |
| TeamDirectory.tsx | 5 |
| InviteAccept.tsx | 4 |
| Setup.tsx | 4 |
| FeedbackEditor.tsx | 2 |
| ConvertedDocuments.tsx | 1 |
| PublicFeedback.tsx | 1 |
| UnifiedDocumentPage.deletedFocusRefetch.test.tsx | 1 |

**The fix pattern, applied per-site (never a blanket `void`):**

1. **`navigate(...)` (react-router).** `NavigateFunction`'s type is `(to, options?) => void |
   Promise<void>`, so every call is technically a floating promise. No established mechanism in
   this codebase handles a navigation rejection, so every fire-and-forget `navigate(...)` call —
   by far the largest share of the 188 sites — is `void navigate(...)`, with `onClick={() =>
   navigate(x)}`-style implicit-return arrows either voided inline or wrapped in a block body.
2. **Self-contained mutation wrappers.** `createDocument`/`updateDocument`/`deleteDocument`
   (`useDocumentsQuery.ts`), `createProject`/`updateProject`/`deleteProject`
   (`useProjectsQuery.ts`), `createProgram`/`updateProgram`/`deleteProgram`
   (`useProgramsQuery.ts`), and `createIssue`/`updateIssue` (`useIssuesQuery.ts`, with one
   exception below) all wrap their underlying `mutateAsync` in `try { ... } catch { return
   null/false; }` and never reject. Handlers built on them, and the shared components that receive
   them as props (`ContextMenuItem`, `DocumentTreeItem`, `ProgramBulkActionBar`,
   `ProjectsBulkActionBar`, `SelectableList`'s `onItemClick`, `DocumentListToolbar`'s
   `createButton`), are `void`d rather than widening those components' declared void-returning
   prop types.
3. **`showToast`'s "Undo" action.** `ToastAction.onClick` is typed `() => void`
   (`components/ui/Toast.tsx`). Three sites (Projects.tsx bulk-archive, App.tsx document-delete,
   App.tsx program-archive) had passed an inline `async () => {...}` directly as `action.onClick` —
   each extracted into a named async function, voided from a sync wrapper, rather than widening the
   toast's own type.
4. **Real bugs found and fixed while wiring rejection handling, not just satisfying the linter:**
   - `InviteAccept.tsx`: `api.invites.validate()`/`accept()` can reject on a network failure;
     unhandled, this left the page stuck on "Loading..." (validate) or the button stuck on
     "Accepting..." forever (accept — `setAccepting` never reset on the throw path). Now routed
     into the `'error'` status this file already declared in its own `InviteStatus` type but never
     actually set, and into the existing `setError`/`setAccepting(false)` failure pattern.
   - `Login.tsx`: `login()` (`useAuth.tsx`) can reject the same way; `handleSubmit` had no
     try/catch, so a network failure during login left the button stuck on "Signing in..." with no
     feedback. Now caught and routed into the existing `error`/`errorField`/`isLoading` state.
   - `AdminDashboard.tsx` / `AdminWorkspaceDetail.tsx` / `WorkspaceSettings.tsx`: each page's
     `loadData()` had **no error handling at all** — a network failure during the initial
     `Promise.all` left `loading` stuck `true` forever with a blank page and no way to recover.
     All three now catch and report (via a new `loadError` state or this file's own existing
     `alert()` convention).
   - `MyWeekPage.tsx`: `handleCreatePlan`/`handleCreateRetro`/`handleCreateStandup` were `try { ...
     } finally { setCreating(null); }` with **no catch and no else on `!res.ok`** — a rejected
     `apiPost` or a non-2xx response silently reset the "Creating..." button with zero feedback.
     Now surfaces an inline `role="alert"` error message (this file has no toast/context
     dependency, so a local `actionError` state was used instead of pulling in `useToast` — see the
     regression-test section below for why).
   - `AdminWorkspaceDetail.tsx` / `WorkspaceSettings.tsx`: `navigator.clipboard.writeText()` calls
     were floating promises, and the pre-fix code showed "Copied!"/flipped the copied state
     **unconditionally**, even when the clipboard write itself failed (e.g. permission denied). Now
     the success state only flips once the write actually resolves.
   - `App.tsx`'s `IssuesList.handleChangeStatus`/`handleArchive`: `onUpdateIssue`
     (`updateIssue`, `useIssuesQuery.ts`) is the one function in the self-contained list above that
     is **not** fully self-contained — it re-throws `CascadeWarningError` instead of swallowing it,
     since a full confirmation-dialog flow belongs in the issue editor, not this compact context
     menu. Both handlers now catch it and show a toast instead of leaving a genuine unhandled
     rejection.
   - `App.tsx`'s `handleSwitchWorkspace`/`logout`/`endImpersonation` call into
     `WorkspaceContext.tsx`/`useAuth.tsx` (out of this ticket's `web/src/pages/*` scope, and neither
     is self-contained). `handleSwitchWorkspace` (in-scope, in App.tsx) got a real try/catch;
     `logout`/`endImpersonation` (their definitions are out of scope) are caught at the App.tsx call
     site with a real `.catch()` rather than voided. `useToast` was added to `AppLayout` for this —
     verified `App.test.tsx` only renders the exported `DocumentsTree` leaf component, not
     `AppLayout`, so this addition doesn't affect it.

**`eslint.config.mjs`.** Added a `web/src/pages/**` config block (after the general
`web/src/**` block, so its `error` severity wins for the same rule keys) with a new
`webPagesCorrectnessRules` promoting both promise rules to `'error'`. Verified with
`eslint --print-config`: `web/src/pages/App.tsx` resolves both rules to severity `2` (error);
`web/src/components/Editor.tsx` still resolves to severity `1` (warn) — the override did not leak
outside `web/src/pages/**`. The header comment block is updated to record this batch, matching
TRO-297's existing pattern for `api/src`.

**Regression test.** `web/src/pages/MyWeekPage.createPlanError.test.tsx` (new file) — picked
`MyWeekPage.tsx`'s `handleCreatePlan` as the single most user-impactful fix to prove, over
e.g. `Projects.tsx`'s bulk-archive (mentioned as an example in the ticket brief): `Projects.tsx`'s
mutations were already fully self-contained end to end, so there was no user-facing bug left to
demonstrate there, whereas `MyWeekPage.tsx` had a real, confirmed one (see above). The test mocks
`apiPost` to reject, clicks "+ Create plan for this week", and asserts (1) an accessible
`role="alert"` error appears saying the create failed and (2) the button recovers to its idle,
retryable label instead of staying stuck on "Creating...". **Confirmed red-for-the-right-reason**:
reverted `handleCreatePlan` to its pre-fix `try { ... } finally { ... }` shape (no catch, no else)
and re-ran — the promise rejection surfaced as an unhandled rejection in the test's stderr and the
alert never rendered (`Unable to find an element with the text: /failed to create weekly
plan/i`), then restored the fix and reconfirmed green (2/2 passing).

A second commit fixed two problems this regression test's own gate run surfaced in the first
attempt at the `MyWeekPage.tsx` fix: (1) the first attempt used `useToast()` for the new error
message, which broke two pre-existing, unrelated test files
(`MyWeekPage.contrast.test.tsx`, `MyWeekPage.loadingAffordance.test.tsx`) that render
`<MyWeekPage />` standalone with no `ToastProvider` ancestor — replaced with a local `actionError`
state rendered inline instead of adding a new context dependency; (2) `review-patterns` (gate
check G7b's automation) flagged `previous_retro!.week_number` as a "new" non-null assertion
because adding `void` to that line changed its exact text, even though the assertion itself
pre-dates this ticket (identical assertions two lines above are untouched) — annotated with
`// review-pattern-ok:` documenting why.

**Verified:**
```bash
source .factory-env
pnpm --filter @ship/web exec tsc --noEmit -p .                # clean, 0 errors
pnpm --filter @ship/web exec eslint src/pages \
  --rule '{"@typescript-eslint/no-floating-promises":"error","@typescript-eslint/no-misused-promises":"error"}'
                                                                 # 0 errors, 16 pre-existing warnings
pnpm --filter @ship/web exec vitest run \
  src/pages/MyWeekPage.createPlanError.test.tsx \
  src/pages/MyWeekPage.contrast.test.tsx src/pages/MyWeekPage.loadingAffordance.test.tsx \
  src/pages/UnifiedDocumentPage.deletedFocusRefetch.test.tsx \
  src/pages/UnifiedDocumentPage.throttledRead.test.tsx \
  src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx \
  src/pages/App.test.tsx                                        # 34/34 passed
```

**What's still open.** `web/src/components/**` and `web/src/lib/**` are a separately-uncounted,
still-open population at `warn` — the header comment and this ticket's own eslint override comment
both say not to widen the `web/src/pages/**` glob to cover them without independently re-verifying
that population first, the same caution TRO-297 gives for `shared/src`. `shared/src` itself
remains untouched by this ticket (still 0 sites at `warn`, per TRO-297).

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/web exec tsc --noEmit -p .
pnpm --filter @ship/web exec eslint src/pages
pnpm --filter @ship/web exec vitest run src/pages/MyWeekPage.createPlanError.test.tsx
```

**How to roll it back.** Revert these commits. `eslint.config.mjs`'s new `web/src/pages/**`
override block reverts along with the header comment update, all 21 files' fixes revert with it
(each is additive — a `void`/`.catch`/try-catch/extraction, no removed functionality), and the new
`MyWeekPage.createPlanError.test.tsx` file is removed.

---

## TRO-229 — [TEST-7] Coverage measurement is broken in api and entirely absent in web and shared

**Scope correction, verified before work began — 2 of the finding's 3 sub-gaps were already fixed.**
TEST-7 as originally filed described three gaps: `@vitest/coverage-v8` missing for `api`, no
`coverage` block in `web/vitest.config.ts`, and `shared/` having no test setup at all. TRO-244
already fixed the first two — confirmed by re-running both packages myself rather than trusting the
prior ticket's own claim:

- `pnpm --filter @ship/api test:coverage` — exit 0, 712/712 tests passed, **46.28% statement
  coverage measured**, above the existing 43% floor (`api/vitest.config.ts`'s TRO-244 comment).
  One run beforehand hit a single failing test (`weeks.test.ts`); a second run passed all 712 —
  this is the pre-existing order-dependent flake TEST-9 already documents, not a coverage-tooling
  defect, and untouched here.
- `pnpm --filter @ship/web test:coverage` — one run exited 1 with **no coverage report written at
  all** (`web/coverage/coverage-summary.json` did not exist) because a single web test
  (`UnifiedDocumentPage.programWeeksNav.test.tsx`) failed and `web/vitest.config.ts`'s coverage
  block has no `coverage.reportOnFailure: true` — exactly the compounding failure mode the original
  TEST-7 measurement (2026-07-28) described between itself and TEST-1. A second run passed all
  465 tests and produced **23.41% statement coverage** (`web/coverage/coverage-summary.json`),
  above the 20% floor. **Noticed but not fixed**: this is a real, currently-live gap — a genuine (not
  flaky) web test failure would make CI's "Web test coverage" step (`.github/workflows/ci.yml`)
  report nothing rather than a number, same as TEST-7's original analysis warned. It sits in
  `web/vitest.config.ts`, which is out of this ticket's scope (narrowed to `shared/` — see below),
  and the failure observed here was a flake on re-run, not a stable regression, so it wasn't treated
  as "genuinely broken" under this ticket's verify-first rule. Flagged here as a follow-up rather
  than fixed.

`shared/package.json` had `build`/`dev`/`clean`/`type-check`/`lint` scripts but no `test` or
`test:coverage` script, and zero test files existed anywhere under `shared/src/` (0 of 8 source
files). **This — `shared/` only — was the ticket's actual remaining scope.**

**What `shared/src` actually contains.** Read all 8 files before writing anything. Four have zero
runtime logic — `types/api.ts`, `types/user.ts`, `types/workspace.ts` are pure `interface`
declarations; `types/auth.ts` is comment-only (its exports were removed by an earlier ticket, so it
isn't even an interface file anymore, just two lines of comment) — three interface-only files and
one comment-only file, verified individually, not assumed from a file-count heuristic. These compile
to no executable statements, so there is nothing in them to unit-test and nothing for v8 to
instrument. Two more files have real, testable logic: `constants.ts`
(`SESSION_TIMEOUT_MS`/`ABSOLUTE_SESSION_TIMEOUT_MS`,
computed millisecond values backing the session semantics `.claude/CLAUDE.md` documents — 15min
idle / 12hr absolute, NIST SP 800-63B-4 AAL2 — plus the `HTTP_STATUS`/`ERROR_CODES` literal maps)
and `types/document.ts` (`computeICEScore()`, a real branching function, plus the
`DEFAULT_PROJECT_PROPERTIES` constant). The remaining two, `index.ts` and `types/index.ts`, are
barrels — `export * from './x.js'` chains. **These were originally (wrongly) grouped with the
four interface-only files as "zero runtime statements"; see the correction below.**

**What changed.**

- `shared/package.json` — added `test` (`vitest run`), `test:watch`, and `test:coverage`
  (`vitest run --coverage`) scripts, matching api/web's script names exactly. Added
  `@vitest/coverage-v8` (pinned to the exact `4.0.17` already used by api/web — not a caret range;
  TRO-244's own CHANGES.md entry explains why a looser range resolves to an incompatible
  `4.1.10`) and `vitest` (`^4.0.16`, same range as api/web) to devDependencies.
  `pnpm-lock.yaml` picked up both at the identical resolved versions api/web already use — a
  6-line lockfile diff, no new package actually downloaded.
- `shared/vitest.config.ts` (new) — same shape as `api`/`web`'s configs: `provider: 'v8'`,
  `reporter: ['text', 'html', 'json-summary']`, `environment: 'node'` (no DOM, no DB — shared has
  neither). No `setupFiles` needed (nothing to set up) and no `fileParallelism`/timeout overrides
  (no shared mutable state, no DB contention).
- `shared/src/constants.test.ts` (new) — 7 cases. Asserts `SESSION_TIMEOUT_MS`/
  `ABSOLUTE_SESSION_TIMEOUT_MS` against independently-computed millisecond literals (900,000 and
  43,200,000), not against the same `15 * 60 * 1000` expression re-typed, which would just check
  the file against itself; a relationship check that the absolute timeout exceeds the idle one;
  `HTTP_STATUS`/`ERROR_CODES` value checks plus a uniqueness check per map (catches a copy-paste
  collision without hardcoding every literal twice).
- `shared/src/types/document.test.ts` (new) — 12 cases for `computeICEScore()`: the
  documented product for a mid-range input, the 1×1×1 floor and 5×5×5 ceiling, null-propagation for
  each of the three arguments individually and all three together, and a `0` (not `null`) input to
  prove the null-check doesn't collapse to `if (!impact)`. Plus 4 cases on
  `DEFAULT_PROJECT_PROPERTIES` confirming it starts with an unset ICE score and no owner.
- **Proved the tests actually exercise the code, not just import it**: temporarily changed
  `computeICEScore`'s multiplication to addition and `SESSION_TIMEOUT_MS`'s multiplier from
  `15 * 60 * 1000` to `15 * 60 * 100`, reran — 5 of 19 tests failed on exactly the mutated lines,
  confirming red for the right reason — then restored both files and reran clean (19/19 passed
  again, diffed byte-identical against the pre-mutation copies).
- **Coverage threshold — corrected after a CodeRabbit review (PR #92), not caught before merge.**
  The original measurement (100%, 8/8 statements) was taken **without an explicit
  `coverage.include`**. Vitest 4 defaults `coverage.include` to "files actually imported during the
  run" — so `types/api.ts`/`auth.ts`/`user.ts`/`workspace.ts` AND both barrel files were never in
  the denominator at all, imported or not. "100%" only ever meant "100% of the 2 files a test
  happened to import," not 100% of the package — the exact "invisible denominator" failure mode
  `docs/IMPROVEMENTS.md`-style audits exist to catch, landing in this ticket's own new file. Verified
  by adding `include: ['src/**/*.ts']` and re-running: coverage **dropped to 53.33%**, correctly
  surfacing the two barrel files' real re-export statements as uncovered (they were never even
  reported before, let alone counted against the threshold).
  - Fix: `coverage.exclude` now explicitly names the four verified-empty interface files (each read
    individually, not inferred). The two barrels are **not** excluded — `export * from './x.js'` is
    a real, executable statement — and `shared/src/index.test.ts` (new, 2 cases) now imports both
    and asserts real re-exported values/functions (not just "the module loaded"), which is itself a
    regression test for barrel/source drift (a renamed or deleted export whose barrel line goes
    stale).
  - Re-measured after the fix: genuinely **100% statement coverage**, 21/21 tests across 3 files.
    `coverage.thresholds.statements` stays at **95**, a couple of points below the (now honest)
    measured number, same convention as api (43 vs. 45.65%) and web (20 vs. ~22.3%). Re-verified the
    threshold is real, not decorative: temporarily set it to `100.01` and reran — `ERROR: Coverage
    for statements (100%) does not meet global threshold (100.01%)`, exit 1 — then reverted to 95.
  - Recorded in `audit/factory/review-findings.jsonl` as two Major findings, both fixed.
- `.github/workflows/ci.yml` — added a **Shared test coverage** step (`pnpm --filter @ship/shared
  test:coverage`) to the `verify` job, right after the existing Web test coverage step. Unlike
  api/web, `shared/` has no pre-existing quarantine baseline and no separate continue-on-error unit
  test step to isolate this from, so a single `test:coverage` step both runs the suite and enforces
  the threshold — either kind of failure should genuinely fail the job. Extended the `Coverage
  summary` step's `coverage-summary.mjs` invocation with `--pkg shared:shared/coverage/coverage-summary.json:95`
  and added `shared/coverage/coverage-summary.json` to the `Upload coverage + audit reports`
  artifact path list. Did **not** touch `scripts/factory/gate.sh` — it currently only runs
  `pnpm --filter @ship/{api,web} test` and has no concept of `shared`'s tests at all, but wiring
  `shared` into CI satisfies the "gate.sh (or CI)" requirement (this repo's ship-qa role brief) that
  a regression test live somewhere the pipeline actually runs it. Flagged as a clean, separate
  follow-up if `gate.sh` itself should also run `shared`'s suite in the factory's local inner loop —
  out of this ticket's stated file scope (`shared/`, `pnpm-lock.yaml`, `shared/package.json`,
  `.github/workflows/ci.yml` only).

**Verified, not just claimed.** `pnpm --filter @ship/shared test` — 3 files, 21/21 passed.
`pnpm --filter @ship/shared test:coverage` — exit 0, genuinely 100% statements (all included files
covered, four verified-empty files correctly excluded). `pnpm --filter @ship/shared type-check` and
`pnpm --filter @ship/shared lint` — both clean on the new test files. Full `pnpm type-check` and
`pnpm build` across all three packages — both clean, confirming the new devDependencies and config
didn't disturb api/web.

**How to run it.**

```bash
pnpm --filter @ship/shared test           # 21 tests, ~1s, no setup required
pnpm --filter @ship/shared test:coverage  # same, plus the v8 coverage report + 95% floor
```

**Rollback.** Revert this commit. Removes `shared/vitest.config.ts`,
`shared/src/constants.test.ts`, `shared/src/types/document.test.ts`, and `shared/src/index.test.ts`;
restores `shared/package.json` to no `test`/`test:coverage` scripts and no `vitest`/`@vitest/coverage-v8`
devDependencies; restores `pnpm-lock.yaml`'s prior 6 lines; and removes the `Shared test coverage`
CI step and its two follow-on references in `.github/workflows/ci.yml`. Reverting drops `shared/`
back to zero test coverage and zero CI signal for it — the state TEST-7 originally described —
without affecting api or web, whose coverage setups this ticket verified but did not modify.

---

## TRO-210 — [TS-5] The shared/ contract is bypassed — 46 exported types, adopted by 13 of 198 web files

**What was broken.** `web/src/lib/api.ts:5` declared its own `interface ApiResponse<T>` (`success`,
`data?`, and an `error?: { code; message }` with no `details`) even though `shared/src/types/api.ts:2`
already exports `ApiResponse<T = unknown>` with a proper `ApiError` (`code`, `message`, and an optional
`details: Record<string, unknown>` the local copy never had). Two hand-maintained guesses at the same
wire contract, free to drift silently — exactly what TS-5 is about.

**Sequencing constraint honored (per the ticket's own warning: "do this WITH TS-2, not before it").**
TS-2 (typing the ~707 untyped `pg` query rows in `api/`) has not landed. `shared/src/types/document.ts`
models the **raw `documents` table row** (`Document`/`ProjectDocument`/`IssueDocument`/etc. — flat
`content`, `properties: ProjectProperties`, `workspace_id`, `document_type`). The actual list/detail
routes do not return that shape. Verified by reading the route handlers, not assumed:

- `api/src/routes/projects.ts:534-548` — the `/api/projects` list query flattens `properties` into
  top-level fields (`impact`, `confidence`, `ease`, `color`, `emoji`, ...), joins in `owner` (name/email),
  and computes `sprint_count`, `issue_count`, `inferred_status`, `is_complete`, `missing_fields` — none
  of which exist on `shared`'s `ProjectDocument`. `web/src/hooks/useProjectsQuery.ts:8`'s local `Project`
  models this response shape, not the raw document row.
- The same pattern holds for `Sprint`/`Week` (`web/src/hooks/useWeeksQuery.ts:10` — computed
  `completed_count`, `started_count`, `has_plan`/`has_retro`, joined `owner`), `Program`
  (`web/src/hooks/useProgramsQuery.ts:10`), `Issue` (`web/src/hooks/useIssuesQuery.ts:25` — joined
  `assignee_name`, computed `display_id`), `Person` (`web/src/components/PersonCombobox.tsx:6` — a
  3-field combobox projection), and `WikiDocument` (`web/src/components/sidebars/WikiSidebar.tsx:5` /
  `web/src/hooks/useDocumentsQuery.ts:4` — partial views with optional fields).

Forcing any of those seven onto `shared/`'s document types today would either not compile (missing
required fields the API never sends, e.g. `content`, `workspace_id`) or silently paper over the gap
with optional-everything — the drift-risk the ticket brief warned against. **None of the 7 were
consolidated.** They're deferred, explicitly, pending TS-2 producing typed route-response interfaces
that actually match what the API returns — at which point those response types (not the raw
`*Document` types) are what `web/src` should import.

**What changed — the one verified-safe case.** `ApiResponse`/`ApiError` is different: it isn't a
document projection, it's the outer HTTP envelope every route already wraps its response in
identically, and the local declaration was a byte-for-byte subset (missing only the optional
`details` field). No route-by-route verification needed — this is the JSON-shape `request<T>()` in
`web/src/lib/api.ts` always produces, and shared's version is a strict superset.

- `web/src/lib/api.ts:1,5-11` — deleted the local `interface ApiResponse<T>`; added
  `import type { ApiResponse } from '@ship/shared';`. No call-site changes were needed: every existing
  read of `data.error?.code` / `data.error?.message` still type-checks against the shared `ApiError`,
  and the `details` field is now reachable (previously a compile error) without changing any runtime
  behavior — nothing in this file reads it yet.

**How to run it.**

```bash
pnpm build:shared
pnpm --filter @ship/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @ship/web test -- src/lib/api.test.ts
```

**Regression test.** `web/src/lib/api.test.ts` (new) — a source-text guard (`apiSource` read via
`readFileSync`) asserting `web/src/lib/api.ts` no longer matches `/\binterface\s+ApiResponse\b/` and
does match an `import type { ApiResponse ... } from '@ship/shared'` pattern, plus a runtime companion
mocking `fetch` through `api.auth.me()` to confirm an `ApiError.details` payload survives end to end.
Confirmed failing on the pre-fix file (both source assertions failed: the interface was present, the
import was absent) by temporarily swapping in the pre-fix `web/src/lib/api.ts` via `git show
HEAD:web/src/lib/api.ts`, running the test, then restoring the fixed file — not via `git stash` (shared
across worktrees). The runtime companion test passed unchanged in both states, as expected: this repo's
`vitest run` does not type-check, so a type-only fix can only be caught by a source-text assertion, not
by executing code whose behavior doesn't change.

**Roll back.** `git revert` the commit, or manually: reinstate

```ts
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
```

at the top of `web/src/lib/api.ts` and remove the `@ship/shared` import; delete
`web/src/lib/api.test.ts`.

---

## TRO-231 — [TEST-9] `pnpm test` TRUNCATEs whatever database `DATABASE_URL` points at — including your dev database

**What was broken.** `api/src/test/setup.ts` runs, in the `beforeAll` of every one of the 28 api
test files, `TRUNCATE TABLE workspace_invites, sessions, files, document_links, document_history,
comments, document_associations, document_snapshots, sprint_iterations, issue_iterations,
documents, audit_logs, workspace_memberships, users, workspaces CASCADE`. `api/src/db/client.ts`
unconditionally loaded `api/.env.local` — the exact file `scripts/dev.sh` writes with a developer's
dev `DATABASE_URL` — before creating the pool. There was no `.env.test` and no test-specific
override.

**The precise mechanism (not just "it loads the wrong file").** `dotenv`'s `config()` does **not**
override a `DATABASE_URL` already present in `process.env` unless `override: true` is passed
(verified directly against this repo's installed `dotenv`: `populate()` only assigns a key when
`!Object.prototype.hasOwnProperty.call(target, key)`). So the bug did not bite every developer —
only one who never explicitly `export`ed `DATABASE_URL` in their shell, which is the common case,
since `pnpm dev` doesn't require one (`scripts/dev.sh` writes it into `.env.local` instead). That
developer's exact, and exactly documented, sequence: `pnpm dev` (writes `.env.local` with the dev
DB URL) → `pnpm test` (`client.ts` loads that URL into `process.env` at import time, before
`setup.ts`'s `beforeAll` ever runs) → the TRUNCATE above fires against the developer's own dev
database. `.claude/CLAUDE.md`'s "Commands" section walks straight into this: `pnpm dev` is listed
first, `pnpm test` second, with no warning between them.

**This does NOT affect the ShipShape factory — correction, CodeRabbit (PR #93).** The original
wording here overstated the guarantee: it is conditional, not unconditional. Every factory
worktree's `.factory-env` explicitly `export`s a worktree-exclusive `DATABASE_URL` before any test
command runs, and an exported var always wins over `.env.local`/`.env` — but **only if no
`api/.env.test` exists in that worktree**. `resolveEnvFilesToLoad` returns `override: true`
specifically when `.env.test` is present (by design — see the function's own header comment: a
developer who set one up wants it to be the single source of truth, not silently second-guessed),
and `client.ts` honors that override, replacing even an already-exported `DATABASE_URL`. No factory
worktree currently creates or commits an `api/.env.test` (only the tracked, developer-opt-in
`.env.test.example` template is added by this ticket — `api/.env.test` itself, not the `.example`
file, is what `.gitignore` excludes), so the factory is unaffected **in practice**
today — but the correct claim is "safe because no worktree has `.env.test`," not "safe
unconditionally." A worktree provisioning script that ever copies `.env.test.example` into place
would need to account for this precedence.

**What changed.**

- `api/src/db/envFile.ts` (new) — `resolveEnvFilesToLoad`, a pure function that decides which
  dotenv file(s) to load and with what override precedence, given `isVitest` and whether
  `api/.env.test` exists. Not under vitest: unchanged — loads `.env.local` then `.env`, neither
  overriding (byte-for-byte `pnpm dev`'s prior behavior). Under vitest with `.env.test` present:
  loads **only** `.env.test`, with `override: true`, so it's the single source of truth for a test
  run regardless of a stray shell export or leftover `.env`. Under vitest with `.env.test`
  **absent**: loads **nothing** — `.env.local` is never even opened, so its `DATABASE_URL` cannot
  end up in `process.env`, let alone get truncated. `DATABASE_URL` is left to whatever the
  environment already provided (`.factory-env`, CI's `CI_DATABASE_URL`, or an explicit developer
  export).
- `api/src/db/client.ts:1-32` — replaced the two unconditional `config({ path: ... })` calls with a
  loop over `resolveEnvFilesToLoad(...)`, passing `process.env.VITEST === 'true'` and
  `existsSync(envTestPath)`.
- `api/.env.test.example` (new) — mirrors the existing `api/.env.example` pattern. Documents copying
  it to `api/.env.test` and pointing it at a dedicated, disposable test database — never the dev
  database `api/.env.local` points at.
- `.gitignore` — added `.env.test` alongside the existing `.env`/`.env.local`/`.env.*.local`
  entries. None of those three patterns matched `.env.test` (confirmed: `.env.*.local` requires a
  `.local` suffix), so without this a developer's real `.env.test` — pointing at a real database
  URL, however disposable — had no gitignore coverage. `.env.test.example` is unaffected; the
  pattern is an exact filename, not a glob that would also catch it.

**On `process.env.VITEST` being the right signal (not `NODE_ENV`).** `setup.ts:57` sets
`process.env.NODE_ENV = 'test'` inside its `beforeAll` — which runs *after* every test file's
top-level imports, `client.ts`'s included, have already executed. `NODE_ENV` cannot be read early
enough at `client.ts`'s module-load time to decide this. `process.env.VITEST` can: verified
directly by reading `node_modules/vitest/dist/chunks/cli-api.*.js`, whose `prepareVitest()` sets
`process.env.VITEST = 'true'` unconditionally before any test file loads, and separately passes
`VITEST: 'true'` in the `env` object handed to every worker process it spawns — and independently
confirmed empirically: this ticket's own regression test asserts `process.env.VITEST === 'true'`
against a real `vitest run`, and that assertion passes.

**Regression test** (`api/src/db/__tests__/envFile.test.ts`, new, 4 cases) — tests
`resolveEnvFilesToLoad` directly, no filesystem/dotenv mocking needed, no database touched:

1. `process.env.VITEST` is genuinely `'true'` during a real test run (the empirical check above).
2. Under vitest with `.env.test` present: plan is exactly `[{ path: <.env.test>, override: true }]`.
3. Under vitest with `.env.test` absent: plan is `[]` — explicitly asserts neither `.env.local` nor
   `.env` appears.
4. Not under vitest: plan is `.env.local` then `.env`, both `override: false`, regardless of
   whether `.env.test` exists — `pnpm dev`'s behavior is unchanged.

**Confirmed red-for-the-right-reason.** Temporarily reverted `resolveEnvFilesToLoad` to
unconditionally return `[{ path: envLocalPath, override: false }, { path: envPath, override:
false }]` (the literal pre-fix `client.ts` behavior) and re-ran this file: cases 2 and 3 above
failed, both showing `.env.local` present in the plan where it must be absent — the exact TEST-9
defect. Cases 1 and 4 still passed, as expected (the old behavior never depended on `VITEST` and
already matched the non-vitest case by coincidence). Restored the real fix immediately after;
`envFile.ts` in this commit has no trace of the reverted version.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/db/__tests__/envFile.test.ts
pnpm --filter @ship/api test           # full api suite — confirms client.ts still loads correctly
```

**Setting up `.env.test` locally (outside the factory).**

```bash
cp api/.env.test.example api/.env.test
createdb ship_test   # or point DATABASE_URL in .env.test at any disposable database
pnpm test
```

Without this file, `pnpm test` now requires an explicitly exported `DATABASE_URL` (pointed at a
throwaway database) instead of silently falling back to your dev database.

**Rollback.** Revert the commit(s) on `fix/test-9-test-db-isolation` touching `api/src/db/client.ts`,
`api/src/db/envFile.ts`, `api/src/db/__tests__/envFile.test.ts`, `api/.env.test.example`, and
`.gitignore`. This restores the pre-fix, unconditional `.env.local`-then-`.env` load in
`client.ts` — i.e. restores the TEST-9 hazard this ticket exists to remove. Do not revert this
without also re-adding a warning at the `pnpm dev` → `pnpm test` sequence in `.claude/CLAUDE.md`.

---

## TRO-212 (TS-7) — `as any` removed from a destructive bulk-mutation call site and a TipTap command return

**What was broken.** Three production `as any` casts (of the entire codebase's 158 occurrences,
154 of which are in test files): `web/src/pages/Projects.tsx:220` and `:233` cast the update
payload passed to `updateProject` inside `handleBulkArchive` and its Undo handler —
`{ archived_at: new Date().toISOString() } as any` / `{ archived_at: null } as any` — and
`web/src/components/editor/FileAttachment.tsx:139` cast an entire TipTap `addCommands()` return
value to `any`. `updateProject`'s real signature (`web/src/contexts/ProjectsContext.tsx:21`) is
`(id: string, updates: Partial<Project>) => Promise<Project | null>`, and `Project.archived_at`
(`web/src/hooks/useProjectsQuery.ts:38`) is genuinely `string | null` — so both Projects.tsx casts
were pure dead weight, not masking a real type gap. AUDIT_REPORT.md's own TS-7 section says as
much ("both assertions are unnecessary today") and names the risk precisely: because they're
redundant *now*, they would silently absorb a real mismatch the first time the `Project` model
changes, on a bulk path that mutates every selected project at once.

**Provenance correction — the third cited site was already fixed, out of scope.** TS-7 also cites
`api/src/routes/issues.ts:155` — `params.push(states as any)` — as a SQL-parameter cast masking a
genuine element-type gap. Read the current file directly rather than trusting the finding text: at
today's line 377, the code is `params.push(states);` with **no cast at all**, because `params` is
now declared `const params: (string | number | boolean | null | string[])[] = [...]` at line 362.
A prior wave already closed this gap. Verified with `grep -n "as any\|params.push(states\|const
params:" api/src/routes/issues.ts` — no match for `as any` in the file. Nothing was touched there;
re-fixing an already-fixed site was explicitly out of this ticket's scope.

**What changed.**

- `web/src/pages/Projects.tsx:220,233` — deleted both `as any` casts. Confirmed with `pnpm
  type-check` (both `web` and the full monorepo) that removal compiles clean with zero errors,
  which is the direct proof the casts were dead weight rather than covering a real mismatch.
- `web/src/components/editor/FileAttachment.tsx` — `addCommands()`'s return value was cast `as
  any` and its inner `({ commands }: any)` parameter was also bare `any`. Replaced both with the
  same typed pattern already established in this codebase at
  `web/src/components/editor/ResizableImage.tsx:132-143`: the returned command map is typed `as
  Partial<RawCommands>` (imported from `@tiptap/core`, TipTap's own type for a command-factory
  map) instead of `any`, and the destructured `commands` parameter gets a local inline type
  (`{ insertContent: (content: { type: string; attrs: typeof options }) => boolean }`) instead of
  `any`. No new type was invented — this mirrors an existing, already-passing precedent in the same
  package.

**Regression test — `web/src/pages/Projects.updateProjectTypeSafety.test.ts` (new).** This is a
type-safety fix with no runtime behavior change (`as any` never affects what code *does*, only what
the compiler is allowed to check), so the regression test is type-level, using the
`// @ts-expect-error` form the assignment brief names as acceptable for exactly this case. It
derives `UpdateProject` from `ReturnType<typeof useProjects>['updateProject']` (the real context,
not a duplicated signature) and asserts two things `pnpm type-check` now enforces: (1) the exact
payload shapes used at Projects.tsx:220/:233 satisfy the real signature with zero cast, and (2) a
payload that does **not** satisfy `Partial<Project>` (`{ archived_at: 12345 }`) is rejected by the
compiler. Confirmed red-for-the-right-reason by hand: temporarily changing the bad payload to a
valid one (`archived_at: null`) makes `pnpm --filter @ship/web type-check` fail with `TS2578:
Unused '@ts-expect-error' directive` — proving the directive is genuinely catching an error, not
sitting there vacuously. Reverted immediately after confirming; the committed test keeps the
mismatched payload. No `any`/`as any`/non-null `!` was introduced in the test itself.

**Honest caveat on "red before / green after."** There is no compiler-level red state tied to
git history here: `as any` never makes `tsc` fail regardless of what's under it, and (per the
provenance check above) the underlying payload shapes were already assignable to `Partial<Project>`
before this ticket touched anything — `pnpm type-check` was green before this diff and stays green
after. What the regression test proves is forward-looking: with the casts removed, a *future*
`Project.archived_at` type change or call-site typo at these two lines will now be caught at
compile time, where previously it would have been silently swallowed. That is the exact failure
mode TS-7 describes, and it's the whole reason deleting these two casts has value despite there
being no bug present today.

**How to run it.**

```bash
pnpm type-check
pnpm --filter @ship/web test -- Projects.updateProjectTypeSafety FileAttachment.test.ts
```

**Rollback.** Revert this commit. Restores the `as any` casts at `Projects.tsx:220,233` and
`FileAttachment.tsx:139` (and its inner `any` parameter) and removes the new test file. No schema,
API, or user-visible behavior changes — this ticket only touches compile-time type annotations.

---

## TRO-280 — [API-7] Rate limits are per-process, so the real ceiling is N instances × configured

**What was broken.** `api/src/middleware/rate-limit.ts`'s `perSourceIpLimiter`/`perIdentityLimiter`
and `api/src/app.ts`'s `loginLimiter` all defaulted to `express-rate-limit`'s `MemoryStore`, which
lives in one Node process's heap. `terraform/elastic-beanstalk.tf`'s ASG runs 1-4 instances
(`aws:autoscaling:asg` `MinSize`/`MaxSize`) behind a load balancer with no session affinity, so a
configured "600 req/min per identity" ceiling was actually "600 x N instances", where N moves under
the SAME autoscaling trigger that fires when traffic is high enough for the limit to matter —
exactly backwards from what a limit is supposed to guarantee.

**Concurrency argument (rule 6 — this ticket IS a distributed-counter race, not just "add Redis").**
The naive distributed-counter fix — "GET the count, add one, SET it back" — is a read-then-write
race: two instances can both read the same value and both write back the same increment, silently
under-counting under exactly the concurrent load the limiter exists to survive. `rate-limit-redis`'s
`RedisStore` does not do that: `retryableIncrement` loads a Lua script once (`SCRIPT LOAD`) and runs
it via `EVALSHA`, so the read-increment-expire sequence executes atomically on the Redis server
itself (Redis is single-threaded for command execution, so concurrent `EVALSHA` calls for the same
key are serialized, never interleaved). That atomicity is the entire fix. Nothing added here
reimplements it — `api/src/middleware/redis-rate-limit-store.ts` only wires an ioredis client to the
library that provides it.

**What changed — Terraform (`terraform/redis.tf` new; `terraform/ssm.tf`, `terraform/variables.tf`,
`terraform/terraform.tfvars.example` touched).** Config only — **`terraform apply` was never run**,
matching this repo's existing AWS-blueprint convention (TF-7/TRO-278: "the AWS blueprints in this
repo are repo hygiene, not the live deployment" — this repo's actual live deployment is Render,
`terraform/render/`, see that directory's README).

- `aws_elasticache_cluster.redis` — a single small node (`var.redis_node_type`, default
  `cache.t4g.micro`), engine `redis` 7.1, `snapshot_retention_limit = 0` (rate-limit counters are
  disposable — worst case on a restart is counters reset to zero, never a correctness problem, only
  a brief window of looser-than-configured limits, so a snapshot window buys nothing here).
- `aws_security_group.redis` — dedicated SG, one ingress rule
  (`aws_security_group_rule.redis_ingress_from_eb`) on port 6379 sourced from
  `aws_security_group.eb_instance.id` only, no outbound rules. Matches TF-7's convention (least
  privilege, source-security-group scoping, never `0.0.0.0/0`) and `aws_security_group.aurora`'s
  existing shape in `database.tf` for the same kind of resource.
- `aws_elasticache_subnet_group.redis` — the same private subnets Aurora uses.
- `aws_ssm_parameter.redis_url` (in `ssm.tf`, next to `database_url`) — `SecureString`,
  `redis://<endpoint>:<port>`. No IAM change needed: the EB role's existing SSM read policy is
  already scoped to `arn:aws:ssm:...:parameter/${var.project_name}/${var.environment}/*`, which
  already covers this new parameter name.
- **Explicitly NOT done, flagged as follow-up** (per this ticket's brief: "a single small node is
  fine... note that production hardening is a follow-up if you don't have time to fully spec it"):
  multi-AZ/automatic failover, `auth_token` (Redis AUTH), and `transit_encryption_enabled` /
  `at_rest_encryption_enabled` all require `aws_elasticache_replication_group` instead of
  `aws_elasticache_cluster` — noted directly in `terraform/redis.tf`'s file-level comment.
- Terraform's own precedent (TF-7) also means this doesn't reach the live site by itself. Extending
  `REDIS_URL` to the *actually live* Render deployment (`terraform/render/web_service.tf`'s
  `env_vars`) is a natural follow-up but is out of this ticket's scope — that file's pattern
  (env vars, no VPC/security-group concept) is materially different from the AWS SG-scoping pattern
  this ticket's brief pointed at, and Render's `render_key_value` (Redis-compatible) resource support
  under the pinned `render-oss/render` provider version was not investigated here.

**What changed — application.**

- `api/src/middleware/redis-rate-limit-store.ts` (new) — `createRedisClient`/`createRedisClientFromEnv`
  (an ioredis client tuned to fail a command FAST rather than queue it indefinitely:
  `maxRetriesPerRequest: 1`, a bounded `retryStrategy`, `connectTimeout: 2000`, plus an `'error'`
  listener so a Redis outage logs instead of crashing the process — ioredis's `'error'` event has no
  listener by default, and Node re-throws unhandled `'error'` events), and
  `createRedisRateLimitStore(client, prefix)` wrapping `rate-limit-redis`'s `RedisStore`.
- `api/src/middleware/rate-limit.ts` — `createApiRateLimiters(env, redisClient)` gained a second,
  optional parameter that defaults to `createRedisClientFromEnv(env)`. When a client is available
  (from `REDIS_URL` or passed explicitly, the latter used by this ticket's own tests to simulate two
  independent instances), both limiters get a `RedisStore` with distinct key prefixes
  (`rl:ip:`/`rl:id:` — Redis has one flat keyspace, so per-limiter prefixes are required, not
  cosmetic) and `passOnStoreError: true`. No `REDIS_URL` -> unchanged `MemoryStore` behavior, byte
  for byte what API-1/TRO-172 already shipped.
- `api/src/app.ts` — one shared Redis client (or `undefined`) built once and passed to both
  `loginLimiter` (new prefix `rl:login:`) and `createApiRateLimiters`, so all three limiters in this
  process share one Redis connection when configured.
- `api/src/config/ssm.ts` — `loadProductionSecrets` now fetches `REDIS_URL` as a separate, **optional**
  step after the five required secrets. Two reasons it can't join that `Promise.all`: (1) the
  ElastiCache instance above has never been applied anywhere, so the parameter genuinely doesn't
  exist yet; (2) even once applied, Redis is an opt-in improvement, not a hard dependency — a missing
  `REDIS_URL` must never fail boot the way a missing `DATABASE_URL` does.

**Fail-open decision (rule 7 — the failure mode this protects against).** When Redis is configured
but unreachable at runtime, every limiter fails **OPEN** (allows the request, logs the error) rather
than **CLOSED** (blocks all traffic). Reasoning:

- A rate limiter's job is anti-abuse, not availability. Failing closed turns a transient Redis blip
  into a full API outage for every user — worse than briefly un-throttled traffic.
- The limiters are one layer among several independent ones (helmet, CSRF, session auth, and
  `loginLimiter`'s own 5-attempts/15-min ceiling do not depend on this store).
- Implemented two ways: (1) every Redis-backed limiter sets `passOnStoreError: true` — a first-class
  `express-rate-limit` option (its default is `false`, i.e. fail closed; verified by reading
  `express-rate-limit@8.2.1`'s `dist/index.cjs` directly, not assumed from its docs) that calls
  `next()` instead of propagating a rejected `store.increment()` to Express's error handler; (2) the
  ioredis client itself is tuned to fail a command fast (see above) rather than let `passOnStoreError`
  wait on a queued command that would never resolve.

**Found while building this ticket's own tests, not assumed from `rate-limit-redis`'s docs.**
Constructing a `RedisStore` against an unreachable Redis produced real, reproducible **unhandled
promise rejections** in the first version of this test suite (`vitest` reported "Vitest caught 4
unhandled errors during the test run" and failed the file even though every individual assertion
passed). Root cause, found by reading `rate-limit-redis@4.3.1`'s `dist/index.cjs` directly: its
`RedisStore` constructor eagerly starts **two** `SCRIPT LOAD` calls (`incrementScriptSha`,
`getScriptSha`) and stores each as a bare promise field. `incrementScriptSha` is later awaited by
`retryableIncrement`, so its rejection is handled. `getScriptSha` backs `.get()`, which none of this
app's limiters call — so if Redis is unreachable at construction time, that promise rejects with
nothing ever awaiting it, which crashes a modern Node process by default. That is the opposite of
the fail-open design above, and it would fire at boot or at reconnect, not during a request.
`createRedisRateLimitStore` now attaches a `.catch(() => {})` to both fields immediately — an
*additional* handler, not a replacement, so `retryableIncrement`'s own await of the same promise
object still observes the real rejection and still drives `passOnStoreError`. Confirmed fixed:
re-running the same test suite afterward shows no "Unhandled Errors" section.

**Local proof — exact scenario, exact result.** Local Redis: `redis:7-alpine` (Docker Hub digest
`sha256:e7723ff7...9219a2`, pulled 2026-07-31), started via `docker run -d --rm -p 127.0.0.1::6379
redis:7-alpine` inside `api/src/middleware/__tests__/redis-rate-limit-store.test.ts`'s own
`beforeAll` (ephemeral host port, read back via a bounded poll of `docker port` — `docker run -d`
can return before the port mapping is queryable, observed directly while building this test, fixed
with a poll rather than a fixed sleep per rule 5). Scenario: two independent ioredis client
connections (`clientA`, `clientB`, simulating two separate EB instances) each back their own
`rateLimit()` middleware/Express app via `createRedisRateLimitStore`, same key prefix, same fixed
identity key, `limit: 3`. Three requests through instance A alone reach the limit (all `200`).
**Result actually observed:** the next request through instance B — which has never served a
request for this identity — is `429`, not `200`. That is only possible if the counter lives in
Redis, not in either process's memory; two separate TCP connections prove it isn't the SAME
in-process object being reused. A companion Docker-free "contrast" test runs the identical scenario
with two plain `MemoryStore` instances and confirms instance B is **not** blocked (`200`) — the
literal defect API-7 reports, still present and now clearly separated from the fix.

**Regression tests** (`api/src/middleware/__tests__/redis-rate-limit-store.test.ts`, new, 9 cases;
`api/src/config/ssm.test.ts`, +2 cases):

1. Wiring — `createRedisClientFromEnv` returns `undefined` with no `REDIS_URL`, a client with one;
   `createRedisRateLimitStore` builds a `RedisStore` with the given prefix; `createApiRateLimiters`
   still returns exactly 2 handlers unconfigured (API-1 unchanged). No Redis needed.
2. Fail-open — a store pointed at `127.0.0.1:1` (a privileged port nothing can bind, so the
   connection fails fast and deterministically, no real Redis needed) with `passOnStoreError: true`
   still serves `200` and logs via `console.error`; a control test with `passOnStoreError` NOT set
   confirms the library's own default really is fail-**closed** (`500`), so this ticket's choice is
   a real override, not a no-op.
3. Contrast (no Redis) — two `MemoryStore` instances do not share a budget for the same identity —
   documents the defect.
4. Shared-state proof (Docker-gated via `describe.skipIf(!dockerAvailable)`, `docker info` checked at
   file load) — the scenario above, plus a smoke test that `createApiRateLimiters` itself (the real
   production factory function, not a hand-rolled limiter) serves a request end-to-end against a
   real Redis. **Checked, not assumed: this repository's own CI (`.github/workflows/ci.yml`) does
   not declare a `redis:` (or any) `services:` container**, and this test does not require one — it
   starts its own via `docker run`. GitHub-hosted `ubuntu-latest` runners do generally have a
   reachable Docker daemon even without a declared service, so this group is expected to run for
   real in CI too, not just skip — but that is **derived from GitHub's documented runner
   image, not verified by watching this exact workflow run in Actions**, which this environment
   cannot do. If a CI environment ever lacks Docker access, `isDockerAvailable()` (a synchronous
   `docker info` check) makes this group skip cleanly with a `console.warn` explaining why, rather
   than fail the gate or silently report nothing was tested.
5. `ssm.test.ts` — `loadProductionSecrets` sets `process.env.REDIS_URL` when SSM has it, and leaves
   it unset (without failing the required-secrets load) when SSM returns `ParameterNotFound` for it.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/redis-rate-limit-store.test.ts
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts   # unchanged, still 15/15
pnpm --filter @ship/api test src/config/ssm.test.ts
cd terraform && /path/to/terraform init -backend=false && terraform validate && terraform fmt -check -recursive .
```

**NOT verified.** Live AWS multi-instance behavior (no AWS credentials, no `apply` — by design, see
above). Whether GitHub Actions' `ubuntu-latest` runner actually has a usable Docker daemon for this
specific workflow (derived from GitHub's general documentation, not observed in this repo's Actions
history). Redis wired into the live Render deployment (out of scope, noted as a follow-up above).

**Roll back.** Revert this ticket's commits. `api/src/middleware/redis-rate-limit-store.ts` is new
and self-contained; `rate-limit.ts`/`app.ts`/`config/ssm.ts` changes are additive (an optional
parameter and an `if (redisClient)` branch) with no `REDIS_URL` behavior change, so simply not
deploying `terraform/redis.tf` (never applied here) leaves production behavior identical to before
this ticket — no `REDIS_URL` SSM parameter exists, `createRedisClientFromEnv` returns `undefined`,
every limiter uses `MemoryStore` exactly as it did under API-1/TRO-172. Remove
`ioredis`/`rate-limit-redis` from `api/package.json` and re-run `pnpm install` if fully reverting.

---

## TRO-186 (DB-9) — Sprint board and document view fired byte-identical requests two and three times

**What was broken.** Two unrelated components shared one root cause: a `useEffect` that called
`apiGet`/`fetch` directly, with no cleanup to cancel the request React 18 `StrictMode` discards.

- `web/src/pages/TeamMode.tsx`'s initial-load effect (previously lines 203-209) ran
  `Promise.all([fetchTeamGrid(...), fetchProjects(), fetchAssignments()])` with no cleanup function
  at all. `StrictMode` (dev only) mounts every component twice — setup, cleanup, setup again — to
  surface exactly this class of bug. With nothing to cancel the first mount's three requests, the
  browser sent them anyway: `GET /api/team/grid`, `GET /api/team/projects`, and
  `GET /api/team/assignments` each fired twice per page load. `audit/db-query/raw/flow-requests.json`
  ("Load sprint board") caught this directly.
- `web/src/components/editor/BacklinksPanel.tsx`'s poll effect (`fetchBacklinks()`, called on mount
  and every 5s via `setInterval`) already tracked a `cancelled` flag from the TRO-196/ERR-9 fix, but
  that flag only suppressed the *state update* from a stale response — it never cancelled the
  underlying `fetch`, so the discarded first mount's request still reached the server. Audit
  evidence: `GET /api/documents/:id/backlinks` fired 3x on one document view (2x from the
  `StrictMode` double-mount, plus one legitimate 5-second poll tick landing inside the 5s
  observation window the audit's harness waits before moving on).

Both are genuinely a frontend duplicate-request bug, not a server issue: the API returns exactly
one response per request it receives (confirmed by reading `api/src/routes/team.ts` and
`api/src/routes/backlinks.ts` — each handler runs once per HTTP request, no fan-out).

**What changed — one fix pattern, applied to both.** Neither file was migrated to `@tanstack/react-query`
(the codebase's usual dedup mechanism for 13 other `use*Query.ts` hooks): `TeamMode.tsx`'s
grid/projects/assignments fetches carry pagination and optimistic-assignment state that would need a
real redesign to move onto query-cache semantics, and `BacklinksPanel.tsx`'s poll-plus-failure-mode-
throttling behavior (TRO-196/ERR-9's `lastLoggedFailureModeRef`) is asserted exactly, line-for-line
call-count, by `BacklinksPanel.errorLogging.test.tsx` — routing its errors through react-query's
global `QueryCache.onError` would reintroduce the console-error storm that ticket fixed. Instead,
both effects now create an `AbortController`, thread its `signal` into the fetch call(s), and call
`controller.abort()` in the effect's cleanup — the same cancellation idiom React's own docs recommend
for exactly this failure mode, and a natural extension of `BacklinksPanel.tsx`'s existing (state-only)
`cancelled` guard rather than a new pattern.

- `web/src/lib/api.ts`: `apiGet(endpoint)` → `apiGet(endpoint, options?: { signal?: AbortSignal })`,
  backward compatible (all 51 pre-existing call sites pass no second argument).
- `web/src/pages/TeamMode.tsx`: `fetchTeamGrid`/`fetchProjects`/`fetchAssignments` each take an
  optional `signal`, forward it to `apiGet`, and treat a resulting `AbortError` as a silent no-op
  (added `isAbortError`) rather than surfacing `setError`. The initial-load effect creates one
  `AbortController`, passes its signal into all three calls, and aborts it on cleanup; a `cancelled`
  guard (same idiom as `BacklinksPanel.tsx`) stops the discarded first mount's `Promise.all(...)
  .finally()` from calling `setLoading(false)` before the real (second) mount's fetches resolve.
  Other call sites (`showArchived` toggle, infinite-scroll `fetchMoreSprints`) are unaffected — they
  are user-triggered, not part of the `StrictMode` double-mount, and were never duplicated.
- `web/src/components/editor/BacklinksPanel.tsx`: added an `AbortController`, passed its `signal`
  into the `fetch(...)` call, and call `controller.abort()` in the existing cleanup alongside the
  pre-existing `cancelled = true` and `clearInterval(intervalId)`. No other line changed — the
  existing `if (!cancelled)` guards already wrapping every state update and every
  `console.debug`/`console.error` call in `fetchBacklinks()` (the TRO-196/ERR-9 fix) already no-op
  correctly for an aborted request; this only stops the wasted request from reaching the server in
  the first place.

**Regression tests** (vitest, run by the gate):
- `web/src/pages/TeamMode.duplicateRequests.test.tsx`
- `web/src/components/editor/BacklinksPanel.duplicateRequests.test.tsx`

Both wrap the component in `<React.StrictMode>` — a single ordinary mount (what
`BacklinksPanel.test.tsx` and `.errorLogging.test.tsx` already use) never exercises this bug, since
React only double-invokes effects under `StrictMode`; a test that didn't force it would pass
unchanged on the pre-fix code and prove nothing. Both mocks are `AbortSignal`-aware: a mock that
always resolves regardless of `signal` would report "2 calls" whether or not the fix is present,
because the discarded first mount's `fetchTeamGrid()`/`fetchBacklinks()` call still *happens* either
way under `StrictMode` — only whether its request reaches a response changes. Each test asserts
three things: the endpoint really was invoked twice (proves the test forces the double-mount),
the first mount's request really was aborted, and exactly one request settles with a real response
(the proxy for "one request reaches the server and runs its DB queries," which is what DB-9 measures).

Confirmed red-before-green on both, without `git stash` (forbidden — the stash stack is shared
across concurrent factory worktrees on this machine): saved the fix as a patch
(`git diff > fix.patch`), `git checkout --` the three source files back to `main`'s state, re-ran —
`TeamMode.duplicateRequests.test.tsx` failed with `expected +0 to be 1` (no aborted request) and
`BacklinksPanel.duplicateRequests.test.tsx` failed the same way — then `git apply`'d the patch back
and confirmed both green, alongside the pre-existing `BacklinksPanel.test.tsx` (2 tests, A11Y-6) and
`BacklinksPanel.errorLogging.test.tsx` (4 tests, ERR-9), unaffected.

**Measured before/after.**

*Conditions.* Factory worktree `ship_wt_tro_186`, dedicated Postgres (`ship-audit-pg` container,
`localhost:5433`), seeded via `pnpm db:seed` + `npx tsx audit/seed-augment.ts` to the audit's exact
target volume — verified 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27
weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users, 813
`document_associations`, matching `audit/db-query/baseline.md` byte-for-byte. Dev servers on the
worktree's own ports (API 3352, web 5525). Logged in as `dev@ship.local`.

*HTTP-request level (Playwright, `audit/db-query/raw/flow-capture.mjs` adapted to these ports —
clean signal, scoped to this worktree's own web server, unaffected by any other worktree's traffic).
One run pre-fix, three separate runs post-fix, each with 2 iterations (cold/steady) per
`flow-capture.mjs`'s own convention:*

| Flow | Endpoint | Before | After |
|---|---|---|---|
| Load sprint board | `GET /api/team/grid` | 2x (both iterations, both runs) | **1x** (both iterations, all 3 runs — deterministic) |
| Load sprint board | `GET /api/team/projects` | 2x (both iterations, both runs) | **1x** (both iterations, all 3 runs — deterministic) |
| Load sprint board | `GET /api/team/assignments` | 2x (both iterations, both runs) | **1x** (both iterations, all 3 runs — deterministic) |
| View a document | `GET /api/documents/:id/backlinks` | 3x (both iterations) | **2x** in 2 of 3 runs, **1x** in 1 of 3 runs |

The sprint-board reduction is exact and deterministic every time: those three fetches only ever ran
once per mount, so removing the `StrictMode`-only duplicate takes them cleanly to 1x. Backlinks is
not fully deterministic because it also polls every 5s — the fix removes the guaranteed
`StrictMode` duplicate every time (3x → at most 2x, confirmed: never observed above 2x post-fix
across 3 runs), but whether the count lands at 2x or 1x depends on whether the interval's next
legitimate tick happens to fall inside the flow's 5-second observation window, which is timing
noise inherent to the poll, not something this fix controls or should try to control.

*DB query count.* The audit's own methodology (statement logging + marker-bracketed capture) turned
out to be **unreliable on this shared machine**: `ship-audit-pg` is one Postgres instance shared by
every concurrent factory worktree, and a repeat of the capture during this measurement caught
unrelated activity from other worktrees inside the same time-sliced window — a `document_type='wiki'`
insert titled "Malformed frame async handler doc" (a different ticket's test fixture) landed inside
my "View a document" slice, and a later attempt caught `Ship-wt-tro_296` running
`CREATE DATABASE`/`DROP DATABASE`/`TRUNCATE TABLE` mid-capture, inflating one flow's reported count
from a real ~40 to 588. Both are verifiable in the raw log by their foreign document titles / database
names, not this worktree's data. Rather than report a contaminated number, per-endpoint query cost
was instead read directly from source (deterministic, not sensitive to what else is running):

| Endpoint | Source | Non-auth queries | + auth (typical duplicate: session `SELECT` only, `UPDATE` already throttled by DB-2) |
|---|---|---|---|
| `GET /api/team/grid` | `api/src/routes/team.ts:14-200` (`getVisibilityContext` + users + workspace + sprints + issues) | 5 | 6 |
| `GET /api/team/projects` | `api/src/routes/team.ts:200-238` (`getVisibilityContext` + projects) | 2 | 3 |
| `GET /api/team/assignments` | `api/src/routes/team.ts:265-457` (`getVisibilityContext` + explicit + workspace + issues) | 4 | 5 |
| `GET /api/documents/:id/backlinks` | `api/src/routes/backlinks.ts:22-73` (`getVisibilityContext` + existence check + backlinks select) | 3 | 4 |

`authMiddleware`'s session-activity `UPDATE` (`api/src/middleware/auth.ts:356-360`) is throttled to
once per 60s per session since DB-2 (already on `main` before this ticket started) — a duplicate
call landing seconds after the first never re-pays it, only the session `SELECT`
(`auth.ts:239-247`) always runs. **Eliminating one duplicate grid + one duplicate projects + one
duplicate assignments call removes 6+3+5 = 14 DB queries per sprint-board page load** — a fact
derived from source, not measured live, but exact regardless of concurrent load on the shared
database, unlike the statement-log approach above. Eliminating backlinks' guaranteed duplicate
removes a minimum of 4 more per document view (up to 8 when timing also avoids the poll window).

**Correcting the ticket's own estimate.** DB-9's brief cited "Sprint board 51 → ~40 (-22%)" from
`audit/db-query/baseline.md`. That 51-query baseline predates DB-2 (TRO-179, session-write
throttling), which already landed on `main` before this ticket started and independently reduced
the flow's per-request auth cost — the absolute counts do not carry over. Re-running this ticket's
own (uncontaminated) capture of "Load sprint board" cold-load against the *current* `main` showed
**42 total queries before this fix**; the 14-query reduction derived above is **-33%** of that
figure — the same direction as the ticket's estimate and clearing the same ≥20% target, but a
larger percentage against a smaller (already-improved) baseline, not the same arithmetic.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/TeamMode.duplicateRequests.test.tsx
pnpm --filter @ship/web exec vitest run src/components/editor/BacklinksPanel.duplicateRequests.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/db-9-duplicate-requests` touching `TeamMode.tsx`,
`BacklinksPanel.tsx`, and `api.ts`'s `apiGet` signature (the added second parameter is additive and
optional, so reverting it is safe independent of the other two), and delete
`TeamMode.duplicateRequests.test.tsx` and `BacklinksPanel.duplicateRequests.test.tsx`.

---

## TRO-297 (TS-10) — `api/`'s 10 floating/misused-promise sites fixed, both rules promoted to `error` for `api/` only

**Scope, deliberately narrower than the ticket's own definition of done.** The Linear ticket asks
for `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` at
`error` in **all three** packages (api, web, shared), citing ~398 sites total. That is too large
for one reviewable PR — web alone is ~389 sites across many files. This ticket covers **`api/` only**.
web and shared stay at `warn`; see "What's still open" below for the recommended follow-up split.

**Live count re-derived, not trusted from the ticket's cache.** The ticket's own text says api has 9
sites (4 floating + 5 misused). The actual live count, from the command below, was **10** (5
floating + 5 misused) — one more than cached, because the ticket's count predates
`session-activity-race.test.ts`'s TRO-300 rewrite, which added a new floating-promise site
(`createCompletionBarrier`'s counter increment) after the ticket was filed.

```bash
source .factory-env
pnpm --filter @ship/api exec eslint src --rule \
  '{"@typescript-eslint/no-floating-promises":"error","@typescript-eslint/no-misused-promises":"error"}'
```
**Before:** `✖ 222 problems (10 errors, 212 warnings)`.
**After (same command):** `✖ 212 problems (0 errors, 212 warnings)` — the 212 remaining warnings are
all `no-explicit-any`/`no-non-null-assertion` (TS-1/TS-2/TS-4/TS-8, untouched, out of scope here).

**The 10 sites and what each one got, grouped by real decision made (never a blanket `void`):**

1. **`api/src/db/migrate.ts:58`** and **`api/src/db/seed.ts:1259`** — the known top-level
   `migrate();` / `seed();` calls. Both functions' OWN try/catch only wraps the body *after*
   `await loadProductionSecrets()` — a call that genuinely throws in production when SSM is
   unreachable and no `DATABASE_URL`/`SESSION_SECRET` fallback is set (`ssm.ts`'s documented
   crash-loop path). That rejection escaped both functions' internal error handling entirely and
   reached the bare top-level call as an unhandled rejection. **Fix: `.catch(...)`** routing through
   the exact same "log and `process.exit(1)`" shape each function's own try/catch already uses
   (`Database migration failed:` / `❌ Seed failed:`) — not a new error-reporting convention, the
   existing one extended to cover the one gap in it.
2. **`api/src/db/client.ts:40,47`** (`no-misused-promises`, 2 sites) — `process.on('SIGTERM', async
   () => { ...; await pool.end(); ... })` and the `SIGINT` twin. `process.on()`/`EventEmitter` never
   awaits a listener's return value, so a `pool.end()` failure during shutdown was an unhandled
   rejection instead of a clean exit. **Fix:** listeners are now plain (non-async) functions;
   `pool.end().then(...).catch(...)` routes both outcomes through an explicit `process.exit(0)` /
   `process.exit(1)`.
3. **`api/src/collaboration/index.ts:219,1388`** (`no-floating-promises`, `schedulePersist`'s
   `setTimeout` callback and the `ws.on('close', ...)` final-persist call) — `persistDocument(...)`
   already catches everything inside its own try/catch and never rethrows; these two call sites only
   needed `.catch(...)` to cover the narrow case where something throws **before** that try block
   (e.g. `Y.encodeStateAsUpdate` on a corrupted doc). **Fix:** `.catch()` logging
   `[Collaboration] Unexpected error scheduling/persisting ... :`.
4. **`api/src/collaboration/index.ts:1112,1185`** (`no-misused-promises`, 2 sites) —
   `server.on('upgrade', async (request, socket, head) => {...})` and
   `wss.on('connection', async (ws, ...) => {...})`, this ticket's stop-for-human file
   (ERR-1/2/10/11/12's async-ordering hazard). **Read the hazard pattern first, then verified this
   fix does not touch it:** both handlers' bodies and `await` ordering are byte-for-byte unchanged —
   ERR-10's "attach the error listener before any `await`" and ERR-11's buffering-listener ordering
   are still the first statements in `handleConnection`. The only change is mechanical: each async
   body was extracted into a named `async function` (`handleUpgrade` / `handleConnection`), and the
   actual `.on()` listener is now a thin **synchronous** wrapper that calls it and attaches
   `.catch(...)`. This is a real fix, not just lint-satisfaction: `handleUpgrade`'s first statement,
   `new URL(request.url || '', \`http://${request.headers.host}\`)`, throws a `TypeError` for a
   syntactically invalid `Host` header — and Node's HTTP parser does not validate `Host`'s grammar,
   it hands the raw client-controlled header value straight through (confirmed directly against a
   bare `http.createServer`). Before this fix, that throw was an **unhandled rejection that killed
   the whole process** — the exact same failure class as ERR-10, one layer up, at the HTTP upgrade
   request instead of the WS frame. See the regression test below, which reproduces this exact
   attack and confirms it goes red against the pre-fix shape.
5. **`api/src/middleware/__tests__/session-activity-race.test.ts:169`** (`no-floating-promises`,
   test-only code) — `outcome.then(() => { completed += 1; ... })` inside `createCompletionBarrier`.
   `outcome` is constructed two lines up to **never reject** (a thrown error becomes a tagged
   `{ ok: false, error }` fulfillment, specifically so this counter can't be short-circuited — see
   TRO-300's entry above). **Fix: `void`**, the one justified case in this ticket — a `.catch` here
   would be dead code contradicting the type's own documented invariant.
6. **`api/src/collaboration/__tests__/malformed-frames.test.ts:633`** (`no-misused-promises`,
   test-only code) — `const asyncHandler: () => void = async () => { throw ... }`. This line is an
   **existing regression test** (predating this ticket) that deliberately pins the exact hazard
   `no-misused-promises` exists to catch: TypeScript's structural typing silently accepts a
   `Promise<void>`-returning function where `() => void` is expected, so `runFrameHandler`'s runtime
   guard has to defend the case regardless of whether lint catches any *particular* attempt to
   construct it. **Fix: scoped `eslint-disable-next-line`**, not a rewrite — rewriting this line to
   satisfy the rule (e.g. an `as` cast) would make the test's own comment ("no cast is needed to
   express that, which is precisely the hazard") false, and moving the async function inline as a
   call argument reproduces the identical violation one line over. No `as any`/`as unknown as`/
   non-null `!` used anywhere in this ticket's changes.

**`eslint.config.mjs`** — `api/src/**/*.ts` split into its own config block with a new
`apiCorrectnessRules` (spreads the shared `correctnessRules`, overrides both promise rules to
`'error'`); `shared/src/**/*.ts` now has its own separate block at the original `warn` (previously
combined with `api/src` in one `files` glob) so a future widening of the `api/src` override can't
accidentally catch `shared/src` too. `web/src/**/*.ts(x)` unchanged.

**Regression tests added (all in `api/src/**/*.test.ts`, all confirmed red against the pre-fix code
before being confirmed green — reverted each fix locally, one at a time, re-ran the exact test,
confirmed the failure, then restored):**
- `api/src/db/__tests__/migrateCli.test.ts` — new describe block, forces `loadProductionSecrets()`
  to reject (`NODE_ENV=production`, empty `DATABASE_URL`/`SESSION_SECRET` so `.env.local` can't
  refill them, `AWS_ENDPOINT_URL_SSM=http://127.0.0.1:1` for a fast deterministic `ECONNREFUSED`
  with no real AWS calls) and asserts the failure is reported through `migrate.ts`'s own
  `Database migration failed:` line, not an unhandled rejection. Pre-fix: stderr contains Node's
  `triggerUncaughtException` trace instead.
- `api/src/db/__tests__/seedCli.test.ts` (new file) — identical shape for `seed.ts`, asserting on
  `❌ Seed failed:`.
- `api/src/db/__tests__/clientShutdown.test.ts` + `fixtures/sigtermRejectsPoolEnd.ts` (new files) —
  the fixture imports the real `pool` from `client.ts` (registering the real SIGTERM/SIGINT
  listeners), monkey-patches `pool.end()` to reject, and calls `process.emit('SIGTERM')` (not a real
  OS signal — this is testing the listener's own logic, not signal delivery). Asserts the rejection
  is reported through `Error closing database pool on SIGTERM:`.
- `api/src/collaboration/__tests__/malformed-frames.test.ts` — one new `it` in the existing ERR-10
  describe block, reusing its server/fixture/`ProcessCrashRecorder` setup: opens a raw `net.Socket`,
  sends a hand-crafted WS upgrade request with `Host: exam ple.invalid` (a literal space — Node's
  HTTP parser passes it through unvalidated), and asserts (a) the crash recorder captured nothing,
  (b) the server closes the connection, and (c) a fresh, well-formed client can still connect and
  persist a write afterward — the same "not merely un-crashed but still serving" bar this file's
  other ERR-10 cases already hold. Needed `socket.resume()` on the client side (a `net.Socket`
  starts in paused mode; without a `'data'` listener or explicit resume it never observes the
  server's FIN, so `'close'` never fires within any deadline — nothing to do with the server's
  actual behavior, discovered while first-drafting this test).

**Verified:**
```bash
source .factory-env
pnpm --filter @ship/api exec tsc --noEmit                     # clean
pnpm --filter @ship/api lint                                  # exit 0, 0 errors, 212 warnings (any/non-null only)
pnpm --filter @ship/api exec vitest run \
  src/db/__tests__/migrateCli.test.ts src/db/__tests__/seedCli.test.ts \
  src/db/__tests__/clientShutdown.test.ts \
  src/collaboration/__tests__/malformed-frames.test.ts \
  src/middleware/__tests__/session-activity-race.test.ts       # 21/21 passed
```

**What's still open — web's ~389 sites.** Recommend splitting into several follow-up tickets by
directory rather than one mega-ticket, e.g.: `web/src/pages/*` in 2-3 batches (grouped by feature
area — this is where the bulk of the sites live, mostly React event handlers), then a smaller
cleanup ticket for `web/src/components/**` and `web/src/lib/**`. `shared/src` is 0 sites today but
was deliberately **not** promoted to `error` in this ticket — it has no dedicated ticket verifying
it stays at zero the way this one did for `api/`, so promoting it would be an unverified drive-by
even though the count happens to already be zero.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api lint
pnpm --filter @ship/api exec vitest run src/db/__tests__/migrateCli.test.ts src/db/__tests__/seedCli.test.ts src/db/__tests__/clientShutdown.test.ts
```

**How to roll it back.** Revert this commit. `eslint.config.mjs`'s `api/src` override reverts to
`warn`, all ten sites' fixes revert with it (each is additive — a `.catch`/`void`/extraction, no
removed functionality), and the five new/modified test files revert to their pre-ticket state.

---

## TRO-201 (BUN-5) — icon glob emitted 245 chunks; only 4 were ever used, not the ~36 estimated

**What was broken.** `web/src/components/icons/uswds/Icon.tsx:23-26` used a whole-directory
`import.meta.glob('/node_modules/@uswds/uswds/dist/img/usa-icons/*.svg', { query: '?react' })`,
which makes every USWDS icon SVG a separate lazy chunk regardless of whether anything in the app
ever renders it. 245 chunks shipped to every deploy; the finding's own methodology (a whole-`web/src`
grep for any quoted literal matching one of the 245 filenames) counted "36 referenced, 209 not."

**The re-derived number is 4, not ~36 — and here is the disconfirming evidence, checked before
trusting the cached figure.** Reproducing that same literal-grep methodology live today
(`grep` every `.ts`/`.tsx` file under `web/src`, excluding `types.ts`, `Icon.tsx`, `__mocks__/`,
and `*.test.*`, for a quoted string matching one of the 245 icon filenames) finds **35** matches —
close to the ticket's cached 36, so the numbers had only drifted by one, as expected. But that
grep counts a name as "referenced" if the *text* appears anywhere as a quoted string, and this
codebase's `<Icon>` component (`web/src/components/icons/uswds/Icon.tsx`) is imported by **exactly
one file**: `web/src/pages/Login.tsx`. Grepping for `<Icon\b` across `web/src` (excluding docstring
examples in `Icon.tsx` itself and `*.test.tsx`) turns up exactly four call sites, all in that one
file, all inline literals:

```tsx
<Icon name="check" className="h-3 w-3 text-green-500" title="Check (h-3)" />
<Icon name="close" className="h-4 w-4 text-red-400" title="Close (h-4)" />
<Icon name="warning" className="h-5 w-5 text-yellow-500" title="Warning (h-5)" />
<Icon name="info" className="h-6 w-6 text-accent" title="Info (h-6)" />
```

The other 31 matches from the whole-file literal grep are coincidental: words like `settings`,
`person`, `search`, `list`, `home`, `work`, `public`, `menu`, `star`, `delete`, `edit`, `lock`,
`timer` etc. are quoted strings elsewhere in the app for unrelated reasons (status values, route
segments, generic identifiers) — and several apparent "icon usages" that surfaced in that search
(`DocumentTypeIcon`, `StatusIcon`, `ColumnStatusIcon`, `IssueStatusIcon` in
`ContextTreeNav.tsx`/`IssuesList.tsx`/`KanbanBoard.tsx`/`pages/App.tsx`, plus
`VisibilityDropdown.tsx`'s `LockIcon`/`GlobeIcon`/`CheckIcon`) turned out on inspection to be
custom hand-written inline `<svg>` components, entirely unrelated to the USWDS `<Icon>` system.
Since `<Icon>` has no aliased import and no `name={someVariable}` call site anywhere (every call
is a literal), there is no code path by which any of those other 31 names could reach the
component's `name` prop. **`e2e/icons.spec.ts` independently corroborates this**: it was already
asserting `iconsContainer.locator('svg[role="img"]')` has count **4** on the login page, by name
(check/close/warning/info), before this ticket touched anything.

**The fix — extending the same generator, not inventing a second mechanism.**
`web/scripts/generate-icon-types.ts` already scanned `@uswds/uswds/dist/img/usa-icons/` to write
`types.ts`'s full `IconName` union (unchanged: still all 245 names, for autocomplete/type-safety on
any icon the sprite ships, whether used yet or not — verified byte-identical before/after this
change). It now also scans `web/src` for every `<Icon name="...">` call and writes a second file,
`usedIcons.generated.ts`: a **static, eager** import map (`Record<string, SvgComponent>`) covering
only the icon names actually found. The scan itself lives in a new shared module,
`web/src/components/icons/uswds/scanUsedIcons.ts`, so it can never drift from what the regression
test (below) checks — both call the exact same function. `Icon.tsx` now renders from this map
instead of the whole-directory glob; `lazy`/`Suspense`/the per-icon module cache are gone entirely,
since eager, statically-imported components need none of that machinery. A name that's a valid
USWDS icon but absent from the map (a new `<Icon name="...">` added without re-running the
generator) renders `null` with a `console.warn` telling the developer to run
`pnpm generate:icon-types` — same graceful-degradation shape the old "unknown icon name" path
already had, not a build break.

**Workflow change for adding a new icon (read this before adding one).** Previously, writing
`<Icon name="whatever">` "just worked" the moment the icon existed in the USWDS sprite, because the
whole directory was eagerly globbed. **That is no longer true.** After adding a new `<Icon
name="...">` call, run `pnpm --filter @ship/web generate:icon-types` and commit the regenerated
`usedIcons.generated.ts` alongside it — otherwise the name still type-checks (it's in `types.ts`'s
full union) but renders nothing at runtime until the generator is re-run. This is the deliberate
tradeoff the finding called for: a developer workflow step in exchange for not shipping 209 (now
potentially more, as the app grows) icons nobody uses. The new regression test below exists
specifically to catch the failure mode where someone forgets this step and it slips past review.

**Measured, before/after.** Methodology: build with `pnpm build` (`tsc && VITE_API_URL= vite
build`) run **from `web/`** — this repo's established convention
(`audit/bundle/baseline.md` §"Fidelity check", repeated in the TRO-197/198/199/200/202 entry above)
because Tailwind's `content` globs resolve against the build's CWD. "Before" was built from this
branch's unmodified base commit (`a8f2bb054b4a8b981c98c0b67f8f7a3123449b21`) in an isolated
`git worktree add --detach` copy with `node_modules`/`shared/dist` symlinked in from this worktree
(same tool versions, no separate install) — not by mutating this worktree, same precedent as the
BUN-1..6 entry above. "After" is this worktree with only the 5 files this ticket touches changed
(confirmed via `git diff --stat` against the before commit). Entry-closure and total-dist figures
are `node audit/bundle/measure.mjs web/dist <label>` (unmodified, existing tool) at gzip level 9,
kB = 1000 bytes. Icon-chunk-specific count/bytes use the same filename-stem classification
`audit/bundle/baseline.md` describes ("everything else lowercase-alphanumeric → USWDS icon
chunks") via a one-off script, also gzip level 9.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Icon chunks emitted | 245 | **0** | −245 |
| Icon chunk bytes (raw / gzip) | 106.35 kB / 75.30 kB | **0 / 0** | −106.35 / −75.30 |
| Total JS chunks emitted | 312 | **67** | −245 |
| Entry chunk `index-*.js` (raw / gzip) | 118.34 kB / 31.95 kB | **78.12 kB / 23.54 kB** | −40.22 kB / −8.41 kB (−34.0% / −26.3%) |
| Initial-load closure, `/login` (raw / gzip) | 410.66 kB / 117.61 kB | **370.47 kB / 109.22 kB** | −40.19 kB / −8.39 kB |
| `/docs` route closure (gzip) | 182.36 kB | **173.97 kB** | −8.39 kB |
| `/documents/:id` route closure (gzip) | 212.25 kB | **203.84 kB** | −8.41 kB |
| Total dist, excl. manifest (raw / gzip) | 3370.09 kB / 1774.16 kB | **3223.55 kB / 1690.45 kB** | −146.54 kB / −83.71 kB |

The total-dist delta reconciles exactly: icon-chunk removal (−106.35/−75.30 kB) plus the
entry-chunk reduction (−40.22/−8.41 kB) sums to −146.57/−83.71 kB, matching the observed total to
within rounding, confirming no other file changed between the two builds.

**Entry-chunk savings are larger than the original finding estimated (~3.6 kB gzip), and here's
why.** The old glob didn't just produce a name→string lookup table; each of the 245 entries was a
`() => import('/node_modules/.../X.svg?react')` closure, and Rollup has to keep bookkeeping for
every one of those 245 dynamic-import call sites in the chunk that references them (the entry
chunk, since `Icon.tsx` is itself eagerly reachable from `Login.tsx`). Removing all 245 — not just
the 4 that survive as static imports — removes that bookkeeping too, not merely a shorter lookup
table.

**Verification.**
- `pnpm --filter @ship/web type-check` — clean (the generated `usedIcons.generated.ts` needed one
  addition: `/// <reference types="vite-plugin-svgr/client" />`, since this repo had never
  statically imported a `*.svg?react` module before — only ever globbed one — so the ambient
  `declare module "*.svg?react"` from `vite-plugin-svgr/client.d.ts` had never been pulled in).
- `pnpm --filter @ship/web test` — 463/463 passed (58 files), including the new regression suite.
- `pnpm --filter @ship/web lint` — 0 errors in touched files.
- `pnpm exec playwright test e2e/icons.spec.ts` — 1/1 passed against a real Chromium build,
  confirming all 4 icons still render as `svg[role="img"]` with `fill="currentColor"` on `/login`.

**Regression test** (`web/src/components/icons/uswds/Icon.test.tsx`, new `describe` block "Icon
liveness — usedIcons.generated.ts must not drift from web/src"): re-runs the exact same
`scanUsedIconNames` function the generator uses against the live `web/src` tree, then asserts every
name it finds is present in `usedIcons.generated.ts`'s map and renders a real `<svg>` without
throwing. Verified this actually catches the regression it's meant to catch, not just a vacuous
pass: temporarily removed `close` from the generated map and re-ran — 2 tests failed
(`expected undefined to be defined` on the map-membership check, `expected null not to be null` on
the render check) — then restored the file and re-ran clean.

**Rollback.** Revert this commit (`git revert`). That restores the whole-directory
`import.meta.glob` in `Icon.tsx` and deletes `usedIcons.generated.ts`/`scanUsedIcons.ts`; no schema,
API, or non-icon frontend code is touched. `types.ts` is untouched by the revert either way (its
generation logic and output are identical before and after this change).

---

## TRO-296 (ERR-15) — `yjsToJson` did not read back marks written via `YXmlText.format()`/`applyDelta()` — round-trip asymmetry in the persistence converter

**Reachability — this is a live, currently-occurring bug, not a latent one.** The finding was
filed as "observed at function level, not via live app" — `api/src/utils/__tests__/yjsConverter.test.ts`
already pinned that `jsonToYjs` then `yjsToJson` disagreed with each other, but that only proves this
converter is internally inconsistent, not that a real editing session ever produces the shape that
trips it. Traced two separate live paths, by reading the actual dependency code shipped in this
repo's `node_modules`, not by inference from documentation:

1. **The dominant path — any live mark, from any user, in any document.** TipTap's
   `@tiptap/extension-collaboration` (`web/src/components/Editor.tsx:692`) delegates to
   `y-prosemirror`. `y-prosemirror/src/plugins/sync-plugin.js`'s `createTypeFromTextNodes` builds
   each run of a paragraph's inline content as one `Y.XmlText` and calls
   `.applyDelta([{ insert, attributes: marksToAttributes(node.marks, meta) }])` — Yjs's native
   text-formatting API, the same one this converter's `jsonToYjs` calls via `.format()`.
   `YXmlText.toString()` (`yjs/src/types/YXmlText.js:68-100`) serializes both identically as literal
   pseudo-XML wrapped around the text. `api/src/collaboration/index.ts`'s `persistDocument()` calls
   `yjsToJson(fragment)` and writes the result into `documents.content` roughly 2 seconds after
   *every* edit (`schedulePersist`, `doc.on('update')`) for the life of any live-collaborated
   document — so any user pressing Cmd+B, or adding a link, corrupts that document's `content` JSON
   backup column into a literal string like `<bold>bold</bold>` within seconds. `documents.yjs_state`
   itself stays correct (it's the raw CRDT state); the corruption is specifically in the JSON
   `content` column that `GET /:id/content` (`api/src/routes/documents.ts:491`) reads in preference
   to converting from `yjs_state`, and that other non-collaborative-socket reads rely on.
2. **A narrower, also-live path.** `collaboration/index.ts`'s `loadDoc()` calls `jsonToYjs` directly,
   once, the first time a document with JSON `content` but no `yjs_state` yet is opened in the
   collaborative editor — e.g. a document written via `PATCH /:id/content` (which explicitly nulls
   `yjs_state`), or the seeded "Welcome to Ship" document
   (`api/src/db/welcomeDocument.ts`, dozens of `bold`/`italic` marks) shown to every new workspace.

Reproduced against the real converter (not a mock) in
`api/src/utils/__tests__/yjsConverter.test.ts`'s new `describe('yjsToJson decodes marks the live
editor actually writes (TRO-296)')` block — one test builds the Yjs tree exactly the way
`createTypeFromTextNodes` does (`Y.XmlText.applyDelta`), **never calling this converter's own
`jsonToYjs` at all**, then runs the real `yjsToJson` against it, proving the bug fires independent of
this converter's own writer. Confirmed red against the pre-fix code (4 new test cases failed,
producing literal `<bold>bold</bold>`-style text), green after the fix — see PR for the transcript.

**What changed.** One file: `api/src/utils/yjsConverter.ts`. Kept `jsonToYjs`'s existing write
representation (`YXmlText.format()`) rather than switching it to wrapper elements, because the live
editor path (path 1 above) never goes through `jsonToYjs` at all — rewriting only this converter's
writer would do nothing for the dominant case. Instead, `yjsToJson` (and its two other read sites,
`yjsElementToJson` and `extractTextWithMarks`) now decode `Y.XmlText.toDelta()` directly instead of
calling `.toString()`, translating each delta op's `attributes` back into a TipTap `marks` array via
new helpers `parseTextDelta`, `marksFromDeltaAttributes`, and `xmlTextToNodes`. Delta attribute keys
are filtered through the existing `MARK_TYPES` allowlist (bold/italic/strike/underline/code/link) and
defensively stripped of y-prosemirror's `--<hash>` overlapping-mark suffix (mirroring its own
`yattr2markname`) before matching — a suffix none of this app's marks trigger today, tested anyway
since it costs nothing and the mapping would otherwise silently drop a mark if that ever changes. A
mark type outside that allowlist (e.g. TipTap's custom `commentMark`) is dropped rather than
reconstructed — the same behavior the old wrapper-element path already had for unknown types, and a
strict improvement over corrupting the surrounding text; extending mark support to comments is a
separate, out-of-scope concern.

**How to verify.**

```bash
pnpm --filter @ship/api test -- src/utils/__tests__/yjsConverter.test.ts
pnpm type-check
```

8 tests pass, including the updated round-trip test (now a plain `toEqual(original)`, since the
round trip is symmetric) and the three new TRO-296 tests. Type-check is clean.

**Rollback.** Revert the commit(s) on `fix/err-15-yjs-mark-roundtrip` touching
`api/src/utils/yjsConverter.ts` and `api/src/utils/__tests__/yjsConverter.test.ts`. No schema,
migration, or collaboration-server change was made or is required to roll back.

---

## TRO-303 — Module-version `aws_s3_bucket.uploads` (dev/shadow) had no `prevent_destroy` — same TF-1 gap, second location; Aurora module gap closed in the same PR

**The problem.** TF-1/TRO-234 added `deletion_protection`/`prevent_destroy` to the flat root's
`aws_rds_cluster.aurora` (`terraform/database.tf`) and `aws_s3_bucket.uploads`
(`terraform/s3-cloudfront.tf`), but that ticket's own "What did NOT change" section explicitly
flagged that `terraform/modules/aurora` and `terraform/modules/cloudfront-s3` — the module versions
consumed by `terraform/environments/dev/main.tf` and `terraform/environments/shadow/main.tf` — carry
the identical gap, and scoped fixing them out as a follow-up. This ticket is that follow-up.

Confirmed both gaps were still open before touching anything, by `grep`:

```
$ grep -n 'deletion_protection\|prevent_destroy' terraform/modules/aurora/main.tf terraform/modules/cloudfront-s3/main.tf
(no output — 0 matches in either file)
```

- `terraform/modules/cloudfront-s3/main.tf`'s `aws_s3_bucket.uploads` had no `lifecycle` block at
  all — nothing stops Terraform from destroying the dev/shadow uploads bucket on a forced
  replacement.
- `terraform/modules/aurora/main.tf`'s `aws_rds_cluster.aurora` had a `lifecycle` block, but it only
  carried `ignore_changes = [final_snapshot_identifier]` (ported over for the `final_snapshot_identifier`
  churn, unrelated to destroy protection) — no `deletion_protection` attribute and no
  `prevent_destroy`. Same defect as the flat root's pre-TF-1 state, just in the module used by
  dev/shadow.

**What changed.** Two additions, mirroring TF-1's flat-root pattern exactly, no resource renamed or
restructured:

- `terraform/modules/cloudfront-s3/main.tf:392-394` — `aws_s3_bucket.uploads` gets a new
  `lifecycle { prevent_destroy = true }` block (S3 has no `deletion_protection` attribute in the AWS
  provider, so `prevent_destroy` is the only available guard, same as the flat root).
- `terraform/modules/aurora/main.tf:70` — `aws_rds_cluster.aurora` gets `deletion_protection = true`
  (first-class RDS attribute, enforced by the AWS API itself). `terraform/modules/aurora/main.tf:93`
  — `prevent_destroy = true` merged into the resource's existing `lifecycle` block alongside the
  pre-existing `ignore_changes = [final_snapshot_identifier]` (one `lifecycle` block per resource,
  so extended rather than duplicated — same approach TF-1 used on the flat root).

Post-change, both files show exactly the expected new matches:

```
$ grep -n 'deletion_protection\|prevent_destroy' terraform/modules/aurora/main.tf terraform/modules/cloudfront-s3/main.tf
terraform/modules/aurora/main.tf:70:  deletion_protection             = true
terraform/modules/aurora/main.tf:93:    prevent_destroy = true
terraform/modules/cloudfront-s3/main.tf:393:    prevent_destroy = true
```

**Scope.** Only these two resources in these two module files changed. The flat root
(`terraform/database.tf`, `terraform/s3-cloudfront.tf`) already carries this protection from TF-1
and was not touched. `terraform/environments/dev` and `terraform/environments/shadow` consume the
modules directly (no vendored copies) so both roots pick up the fix without any change of their own.

**Deliberate consequence, not a surprise** (same shape as TF-1's, now true for dev/shadow too):
removing `prevent_destroy` from either module resource only permits Terraform to *attempt* deletion,
not guarantees it succeeds — the uploads bucket has versioning enabled with no `force_destroy`, so an
operator must still empty it by hand (every object, version, and delete marker) before a destroy can
complete. For the Aurora cluster, `deletion_protection` and `prevent_destroy` are two independent
safeguards — one Terraform-side, one enforced by the AWS API directly — and an intentional teardown
must remove both, flipping `deletion_protection = false` and applying *before* attempting the destroy.

**How to run it.**

```bash
# Terraform binary: v1.15.8 (from an existing scratch cache; not committed to the repo)
cd terraform/environments/dev
terraform init -backend=false -input=false   # Terraform has been successfully initialized!
terraform validate                           # Success! The configuration is valid.
cd ../shadow
terraform init -backend=false -input=false   # Terraform has been successfully initialized!
terraform validate                           # Success! The configuration is valid.
cd ../..
terraform fmt -check -recursive terraform/   # exit 0 before AND after this change — no diff
```

**Verification note.** `terraform validate` and `terraform fmt -check -recursive` were run on both
consuming roots (`terraform/environments/dev`, `terraform/environments/shadow`) before and after
this change: both report `Success!` with no warnings and no diagnostics, before and after — this
change introduces no new warnings or errors on either root. `terraform plan` was attempted on
`dev` (after `rm -rf .terraform` to force a fresh backend init) and fails with
`Error: Backend initialization required, please run "terraform init"` (backend `"s3"`) — no S3
backend or AWS credentials are available in this environment, the same documented failure mode
TF-1/TF-2/TF-3 recorded. **No `terraform apply` was run against any account, live or otherwise.**

**No vitest regression test applies.** Same precedent as TF-1/TF-3/TF-4/TF-5/TF-9: this is a
Terraform-only config change with no application code path to exercise. The evidence is the `grep`
before/after above (0 matches → 3 matches, each attributable to a specific line) plus the
`validate`/`fmt` output showing the config stays syntactically valid on both consuming roots.
`gate.sh`'s regression-test check is expected to fail honestly here rather than have a fake test
manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf1-module-prevent-destroy`. This removes
`deletion_protection` and both `prevent_destroy` additions from the two module files, returning
`terraform/modules/aurora` and `terraform/modules/cloudfront-s3` to their pre-TRO-303 unprotected
state (dev/shadow only — the flat root is unaffected either way). No live AWS state is touched,
since no `apply` was ever run.

---

## TRO-249 [RULE-8] — audited every `CHANGES.md` entry against the three-question bar; backfilled TRO-242/TRO-243's rollback caveats and the missing `audit-baseline` tag note

**What this is.** RULE-8 requires that `CHANGES.md` answer, per entry: what was added, how to run
it, how to roll it back. This ticket predates the now-consistent rich format (it was filed when
`CHANGES.md` barely existed) — its job was to **verify** the file now actually satisfies the rule
for every entry, not to write it from scratch. Same class as TRO-245 (RULE-3): an audit of prior
work, not a new fix, so there is no application code and no regression test.

**Method.** Read every entry (68 total — `node scripts/factory/merge-changes.mjs --check` counts
66 `TRO-*` headings plus the 2 "no ticket: tooling" sections). Cross-checked by hand against that
script's own structural validator, which already flags any entry missing its own
`**How to run it.**`/`**Rollback.**`-style heading — as a non-fatal **warning**, by design, because
(per the script's comment) a chunk of real entries answer the same question in different prose
("How to re-capture.", "How to run it / verify.", a verification-methodology paragraph for a
docs-only change) rather than the one recognized heading. Before this ticket's edits, the check
reported `68 entries, 134 fences, 7 warning(s)`, 0 fatal.

**Result: all 68 entries substantively answer all three questions; 7 use non-standard phrasing the
validator warns on but a human read confirms is not a gap.** Manually opened each of the 7 warned
entries and confirmed real content: TRO-305 (`**How to re-capture.**` + a real `pnpm dev` /
`vitest run` block), TRO-294 (docs-only; `**How to roll it back.**` present, plus a "How I
confirmed the new URL" section standing in for "how to run" since there is nothing to run in a
`.claude/CLAUDE.md` string edit), TRO-292 (`**How to run it / verify.**`, a full shell
reproduction, plus `**How to roll it back.**`), TRO-302 (`**Rollback.**` present; run/verify
commands embedded in its "Verified against" prose), TRO-203+TRO-204 (`**Rollback**` present; build
and test commands embedded in "Verified nothing broke"), TRO-197..202 (`**Rollback.**` present; a
"Build from `web/`" run instruction plus a named regression-test list), TRO-179+TRO-177
(`**Rollback:**` present; a `Tests:` line naming exact vitest files plus a full "Measured"
methodology section). None of the 7 were rewritten — this ticket does not touch entries that are
already substantively compliant, per its own scope rule.

**TRO-242 and TRO-243, backfilled as this ticket's brief specifically asked.** Both already had a
`**Rollback.**` line naming a commit SHA, but neither stated the consequence of actually rolling
back. Verified both SHAs before writing anything:

- `git show bace770 --stat` — a merge commit (`Merge: 149873a 137dcd4`) titled "Merge
  feat/render-deploy: build image from source, serve SPA from API", touching `Dockerfile` (78
  lines) and `api/src/app.ts` (28 lines). Matches TRO-242 exactly. `git diff 149873a bace770 --
  Dockerfile` shows the pre-image copying `shared/dist/` and `api/dist/` straight from the build
  context (`COPY shared/dist/ ./shared/dist/`, `COPY api/dist/ ./api/dist/`) — both gitignored, so
  that old image cannot build from a clean checkout. Added to TRO-242's rollback: reverting brings
  that image back, so **the old image needs a local `pnpm build` before `docker build`**.
- `git show 5b72a79 --stat` — a merge commit (`Merge: bace770 11e93b6`) titled "Merge
  fix/ssm-fallback: allow non-AWS hosts to supply secrets directly", touching only
  `api/src/config/ssm.ts` (41/16 lines). Matches TRO-243 exactly. `git diff bace770 5b72a79 --
  api/src/config/ssm.ts` shows the fix wraps the SSM calls in `try`/`catch`, falling back to
  `DATABASE_URL`/`SESSION_SECRET` from the environment and rethrowing only when neither is set.
  Added to TRO-243's rollback: reverting removes that `catch`, so **it re-breaks non-AWS
  deployment** — any host without AWS SSM access throws on startup again.

**The `audit-baseline` tag note — genuinely missing from `CHANGES.md`, added.** Checked first
(per the claim-provenance rule): the tag was already documented in
`.claude/skills/ship-factory/references/evals.md`, `.claude/skills/ship-factory/SKILL.md`, and
`memory-bank/progress.md`, but nowhere in `CHANGES.md` itself beyond one passing reference to
"`audit-baseline`" inside TRO-174's compression note. Added a short paragraph to this file's
header (above) stating what it points to and why, verified with `git rev-list -n1 audit-baseline`
(`149873a73193dc73e5c3c825b6a46b8ed6fce1c6`) and `git log --oneline --first-parent 149873a..bace770`
(confirms `bace770` — TRO-242 — is the sole first-parent commit after the tag, i.e. the first
Phase 2 merge).

**How to run it.**

```bash
node scripts/factory/merge-changes.mjs --check CHANGES.md
```

**Regression test:** none — documentation/audit ticket, no application code changed, same class as
RULE-3 (TRO-245) and the terraform-only tickets. `gate.sh`'s regression-test check is expected to
fail here and that failure is not a defect in this work.

**Rollback.** Revert this commit. Restores TRO-242/TRO-243's rollback lines to their pre-audit,
SHA-only form and removes the `audit-baseline` paragraph from this file's header. No other entry
was modified.

---

## TRO-283 (TF-8) — CloudFront `compress = true` on `/api/*` was inert; the attached cache policy never enabled Accept-Encoding

**What was broken.** The `/api/*` `ordered_cache_behavior` in both `terraform/s3-cloudfront.tf:154`
(flat root — deployed to prod, per TF-2/TRO-235's convergence) and
`terraform/modules/cloudfront-s3/main.tf:169` (shared module, consumed by
`terraform/environments/dev` and `terraform/environments/shadow`) sets `compress = true`. That
setting is a no-op unless the cache policy attached to the same behavior
(`aws_cloudfront_cache_policy.api_no_cache`, `s3-cloudfront.tf:25` /
`modules/cloudfront-s3/main.tf:27`) explicitly enables `enable_accept_encoding_gzip` and/or
`enable_accept_encoding_brotli` inside its `parameters_in_cache_key_and_forwarded_to_origin` block
— this is a documented AWS provider requirement for cache-policy-based behaviors (as opposed to the
legacy `forwarded_values` style). Neither file set either attribute. **Confirmed by repo-wide
grep** (`grep -rn "enable_accept_encoding" . --include="*.tf"`, run before making any change):
zero matches anywhere in the repo — the ticket's claim that these attributes were "genuinely
absent everywhere" is observed, not assumed.

**What changed.** Added, inside `parameters_in_cache_key_and_forwarded_to_origin` on
`aws_cloudfront_cache_policy.api_no_cache` in both files:

```hcl
enable_accept_encoding_gzip   = true
enable_accept_encoding_brotli = true
```

Plus a short comment above each resource explaining why the attributes matter, referencing this
ticket. No other attribute on either cache policy changed — `default_ttl`/`max_ttl`/`min_ttl`
remain `0` (this policy still disables caching for API routes; only whether CloudFront is allowed
to vary/compress on `Accept-Encoding` changes).

**curl verification — observed, and what it does and does not show.** Per the ticket, ran
`curl -H 'Accept-Encoding: gzip' <url>` against the live prod CloudFront domain from this factory
environment, looking for a `Content-Encoding` response header. **Observed:** every request made —
`https://ship.awsdev.treasury.gov/health`, `/api/health`, `/api/csrf-token`, `/api/setup/status`,
and even the plain SPA root `/` — was intercepted at the CloudFront edge before reaching the
Express origin. `/health` returned `HTTP/2 308` with `x-cache: FunctionGeneratedResponse from
cloudfront`, redirecting to a different host (`273366117842-prod.awsc.caelum.treasury.gov/health`)
that itself timed out (`curl -L`, exit 28, 20s timeout — not reachable from this environment).
Every other path, including the static SPA root, returned an identical CloudFront-generated
`HTTP/2 403` ("Request blocked. We can't connect to the server...", `content-length: 919`,
`x-cache: Error from cloudfront`) — same with and without a browser `User-Agent` header. None of
these responses carried a `Content-Encoding` header or any origin-backend marker; they were
generated by CloudFront itself (a viewer-request CloudFront Function for `/health`, and
WAF/edge-level rejection for everything else), not by the API origin.

**Derived, not observed:** getting the *same* CloudFront-generated 403 for every single path
tested — including the static SPA root, which has nothing to do with this ticket's cache policy —
points at this sandbox's egress IP being rejected by CloudFront/WAF before cache-behavior or origin
evaluation ever happens, not at anything caused by the missing `enable_accept_encoding_*`
attributes. **This curl check did not settle whether responses are compressed in practice** — no
request in this session ever reached the origin, so `Content-Encoding` could not be observed either
way. Reporting this plainly rather than inferring a result from an unrelated block: the endpoint
was not reachable from this environment, for reasons unconnected to the change being made here.

**What the code (read, not curl) does show.** `api/src/app.ts:238` already wraps the whole app in
the `compression` npm middleware (`threshold: 1024`), added by TRO-174, and the API's own
`aws_cloudfront_origin_request_policy.api` (`s3-cloudfront.tf:4-22`) uses
`header_behavior = "allViewerAndWhitelistCloudFront"`, which forwards the viewer's
`Accept-Encoding` header to the origin unchanged. So a real client's `Accept-Encoding: gzip`
already reaches the Express origin today, and the origin already gzips qualifying responses,
independent of this ticket. That supports the ticket's own hypothesis that TRO-174's origin-side
gzip likely already covers most real traffic — this fix closes a secondary gap: CloudFront's own
edge-side `compress = true` (a backstop for responses the origin doesn't compress — e.g. below the
1024-byte threshold, or an excluded content-type) was silently never active because the cache
policy never told CloudFront that `Accept-Encoding` was relevant. This is a config-correctness fix
with a plausible but unmeasured secondary benefit, not a fix for a currently-broken client-facing
compression path.

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.15.8 (darwin_arm64), matching the repo's pinned
# terraform/.terraform-version exactly. Not installed on this machine beforehand; not committed to
# the repo. Same "download to a scratch dir" precedent as TF-1/TF-3/TF-4/TF-5/TF-9.
cd terraform
terraform init -backend=false -input=false
terraform validate                 # BEFORE and AFTER: Success! The configuration is valid. (0 warnings, both)
terraform fmt -check -recursive .  # exit 0, no formatting changes needed, both before and after
git clean -fdx -- .terraform       # removes the generated provider cache this init created; the
                                    # committed terraform/.terraform.lock.hcl was reused unchanged
                                    # ("Reusing previous version" in init output), not regenerated

cd environments/dev                # second root: consumes terraform/modules/cloudfront-s3
terraform init -backend=false -input=false   # generates a fresh .terraform.lock.hcl (none tracked here — the TF-4 gap, untouched by this ticket)
terraform validate                 # BEFORE and AFTER: Success! The configuration is valid.
terraform fmt -check -recursive .  # exit 0, both before and after
git clean -fdx -- .terraform .terraform.lock.hcl   # both gitignored (terraform/.gitignore:2,7); leaves `git status` clean

cd ../shadow                       # third root: also consumes terraform/modules/cloudfront-s3
terraform init -backend=false -input=false
terraform validate                 # BEFORE and AFTER: Success! The configuration is valid.
terraform fmt -check -recursive .  # exit 0, both before and after
git clean -fdx -- .terraform .terraform.lock.hcl
```

`terraform plan` was attempted against the flat root and failed with the documented, expected
error: `Backend initialization required, please run "terraform init"` (backend `"s3"`, no
credentials available in this environment) — the same outcome as TF-1/TF-3/TF-4/TF-5/TF-9's
precedent, not a new problem introduced by this change. **`terraform apply` was never run, against
any account, live or otherwise** — this ticket carries an explicit escalation flag ("Do NOT
`terraform apply` without an explicit human decision") and that gate was respected throughout:
config change plus `validate`/`fmt`/`plan`-attempt only.

**No vitest regression test applies.** Pure Terraform config change — same precedent as
TF-1/TF-3/TF-4/TF-5/TF-9/TRO-303: no application code path exists to exercise this from
`api/src/**/*.test.ts` or `web/src/**/*.test.ts(x)`. The evidence is the `terraform validate`
before/after output above (clean both times, on all three consuming roots) plus the diff itself.
`gate.sh`'s regression-test check is expected to fail honestly here rather than have a fake test
manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf-8-cloudfront-compression`. This removes the two
`enable_accept_encoding_*` lines from both `terraform/s3-cloudfront.tf` and
`terraform/modules/cloudfront-s3/main.tf`, returning to today's state (edge-side `compress = true`
inert again, origin-side gzip via TRO-174 unaffected either way). Since `terraform apply` was never
run against any account in this session, no live AWS state exists to reconcile — reverting this
commit and reverting a hypothetical future `apply` of it are two different operations; only the
former is guaranteed to be a no-op against real infrastructure by this entry.

**Follow-up required — not done here, by design.** Applying this change to real CloudFront cache
policies (dev, shadow, and eventually prod) is a separate, human-gated action: whoever has AWS
credentials and makes the explicit human decision the ticket requires should run `terraform plan`
then `terraform apply` against each environment's actual backend, and ideally re-run the
`curl -H 'Accept-Encoding: gzip'` check from a network path that isn't blocked at the CloudFront
edge, to get a real `Content-Encoding` observation post-apply — something this session could not
produce.

---

## TRO-244 (RULE-4) — CI pipeline was missing 3 of the 7 required checks (coverage, dependency audit, security scan)

**What was broken.** Assignment rule 4 requires exactly 7 CI checks: build, lint, type-check, test,
coverage, dependency audit (`pnpm audit`), security scan. `.github/workflows/ci.yml`'s `verify` job
ran build, lint, type-check, and test — four of seven. Coverage was never collected, `pnpm audit`
was never run, and there was no security scan of any kind. Note: `.claude/skills/ship-security-compliance/SKILL.md`
still says CI "deliberately omits `pnpm lint`" because no ESLint config exists — that was true when
written but is now stale; TRO-211/TS-6 already added a real `Lint` step running a working flat
ESLint config. That skill doc's summary needs a follow-up correction; this ticket didn't touch it
beyond noting the discrepancy here so it doesn't get inherited as fact again.

**What changed — three additions, one per missing check.**

**1. Coverage.** `api/vitest.config.ts` already declared a `coverage` block (provider `v8`); the
`@vitest/coverage-v8` provider package itself was simply never installed, so `test:coverage` (which
already existed in `api/package.json`) would have failed on first real use. Added
`@vitest/coverage-v8` to `api/package.json`'s devDependencies. `web/package.json` had no coverage
script or config at all — added `test:coverage`, a matching `coverage` block in
`web/vitest.config.ts`, and the same provider dependency.

Both provider versions are pinned to the **exact** version resolved for `vitest` itself (`4.0.17`),
not a caret range: `@vitest/coverage-v8`'s own `peerDependencies` pin `vitest` to that exact same
version (confirmed via `npm view @vitest/coverage-v8@4.0.17 peerDependencies`), so a looser caret
(`^4.0.16`) resolves to whatever is newest on the `4.x` line at install time — `pnpm install`
actually picked `4.1.10` on the first attempt here, which doesn't match the installed `vitest@4.0.17`
and `pnpm install` reported an unmet-peer warning. Exact-pinning avoids that drift; bump both
together when `vitest` itself is bumped.

Both configs added a **generous, non-enforced-by-default-but-real** floor via vitest's own
`coverage.thresholds.statements`, so the check does something beyond "runs and prints a number":
- **api: 43%** (measured 45.65% on 2026-07-31 — floor is ~2.5 points below).
- **web: 20%** (measured ~22.3% on 2026-07-31 — floor is ~2 points below, and this run showed some
  natural run-to-run variance, 22.27%–22.38%, wide enough margin either way).

Chosen deliberately low: the goal today is "catch a silent regression," not "enforce a coverage
target nobody has agreed to." Confirmed the enforcement is real, not decorative, by temporarily
setting `api`'s threshold to 99% and re-running — it failed with
`ERROR: Coverage for statements (45.65%) does not meet global threshold (99%)` — then reverted to 43%.

Two new CI steps in the `verify` job run `pnpm --filter @ship/api test:coverage` and
`pnpm --filter @ship/web test:coverage` against the same CI Postgres database the existing unit-test
steps use. They are **separate** steps from the existing "API/web unit tests" steps (which already
run the suite once with `continue-on-error: true` for the quarantine-diff gate) rather than folding
`--coverage` into those — vitest happily accepts both flags in one invocation, but doing so would let
a real coverage-threshold failure get silently absorbed by `continue-on-error: true`, which is
supposed to only tolerate *pre-quarantined test failures*, not a coverage regression. The tradeoff is
the api/web suites now run twice in CI (once plain, once instrumented) — accepted deliberately for
that isolation.

A new `scripts/factory/lib/coverage-summary.mjs` reads both packages'
`coverage/coverage-summary.json` (added `json-summary` to each `coverage.reporter` array) and appends
a markdown table to `$GITHUB_STEP_SUMMARY`, visible on every run. Kept as its own file instead of an
inline `node -e '...'` in the YAML `run:` block deliberately — seeing the dependency-audit script hit
a real shell-quoting bug from embedded backticks (see below) made clear that any JS containing
template literals belongs in a file, not inlined in a bash heredoc.

**2. `pnpm audit` — baseline-diff, not a hard gate.** Verified fresh on 2026-07-31 at commit
`2ca800ae47b1fef0368bb86869de19e602297571` (`main`, and this branch's unmodified base):
`pnpm audit --json` reports **135 pre-existing findings — 10 low / 64 moderate / 58 high / 3
critical** — matching the number given in this ticket's brief exactly. (Observed both with and
without `--audit-level=high`; the flag only changes pnpm's own exit-code threshold, not what the
JSON body reports, so the two invocations produce identical `metadata.vulnerabilities` counts.) None
of these are introduced by this change — this repo's dependency tree already carried them.

A hard `pnpm audit --audit-level=high` (or any-severity) CI step would fail on all 135 immediately,
including several other factory tickets' PRs mid-review the same day this landed. **Documented
deviation** (assignment rule 4 explicitly allows a deviation from a required check's naive form when
given written justification — this is that justification): instead of gating on raw findings, this
follows the exact pattern this repo already uses for test regressions
(`audit/factory/quarantine.json` + `scripts/factory/lib/testdiff.mjs`, which diffs failure
*identities* against a baseline, not counts).

- `audit/factory/dependency-audit-baseline.json` — new baseline file, captured from the same
  `pnpm audit --json` run described above. Records `capturedAt`, `capturedAtCommit`,
  `severityCountsAtCapture` (135: 10/64/58/3), and `knownAdvisories`: 124 unique GHSA ids (fewer than
  135 because one advisory can affect more than one dependency path — pnpm's summary counts by
  finding/path, this file's identity list counts by unique advisory).
- `scripts/factory/lib/dependency-audit-diff.mjs` — new script, modeled directly on
  `testdiff.mjs`'s structure. Exports `extractAdvisoryIds()` (GHSA id, falling back to a prefixed
  numeric pnpm advisory id when no GHSA id exists), `severityCounts()`, and `diffAdvisories()` as
  pure functions, plus a CLI entry point guarded by `import.meta.url === file://${process.argv[1]}`
  so the test file below can import the functions without running the CLI. Exit 0 = no new advisory
  vs. the baseline. Exit 1 = a new advisory was introduced — this is what actually fails the build,
  not `pnpm audit`'s own exit code (which is 1 whenever ANY finding exists, baseline or not — the
  new CI step explicitly does not gate on it, see the step's own comment in `ci.yml`). Exit 2 = the
  audit JSON couldn't be read/parsed, e.g. a registry hiccup — reported as a failure, not silently
  treated as a pass. Also writes the same severity table to `$GITHUB_STEP_SUMMARY` when that env var
  is set, so the number is visible on every run, not only on failure — the brief's explicit ask.
- New CI step in the `verify` job: `pnpm audit --json > pnpm-audit-current.json`, then runs the diff
  script against the baseline. Verified locally against a fresh `pnpm audit --json` run on this
  branch (unchanged dependencies): **0 new advisories, 0 resolved, 124/124 still present**, exit 0 —
  and separately verified the fail path by injecting a synthetic fake GHSA id into a copy of the
  audit JSON, which correctly reported `newAdvisories: ["GHSA-fake-fake-fake"]` and exited 1.

**Caught by the PR's own live CI run, not by local testing — stated plainly because this is exactly
the kind of gap the claim-provenance rule in `.claude/CLAUDE.md` exists to catch.** The first two
live runs of this workflow (PR #76, runs `30644101853` and `30644438852`) both failed the audit step
in ~1.2s with zero output from the diff script. Root cause: GitHub Actions' default shell for `run:`
is already `bash -e {0}` (confirmed from the job's own `shell: /usr/bin/bash -e {0}` log line) —
`pnpm audit` exits non-zero on the 135 pre-existing findings *every single run*, and the step's own
`set -uo pipefail` line does not (and cannot) turn off an `-e` that was already active before the
script started running. So `pnpm audit`'s expected, harmless non-zero exit aborted the step before
`dependency-audit-diff.mjs` ever ran. My local verification above never caught this because an
interactive local shell does not run with `-e` by default — it was "verified," but verified under a
shell configuration that could not have exercised this failure mode. Fixed by appending `|| true` to
the `pnpm audit` line, the same idiom the `inventory` job already uses elsewhere in this same file
for its own known-can-fail commands. Confirmed the fix locally by running the exact step body through
`bash -e` (not a plain local shell) before pushing again — exit 0, correct JSON output.

Remediating the inherited 135 findings is **explicitly out of scope for this ticket** — that is
per-advisory dependency upgrade/replacement work, not a CI-pipeline change, and cannot be done safely
under today's deadline. What changed is that the number is now visible and non-regressing on every
PR instead of being unenforced and invisible.

**3. Security scan — CodeQL.** Added a `codeql` job to `ci.yml` (`init` → `analyze`, the currently
recommended two-step form — `autobuild` is legacy and only applies to compiled languages per
`github/codeql-action`'s own README; JS/TS is interpreted, so `build-mode: none` is correct and
fastest). `languages: javascript-typescript` is the current combined identifier (confirmed against
GitHub's docs — `javascript`/`typescript` alone are accepted aliases but `javascript-typescript` is
the documented explicit spelling and analyzes both together regardless). Pinned to commit
`a2983b8bed1923f44751c5c43237f479442827b3` — the commit behind the `v3.37.4` release tag, resolved
via `gh api repos/github/codeql-action/git/refs/tags/v3.37.4` then dereferencing the annotated tag
object to its commit — rather than the mutable `v3` tag, matching this repo's existing third-party
action pinning convention (e.g. `pnpm/action-setup@b906aff... # v4`). Job gets its own
`security-events: write` (least-privilege — the workflow's top-level `permissions:` is `contents:
read` only, and job-level `permissions:` replaces rather than extends that).

**Coverage floor & baseline-diff logic have real, provable failure modes**, per the two checks above.
CodeQL and the coverage/lint/typecheck/test/build/inventory jobs cannot be meaningfully unit-tested
outside GitHub Actions itself — the branch's own PR run is the proof for those (see the PR for the
live run URL and per-job result).

**Regression test — `scripts/factory/lib/dependency-audit-diff.test.mjs`** (Node's built-in
`node:test` + `node:assert/strict`, zero new dependencies). 12 cases covering: GHSA-id extraction,
fallback to a prefixed numeric id when no GHSA id exists, deduping two advisory entries that share
one GHSA id, an empty/missing `advisories` object, `severityCounts()` reading/defaulting
`metadata.vulnerabilities`, and — the core property this whole script exists for —
`diffAdvisories()` correctly classifying a pre-existing advisory as NOT new, a genuinely new one as
new, a since-fixed one as resolved (not new), and a mixed case with all three at once. A final
end-to-end case chains `extractAdvisoryIds()` into `diffAdvisories()` against a fake PR audit report
to prove the whole pipeline, not just the pieces.

No `scripts/factory/lib/*.test.ts` pattern exists yet — nothing under `scripts/` had a test before
this ticket, and this logic lives in a standalone CLI script outside any package's TypeScript
project, so a `node script.test.mjs`-style file is the better fit than forcing it into `api/` or
`web/`'s vitest suite. **Known gap, stated plainly:** `scripts/factory/gate.sh`'s G6 regression-test
check only greps added lines in `*.test.ts` / `*.test.tsx` / `*.spec.ts` files, so it will NOT count
this file's 12 `test(...)` cases. That check was written before anything under `scripts/` had tests
and nobody has updated its glob — filed as a known, documented gap rather than silently relying on
G6 to "just work" here. The test is not orphaned regardless: it is wired into CI as its own step (see
below) so it actually executes on every run.

**How to run it.** (each check, locally)

```bash
# Coverage (requires local Postgres running + the worktree's .env — see
# .claude/CLAUDE.md's Commands section)
source .factory-env
pnpm --filter @ship/api test:coverage
pnpm --filter @ship/web test:coverage

# Coverage summary (same output CI writes to $GITHUB_STEP_SUMMARY; prints to
# stdout when that env var is unset)
node scripts/factory/lib/coverage-summary.mjs \
  --pkg api:api/coverage/coverage-summary.json:43 \
  --pkg web:web/coverage/coverage-summary.json:20

# Dependency audit baseline diff
pnpm audit --json > /tmp/pnpm-audit-current.json
node scripts/factory/lib/dependency-audit-diff.mjs \
  --current /tmp/pnpm-audit-current.json \
  --baseline audit/factory/dependency-audit-baseline.json

# Dependency-audit-diff's own regression test
node --test scripts/factory/lib/dependency-audit-diff.test.mjs

# CodeQL cannot be run locally in the same form it runs in Actions (it needs
# the Actions runtime to initialize/upload); the PR's own CI run is the proof.
```

**Rollback.** Revert the commit(s) on `fix/ci-missing-checks` touching `.github/workflows/ci.yml`,
`api/package.json`, `api/vitest.config.ts`, `web/package.json`, `web/vitest.config.ts`, `.gitignore`
(the added `coverage` ignore line), and delete
`audit/factory/dependency-audit-baseline.json`,
`scripts/factory/lib/dependency-audit-diff.mjs`,
`scripts/factory/lib/dependency-audit-diff.test.mjs`, and
`scripts/factory/lib/coverage-summary.mjs`. `pnpm-lock.yaml` will need `pnpm install` re-run after
reverting the two `package.json` files to drop the now-unused `@vitest/coverage-v8` entries. Reverting
does not touch the existing `verify`/`inventory`/`build-image` jobs or any application code — no
other rollback steps required.

---

## TRO-305 — Category 6 (error handling) screenshots/recordings, closing the gap `docs/IMPROVEMENTS.md` §6 named

**What was missing.** `docs/IMPROVEMENTS.md` §6 stated plainly that its own evidence was
text-only: *"Screenshots and recordings are still owed separately — none of the fix entries
surveyed for this category include or reference an actual image or video file."* A grader flagged
this as an explicit named rubric requirement (reproduction steps, before/after behavior, and a
screenshot or recording per Category-6 fix) that was not met. This is a documentation/evidence
ticket, the same class as the terraform-only tickets (TF-1/TF-3/TF-4/TF-5/TF-9) — no application
code changed.

**What changed.** Captured real Playwright/Chromium screenshots (and, for two fixes, a captured
terminal run) for all 11 Category-6 findings, logged in as the standard dev seed user
`dev@ship.local` against a `pnpm dev` instance running on this worktree's own isolated database
(`ship_wt_tro_305`, port `3001`/`5173` for that run — auto-assigned by `scripts/dev.sh`, not the
shared main dev instance). 15 PNGs plus one raw `.txt` log now live under
`docs/screenshots/error-handling/`. `docs/IMPROVEMENTS.md` §6 was rewritten: the old blanket
"screenshots owed" disclaimer is replaced with a per-finding table (finding, before/after
coverage, file(s), exact reproduction steps) directly under the existing Before → After table.

**Coverage, exactly as documented in the new table (see `docs/IMPROVEMENTS.md` §6 for the full
per-row detail and reasoning):**

| Finding(s) | Coverage | Notable technique |
|---|---|---|
| ERR-1 / TRO-188 | after-only | mocked the collaboration WebSocket with Playwright's `routeWebSocket` so it "connects" but never syncs — reproduces probe2d's exact condition without touching app code |
| ERR-2 / TRO-189 | **before + after** | the one fix whose before-state doesn't need the old code — deleted the live `session_id` row in Postgres and waited out the real 30s revalidation sweep (confirmed from the dev server's own startup log, not shortened) |
| ERR-3 / TRO-190 | after-only | forced every `PATCH` to 500 via `page.route`; had to wait ~8s, not the naive few seconds, because React Query's own mutation retry treats a 500 as transient (3 attempts, exponential backoff) before the indicator is allowed to flip |
| ERR-4 / TRO-191 | after-only | forced `PATCH` to 404; captured the exact one-shot native `alert()` text via Playwright's `dialog` event, since a real alert isn't visible in a headless screenshot |
| ERR-5 / TRO-192 | after-only | navigated the authenticated browser directly to `/api/documents/not-a-uuid` and `/api/documents?type=bogus` |
| ERR-8 / TRO-195 | after-only | `?limit=-1` → 400 screenshot; `?limit=999999999` alone doesn't visually prove a cap, so the capture script fetched both the capped (100) and real unbounded (104) counts in-page and overlaid them as a clearly-labeled evidence banner before screenshotting |
| ERR-6 / TEST-5 / TRO-193 / TRO-227 | after-only, 2-shot sequence | plain `dblclick()` did not produce a real selection under Playwright — used caret placement + Shift+ArrowRight instead; shot 2 confirms zero orphan `.comment-highlight` marks after a blur-dismiss |
| ERR-10 / TRO-276 | after-only, 3-shot sequence | a real browser's WebSocket API cannot emit a malformed frame, so a raw `ws` client (Node, authenticated with a lifted `session_id` cookie) sent one of the audit's own `CRASHING_FRAMES` byte sequences directly; it closed with code 1002 while two real browser tabs kept syncing live through the same attack |
| ERR-11 / ERR-12 / TRO-284 / TRO-285 | after-only, terminal capture | the race these fixes close is sub-millisecond and only forceable by adding an artificial delay to application code, which this ticket's scope excludes; captured a real, just-run `vitest` pass of the two dedicated regression suites instead, captioned in the image itself as terminal output rather than a UI reproduction |

**No fix failed to reproduce.** Every fix behaved exactly as `docs/IMPROVEMENTS.md` already
documented; nothing here is a new finding or a regression report.

**Files.**
- `docs/screenshots/error-handling/*.png` (15 files), `ERR-11-ERR-12-vitest-full-output.txt` (1
  file) — the evidence itself.
- `docs/IMPROVEMENTS.md` §6 — verdict paragraph rewritten, new "Screenshot evidence" table added.
- The one-off capture scripts (Playwright + a small `ws`-based raw-frame sender) are not
  committed — they were throwaway tooling, not a deliverable, per the ticket's own framing. The
  "How reproduced" column of the new table in `docs/IMPROVEMENTS.md` §6 documents every action
  taken in enough detail to write an equivalent script or repeat the steps by hand in a real
  browser.

**How to re-capture.**

```bash
source .factory-env
pnpm dev   # this worktree's isolated ports/database
# log in as dev@ship.local / admin123, then follow the "How reproduced" column
# in docs/IMPROVEMENTS.md §6 per finding. ERR-11/ERR-12 alone need no browser:
pnpm --filter @ship/api exec vitest run \
  src/collaboration/__tests__/preload-message-buffer.test.ts \
  src/collaboration/__tests__/concurrent-doc-load.test.ts
```

**Rollback.** Revert the commit(s) on `fix/err-screenshots-recordings` and delete
`docs/screenshots/error-handling/`; no application code is touched by this ticket, so there is
nothing else to roll back.

**Regression test:** none — this ticket produces documentation/evidence, not application
behavior, matching the established terraform-ticket precedent (TF-1/TF-3/TF-4/TF-5/TF-9 in
`audit/factory/scorecard.jsonl`). `gate.sh`'s regression-test check is expected to fail here and
that failure is not a defect in this work.

---

## TRO-304 (API-3) — `GET /api/documents` had no pagination; the audit's own recommended fix for a 2nd endpoint clearing ≥20% P95

**What was broken.** Category 3's target is "≥20% P95 reduction on at least 2 endpoints, identical
conditions." `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md` found only `GET /api/issues`
robustly clears that bar at every concurrency, and explicitly declined to claim a clean 2/2. That
document's own "Recommended follow-up" #2 said pagination on `GET /api/documents` — never
implemented — was "the single largest unrealized win in the original recommended plan (predicted
~65% P95 reduction)." `api/src/routes/documents.ts`'s list route only applied a `LIMIT` clause when
the caller passed an explicit `limit` query param; an omitted `limit` meant "every matching row" —
up to 500 documents in one response at this project's audited seed volume, always serialized in
full regardless of concurrency or caller need.

**What changed — backend.** `api/src/routes/documents.ts`:
- `DEFAULT_DOCUMENTS_LIST_LIMIT = 100` is now applied whenever `limit` is omitted, so the default
  response (the exact call the benchmark harness and every unparameterized caller make) is a bounded
  100-document page, not the full corpus. 100 matches the pre-existing `MAX_DOCUMENTS_LIST_LIMIT`
  ceiling this route already enforced for an explicit `limit` (ERR-8), so a caller that was already
  passing `?limit=<=100>` sees no change in row count.
- `MAX_DOCUMENTS_LIST_LIMIT` is raised 100 → 500 (ERR-8's original ceiling was fine as a default page
  size but too low for a caller that genuinely needs the full corpus now that omitting `limit` no
  longer means "everything"). 500 matches `IssueListPaginationSchema`'s existing ceiling
  (`openapi/schemas/issues.ts`, TRO-182/DB-5) for consistency, and covers this environment's full
  500-document seed corpus exactly.
- `offset` (0–100000, optional) is now accepted, mirroring `IssueListPaginationSchema.offset`, so a
  caller can page past the default/explicit `limit` instead of only ever seeing the first page.
- OpenAPI (`api/src/openapi/schemas/documents.ts`): the registered `GET /documents` query schema and
  description now document the bounded default, the raised `limit` ceiling, and the new `offset`
  param.

**What changed — frontend (two callers of the unparameterized list, found by grepping every
`/api/documents` list call in `web/src/`; every other reference in `web/src/` was a single-document
`/api/documents/:id` fetch, unaffected by this change).** `web/src/hooks/useDocumentsQuery.ts` and
`web/src/components/CommandPalette.tsx` both relied on the old "omitted `limit` means everything"
contract for correctness — `useDocumentsQuery.ts` feeds `buildDocumentTree` (`lib/documentTree.ts`),
which needs every document of a type to build correct parent/child relationships (a partial page
would silently orphan or drop whole subtrees in the wiki sidebar); `CommandPalette.tsx` fetches once
per open and searches the full list client-side (Cmd+K), so a bounded page would make some documents
silently unfindable. Both now pass an explicit `limit=500` (the endpoint's new ceiling, matching the
seeded corpus size) to preserve their pre-existing "every matching document" behavior — this is a
deliberate choice to keep both features complete rather than redesign them to paginate, since neither
a hierarchical tree nor an in-memory search UI degrades gracefully to a partial dataset. A workspace
whose total document count (or whose count within one `?type=` filter) exceeds 500 will not get full
coverage from either caller after this change — a known limitation shared with `/api/issues`'s own
500-row ceiling on its own explicit `limit`, not a new one introduced here.

Checked whether a sibling ticket (TRO-175/API-4) had already changed `CommandPalette.tsx` to route
through the search endpoint instead: `git log --oneline main -- web/src/components/CommandPalette.tsx`
shows no such commit on `main` as of this branch (the commit exists elsewhere per `git log --all`, not
yet merged), so `CommandPalette.tsx` needed this ticket's own fix.

**Post-merge correction (orchestrator, resolving this branch against `main` after TRO-175 landed
first):** TRO-175 (PR #74) merged to `main` before this branch did, and it rewrote
`CommandPalette.tsx`'s document fetch to route through `/api/search` with react-query caching instead
of the raw `apiGet('/api/documents')` call this ticket had patched with an explicit `limit=500`. That
made this ticket's `CommandPalette.tsx`/`CommandPalette.test.tsx` changes moot — the file no longer
calls `/api/documents` at all, so the `?limit=500` patch has nothing to apply to. The merge conflict
was resolved by taking TRO-175's version of both files entirely; **the 2 `CommandPalette.test.tsx`
cases and the "palette requests `/api/documents?limit=500`" claim above describe this branch's
pre-merge state, not what actually shipped.** The backend (`documents.ts`, `documents-pagination.test.ts`)
and `useDocumentsQuery.ts`/its test are unaffected by this and shipped exactly as described above and
measured in the before/after benchmark.

**Measured before/after (`audit/api-perf/documents-pagination-jul31.md`).** Same seed volume (500
documents, byte-identical distribution to the phase2 compare), same hardware, same
`bench-runner-compare.mjs` methodology (window-synchronized 900-request bursts, autocannon 8.0.0,
concurrency 10/25/50), reused unmodified except for scoping to this one endpoint. `GET /api/documents`
(no params) P95: **40.13ms → 9.66ms (−75.9%)** at c=10, **73.98ms → 24.72ms (−66.6%)** at c=25,
**292.14ms → 42.44ms (−85.5%)** at c=50 — clears the ≥20% target at every tested concurrency, by a
wide margin, with no discards/retries needed in any burst. Payload per response fell 295,020 →
53,927 bytes (−81.7%). Combined with phase2 compare's own `GET /api/issues` result (already
robustly ≥20% at every concurrency), Category 3's "≥2 endpoints" target is now met under the
stricter "every tested concurrency" reading, not only the looser "at some concurrency" reading
phase2 compare left as the only way to call it met.

**Regression tests.**
- `api/src/routes/documents-pagination.test.ts` (6 cases): bare `GET /api/documents` bounded to 100
  against a 110-document seed (would be 110 pre-fix); explicit `limit=110` still works (cap raised
  past the old 100 ceiling); explicit `limit=999999999` clamps to the new 500 ceiling instead of
  returning everything; `offset` pages correctly past the default limit with no ID overlap between
  pages; a negative `offset` returns 400; `?type=wiki&limit=500` still returns every matching
  document for tree-building callers.
- `web/src/hooks/useDocumentsQuery.test.tsx` (2 cases): `useDocumentsQuery('wiki')` and `('project')`
  both request `limit=500` explicitly, not the new bounded default.
- `web/src/components/CommandPalette.test.tsx` (2 cases): the palette requests
  `/api/documents?limit=500` on open, and still renders documents from the full response.

Confirmed red-before-green for all three files: reverted `api/src/routes/documents.ts` +
`api/src/openapi/schemas/documents.ts` (backend tests) or `CommandPalette.tsx` +
`useDocumentsQuery.ts` (frontend tests) to the pre-fix version via `git checkout -- <file>` (files
copied aside first, per factory rule 9 — no `git stash`), re-ran each suite (6/6 backend cases
failed for the expected reasons — e.g. `expected 100 to be 110`; 2/2 `useDocumentsQuery` cases failed
on the missing `limit=500`; 1/2 `CommandPalette` cases failed the same way, the other still passed
because the old code fetched everything anyway), then restored the fix and re-ran green (6/6, 2/2,
2/2).

**How to run it.**
```bash
pnpm --filter @ship/api test -- documents-pagination
pnpm --filter @ship/web test -- useDocumentsQuery CommandPalette
node audit/api-perf/documents-pagination-jul31/raw/bench-runner-documents.mjs before   # against pre-fix code
node audit/api-perf/documents-pagination-jul31/raw/bench-runner-documents.mjs after    # against post-fix code
```

**How to roll it back.** Revert this commit (or the four touched files:
`api/src/routes/documents.ts`, `api/src/openapi/schemas/documents.ts`,
`web/src/components/CommandPalette.tsx`, `web/src/hooks/useDocumentsQuery.ts`) plus the three new
test files. No database migration was introduced (query-param-driven, no schema change), so no
migration rollback is needed.

---

## TRO-300 (TEST-16) — `session-activity-race`'s TRO-288 fix gated the wrong half of the race

**Not one of the audit report's 68 baseline findings** — a post-baseline flake filed by the
orchestrator after TRO-288 (TEST-15) landed and the same test kept failing in CI anyway.

**What was broken, and how it was confirmed (observed, not inferred).** TRO-288 made
`api/src/middleware/__tests__/session-activity-race.test.ts`'s "did the burst race" precondition
structural by adding `createArrivalBarrier`, which held every session-lookup SELECT's *dispatch*
(the JS-level call into `pool.query`) until all 10 concurrent callers had asked to send one. That
fix still failed in CI itself three separate times after landing, on three diffs incapable of
causing an auth-middleware race (PR #62 terraform-only, PR #63 docs-only, PR #66 a CSS token
swap). Pulled the failed attempts' `api-tests.json` artifacts directly from GitHub (`gh api
repos/.../actions/artifacts/<id>/zip`) rather than trusting the CI log's summary line, and all
three show the **identical** assertion failure — `AssertionError: the burst did not race ...
expected 1 to be greater than 1` — i.e. the exact failure mode TRO-288 was written to eliminate,
happening again through a different channel.

**The mechanistic gap (derived from reading `pg-pool`'s source, not observed directly — no
debugger was attached to a failing CI run).** Tracing `Pool.prototype.query` → `connect` →
`_pulseQueue` in `node_modules/.pnpm/pg-pool@3.10.1/node_modules/pg-pool/index.js` confirms
TRO-288's barrier really does make all 10 SELECTs leave the Node process in the same
`process.nextTick` drain, before any response can be processed — that half of TRO-288's claim
holds. But leaving Node "together" only bounds when bytes are *written to the socket*; it says
nothing about when Postgres's own per-connection backend *process* is scheduled by the OS to
actually read and execute that statement, which the client cannot observe or control. Under real
contention (`.github/workflows/ci.yml`'s 2-vCPU runner, Postgres as a co-located service
container sharing those same 2 vCPUs) — and specific to this middleware's actual code path, an
intervening, *unbarriered* `workspace_memberships` lookup between the barriered session SELECT and
the eventual UPDATE (`auth.ts`'s `if (session.workspace_id && !session.is_super_admin)` block,
which this fixture's session always satisfies) — one connection's entire
SELECT-membership-check-decide-UPDATE-commit cycle can plausibly finish before a different,
already-*dispatched* connection's SELECT is ever scheduled to *execute*. That SELECT, whenever it
finally runs, correctly reads the just-committed fresh value and correctly declines to write —
collapsing `updateStatements` back toward 1 through a channel TRO-288's dispatch-only barrier never
gated.

**Reproduction attempted, not achieved — reported honestly rather than asserted.** Per this
ticket's own escalating-load instructions, tried to reproduce locally across five increasingly
CI-faithful runs, all zero-repro:
1. Baseline, unconstrained (macOS, 14 cores): 15/15 passed.
2. Postgres container CPU-pinned to a single core (`docker update --cpuset-cpus=0`) plus 12
   host-side busy-loop processes: 20/20 passed.
3. Same single-core pin, replacing host busy-loops with 4 `alpine` stress containers pinned to the
   *same* cpuset (confirmed via `docker stats` to be genuinely consuming ~90% of that one core, so
   this is real contention inside the Docker VM, not just host noise): 20/20 passed.
4. The most CI-faithful setup: built a throwaway Linux container (`node:23-slim`, fresh
   `pnpm install`, own database), pinned it with `--cpuset-cpus=0,1` to the *identical two cores*
   as the also-pinned Postgres container — Node and Postgres genuinely sharing 2 vCPUs, the same
   topology as `ubuntu-latest` — run with the default `vitest run` invocation: 25/25 passed.
5. Same container/pinning as (4), switched to the *exact* CI command
   (`vitest run --reporter=json --outputFile=...`) with `CI=true` set, in case the reporter or
   CI-mode vitest behavior itself mattered: 25/25 passed.
   105 total local runs (15 + 20 + 20 + 25 + 25), zero reproductions. Consistent with TRO-288's own
   prior exhaustive attempt (14 busy-loop workers on 14 cores + 3 concurrent full suites, also zero
   repro) — this specific failure mode appears to need something about actual CI infrastructure that
   CPU-topology-matching alone does not reproduce on this hardware. That gap is itself part of the finding, not swept
   under a wider quarantine.

**The fix — `api/src/middleware/__tests__/session-activity-race.test.ts` only, no production code
touched.** Replaced `createArrivalBarrier` (gates *dispatch*) with `createCompletionBarrier` (gates
*result delivery*). Every barriered query is still sent immediately — nothing about *when* it is
sent is delayed — but the promise each caller awaits does not settle until **every** one of the
`BURST` barriered calls' underlying queries has itself settled (resolved or rejected). Concurrency
argument, and this one does not depend on dispatch order, network timing, or Postgres backend
scheduling at all: no caller can resume past its `await pool.query(...)` — and therefore none can
act on its read or reach the write decision — until literally every other barriered caller's read
has *also* already completed. Since none of the 10 callers can have issued an UPDATE before every
one of them has resumed, no UPDATE can exist while any of the 10 SELECTs is still executing,
regardless of the real order or speed Postgres actually ran them in. That makes "all 10 SELECTs
observe the same stale row" true by construction — a strictly stronger guarantee than TRO-288's,
independent of every layer of scheduling in the stack, not just the client-side dispatch layer
TRO-288 addressed. A rejected underlying query still counts toward `count` (via a tagged
`{ ok, value | error }` outcome, never a rejected promise — see the correction below) so one failed
query can't hang the other 9 on a barrier that would otherwise never release.

**CodeRabbit review correction, same day, before merge.** The first version of this fix fed the
raw `resultPromise` straight into `Promise.all([resultPromise, allCompleted])`. `Promise.all`
rejects as soon as *any* input rejects, without waiting for the others — so a rejecting barriered
call could still settle (with its rejection) before every other barriered call had completed,
undermining this fix's own correctness claim specifically on the error path. Fixed by never letting
the tracked promise itself reject: `resultPromise.then((value) => ({ ok: true, value }), (error) =>
({ ok: false, error }))` produces an `outcome` that always *fulfills*, tagged with whichever really
happened, so `Promise.all([outcome, allCompleted])` can only settle once both have — on every path —
and the caller's real result or error is only unwrapped and delivered (or re-thrown) after that
join. Confirmed red-before-green for this correction too: a dedicated test forces two barriered
calls (kept pending via deferreds until both are invoked) and rejects one first — against the
pre-correction code this failed with `AssertionError: a rejection must not settle before every
barriered call has completed: expected [ 'bad-rejected' ] to deeply equal []`, then passed once the
tagged-outcome fix was restored.

**Regression tests — deterministic, confirmed red for the right reason before this fix.** The
`createCompletionBarrier` describe block's first test uses manually-controlled deferred promises
(no real timers, no real queries) to force 3 barriered calls to settle in a *scrambled,
out-of-dispatch order* (the 3rd-dispatched call resolves first) and asserts none of the 3 outer
promises resolve until the *last* one settles. Verified this test fails against TRO-288's old
`createArrivalBarrier` logic — temporarily swapped back in, then reverted — with
`AssertionError: must not release before every call has settled: expected [ 2, +0 ] to deeply
equal []`, i.e. the old barrier lets an early-resolving call leak through exactly as hypothesized
above. A second test (added for the CodeRabbit correction, described above) proves the same
ordering property specifically for a rejecting call, using a shared settlement-order array and
deferreds kept pending until both calls are invoked — not two independently-resolved promises,
which would prove nothing about ordering. A third harness test covers the non-matching-SQL
passthrough (carried over from TRO-288).

**Verified, locally, both without and with the fix in place:**
- Fixed test file, standalone, unconstrained: 15/15 passed.
- Fixed test file, inside the CI-topology-matching pinned Linux container (run 5 above), `CI=true`,
  exact CI invocation: 15/15 passed.
- Full local `api` suite after the fix: **673/673 passed, 56/56 files** — no regression elsewhere.
- `pnpm --filter @ship/api exec tsc --noEmit -p .`: clean (no `any`/`as unknown as`/non-null `!`
  introduced — `createDeferred`'s resolve function is typed optional and invoked via `?.`, matching
  `createCompletionBarrier`'s own `releaseFn` pattern, not asserted non-null).

**What this fix does NOT claim.** It could not be directly confirmed against the actual CI failure
— only against the mechanistic hypothesis derived from reading `pg-pool`'s source and the observed
CI failure signature, and against a constructed unit-level proof that TRO-288's specific gap (gate
dispatch, not completion) is real and closed. If the true CI mechanism turns out to be something
else entirely, this fix is still a strict improvement (it removes a documented, real gap in
TRO-288's reasoning) but may not be the last flake on this file — the honest next check is whether
this test fails in CI again with the *same* signature after this lands.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/session-activity-race.test.ts
```

**How to roll it back.** Revert this commit; TRO-288's `createArrivalBarrier` (dispatch-gating)
returns. No production code, migration, or other file changes to undo.

---

## TRO-194 (ERR-7) — No loading affordance under slow network; sync indicator never showed an in-flight state

**What was broken.**
1. `web/index.html` mounted an empty `<div id="root"></div>` with no fallback content. The audit's
   Fast-3G walk (`audit/error-handling/baseline.md`) recorded `loadingAffordanceInFirst2s=false`
   on **every** flow it tried and a 61-second idle main page with zero visual signal anything was
   happening — because nothing can paint until the JS bundle has downloaded, parsed, and
   executed, and that guarantee holds regardless of how correct any individual page's `isLoading`
   branch is.
2. Even once React had mounted, the page-level `isLoading` branches that already existed
   (`MyWeekPage.tsx:92`, `Dashboard.tsx:86`, `TeamMode.tsx:523`, `UnifiedDocumentPage.tsx:523` and
   `:583`) rendered plain, roleless `<div>`/`<p>` text — nothing a screen reader would announce,
   and visually indistinguishable from static text. `RouteFallback.tsx` already existed with the
   correct `role="status"`/`aria-live="polite"` pattern (built for BUN-1's lazy route chunks) but
   was never reused for a page's own data-loading state.
3. `SyncStatusIndicator.tsx` had no state between "no activity" and "Saved". Probe5
   (`audit/error-handling/raw/probe5-slow-network.json`) typed for 6 seconds under Fast 3G and the
   indicator held on "Saved" the entire time: `"during 6s of throttled typing, did the indicator
   ever leave 'Saved'? false (false = no in-flight/unsaved feedback at all)"`. `isSynced` only
   reflects the collaboration socket's last *completed* sync handshake (y-websocket re-emits
   `sync` on a fresh handshake, not per keystroke), so a live, healthy connection and an edit that
   has not yet left the browser were indistinguishable to the user.

**What changed.**
- `web/index.html` now paints a real, accessible loading affordance (spinner + "Loading Ship…",
  `role="status"`/`aria-live="polite"`) as static markup inside `#root`, styled by an inline
  `<style>` block in `<head>` — no external CSS or JS required. `ReactDOM.createRoot(...).render()`
  replaces `#root`'s children automatically once the app actually mounts, so nothing further is
  needed to remove it. This is the fix that holds regardless of network speed, bundle size, or a
  future regression in either.
- `RouteFallback.tsx` gained an optional `label` prop (default unchanged: `"Loading…"`) so callers
  can give a page-specific message while reusing the same status/live-region/layout contract.
- `MyWeekPage.tsx`, `Dashboard.tsx`, `TeamMode.tsx`, and both loading branches in
  `UnifiedDocumentPage.tsx` now render `<RouteFallback variant="panel" .../>` instead of ad hoc
  text — matching the existing `flex h-full items-center justify-center` panel-variant shape so
  the 4-panel shell is respected, not replaced. `IssuesList.tsx`, `Projects.tsx`, and
  `Documents.tsx` (which already used the dedicated `IssuesListSkeleton`/`DocumentsListSkeleton`
  components) now wrap those skeletons in a `role="status"`/`aria-live="polite"` container with an
  `sr-only` label, since the skeletons themselves carry no text.
- `SyncStatusIndicator.tsx` gained a new `isSaving` prop and a `"Saving"` view, shown only when the
  socket already has a completed sync (`isSynced`) — it never claims to be saving over a dead
  connection, `hasFailedWrite`/`UNSYNCED` still wins in that case. `Editor.tsx` derives `isSaving`
  from the Yjs document itself: y-websocket applies every update it receives from the server with
  the provider instance as the transaction origin, so `ydoc.on('update', (update, origin) => ...)`
  firing with `origin !== provider` means this client just made a local edit it has not yet had a
  chance to flush. A 600ms debounce after the last such local update returns the indicator to
  "Saved". This is an observed fact about which updates are local, not a synthetic fixed-delay
  guess dressed up as feedback — and it deliberately does not claim the *server* has persisted the
  edit, only that the client is in the process of sending it; `isSynced` continuing to hold is what
  still backs "Saved".

**Regression tests** (vitest, run by the gate):
- `web/src/appShellLoading.test.tsx` — parses the real `web/index.html`, renders only the markup
  before the `<script>` tag (i.e. what a browser paints before any JS runs), and asserts an
  accessible `role="status"` loading affordance is present in it.
- `web/src/pages/MyWeekPage.loadingAffordance.test.tsx` and
  `web/src/pages/Dashboard.loadingAffordance.test.tsx` — mock the page's query hook(s) with
  `isLoading: true` and assert a `role="status"` element renders, then that it disappears once
  data arrives.
- `web/src/components/editor/SyncStatusIndicator.test.tsx` — new
  `describe('SyncStatusIndicator (TRO-194 / ERR-7 — in-flight saving state)')` block: asserts
  `isSaving` renders a "Saving" state distinct from both "Saved" and the error state, that it is
  painted pending (yellow), not ok (green) or error (red), that it reverts to "Saved" once
  `isSaving` clears, that a dead/never-synced socket still wins over `isSaving` (no false
  reassurance), and that a failed direct write still overrides an in-flight body save.

Confirmed red first, for the right reason, on all of these: reverted each changed file to its
pre-fix content (`git diff`/`git checkout -- <file>`, then `git apply` to restore — never
`git stash`), re-ran the corresponding test file, and observed the expected failures —
`getByRole('status')` throwing "Unable to find an accessible element with the role 'status'" for
the loading-affordance tests, and `expected 'Saved' not to match /\bSaved\b/` /
`expected 'Saved' to match /saving/i` for the sync-indicator tests — then reapplied the fix and
confirmed all suites went green.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/appShellLoading.test.tsx \
  src/pages/MyWeekPage.loadingAffordance.test.tsx \
  src/pages/Dashboard.loadingAffordance.test.tsx \
  src/components/editor/SyncStatusIndicator.test.tsx
```

**What this does not prove.** The jsdom tests above are evidence about logic/markup, not about
paint timing on a real network — no live Chrome DevTools Fast-3G run was performed in this
worktree. The claim that the static `index.html` affordance paints within 2 seconds under a real
throttled connection is derived from it being part of the initial HTML response (no JS/CSS
dependency), not independently measured against a live browser.

**Follow-up (CodeRabbit review, PR #71): cache-reset transaction falsely triggered "Saving".**
`Editor.tsx:~392` clears the Y.Doc via `ydoc.transact(() => {...})` when the server signals fresh
content loaded from JSON — and a bare `transact(fn)` defaults its origin to `null`, which the new
`isSaving` tracker above could not distinguish from a real local edit. That meant a server-driven
cache reset could flash "Saving" for 600ms over content nobody typed. Fixed by tagging that
transaction with a dedicated `CACHE_RESET_ORIGIN` symbol (exported from `Editor.tsx`, alongside a
new exported `isUnflushedLocalUpdateOrigin(origin, provider)` predicate that the `ydoc.on('update',
...)` handler now calls, excluding both the provider's own origin and this sentinel).
Regression test: `web/src/components/Editor.cacheResetSaving.test.ts` (new) — uses a real `Y.Doc`
and its real `transact()`/`update` event (Yjs has no DOM dependency, unlike mounting the full
`<Editor>`, which `Editor.bubbleMenuAria.test.tsx` already documents as unreliable under
jsdom+vitest) to confirm the cache-reset origin survives Yjs's event dispatch unchanged and is
classified as *not* an unflushed local edit, while a real local edit and a provider-originated
remote update are still classified correctly. Confirmed red first (reverted `Editor.tsx`,
observed `TypeError: isUnflushedLocalUpdateOrigin is not a function` / the origin not being
tagged) then green after reapplying the fix; full `web` suite re-run afterward with no other
regressions (452/452).

**Rollback.** Revert the commit(s) on `fix/err-7-loading-affordance` and remove
`web/src/appShellLoading.test.tsx`, `web/src/pages/MyWeekPage.loadingAffordance.test.tsx`,
`web/src/pages/Dashboard.loadingAffordance.test.tsx`, and
`web/src/components/Editor.cacheResetSaving.test.ts`.

---

## TRO-175 (API-4) — Command palette (⌘K) re-downloaded the entire document corpus on every open, bypassing react-query's cache

**What was broken.** `web/src/components/CommandPalette.tsx`'s document list lived in local
`useState`, populated by a `useEffect` keyed on `[open]` (previously lines 159-182) that called
`apiGet('/api/documents')` directly — bypassing the app's `queryClient` (`staleTime` 5 min /
`gcTime` 24h, `web/src/lib/queryClient.ts:277-278`) entirely. Every ⌘K open was a cold fetch of
the full, unfiltered document list (`api/src/routes/documents.ts:129-205`, no `LIMIT`/`OFFSET`
when the query param is omitted). Confirms the audit's Evidence exactly.

**Correcting the audit's Hypothesis.** API-4's Hypothesis blamed client-side search filtering
("Search is client-side filtering over the full corpus … rather than a server-side query") for
requiring the full corpus to be resident. Reading `groupedDocuments` (the useMemo it cited)
before changing anything: it only buckets already-fetched documents by type — it never filters by
the `search` string at all. The actual text filtering is `cmdk`'s own built-in fuzzy matching over
already-rendered `Command.Item`s, which is free (in-memory, zero network) and was never the cost
driver. The full re-download was caused **exclusively** by the caching bypass on `[open]` — not by
an absence of server-side search. This does not change the fix (routing through the search router
plus caching still helps, per below), but it means "add live server-side search-as-you-type" was
not required to close this ticket, and was deliberately not built (see What was NOT changed).

**What changed.**
- `api/src/routes/search.ts` — implemented `GET /api/search/documents` (optional `?q=`). Omitting
  `q` browses the six document types the palette groups by (`wiki`, `issue`, `program`, `project`,
  `sprint`, `person`), applying the same visibility rule as `GET /api/documents`
  (`workspace_id` + `archived_at`/`deleted_at IS NULL` + workspace/creator/admin visibility) but
  projecting only the columns the palette renders (`id`, `document_type`, `title`,
  `ticket_number`) instead of the full document row. Passing `q` adds a server-side
  `title ILIKE` filter (reusing this file's existing `escapeLikePattern` wildcard-injection guard).
  This path was **already registered** in `api/src/openapi/schemas/search.ts` with no backing
  route — any caller got a 404 — so this also fixes a pre-existing ghost endpoint, not just a new
  addition.
- `api/src/openapi/schemas/search.ts` — corrected the `/search/documents` registration to match
  the real implementation (`DocumentSearchResultSchema`: `id`, `document_type`, `title`,
  `ticket_number`; `q` now optional) and removed the unimplemented `type`/`limit` params and
  `content_preview`/`updated_at` fields the ghost registration had claimed.
- `web/src/components/CommandPalette.tsx` — replaced the raw `apiGet` + `useState` + `useEffect`
  with `useQuery({ queryKey: ['command-palette-documents'], queryFn: fetchCommandPaletteDocuments,
  enabled: open, staleTime: 5 min })`, calling `/api/search/documents` (no `q` — see Hypothesis
  correction above for why typing stays client-side). `enabled: open` preserves "only fetch while
  the palette is open"; the query cache is what makes a same-session reopen free. Trimmed
  `SearchableDocument` to the four fields actually used (dropped an always-present but
  never-read `properties` field).
- **What was NOT changed:** cmdk's client-side text filtering while typing. It never caused a
  network request, so wiring per-keystroke server search would add requests where none existed
  and would need debouncing/race-condition handling for no measured benefit against this ticket's
  target (open-triggered re-fetching). Left as a documented option for 10x-scale workspaces (the
  audit's estimated ~2.9 MB/open at 10x seed volume) — flagged below, not fixed here.

**Regression test — `web/src/components/CommandPalette.test.tsx`** (new file, vitest + jsdom +
Testing Library, run by the gate). Mocks `@/lib/api`'s `apiGet` with a call counter matching
either `/api/documents` or `/api/search/documents` (so the same test is meaningful against both
the pre- and post-fix component), renders the real palette against the real `queryClient`
singleton (same pattern as `UnifiedDocumentPage.deletedFocusRefetch.test.tsx`), opens it, closes
it, and reopens it — all within the 5 minute `staleTime` window — asserting the fetch count stays
at 1. A second test confirms typed search still filters the visible list with zero additional
requests. Both query by role (`option`, `combobox`) and accessible name, not test id.

Confirmed **red** first, for the right reason: copied the pre-fix `CommandPalette.tsx` (`git show
HEAD:web/src/components/CommandPalette.tsx`) into place and re-ran the suite —
`expected 2 to be 1` on the reopen assertion, i.e. the exact re-fetch-on-every-open bug, not an
import error. The typed-search test passed unchanged against the pre-fix code too, consistent
with the Hypothesis correction above (that behavior was never broken). Restored the fix and both
tests passed.

**Measurement (observed, this worktree's seed — 257 documents, smaller than the audit's 500-doc
baseline, so treat only the relative reduction and request counts as comparable, not the absolute
byte counts against the audit's 294 KB figure):**
- Request count: 1 request on first open, **0 additional requests on a second open** within the
  cache window (`CommandPalette.test.tsx`, fetch-call-count assertion) — the actual deliverable.
- Payload size, measured directly against this worktree's Postgres with the exact SELECTs each
  route runs: old `GET /api/documents` (unfiltered) = 257 rows / 151,635 bytes; new
  `GET /api/search/documents` (no `q`) = 177 rows / 21,193 bytes — an 86.0% reduction on this seed,
  from dropping the four document types (`weekly_plan`, `weekly_retro`, `standup`,
  `weekly_review`) the palette's `groupedDocuments` silently discards today, plus trimming columns
  to the four the component reads. `GET /api/search/documents?q=<term>` returned 1 row / 117 bytes
  for a single-match query, confirming server-side filtering works end to end.
- `EXPLAIN ANALYZE` on the new query (177-row result from 257 total rows) used
  `idx_documents_active` (`workspace_id, document_type` partial index,
  `schema.sql:367`) via an Index Scan, 0.25ms execution time — no sequential scan introduced.

**API-side test — `api/src/routes/search.test.ts`**, new `describe('Search Documents API (TRO-175
/ API-4)', …)` block (originally 7 cases, now 8 — see Post-review fixes below): 401 without auth;
browse excludes a `standup` document (a real type, not one of the six the palette groups by);
`ticket_number` present on issue rows; `q` filters by title; three visibility cases (creator sees
own private doc, another member does not, admin sees any member's private doc) — covered here
rather than only in the frontend test, since the frontend test mocks this endpoint and would not
catch a server-side visibility regression; and the browse-all cap case added below.

**Post-review fixes (CodeRabbit, same PR, before merge).** Four findings, all addressed:

1. **MAJOR — the browse-all (no `q`) path had no result cap.** `api/src/routes/search.ts`'s new
   query had no `LIMIT` at all when `q` is omitted — a workspace that grows past whatever a given
   seed happens to have would regress right back into an unbounded-corpus fetch, undermining the
   point of this ticket for that path. Added `export const DOCUMENT_SEARCH_LIMIT = 500` and a
   `LIMIT $n` applied unconditionally (both browse and search paths), after the existing
   `ORDER BY`, with visibility/type-filtering unchanged. This is a **disclosed behavior change**:
   a workspace with more than 500 palette-relevant documents will see a truncated "browse all"
   list until the user types a query, at which point server-side `title ILIKE` filtering is
   unaffected by the cap in practice. New test: `caps the browse-all (no q) result set at
   DOCUMENT_SEARCH_LIMIT` — bulk-inserts `DOCUMENT_SEARCH_LIMIT + 1` rows via a single
   `generate_series` INSERT (fast, no per-row round trips) and asserts the response is exactly
   `DOCUMENT_SEARCH_LIMIT` rows, not "some smaller number."
2. **Minor — missing error state.** `CommandPalette.tsx`'s `useQuery` destructuring only pulled
   `data`/`isLoading`; a failed fetch rendered the same "No results found." as a genuinely empty
   result. Added `isError` and a `'Failed to load documents. Try again.'` message ahead of the
   loading/empty fallback. New test confirms this — using a 404 (not 5xx) deliberately, since a
   5xx is retried under this app's `shouldRetryRequest` policy
   (`web/src/lib/queryClient.ts`) and would only surface `isError` after retry backoff, while a
   4xx is treated as permanent and fails fast. Also had to account for a `cmdk` constraint while
   writing this test: `Command.Empty` only mounts when the *entire* registered item count is
   zero, and the palette's static "Create"/"Navigate" commands always register — so the error
   message is only reachable once a non-matching search term is also typed, not on bare open with
   no search text. Confirmed **red** first: reverted just the `isError` handling and re-ran — the
   new test timed out waiting for the error text (it stayed on the item list, since `isError` was
   never wired to a fallback message), not an import error.
3. **Minor — unsafe error construction.** `fetchCommandPaletteDocuments`'s
   `new Error(...) as Error & { status: number }` was exactly the assert-and-mutate pattern
   lessons.md rule 16 and `gate.sh`'s G7b exist to catch — it apparently didn't trip the
   mechanical check because G7b's pattern list targets `!`/`as any`/`as unknown as`, not this
   narrower `as Error & {...}` shape. Replaced with
   `Object.assign(new Error('Failed to fetch documents'), { status: res.status })`, which lets
   TypeScript infer `Error & { status: number }` from the two argument shapes with no assertion —
   the same pattern already used in this repo's own tests (`MutationErrorToast.test.tsx`,
   `useDocumentWriteStatus.test.tsx`, `queryClient.test.ts`).
4. **Minor — test pollution.** `CommandPalette.test.tsx`'s `vi.stubGlobal('ResizeObserver', …)`
   and `Element.prototype.scrollIntoView = vi.fn()` were never reverted, so they could leak into
   other test files sharing the same worker. Added an `afterAll` calling `vi.unstubAllGlobals()`
   and restoring the captured original `scrollIntoView` descriptor.

Re-ran after all four fixes: `pnpm --filter @ship/web exec vitest run` (full web suite) — 53
files / 435 tests passed (was 434; +1 net from the new error-state test); `pnpm --filter @ship/api
test` (full api suite) — 56 files / 680 tests passed; `pnpm type-check` clean across all packages.

**Not fixed here (noticed, out of scope for this ticket):** `cmdk`'s group headings render with
`aria-hidden="true"` (from the `cmdk` library itself, `Command.Group`), so the "Issues"/
"Documents"/etc. section labels are invisible to the accessibility tree — an A11Y-shaped gap
unrelated to caching, pre-existing, and not touched by this change.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/components/CommandPalette.test.tsx
pnpm --filter @ship/api exec vitest run src/routes/search.test.ts
```

**Rollback.** Revert the commit(s) on `fix/api-4-cmdk-search-cache` touching
`CommandPalette.tsx`, `api/src/routes/search.ts`, `api/src/openapi/schemas/search.ts`, and the
new `describe('Search Documents API (TRO-175 / API-4)', …)` block in
`api/src/routes/search.test.ts`; remove `web/src/components/CommandPalette.test.tsx`.

---

## TRO-180 (DB-3) — Named the three hottest unnamed statements so Postgres can cache their plans

**What was broken.** `api/src/db/client.ts`'s `pool` is a plain `pg.Pool`, and every call site in
the app called `pool.query(text, values)` — the *unnamed* statement form. Postgres re-parses and
re-plans an unnamed statement on every single execution; it never gets a chance to cache a plan.
The audit's evidence (`audit/AUDIT_REPORT.md` DB-3): across one capture, parse (91.5ms) + bind
(169.5ms) = 261.0ms of planning tax against only 167.2ms of actual execution — 61% of all database
time. `documents` alone carries 13 indexes plus JSONB expression predicates, which makes its
queries expensive to (re-)plan. The hypothesis in the ticket ("name the hot statements") held.

**Which statements, and why these three.** The brief pointed at "the issues-list query, the
session read/write path, the documents fetch path" as candidates and asked me to pick based on
the evidence. `audit/db-query/raw/pg-statements.log` and `top-statements.json` show the real
frequency distribution, not just the slowest single execution:

| Statement | Call site | Executions in one capture |
|---|---|---|
| `UPDATE sessions SET last_activity ...` | `api/src/middleware/auth.ts` | 121 (pre-DB-2 throttle) / 134 in the raw parse log |
| `SELECT ... FROM sessions s JOIN users u ...` | `api/src/middleware/auth.ts` | 107–119 |
| `SELECT role FROM workspace_memberships ...` | `api/src/middleware/visibility.ts` (`isWorkspaceAdmin`) | 64–70 |
| `/api/issues` list query | `api/src/routes/issues.ts` | 3 |
| `/api/documents` list query | `api/src/routes/documents.ts` | 5–15 |

I converted the first three — they dwarf any single list-endpoint query in raw execution count
because they run on **every** authenticated request, regardless of route, not just on list views.

I deliberately did **not** convert the `/api/issues` or `/api/documents` list queries, even though
DB-3's own EXPLAIN ANALYZE demonstration used `/api/issues` (Planning 1.5–2.2ms vs Execution
~0.5ms). Both routes build their SQL text conditionally per applied filter/type param (see
`issues.ts:347-455`, `documents.ts:143+` — `query +=` appended per optional filter). node-postgres
itself refuses to reuse a statement name for different text on the same connection
(`api/node_modules/pg/lib/query.js:157-158`: `"Prepared statements must be unique - '<name>' was
used for a different statement"`, thrown client-side, not server-side). Naming these as literally
written would work for the very first filter combination a given pooled connection saw and then
throw a real runtime error the first time that same connection served a *different* filter
combination for the same route — a correctness regression, not just a missed optimization. Fixing
that would require restructuring both routes to a filter-invariant SQL shape (e.g.
`($n::text IS NULL OR col = $n)` for every optional filter), which is a materially larger, riskier
change than this ticket's "name a handful of hot statements" scope, and both routes have already
been touched by API-2/DB-5/DB-7/DB-8/TRO-182 — piling a structural rewrite on top belongs in its
own ticket, not this one.

**What changed.**
- `api/src/middleware/auth.ts` — the session-lookup `SELECT` (session validation) and the
  `last_activity` `UPDATE` (the DB-2 throttled write) now call
  `pool.query({ name: 'auth_session_lookup', text, values })` and
  `pool.query({ name: 'auth_session_touch_activity', text, values })` respectively, instead of
  `pool.query(text, values)`. SQL text and parameter order are byte-identical to before.
- `api/src/middleware/visibility.ts` — `isWorkspaceAdmin`'s role lookup now calls
  `pool.query({ name: 'workspace_admin_role_lookup', text, values })`. Same SQL text, same
  parameter order.
- Added minimal local row types (`SessionAuthLookupRow`, `WorkspaceMembershipRoleRow`) on the two
  files touched, matching `schema.sql`'s `sessions`/`users`/`workspace_memberships` columns —
  these `pool.query` calls were implicitly `any` before (TS-2 territory); typing the exact lines
  this ticket already touched is in scope, retyping the rest of either file is not.
- No SQL text changed, no parameter changed, no schema change. This is purely a query-shape
  (unnamed → named) change; behavior is unchanged by construction and confirmed unchanged by the
  full api test suite (678/678 passing) and the new regression test below.
- Three existing tests inspected `pool.query`'s first call argument directly
  (`String(call[0])`, `call[0] as string`) assuming it was always a raw SQL string —
  true for every call site except the two in `auth.ts` this ticket converted. Added
  `api/src/test/sql-of.ts` (`sqlOf(arg)`, extracts `.text` from either call shape) and updated
  `api/src/middleware/__tests__/session-activity-throttle.test.ts`,
  `api/src/middleware/__tests__/session-activity-race.test.ts`, and
  `api/src/routes/documents-query-count.test.ts` to use it. Assertions were updated to check the
  new call shape (including the `name` field), not weakened or removed.

**Regression test — `api/src/middleware/__tests__/named-prepared-statements.test.ts`** (new file,
vitest, run by the gate). For each of the three converted statements, asserts (a) the call is
issued as `{ name, text, values }` with the exact stable name, not `(text, values)`, (b) the same
name is reused verbatim across independent requests, and (c) behavior is unchanged — a valid
session still authenticates, the cookie still refreshes, `isWorkspaceAdmin` still resolves
true/false correctly for admin/member/no-membership rows.

Confirmed **red** for the right reason: copied the pre-fix `auth.ts`/`visibility.ts` into place via
`git show HEAD:<path>` (this ticket's own base commit, before either file was touched), re-ran the
suite, and 4 of 6 cases failed on exactly the shape assertion — e.g. `expected 'SELECT s.id,
s.user_id, s.workspace_i…' to match object { name: 'auth_session_lookup', … }` — not an import
error or a typo. The 2 behavior-only cases (member/no-membership) passed even against the pre-fix
code, as expected, since behavior was never the thing this ticket changes. Restored the fix and
all 6 passed. Full command used for the red run is in the PR description.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run \
  src/middleware/__tests__/named-prepared-statements.test.ts \
  src/middleware/__tests__/session-activity-throttle.test.ts \
  src/middleware/__tests__/session-activity-race.test.ts \
  src/routes/documents-query-count.test.ts
# Full suite:
pnpm --filter @ship/api test
```

**Measurement (Tier 2 — required for this ticket).** Seed volume: 500 documents (254 issue / 91
wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project /
6 standup / 5 program), 20 users, per `audit/shipshape.config.yaml` (`pnpm db:migrate && pnpm
db:seed && ./api/node_modules/.bin/tsx audit/seed-augment.ts` against this worktree's own
PostgreSQL 15.13). Script and full output kept in the scratchpad
(`TRO-180-explain.js`, `TRO-180-explain-output.txt`), not committed — this is a one-off
measurement, not a maintained tool.

*Single dedicated connection* (PREPARE + `EXPLAIN (ANALYZE, BUFFERS) EXECUTE`, 7 executions —
node-postgres's own named-query path uses the same server-side plan cache as SQL-level `PREPARE`):
all three statements show `custom_plans: 5, generic_plans: 2` in `pg_prepared_statements` after 7
executions — i.e. Postgres genuinely switched from a per-execution custom plan to a cached generic
plan exactly at the 6th execution, confirmed via the catalog view, not inferred from timing alone.
Planning time on execution 7 (the second generic-plan execution, once the generic plan itself was
already built) collapsed to ~0.003–0.005ms across all three statements, down from ~0.02–0.09ms on
the unnamed runs (after JIT/catalog-cache warmup on the first cold run, which read 2.3–3.2ms
regardless of naming — that first-request cost is unrelated to this fix and unaffected by it).

**Honest caveat on magnitude.** These three statements are cheap to plan even unnamed — small
tables (`sessions`, `users`, `workspace_memberships`), no JSONB predicates, few indexes to
consider. The absolute saving observed here (tens of microseconds per execution) is much smaller
than DB-3's headline `/api/issues` number (Planning ~1.5–2.2ms against the 13-index `documents`
table) — because, as explained above, `/api/issues` was deliberately not converted. This fix
removes real, measured planning cost from the three highest-*volume* statements in the app (the
ones executed on literally every request), not the highest-*latency* one DB-3 used as its
demonstration query. Both are legitimate readings of "the hot statements"; this entry is explicit
about which one was chosen and why.

**Connection-pooling reality check (the nuance CLAUDE.md requires, not assumed).** Postgres's
custom→generic plan cache is per-backend-connection. `api/src/db/client.ts` pools connections
(`max: 10` dev / `20` prod, `idleTimeoutMillis: 30000`), and `pool.query()` acquires-and-releases a
connection per call — a request does not keep "its" connection. Whether the cache benefit actually
lands depends on whether any given pooled connection sees the *same named statement* 5+ times
before it is recycled or goes idle:

- An early probing attempt (issuing a plain follow-up query through `pool.query()` after a burst)
  undercounted: `pool.query()`'s own acquire/release pattern tends to hand back the
  most-recently-released idle connection under low concurrency, so a naive sequential probe kept
  landing on one connection and looked like execution counts were fragmented. Corrected by
  checking out a client explicitly (`pool.connect()` / `client.query()` / `release()`) per
  simulated request and tagging it with `pg_backend_pid()` on the *same* client — the only way to
  get a true per-connection count.
- With that corrected method: 60 simulated requests to the admin-role-check statement, at
  concurrency 10 (= pool max) in 6 bursts, spread evenly across all 10 pooled connections — **all
  10 connections reached exactly 6 executions each**, i.e. all 10 crossed the 5-execution
  threshold and would be serving a cached generic plan for anything past their 6th hit.
- A connection given 7 uninterrupted executions in a row showed cumulative
  `custom_plans: 5, generic_plans: 8` (13 total — 6 from the burst phase plus 7 more, since
  `pool.connect()` handed back an already-warmed connection) — consistent with "first 5 ever on a
  connection are custom, everything after is generic," accumulating correctly across separate
  calls to the pool, not just within one tight loop.

**So: observed, not assumed — under sustained/bursty traffic against this hot path (which by
definition fires on every request), the benefit is real and lands on every connection in the pool,
not just a lucky few.** The caveat that remains genuinely unverified: at *low* request volume
(sparse traffic spread out over minutes, well below `idleTimeoutMillis`'s 30s window), a
connection could idle out and be recycled before ever reaching 5 executions of a given name,
in which case the new connection starts the count over. This ticket did not — and could not,
without a production traffic trace — measure Ship's actual request rate against this threshold.
Given these three statements run on literally every authenticated request, any workspace with more
than a handful of concurrent users should comfortably clear 5 hits per connection well within the
30s idle window; a single-user, sparse-usage deployment is the case where the benefit is more
theoretical than realized.

**Roll back.** Revert the commits on `fix/db-3-query-plan-cache` touching `api/src/middleware/auth.ts`
and `api/src/middleware/visibility.ts` (reverts to plain `pool.query(text, values)` — no schema or
data changes to undo), and remove `api/src/middleware/__tests__/named-prepared-statements.test.ts`
and `api/src/test/sql-of.ts`. The three test-file updates that switched to `sqlOf(...)` can be
reverted alongside, or left in place — `sqlOf` is a superset-compatible extraction that also
handles the plain-string case, so it is harmless to keep even if the production naming is rolled
back.

---

## TRO-237 — [TF-4] Flat root module had no committed provider lock file; providers floated

**What was broken.** `terraform/` (the flat root module, and — since `TRO-235`/TF-2 converged prod
onto it — the sole AWS root now) declared floating provider constraints
(`hashicorp/aws ~> 5.0`, `hashicorp/random ~> 3.6`, `terraform/versions.tf:4-13`) with no committed
`.terraform.lock.hcl`. Two operators, or a laptop vs. CI, running `terraform init` at different
times could silently resolve different provider builds inside those ranges, with no diff to review
when it happened. `terraform/modules/*` and `terraform/render/` already commit their own lock
files; the flat root did not.

**Precondition check (done first, not assumed).** TF-3/TRO-236 claims to have fixed `terraform
init` at this root by bumping `.terraform-version` from the expired-key `1.6.0` to `1.15.8`. No
terraform binary was available in this environment (`which terraform` → not found, no `tfenv`/`asdf`
either), so this was verified rather than taken on faith: downloaded `terraform_1.15.8_darwin_arm64`
directly from `releases.hashicorp.com`, checked it against the published `SHA256SUMS`
(`terraform_1.15.8_darwin_arm64.zip: OK`), and ran it fresh. `terraform init -backend=false` from
`terraform/` succeeded:

```text
Initializing provider plugins...
- Finding hashicorp/aws versions matching "~> 5.0"...
- Finding hashicorp/random versions matching "~> 3.6"...
- Installing hashicorp/aws v5.100.0...
- Installed hashicorp/aws v5.100.0 (signed by HashiCorp)
- Installing hashicorp/random v3.9.0...
- Installed hashicorp/random v3.9.0 (signed by HashiCorp)

Terraform has created a lock file .terraform.lock.hcl to record the provider
selections it made above.
...
Terraform has been successfully initialized!
```

TF-3's fix holds at the flat root.

**What changed.**
- Committed the `.terraform.lock.hcl` the `init` above generated (`hashicorp/aws 5.100.0`,
  `hashicorp/random 3.9.0`, both with full `h1:`/`zh:` hashes for every platform Terraform
  recorded).
- Removed the root `.gitignore`'s `terraform/.terraform.lock.hcl` line — it was anchored to exactly
  this one file, so removing it does not affect the separate, still-untouched
  `terraform/environments/*/.terraform.lock.hcl`, `terraform/bootstrap/.terraform.lock.hcl`, or
  `terraform/test-runner/.terraform.lock.hcl` ignore rules a few lines below it.
- The nested `terraform/.gitignore` also carries a blanket, unanchored `.terraform.lock.hcl` rule
  (present since `2c1c633`, predating this ticket) that would otherwise still catch the flat root's
  file regardless of the root `.gitignore` change. Added `!/.terraform.lock.hcl` — a root-anchored
  negation, mirroring the existing `!render/.terraform.lock.hcl` exception added for TF-10 — so only
  `terraform/.terraform.lock.hcl` itself is un-ignored; nested lock files under `environments/*`,
  `modules/*`, `bootstrap/`, and `test-runner/` stay covered by the blanket rule.
- `terraform/.terraform/` (the provider binary cache `init` also creates) was **not** committed —
  confirmed still ignored (`git check-ignore terraform/.terraform/providers` matches
  `terraform/.gitignore:2:.terraform/`) and absent from `git status --porcelain` after staging.

**Correction to the ticket brief.** The brief asserted "the modular paths (`terraform/
environments/*`) ARE already properly locked." That is not accurate as of this ticket: neither
`terraform/environments/dev/` nor `terraform/environments/shadow/` has a committed
`.terraform.lock.hcl` — `git ls-files terraform/environments/` lists no lock file for either, and
TF-3's own `CHANGES.md` entry (`TRO-236`) says the same thing explicitly: lock files `init`
generated for `dev` and `shadow` "none of which are committed." What genuinely *is* already locked
is `terraform/modules/*/.terraform.lock.hcl` (six modules, all tracked) and
`terraform/render/.terraform.lock.hcl` (TF-10). Left `environments/*` untouched — closing that gap,
if wanted, is outside TF-4's declared scope (a flat-root-only fix) and is a separate, currently
unfiled gap, not this ticket.

**How to run it.**

```bash
cd terraform
terraform init -backend=false   # deterministic now: resolves aws 5.100.0 / random 3.9.0 from the lock file
terraform validate              # Success! 1 pre-existing warning only (TF-5's S3 lifecycle rule, untouched here)
terraform fmt -check -recursive # exit 0, no output — nothing to reformat
```

`terraform plan` was not attempted for evidence beyond `-backend=false` `init`: this config's
backend is S3 with the bucket name in SSM, and there are no AWS credentials in this environment —
the same documented gap TF-1/TF-3 hit, not new here.

**Not covered by this ticket.** TF-5 (the uploads-bucket lifecycle-rule `validate` warning) and the
security-groups file (TF-7, already merged) were left untouched, per scope. The
`terraform/environments/*` lock-file gap identified above is also left untouched — not TF-4's
declared scope.

**Regression test:** none added — pure Terraform configuration/tooling change, no application code
path for vitest to exercise. Same "regression-test gate inapplicable" judgment as TF-1/TRO-234,
TF-3/TRO-236, and TF-9/TRO-292 (`audit/factory/scorecard.jsonl`); the `terraform init`/`validate`/
`fmt` transcripts above are the evidence in their place.

**How to roll it back.** `git revert <this commit>` deletes `terraform/.terraform.lock.hcl` and
restores both `.gitignore` rules. That does not reintroduce TF-3's `init` failure (the version pin
is a separate file, untouched here) — it only re-floats the provider versions within `~> 5.0` /
`~> 3.6`, i.e. exactly TF-4's original finding, reopened. There is no scenario where reverting is
desirable; it exists only as a mechanical undo.

---

## TRO-245 [RULE-3] — verified every Phase 2 bug fix actually shipped the regression test it claimed

**What this is.** RULE-3 is the assignment-implementation rule that every bug fixed in this
project's remediation must ship with a regression test that would have caught it. It is not one of
the audit's 68 numbered findings. The 5 highest-value fixes (DB-1, ERR-1, ERR-2, API-1,
TEST-5/ERR-6) were already marked Done in Linear, meaning each was supposed to have already merged
with such a test. This ticket's job was to **verify** that claim per-finding — not re-implement any
fix — and close any gap found.

**Verification method.** For each finding: located the merged fix and its regression test on
`main`, read the test to confirm it asserts the real invariant (not just "didn't crash"), confirmed
it lives in a vitest file the gate actually executes (`api/src/**/*.test.ts` /
`web/src/**/*.test.ts(x)`, never only `e2e/*.spec.ts`), then — wherever feasible — temporarily
reintroduced the historical bug in the worktree (never committed), re-ran the test, confirmed a
genuine `AssertionError` (not an import/type error), and restored the file via `git checkout --`.
All five were verified this way (revert-and-watch), not by reading alone.

| Finding | Ticket | Regression test | Result |
|---|---|---|---|
| DB-1 | TRO-178 | `api/src/db/__tests__/migrationRunner.test.ts`, `verifyMigrations.test.ts` | PASS — reintroduced the historical "swallow any *already exists* error" catch in `runPendingMigrations`; 2 tests went red with `AssertionError: promise resolved ... instead of rejecting` (one in `migrationLock.test.ts` too, an unrelated file exercising the same code path). Restored, green again. |
| ERR-1 | TRO-188 | `web/src/components/editor/SyncStatusIndicator.test.tsx` | PASS — reverted `deriveSyncIndicator` to trust `syncStatus` alone (the pre-fix behavior); 5 tests went red reproducing the exact "Saved"/"Cached" data-loss lie. Restored, green again. |
| ERR-2 | TRO-189 | `api/src/collaboration/__tests__/session-revocation.test.ts` | PASS — made `revokeConnection` a no-op (session authenticated once at upgrade, never re-checked, matching the historical defect); 4 of 5 tests went red (the control case, which needs no revocation, correctly stayed green) with real socket/database assertions (`closed` stayed `false`, a post-revocation write reached `documents`). Restored, green again. |
| API-1 | TRO-172 | `api/src/middleware/__tests__/rate-limit.test.ts`, `web/src/lib/queryClient.test.ts`, `web/src/components/MutationErrorToast.test.tsx` | PASS — reverted `shouldRetryRequest` to treat 429 as permanent like every other 4xx: 1 test red directly, 6 more red in dependent files (`PersonEditor.test.tsx`, `UnifiedDocumentPage.throttledRead.test.tsx`) proving the retry policy is exercised broadly. Separately reverted `apiRateLimitKey`/`identityLimit` to the old per-IP/100-per-minute config: 7 tests went red. Restored both files, green again. |
| TEST-5 / ERR-6 | TRO-227 | `web/src/components/editor/CommentDisplay.test.ts` | PASS — reverted the plugin's `view()` lifecycle to the pre-fix behavior (blur/click-away had no handler; Escape required the input to already have focus); the 3 dismissal-path tests went red (happy-path and destroy-path tests correctly stayed green). Restored, green again. |

**One gap found and closed, precisely scoped.** No test previously spawned the actual `migrate.ts`
CLI process — `migrationRunner.test.ts`/`verifyMigrations.test.ts` both call `runMigrations()`
directly as a function, which cannot observe whether `migrate.ts`'s own try/catch actually converts
a rejection into `process.exit(1)`. Added
`api/src/db/__tests__/migrateCli.test.ts`: spawns the real `tsx src/db/migrate.ts` (what
`db:migrate` runs) against an unreachable `DATABASE_URL` and asserts the process exits non-zero and
reports the failure on stderr.

**Stated precisely, per the claim-provenance rule:** this new test does **not** reproduce DB-1's
specific historical defect — verified by swapping in the actual pre-DB-1-fix `migrate.ts` (`git
show <pre-TRO-178 commit>:api/src/db/migrate.ts`, never committed) and re-running it: the test
**stayed green**, because the old bug only swallowed errors whose message contains "already
exists", and a refused database connection does not match that string. DB-1's exact shape is what
`migrationRunner.test.ts`'s revert-and-watch above already proves red at the `runMigrations()`
level. This new test instead closes the adjacent, previously-unverified gap: that the CLI wrapper
forwards *any* `runMigrations()` failure — not only DB-1's specific one — into a non-zero exit
code, which is what "non-zero exit on failure" requires end-to-end and what no prior test checked
by spawning the real process.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/db/__tests__/migrateCli.test.ts
```

**No production code changed.** All 5 findings' fixes were confirmed correct as merged; nothing
was found incomplete.

**Rollback.** Remove `api/src/db/__tests__/migrateCli.test.ts`.

---

## TRO-238 (TF-5) — uploads S3 lifecycle rule had no `filter`/`prefix`; added an explicit empty `filter {}`

**What was broken.** `aws_s3_bucket_lifecycle_configuration.uploads` — the rule that aborts stray
incomplete multipart uploads on the uploads bucket — declared a `rule` block with an `id`,
`status`, and `abort_incomplete_multipart_upload`, but no `filter` and no top-level `prefix`. The
AWS provider (`hashicorp/aws` `~> 5.0`, resolved to `5.100.0` in this environment) treats that
combination as invalid: exactly one of `rule[0].filter` / `rule[0].prefix` is required. Today it's
a validation warning ("This will be an error in a future version of the provider"); a future
provider major turns it into a hard `terraform validate`/`plan` failure. It also left the rule's
actual scope ambiguous on paper — "applies to all objects" was only true by implicit default, not
declared.

Two locations carried the identical resource and warning:
- `terraform/s3-cloudfront.tf:430` (the flat root — this is what's actually deployed to prod,
  per TF-2/TRO-235's convergence).
- `terraform/modules/cloudfront-s3/main.tf:437` (the shared module, consumed by
  `terraform/environments/dev` and `terraform/environments/shadow` — `environments/prod` used to
  be a third consumer but TRO-235 deleted it as part of the TF-2 fix, before this ticket started).

**What changed.** Added an empty `filter {}` block to the `rule` in both files, immediately before
`abort_incomplete_multipart_upload`. An empty filter matches the AWS default (applies to every
object in the bucket, no prefix/tag narrowing) — this preserves today's actual behavior exactly,
it just makes it explicit and satisfies the provider's "specify exactly one of filter/prefix"
requirement. No prefix scoping was intended: the rule's `id` (`abort-incomplete-multipart`) and
its comment ("clean up incomplete multipart uploads") both describe a bucket-wide housekeeping
rule, not something scoped to a subset of keys, and there is no other evidence anywhere in the
repo (docs, other lifecycle rules, upload code) suggesting a narrower scope was ever intended. This
is a config-only change: no resource is replaced, no attribute that affects data retention/deletion
changed — only the shape of the declaration.

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.9.8 (darwin_arm64) to a scratch dir, matching the
# TF-1/TF-2/TF-3 precedent in this factory — the repo's pinned 1.15.8 (terraform/.terraform-version)
# is not installed on this machine and was not modified by this ticket. Not committed to the repo.
cd terraform
terraform init -backend=false -input=false
terraform validate                 # BEFORE: Success! with 1 warning (filter/prefix, TF-5)
                                    # AFTER:  Success! The configuration is valid. (0 warnings)
terraform fmt -check -recursive .  # exit 0, no formatting changes needed
git clean -fdx -- .terraform .terraform.lock.hcl   # removes the generated cache + lock file this
                                                    # init created; git clean only ever touches
                                                    # untracked/ignored paths, so it is safe here
                                                    # (leaves `git status` clean) and would refuse
                                                    # to remove either path if it were ever tracked
cd environments/shadow             # second root: consumes terraform/modules/cloudfront-s3
terraform init -backend=false -input=false
terraform validate                 # BEFORE: Success! with the same warning, module-relative path
                                    # AFTER:  Success! The configuration is valid. (0 warnings)
git clean -fdx -- .terraform .terraform.lock.hcl   # same reasoning: this init generates a fresh
                                                    # .terraform.lock.hcl here (none was tracked
                                                    # before), so cleanup must remove it too or
                                                    # `git status` is left dirty — `git clean`
                                                    # (never `rm -rf`) is what makes that safe to
                                                    # do unconditionally, here or in any other
                                                    # terraform/modules/* root that DOES commit one
```

**Verification performed here — before/after `terraform validate`.**

Before (flat root, `terraform/`):

```text
╷
│ Warning: Invalid Attribute Combination
│
│   with aws_s3_bucket_lifecycle_configuration.uploads,
│   on s3-cloudfront.tf line 430, in resource "aws_s3_bucket_lifecycle_configuration" "uploads":
│  430: resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
│
│ No attribute specified when one (and only one) of
│ [rule[0].filter,rule[0].prefix] is required
│
│ This will be an error in a future version of the provider
╵
Success! The configuration is valid, but there were some
validation warnings as shown above.
```

Before (`terraform/environments/shadow`, via the module):

```text
╷
│ Warning: Invalid Attribute Combination
│
│   with module.cloudfront_s3.aws_s3_bucket_lifecycle_configuration.uploads,
│   on ../../modules/cloudfront-s3/main.tf line 437, in resource "aws_s3_bucket_lifecycle_configuration" "uploads":
│  437: resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
│
│ No attribute specified when one (and only one) of
│ [rule[0].filter,rule[0].prefix] is required
│
│ This will be an error in a future version of the provider
╵
Success! The configuration is valid, but there were some
validation warnings as shown above.
```

After, both roots (and `terraform/environments/dev`, checked as a third data point since it also
consumes the same module):

```text
Success! The configuration is valid.
```

`terraform fmt -check -recursive .` from `terraform/`: exit 0, no output — no formatting drift
introduced. `terraform plan` was not run against either root: no S3 backend/AWS credentials are
available in this environment, matching the documented "Backend initialization required" failure
mode from `audit/terraform/baseline.md` and the TF-1/TF-2/TF-3 precedent. **No `terraform apply`
was run against any account, live or otherwise.**

**No vitest regression test applies.** This is a Terraform-only, infrastructure-as-code change —
there is no application code path to exercise and nothing importable into
`api/src/**/*.test.ts` or `web/src/**/*.test.ts(x)`. The evidence for "before: 1 warning, after: 0
warnings" is the `terraform validate` output above, captured on both affected roots before and
after the same one-line-per-file change. `gate.sh`'s regression-test check is expected to fail
honestly here, following the TF-1/TF-2/TF-3 precedent in this factory, rather than have a fake
vitest file manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf-5-lifecycle-filter`. This removes the `filter
{}` block from both `terraform/s3-cloudfront.tf` and `terraform/modules/cloudfront-s3/main.tf`,
returning to the pre-TRO-238 state (1 validation warning, same implicit all-objects behavior).

For *this PR's own validation-only work* (the `terraform init -backend=false` / `validate` / `fmt
-check` runs above), no live AWS state is touched either way, since no `apply` was ever run against
any account. That is a statement about what happened here, not a general property of `git revert`
on this file: `filter {}` on an already-empty-scope rule is a no-op against real AWS lifecycle
config, so if this change is ever `terraform apply`'d to a live account, a later `git revert` alone
does **not** undo anything on the AWS side — Terraform only reconciles infrastructure when you run
it. A rollback *after* a real `apply` would additionally require running `terraform plan` and
`terraform apply` from the affected root(s) (`terraform/`, and `terraform/environments/{dev,shadow}`
for the module) once the revert commit lands, so AWS is actually updated to match the reverted
config.

---

## TRO-196 (ERR-9) — BacklinksPanel's `console.error` storm on every failed poll buried the real signal

**What was broken.** `web/src/components/editor/BacklinksPanel.tsx`'s `fetchBacklinks()` polls
`/api/documents/:id/backlinks` every 5 seconds and, on any failure, called `console.error`
unconditionally in the `catch` block (previously line 56) — once per poll, for as long as the
failure lasted. The audit's raw evidence
(`audit/error-handling/raw/probe4-concurrency.json`, `probe6-mixed.json`) shows exactly this: a
document deleted elsewhere (404) or an expired/revoked session (401) produced a repeating
`Error fetching backlinks: Error: Failed to fetch backlinks` line every 5 seconds. That is console
noise during precisely the scenarios (offline, deleted doc, expired session) where a developer
most needs the console clean — and it buries the one signal that actually matters, the 404 storm
ERR-4's ghost-editor scenario produces.

**What changed.**
- Failed responses now throw a `BacklinksFetchError` carrying the HTTP status, so the `catch`
  block can distinguish failure modes instead of matching on a generic `Error` message.
- A `lastLoggedFailureModeRef` tracks the failure mode (`'404'`, `'401'`, `'500'`, `'network'`,
  etc.) of the most recently *logged* failure. A poll that fails the same way as the last logged
  failure is now silent — no re-log per retry/poll. A successful fetch resets the tracked mode, so
  a later failure (even the same status, after a recovery) is logged again — this is not a
  log-once-ever suppression, it is log-once-per-streak.
- 404 (document deleted elsewhere) and 401 (session expired or revoked) are additionally
  downgraded from `console.error` to `console.debug` — they are expected states, not bugs. Other
  failure modes (network errors, 5xx) keep `console.error`, just deduped.
- No user-visible behavior changed: the panel's `error` state and the "Failed to load backlinks"
  message still update on every failed poll exactly as before. Only the console-logging cadence
  and level changed. (Confirmed this does not trip escalation gate 4/6 in
  `ship-factory/references/escalation.md` — no auth/session semantics were touched, only client
  logging around an existing 401/404 response.)

**Regression test — `web/src/components/editor/BacklinksPanel.errorLogging.test.tsx`** (vitest,
run by the gate). Renders the real component with fake timers, mocks `global.fetch` to fail the
same way across the initial fetch + two 5-second polls, and asserts:
1. Repeated 404s never call `console.error` (downgraded to `console.debug`).
2. Repeated 401s never call `console.error` (downgraded to `console.debug`).
3. Repeated network failures (fetch throws) call `console.error` at most once across 3 attempts,
   not once per attempt.
4. A failure → success → failure sequence logs twice, not once — proving the suppression is
   per-streak, not a blanket "log only the first failure ever."

Confirmed red first, for the right reason: copied the pre-fix `BacklinksPanel.tsx` (`git show
HEAD:...`) into place and re-ran the suite — 3 of 4 cases failed with
`expected "error" to not be called at all, but actually been called 3 times` (404/401 cases) and
`expected "error" to be called 1 times, but got 3 times` (network case), i.e. the exact storm
being fixed, not an import error. Restored the fix and the same run went green
(`4 tests passed`), alongside the pre-existing `BacklinksPanel.test.tsx` (A11Y-6 heading-level
test, unaffected — 2 tests still passing).

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/components/editor/BacklinksPanel.errorLogging.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/err-9-backlinkspanel-console-storm` touching
`BacklinksPanel.tsx` and remove `BacklinksPanel.errorLogging.test.tsx`.

---

## TRO-281 — [A11Y-9] Project context sidebar lists have no accessible name

**POST-BASELINE** — found incidentally while fixing A11Y-1 (TRO-215, PR #6), not one of the
audit report's 68 findings.

**What was broken.** `web/src/components/sidebars/ProjectContextSidebar.tsx` renders two
navigation lists — the "Weekly Docs" people list (`:290`, formerly unlabelled `<ul>`) and the
"Issues" list (`:398`, formerly unlabelled `<ul>`) — and neither had an accessible name. TRO-215
fixed the `role="tree"` problem in this same file (a *role* gap: an implied keyboard model that
was never implemented) but left this *naming* gap untouched. axe does not flag an unnamed
`<ul>` — there is no WCAG rule requiring one — which is exactly why the baseline audit never
caught it.

**What changed.** Each list now has `aria-labelledby` pointing at its existing visible section
heading, keeping the visible and accessible names in sync per the ticket's fix direction:

- Gave the "Weekly Docs" heading `<div>` and the "Issues" toggle `<button>` each a stable id via
  `useId()`.
- Wired `aria-labelledby={weeklyDocsHeadingId}` onto the people `<ul>` and
  `aria-labelledby={issuesHeadingId}` onto the issues `<ul>`.
- No visual change, no behavior change — both ids are invisible attributes.

**Sanity-checked, not changed:** the ticket asked to confirm the wording of
`aria-label="Projects"` added at `App.tsx:1241` (now `:1258`, drifted by unrelated commits) by
TRO-215. That list is `ProjectsList`'s `<ul>` rendering `projects.map(...)` — the label matches
what it contains. No inconsistency found, left as-is.

**Evidence.** `web/src/components/sidebars/ProjectContextSidebar.test.tsx` — two new cases in
describe block `ProjectContextSidebar — list accessible names (A11Y-9 / TRO-281)`, added to the
existing test file (not a new one) since it already covers this component's accessibility
tree via Testing Library. Both assert via `getByRole('list', { name: ... })` /
`findByRole('list', { name: ... })`, i.e. the resolved accessible name in the accessibility
tree — not an axe scan, since axe would not have caught this class of defect either way.
Confirmed **red** on the unfixed code (`TestingLibraryElementError: Unable to find role="list"
and name ...`, both new lists found by role but rejected on name) before writing the fix, and
**green** after (`pnpm --filter @ship/web test` — 49 files / 422 tests passed, no regressions).

**Still owed — do not mark this fully verified.** Nobody has run VoiceOver against the fixed
build. What's established here is that the accessible name *resolves correctly in the DOM/
testing-library accessibility tree* — not what a screen reader actually speaks. Batch this
verification with the VoiceOver pass already owed on TRO-215 rather than scheduling a second
session.

**How to run it.**

```bash
pnpm --filter @ship/web test -- --run web/src/components/sidebars/ProjectContextSidebar.test.tsx
```

**Rollback.** `git revert` the commit(s) on `fix/a11y-9-sidebar-accessible-names`, or by hand:
remove the two `aria-labelledby` attributes, the two `id`s, and the `useId` import/calls. The two
new test cases fail if either list's accessible name regresses, which is the point.

---

## TRO-298 — [A11Y-10] `DashboardSidebar` active nav item fails colour contrast (2.74:1), newly reachable on `/search` and `/weeks`

**What was broken.** `DashboardSidebar.tsx:36,51` used `bg-accent/10 text-accent` for the active
"My Work" / "Overview" nav item — the same mistake A11Y-3 (TRO-217) fixed on `/my-week`: `accent`
(`#005ea2`) is documented in `web/tailwind.config.js` as a *fill* colour, only 2.89:1 as text on
`background`, and worse once composited under the `/10` badge fill. Measured directly from the
resolved DOM: `text-accent` (`#005ea2`) on the composited `bg-accent/10` badge (`#0c151c`) is
**2.74:1** — well under the WCAG AA minimum of 4.5:1.

This is not a new defect. `DashboardSidebar` itself never changed. It became reachable only after
PR #53 made `/search` and `/weeks` render for the first time — previously those routes rendered
nothing, so axe never got a page to scan. Once `AppLayout` mounts there, `getActiveMode()`
(`pages/App.tsx`) has no match for `/search` or `/weeks`, falls through to its `'dashboard'`
default, and highlights "My Work" with the failing pair. axe reported it Serious on both routes
against branch `fix/a11y-5-6-7-landmarks`. This exact case was flagged and deliberately left
unfixed in the A11Y-3 PR (see that entry, "New, honestly-reported") specifically because it was
out of that ticket's landmark/heading scope — TRO-298 is the follow-up filed there.

**What changed.** `web/src/components/DashboardSidebar.tsx:36,51` — `text-accent` → `text-accent-text`
on both nav buttons (the "My Work" and "Overview" active states). `text-accent-text` (`#2491ff`,
USWDS blue-40v) is the token `web/tailwind.config.js` already defines for accent-colored text
(added by A11Y-3): **5.76:1** on the same composited `bg-accent/10` badge background, clearing AA
with margin. `accent` itself is unchanged, so the badge fill and every `bg-accent` usage elsewhere
in the app look exactly as before — same fix shape as A11Y-3 (token-level addition, not a mutation
of `accent`).

**Evidence.** Verified live, not just by class name. Both button elements were rendered on a
freshly-restarted dev server (`web :5502`, `api :3329`, this worktree's own `ship_wt_tro_298` DB,
authenticated as `dev@ship.local`) at `/search`, with the computed style read directly via
`getComputedStyle(...).color`:

| State | Class | Computed `color` | Ratio on `bg-accent/10` |
|---|---|---|---|
| Before | `text-accent` | `rgb(0, 94, 162)` (`#005ea2`) | **2.74:1** — fails AA |
| After | `text-accent-text` | `rgb(36, 145, 255)` (`#2491ff`) | **5.76:1** — passes AA |

Before/after screenshots (cropped to the sidebar) captured in the same session are attached to the
PR. Each capture followed a full Vite restart (not just HMR/reload) after swapping the source file,
because an in-place `cp` over a running dev server was observed to serve a stale transform despite
`Cache-Control: no-cache` — confirmed by `curl`ing the raw module and comparing to the file on disk
before trusting either screenshot.

**Regression test.** `web/src/components/DashboardSidebar.contrast.test.tsx` — same shape as
A11Y-3's `MyWeekPage.contrast.test.tsx`: resolves *effective colours* out of the rendered DOM via
`resolveContrastPairs` (`web/src/lib/contrast.ts`) and asserts the WCAG ratio, not a class string,
so it survives a markup refactor and fails again if a palette hex drifts back under 4.5:1. Renders
both view states (`/` → "My Work" active, `/?view=overview` → "Overview" active) since each nav
item's active-state pair only exists in its own state.

Confirmed red first on the unfixed component (restored via `git show HEAD:<path>` copied aside,
never `git stash`, per this project's standing rule): 3 of 4 tests failed, every one an
`AssertionError` at exactly **2.740106658407859**, matching the badge-composited ratio above — not
an import error or locator failure. Green after the fix, 4/4, with no other assertion changed.

**How to run it.**

```bash
pnpm --filter @ship/web exec vitest run src/components/DashboardSidebar.contrast.test.tsx
pnpm --filter @ship/web test        # 424 tests pass, 0 failures — no regressions elsewhere
pnpm --filter @ship/web type-check  # clean
```

**Not verified.** That a low-vision user can now read the sidebar — contrast ratios are measured;
the user-facing benefit is *derived* from them, same caveat A11Y-3 recorded. Also not verified:
whether the e2e a11y specs' "critical-only" severity filter (`e2e/accessibility-remediation.spec.ts`,
noted as an A11Y-7 follow-up) should tighten to Serious+ now that this Serious finding exists —
flagged for the maintainer, not changed here; it is a CI-policy change outside this ticket's scope
and the e2e specs are not run by the factory gate regardless.

**Found and not fixed.** Nothing new. `getActiveMode()` falling through to `'dashboard'` on
`/search` and `/weeks` (so an unrelated route highlights "My Work") is a pre-existing routing quirk,
not an accessibility defect, and out of scope here.

**Roll back.** `git revert` the commit on `fix/a11y-10-dashboardsidebar-contrast`, or by hand:
restore `text-accent` on both `DashboardSidebar.tsx` nav buttons and delete
`DashboardSidebar.contrast.test.tsx`. No token or other file changes to undo — `accent-text` already
existed from A11Y-3 and is unchanged here.

---

## TRO-301 (ERR-17) — the document-by-id query hardcoded `retry: false`, so a throttled (429) read failed permanently on the first attempt

**Not one of the original 68 audit findings** — a post-baseline Linear ticket, no
`audit/AUDIT_REPORT.md` section.

**The ticket's premise, checked against the file before acting on it.** The ticket described
`UnifiedDocumentPage.tsx`'s document query as throwing a plain `Error` with no `.status`, so even
without `retry: false` the shared `errorStatus()`/`shouldRetryRequest` predicate (queryClient.ts,
built for TRO-172/API-1) couldn't classify a 429 as throttling. That part of the premise is
**stale**: PR #51 (`51f6c2e`, TRO-290/ERR-14) already attached `.status` to the thrown error, as a
side effect of telling a 404 apart from other fetch failures for the deletion-notice fix. Reading
the current file (`git show 51f6c2e -- web/src/pages/UnifiedDocumentPage.tsx`) confirms it. The
**only** remaining defect is `UnifiedDocumentPage.tsx:86`'s own `retry: false`, which overrides
that shared policy regardless of what the thrown error carries.

**Root cause.** `web/src/pages/UnifiedDocumentPage.tsx`'s top-level `useQuery(['document', id])` set
`retry: false` as a per-query override. `queryClient`'s `defaultOptions.queries.retry` is
`shouldRetryRequest`, which backs a 429 off across the server's 60s rate-limit window
(`THROTTLE_RETRY_DELAYS_MS`) instead of dropping it — exactly the policy TRO-190/ERR-3 already gives
every mutation. The per-query `retry: false` silently opted this one read out of it, so a throttled
document load failed for good on the very first attempt.

**What changed.** Removed the `retry: false` override from the query options (no `retry`/`retryDelay`
set at all — same pattern `PersonEditor.tsx`'s `updatePersonMutation` already uses for its write
path). The query now inherits `queryClient`'s shared policy: a 429 retries with backoff, and every
other 4xx (including 404) is still treated as permanent on the first attempt. The `queryFn`'s
`.status` attachment was not touched — it was already correct.

**Preserved: ERR-14's deleted-document handling (PR #51).** `isNotFoundError` classifies 404 as a
permanent 4xx under `shouldRetryRequest`, so a deleted document still fails immediately with no
retry storm, and the existing effect that routes a 404 into `notifyDocumentGoneOnRead` /
`useDocumentWriteStatus`'s one-shot deletion notice is unchanged. Verified explicitly: reran
`UnifiedDocumentPage.deletedFocusRefetch.test.tsx` after this fix — both cases still pass (2/2).

**Regression test — `web/src/pages/UnifiedDocumentPage.throttledRead.test.tsx`** (vitest, run by the
gate). Drives the real `queryClient` singleton and real timers, like the ERR-14 test:

1. A 429 on the first fetch, then a 200 on the retry — asserts the editor eventually mounts and the
   document was fetched more than once (real backoff, ~2-3s, `waitFor` given an 8s window).
2. A 404 on the first fetch — asserts the "not found" screen appears immediately and the document
   was fetched exactly once, with no growth in call count across 5 flushed microtask/macrotask
   turns (a 404 disables retry synchronously, so there's no backoff window to wait out).

Confirmed red first, for the right reason: reverting `UnifiedDocumentPage.tsx`'s query options back
to `retry: false` (`git checkout HEAD -- web/src/pages/UnifiedDocumentPage.tsx`, since the fix was
still uncommitted) and rerunning — test 1 failed with the page stuck on "Failed to fetch document"
and `docCallCount` never advancing past 1 (timed out waiting for `editor-mounted`); test 2 still
passed, because 404 handling doesn't change with this fix. Restored the fix and reran: both green.

Also checked the ticket's literal premise directly: temporarily combined "no `.status` attached" (the
pre-ERR14 `queryFn`) with "`retry: false` removed" and reran the 404 case alone — it *did* regress
into a retry storm (stuck on "Loading...", no `.status` means `shouldRetryRequest` treats the error
as un-classified and retries up to `DEFAULT_MAX_RETRIES`). That confirms why the (b) test matters as
a standing regression guard even though it doesn't flip red→green on this specific one-line diff in
the current, already-`.status`-carrying codebase.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/UnifiedDocumentPage.throttledRead.test.tsx
```

**Rollback.** Revert the commit on `fix/err-17-document-query-retry` touching
`UnifiedDocumentPage.tsx`'s query options (re-adds `retry: false`) and delete
`UnifiedDocumentPage.throttledRead.test.tsx`. No other files changed.

---

## TRO-294 — direct-to-ALB health check URL in `.claude/CLAUDE.md` corrected to the CloudFront-fronted path

**Docs-only, priority Low, no vitest path applies (regression-test evidence below instead).**

**What was wrong.** `.claude/CLAUDE.md`'s Deployment section documented the prod API health check
as `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health` — a direct hit on the
Elastic Beanstalk ALB's own DNS name, bypassing CloudFront. TF-7/TRO-278 (already merged, see that
entry above) restricted the ALB security group (`terraform/security-groups.tf`) to CloudFront's
origin-facing prefix list, `data.aws_ec2_managed_prefix_list.cloudfront_origin_facing`. Once that
SG is actually applied to a live account, a direct connection to the ALB URL times out for most
clients — the DNS name itself still resolves; the security group silently drops the TCP connection
because it isn't sourced from CloudFront's IP ranges. Either way, not an API-health problem: the
network path is blocked. TRO-278's own
CHANGES.md entry called this out as DERIVED and explicitly left it for a human/follow-up ticket to
fix; this ticket is that follow-up.

**What changed.** `.claude/CLAUDE.md`'s Prod API health check now reads
`https://ship.awsdev.treasury.gov/health`, with a note explaining why the old URL breaks and where
the replacement comes from.

**How I confirmed the new URL (observed, not invented).** Read `terraform/s3-cloudfront.tf`
directly: the `dynamic "ordered_cache_behavior"` block with `path_pattern = "/health"` (only
created `for_each = var.eb_environment_cname != "" ? [1] : []`) targets `target_origin_id =
"EB-API"` — CloudFront already proxies this exact path to the same Elastic Beanstalk origin the
old URL hit directly. The domain to use is `var.app_domain_name` (`terraform/variables.tf`) when
set, else the CloudFront-assigned domain exposed as the `cloudfront_domain_name` output
(`terraform/outputs.tf`); the `frontend_url` output already picks the right one of the two
(`var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"`).
`ship.awsdev.treasury.gov` is prod's `app_domain_name` value — corroborated by every other prod
reference in the repo (`.claude/CLAUDE.md`'s own "Prod Web" line just below the edit,
`audit/AUDIT_REPORT.md`, `memory-bank/techContext.md`, `docs/fpki-auth-client-dcr-analysis.md`'s
OAuth redirect URI), not by a fresh `terraform output` (no AWS credentials / apply available here,
same constraint TF-7's own work noted). **Not verified:** whether the ALB SG restriction has
actually been `apply`'d to the live prod account yet. `memory-bank/progress.md` records two
*separate* 2026-07-28 checks, not one combined result: `ship.awsdev.treasury.gov` (the domain this
PR's new health-check URL uses) returned **HTTP 403** — the request reached an HTTP endpoint and
was refused, which is not evidence of an unreachable network path — but confirms only that the
viewer-facing hostname returned an HTTP response; it does **not** confirm CloudFront reached the
`EB-API` origin, since CloudFront or an upstream policy can reject a request before origin access.
The old direct-ALB
hostname (`ship-api-prod...elasticbeanstalk.com`) returned **no response at all** — a different,
stronger signal, closer to what TF-7's SG restriction would actually produce. Neither result
confirms the SG restriction is live in prod; the new URL could not be curled end-to-end to verify
from here.

**Regression-test note.** Pure documentation change; neither vitest project (`api/src/**/*.test.ts`,
`web/src/**/*.test.ts(x)`) has a path to assert against a markdown string, so no test file is added.
`scripts/factory/gate.sh`'s G6 (regression-test present) is expected to fail on this branch for that
reason — the evidence for the fix is the terraform cross-reference above, not a test.

**How to roll it back.** `git revert <commit>`, or manually restore the old two-line health-check
list in `.claude/CLAUDE.md`. This is a docs-only revert — it restores the stale URL text but does
**not** undo the TF-7/TRO-278 ALB security-group restriction that made the URL stale; that lives in
a separate, already-merged change (`terraform/security-groups.tf`) with its own Terraform
apply/revert path. No code, schema, or infra changed by this commit either direction.

---

## TRO-234 — [TF-1] Prod Aurora cluster and uploads bucket had no deletion protection

**The problem.** Of the flat root's 74 resource blocks, only the Terraform **state** bucket
(`terraform/bootstrap/main.tf:22-23`) carried `lifecycle { prevent_destroy = true }`. The Aurora
cluster (`terraform/database.tf`, `aws_rds_cluster.aurora`) had neither `deletion_protection` nor
`prevent_destroy`, and the uploads bucket (`terraform/s3-cloudfront.tf`, `aws_s3_bucket.uploads`)
had no `prevent_destroy` either. Both are Tier-1 "data loss on replace or destroy" in
`audit/terraform/baseline.md`'s blast-radius table: a config change that forces replacement of
either (e.g. `cluster_identifier`, `master_username`, or the bucket-name interpolation) would let
Terraform proceed straight to destroying the live production database or every uploaded file,
with no safety stop. (Line numbers in the Linear ticket — `database.tf:34` /
`s3-cloudfront.tf:374` — were current at audit time; TF-2's convergence, already merged, shifted
the Aurora cluster resource to `database.tf:63` by porting in 5 parameter-group settings ahead of
it. Same resource, same defect.)

**What changed.** Two additions, no resource renamed or restructured:

- `terraform/database.tf` — `aws_rds_cluster.aurora` gets `deletion_protection = true`
  (a first-class RDS attribute: the AWS API itself refuses a destroy while set) plus
  `prevent_destroy = true` added to its existing `lifecycle` block (which already carried
  `ignore_changes = [final_snapshot_identifier]` from `TF-7`/`TF-2` work — merged in, not a
  second `lifecycle` block, since a resource may declare only one).
- `terraform/s3-cloudfront.tf` — `aws_s3_bucket.uploads` gets a new
  `lifecycle { prevent_destroy = true }` block. S3 buckets have no `deletion_protection`
  attribute in the AWS provider (that concept is RDS-specific), so `prevent_destroy` is the only
  available guard — same pattern already used on the state bucket.

**Deliberate consequence, not a surprise.** Both resources now require a config change before an
intentional teardown, but the two guards are independent and **both** must be removed:

- `terraform/s3-cloudfront.tf` (uploads bucket): removing `lifecycle { prevent_destroy = true }`
  only permits Terraform to *attempt* the deletion — it doesn't make the deletion succeed. The
  bucket has versioning enabled (`aws_s3_bucket_versioning.uploads`) and does not set
  `force_destroy`, and no Terraform resource manages object cleanup for it. Before destruction, an
  operator must also empty the bucket by hand: every object, every object version, and every
  delete marker, or the destroy call fails on a non-empty bucket regardless of `prevent_destroy`.
- `terraform/database.tf` (Aurora cluster): **two separate safeguards**, not one.
  `lifecycle { prevent_destroy = true }` is Terraform-side, same as the bucket — but
  `deletion_protection = true` is a distinct, first-class RDS attribute enforced by the **AWS API
  itself**, independent of Terraform. Removing only `prevent_destroy` from the config is not
  enough: AWS will still refuse the `DeleteDBCluster` call. An operator must apply a config change
  that sets `deletion_protection = false` *and* removes `prevent_destroy`, then run the destroy —
  in that order, since the API-level flag has to flip before AWS will honor a destroy at all.

That extra step is the entire point of this ticket (TF-1's finding is literally "one careless
apply/destroy from prod data loss"); it is called out here — accurately, for both resources — so
it isn't rediscovered as a mystery blocker during a future teardown.

**What did NOT change.** No other flat-root resource, and no module. `terraform/modules/aurora`
(used by `terraform/environments/dev` and `terraform/environments/shadow`, kept per TF-2's
convergence decision) has the same gap — no `deletion_protection`/`prevent_destroy` on its own
`aws_rds_cluster` — but dev/shadow are non-prod, TF-1's finding and the Linear ticket both scope
explicitly to the flat root's two named resources, and touching the module is out of scope for
this ticket. Flagging it as a follow-up candidate, not fixing it here.

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.9.8 to a scratch dir (matches audit/terraform/baseline.md
# and the TF-2/TF-3 precedent; the repo's pinned 1.6.0 cannot `init` at all — TF-3, expired
# provider-signing key). Not committed to the repo.
cd terraform
terraform init -backend=false -input=false
terraform validate       # Success! same single pre-existing TF-5 warning, before and after
terraform fmt -check -recursive .   # exit 0, no formatting changes needed
terraform plan            # Error: Backend initialization required (s3) — expected; no AWS
                           # credentials or remote-state bucket are available here, matching
                           # audit/terraform/baseline.md's documented "Live plan not runnable"
rm -rf .terraform .terraform.lock.hcl   # leaves `git status terraform/` clean, per audit methodology
cd ..
grep -n 'deletion_protection\|prevent_destroy' terraform/database.tf terraform/s3-cloudfront.tf
```

**Verification note.** `terraform validate` was run on the flat root before and after this change
with the same 1.9.8 binary: both report `Success!` with the identical single pre-existing warning
(TF-5, the uploads-bucket lifecycle-rule `filter`/`prefix` warning) — this change introduces no
new warnings or errors. `terraform plan` fails identically before and after with "Backend
initialization required" (no S3 backend/creds available in this environment) — this is the
documented, expected failure mode from `audit/terraform/baseline.md`, not a regression caused by
this change. **No `terraform apply` was run against any account, live or otherwise** — this PR is
config-only, per the escalation-gate-2 rule against irreversible/outward-facing actions.

**No vitest regression test applies.** This is a Terraform-only, infrastructure-as-code change;
there is no application code path to exercise and nothing importable into `api/src/**/*.test.ts`
or `web/src/**/*.test.ts(x)`. The evidence for "before: unprotected, after: protected" is the
`grep` above — 0 matches across these two files before this change; 3 after, each attributable to
a specific line: `database.tf:72` (`deletion_protection = true`, the Aurora cluster),
`database.tf:95` (`prevent_destroy = true`, the same Aurora cluster's `lifecycle` block), and
`s3-cloudfront.tf:382` (`prevent_destroy = true`, the uploads bucket) — plus the
`terraform validate`/`plan` output showing the config stays syntactically valid. `gate.sh`'s
regression-test check is expected to fail honestly here, following the TF-2/TF-3 precedent in
this factory, rather than have a fake vitest file manufactured to satisfy it.

**Rollback.** `git revert` the commit(s) on `fix/tf-1-deletion-protection`. This removes
`deletion_protection` and both `prevent_destroy` blocks, returning to the pre-TRO-234 unprotected
state. No live AWS state is touched either way, since no `apply` was ever run.

---

## TRO-292 (TF-9) — Removed committed binary `tfplan` from `terraform/environments/shadow/`; closed the `.gitignore` gap for the whole `environments/` family

**Post-baseline, not one of the 68 audit findings — no `AUDIT_REPORT.md` section.** Full spec was
the Linear ticket body.

**What was wrong.** `terraform/environments/shadow/tfplan` was a git-tracked ~28.5KB binary
Terraform plan artifact in a public repo. A `strings` scan found no password/secret/token/key
patterns, but that's a pattern scan of a binary, not proof of absence — moot anyway, since scope
here was drift, not a secret-exposure claim. Root cause: the root `.gitignore`'s
`terraform/*.tfplan` / `terraform/tfplan` rules (lines 72-73) are anchored one directory deep — no
`**` — so they never matched anything under `terraform/environments/<env>/`. The TF-10/TRO-299
Render fix added `terraform/render/*.tfplan` / `terraform/render/tfplan` for that one subdirectory
for the same reason, but the `environments/` family (which already had its own generalized
`environments/*/terraform.tfvars` and `environments/*/.terraform.lock.hcl` rules) was never given
the equivalent for `tfplan`. Nothing pattern-scans plan files for secrets before commit, so this
class of drift (tfplan → public repo) can recur on any new environment directory.

**What changed.**
- Removed `terraform/environments/shadow/tfplan` with `git rm` (not `git rm --cached` — that flag
  only unstages a file from the index and leaves it sitting on disk, untracked; the goal here was
  removing it from the working tree too, which plain `git rm` does in one step, confirmed by
  `git show f60ab9b --stat` reporting the file deleted and its absence from `ls` afterward).
- Added `terraform/environments/*/*.tfplan` and `terraform/environments/*/tfplan` to the root
  `.gitignore`, next to the existing `environments/*/terraform.tfvars` /
  `environments/*/.terraform.lock.hcl` lines — same glob family, so it also covers
  `terraform/environments/dev/` and any future environment, not just `shadow/`.

**Explicitly out of scope (by ticket design):** rewriting git history to purge the blob from prior
commits. The file remains recoverable from history; only future drift is stopped. No other
Terraform files were touched, and no `terraform apply`/`plan` was run.

**How to run it / verify.**

```bash
# proves tfplan is gone from the index, not just from `git status` output:
git ls-files --error-unmatch terraform/environments/shadow/tfplan   # exits 1: not tracked
# throwaway regression check (no vitest path applies — this is repo hygiene, not app code):
head -c 2000 /dev/urandom > terraform/environments/shadow/throwaway.tfplan
git status --short                                   # throwaway *.tfplan file does not appear
rm terraform/environments/shadow/throwaway.tfplan
git check-ignore -v terraform/environments/shadow/newplan.tfplan   # matches the *.tfplan rule
# the .gitignore change also added a second, extensionless rule
# (terraform/environments/*/tfplan) — exercise that one separately, since the
# *.tfplan checks above never touch it:
touch terraform/environments/shadow/tfplan
git status --short                                   # bare-name file does not appear either
git check-ignore -v terraform/environments/shadow/tfplan   # matches the extensionless rule
rm terraform/environments/shadow/tfplan
```

**How to roll it back.** `git revert <the tfplan-removal commit>` re-creates
`terraform/environments/shadow/tfplan` from the parent commit **and re-tracks it** — `revert`
commits the inverse diff, so the file comes back staged and committed, not just present in the
working tree. Verified empirically (disposable repo: delete-then-revert leaves the file in
`git ls-files` with a clean `git status`) before writing this, since the first draft of this
paragraph asserted the opposite and was wrong — flagged by CodeRabbit review on this same PR.
The `.gitignore` lines revert normally either way.

---

## TRO-236 — [TF-3] Pinned Terraform 1.6.0 can no longer `init`; bumped to current 1.15.8

**What was broken.** `terraform/.terraform-version` (`d826517`) pinned Terraform to `1.6.0`.
HashiCorp's provider-signing key valid at that historical release has since expired, so `terraform
init` on a clean machine fails installing *any* provider — `hashicorp/random` and `hashicorp/aws`
both error `error checking signature: openpgp: key expired`. Reproduced verbatim against the flat
root (`terraform/`) with a freshly downloaded `1.6.0` binary (no cached provider plugins, no prior
`.terraform/`). Every root config that reads this pin (there is exactly one `.terraform-version`
file in the repo, and `TRO-235`/TF-2 already converged the flat root as the sole AWS root, so
`environments/prod` no longer exists to hold a second copy) inherits the same failure via tfenv's
upward directory search: `terraform/` (flat root), `terraform/environments/dev`,
`terraform/environments/shadow`, `terraform/bootstrap`, and `terraform/render` (added since the
baseline audit, by TF-10) all resolve to `terraform/.terraform-version` since none of them carries
its own copy.

**What changed.** Bumped `terraform/.terraform-version` from `1.6.0` to `1.15.8` — the current
stable release (verified via `https://checkpoint-api.hashicorp.com/v1/check/terraform` and GitHub's
`releases/latest`, published 2026-07-08, not a prerelease). No `required_version` constraint
changed: the flat root, `bootstrap`, `dev`, and `shadow` all declare `>= 1.6.0` (a floor, already
satisfied), and `terraform/render` declares `>= 1.9.0` (also satisfied by `1.15.8`; a lower bump
like `1.9.x` would have worked for the AWS roots but this repo also has to satisfy render's higher
floor, and it made no sense to leave `.terraform-version` sitting mid-way between two roots'
requirements when "current release" is what the finding asked for).

**How to run it.**

```bash
# each line runs in its own subshell so `cd` never persists into the next line
# (a shared `cd terraform` followed by a relative `cd terraform/environments/dev`
# would resolve to the nonexistent terraform/terraform/environments/dev)
(cd terraform && terraform init -backend=false)   # flat root — no AWS creds/backend needed to prove init
(cd terraform/environments/dev && terraform init -backend=false)
(cd terraform/environments/shadow && terraform init -backend=false)
(cd terraform/render && terraform init)            # local backend, no -backend=false needed
```

All four succeeded with a freshly downloaded `1.15.8` binary (`Terraform has been successfully
initialized!`), each on a clean run with no pre-existing `.terraform/` or lock file for that
directory (render's pre-existing committed `.terraform.lock.hcl` was reused unchanged — confirmed
via `git status` showing no diff on it). The same `1.6.0` binary against the same flat root, run
first, reproduced the reported failure exactly. `.terraform/` caches and the lock files `init`
generated for the flat root, `dev`, and `shadow` (none of which are committed — see
`.gitignore:67-77`) were removed afterward so `terraform/` carries only the one-line pin change;
`git status --short terraform/` shows `M terraform/.terraform-version` and nothing else.

**Not covered by this ticket.** TF-4 (flat root has no committed `.terraform.lock.hcl` — providers
float) and TF-1 (no deletion protection on prod data stores) are separate findings, untouched here.
No regression test applies — this is a Terraform CLI/tooling pin, not application code; the
before/after `terraform init` transcripts above are the evidence in place of a vitest test, per the
ticket's regression-test note.

**How to roll it back.** `git revert <this commit>` restores `1.6.0` — which will immediately fail
`init` again on any machine trusting HashiCorp's current provider registry, so there is no
scenario where reverting is desirable; it exists only as a mechanical undo.

---

## TRO-299 (TF-10) follow-up — live Render deployment adopted into Terraform state via `import`; post-import plan is a clean no-op

**What was added.** Maintainer decision 2026-07-30 resolved the TF-10 entry's HOLD: adopt the
live, hand-built Render deployment via `terraform import` rather than a clean-machine `apply`
(no duplicate stack, no data loss, no second URL). Both live resources
(`render_web_service.ship` = srv-d9kf2t942hec73aofrt0, `render_postgres.ship` =
dpg-d9kgth6417fc7386hhh0-a) were imported into the config's local, gitignored state. Two
reconciliation rounds followed, exactly as `terraform/render/README.md` predicted:
`database_name` reconciled to the live auto-generated `ship_34oc` (its mismatch forced a
**destructive replacement** in the first post-import plan — never applied), then
`environment_id` declared plus `lifecycle.ignore_changes` on Render-assigned display fields.
Final result: **"No changes. Your infrastructure matches the configuration."**

**How to run it.**

```bash
cd terraform/render
set -a; source ../../.env; set +a   # RENDER_API_KEY (gitignored)
terraform init && terraform plan     # expect: No changes
```

Evidence: `terraform/render/plan/post-import-plan-no-changes.txt` (verbatim capture) and
`terraform/render/plan/IMPORT-LOG.md` (full narrative). `terraform apply` was never run; the
live service was never modified — import writes only local state.

**How to roll it back.** `terraform state rm render_web_service.ship render_postgres.ship`
un-adopts the resources (state-only; the live service is untouched either way). The config
edits (`database_name` default, `environment_id`, `ignore_changes`) revert with
`git revert <commit>`.

---

## TRO-278 — [TF-7] ALB security group locked to CloudFront's prefix list; `trust proxy` hop count made environment-configurable

**HOLD, scoped to the terraform side only — security semantics (gate 6) + infra change (gate 2).**
`terraform/security-groups.tf` and `terraform/elastic-beanstalk.tf` still need human sign-off
before any AWS `apply`. Per the maintainer, that `apply` is **not planned** — the AWS blueprints in
this repo are repo hygiene, not the live deployment. **The `api/src/app.ts` change is NOT held** and
is safe to auto-deploy to the actual live target, Render: see the maintainer follow-up immediately
below for why, and the post-deploy checklist further down for what remains genuinely unverified on
the AWS side.

**MAINTAINER FOLLOW-UP (2026-07-30) — this repo's live deployment is Render, not AWS.** The first
version of this fix set `app.set('trust proxy', 2)` unconditionally. That count is correct only for
the AWS chain analyzed below (`client -> CloudFront -> ALB -> Express`, two hops). This repo's
actual live deployment is **Render** (`terraform/render/web_service.tf`, adopted onto `main` via
TF-10 the same day, `auto_deploy = true`), sitting directly in front of Express with **no CDN
layer** — `client -> Render's proxy -> Express`, ONE hop. Render auto-deploys from `main`, so
merging the unconditional `2` as originally written would have made `req.ip` forgeable (a
client-supplied `X-Forwarded-For` entry trusted as though it were Render's own) on the live demo
site the moment this PR merged — recreating on Render the exact vulnerability this ticket fixes on
AWS.

**The fix:** the hop count is no longer a constant. `api/src/app.ts`'s `resolveTrustProxyHops`
(defined just above `createApp`, called at `app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS))`)
reads `TRUST_PROXY_HOPS` from the environment, validated as a positive integer, and **defaults to
1** when the variable is unset, empty, or invalid (zero, negative, non-integer, or non-numeric) —
logging a warning rather than crashing or silently trusting a bogus count. 1 is the correct value
for Render and local dev, and is *identical* to what `app.set('trust proxy', 1)` did before this
ticket touched the file at all, because `terraform/render/web_service.tf` sets no
`TRUST_PROXY_HOPS` override — so the default is what actually ships to the live site.
`terraform/elastic-beanstalk.tf` now sets `TRUST_PROXY_HOPS = "2"` for the AWS blueprint (the
CloudFront -> ALB chain below) — inert today since that environment is not live and not planned to
be applied, but present so the blueprint is correct if it ever is.

**Observed** (`terraform/security-groups.tf`, before this change): the ALB security group allowed
ports 80/443 from `0.0.0.0/0` — not restricted to CloudFront — while `api/src/app.ts` set
`trust proxy 1`. Filed from TRO-172's rate-limiter work, whose per-source-IP flood floor
(`perSourceIpLimiter` in `api/src/middleware/rate-limit.ts`) depends on `req.ip` being unspoofable.

**What changed — the security group (`terraform/security-groups.tf`).**

- Added `data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing"`, looked up by AWS's
  well-known name `com.amazonaws.global.cloudfront.origin-facing`.
- The `aws_security_group.alb` ingress rules for ports 80 and 443 now use
  `prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]` instead of
  `cidr_blocks = ["0.0.0.0/0"]`. Egress and every other resource in the file are untouched.
- **Does anything else legitimately reach the ALB directly?** EB's own health checks travel
  ALB -> EC2 target *inside* the VPC and are unaffected (`aws_security_group.eb_instance`'s
  ingress-from-ALB rule is untouched). The automated deploy monitor
  (`.claude/skills/ship-deploy/SKILL.md`) polls `aws elasticbeanstalk describe-environments`, an
  AWS-API call, not an HTTP hit on the ALB — also unaffected. **DERIVED, breaks after this
  deploys:** `.claude/CLAUDE.md`'s documented manual health check,
  `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health`, is a direct external
  request to the ALB's own DNS name, bypassing CloudFront entirely — it will stop resolving from a
  human's machine once this SG is live. CloudFront already proxies `/health` to `EB-API`
  (`terraform/s3-cloudfront.tf`), so the equivalent check post-deploy is the CloudFront-fronted URL
  instead. Not fixed here (out of this ticket's scope: only `terraform/security-groups.tf` plus the
  `app.ts` hop count); flagged for the human reviewer to decide whether to update that doc.
- **Residual limitation, DERIVED, not fixable by an SG alone:** a prefix-list rule authorizes by
  *network origin*, not by *distribution identity* — any CloudFront distribution, including one an
  attacker creates in their own AWS account with this ALB's public DNS name as a custom origin,
  egresses from the same prefix-list ranges. The standard supplementary control is a shared-secret
  header the app validates, checked only against *this* distribution. Not implemented here — it is
  a defense-in-depth addition beyond this ticket's stated fix direction, not a gap this PR claims to
  close.

**What changed — the trust-proxy hop count (`api/src/app.ts`).**

`terraform/s3-cloudfront.tf` puts the ALB behind CloudFront as a custom origin (`EB-API`), so the
AWS chain is `client -> CloudFront -> ALB -> Express`: **two** reverse-proxy hops, not one.
`trust proxy 1` under-counted by one hop for that chain — verified by reading the installed
`proxy-addr`/`forwarded` packages (not by assumption): with N trusted hops, `req.ip` resolves to the
(N+1)-th `X-Forwarded-For` entry counting from the end, because each honest proxy appends exactly
one entry. At N=1, `req.ip` for legitimate CloudFront-routed traffic would resolve to CloudFront's
own edge-server IP, never the real client — a correctness bug independent of the security-group
finding, *if* AWS were live. It is not (see the follow-up above), which is why `1` is also the
correct value for the deployment that is actually live.
`app.set('trust proxy', 1)` is now `app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS))`,
which evaluates to `2` only when `TRUST_PROXY_HOPS=2` is set (as `terraform/elastic-beanstalk.tf`
now does for the AWS blueprint) and defaults to `1` everywhere else, including Render and local dev.

**DERIVED, not verified against live traffic** (no AWS credentials/apply available here): AWS's
documented behavior is that the ALB always appends the peer it directly observed to
`X-Forwarded-For` (creating the header if absent), and CloudFront always sets `X-Forwarded-For`
itself with the real viewer IP it observed for a custom origin, regardless of the origin request
policy's header allow-list. Both are load-bearing assumptions behind trusting exactly 2 hops; a
human with AWS access should confirm them post-deploy (checklist below).

**The two AWS-side changes remain paired, not independent — relevant only if that blueprint is ever
applied.** Raising the trusted hop count to 2 there is only safe *because* the ALB would be
unreachable except from CloudFront's ranges. Proven mechanically (not just asserted) by test 3
below: with N=2 and only one real proxy hop actually present — i.e. the security group *not*
enforcing this — a client's own forged `X-Forwarded-For` entry gets trusted as though it were
CloudFront's. Under N=1 (this ticket's default, and what was live before either version of this
fix), the same forged header does **not** work: the honest proxy's own append is always what N=1
selects, regardless of any decoy entries in front of it. That means the finding's literal framing
("a client reaching the ALB directly can choose `req.ip`") was **not yet true under the code as it
originally stood** (`trust proxy 1`) — it becomes true only once the hop count is raised to 2 for an
environment where the SG restriction doesn't also apply, which is exactly why the SG restriction has
to land paired with `TRUST_PROXY_HOPS=2` and not be treated as optional hardening.

**How to run it.** Regression tests live in `api/src/app.test.ts`,
`describe('TF-7: trust proxy hop count')` and `describe('resolveTrustProxyHops')`:

```bash
source .factory-env
pnpm --filter @ship/api test src/app.test.ts
```

`describe('TF-7: trust proxy hop count')` (integration, through a real Express app via supertest):

1. `recovers the real client IP through the CloudFront -> ALB chain, not an intermediate hop
   (TRUST_PROXY_HOPS=2)` — **PIN.** A synthetic 2-entry `X-Forwarded-For` (real client, then a
   CloudFront-edge stand-in) resolves to the real client with `TRUST_PROXY_HOPS=2` set. Passes
   against both the prior hard-coded-`2` commit (which ignored the env var and always behaved as 2)
   and this round's change — only the configuration mechanism moved, not this behavior.
2. `still resolves correctly when only one proxy hop is present` — **PIN**, hop-count-invariant
   (true for any N >= 1); left on the default deliberately.
3. `would trust a forged entry if a client ever reached the ALB directly (why the security-group fix
   is required) (TRUST_PROXY_HOPS=2)` — **PIN**, same reasoning as #1: characterizes an accepted,
   SG-gated risk under explicit `TRUST_PROXY_HOPS=2`, unchanged by this round.
4. `defaults to trusting exactly one hop when TRUST_PROXY_HOPS is unset — the live Render/local-dev
   topology` — **RED BEFORE this round / GREEN AFTER.** Against the prior commit (hard-coded `2`,
   no env var support), this exact assertion fails: `AssertionError: expected '192.0.2.150' to be
   '203.0.113.77'` — it walks past the honest proxy's append and lands on the client's decoy,
   reproducing the Render vulnerability the maintainer flagged. Verified by temporarily restoring
   the pre-round `app.ts` via `git show` (not by inference) and re-running this test in isolation;
   it failed with that exact assertion, not an import error.
5. `falls back to one trusted hop when TRUST_PROXY_HOPS is not a positive integer, rather than
   crashing` — **RED BEFORE / GREEN AFTER**, same mechanism, `TRUST_PROXY_HOPS=0`. Also verified to
   fail (not error) against the pre-round `app.ts`.

`describe('resolveTrustProxyHops')` (unit, the pure function directly) — 3 tests covering the full
validation matrix (unset/empty/whitespace -> 1; valid positive integers, including
whitespace-trimmed; zero/negative/non-integer/non-numeric -> 1 with a logged warning, never a
throw). **New capability, not red-before/pin** — the function did not exist before this round.

All 8 tests pass together post-fix; the full api suite (56 files / 670 tests, against `main` merged
through TF-10/TS-4 and the rest of that day's landings) passes with `scripts/factory/gate.sh
--skip-review`. One run's full-suite pass hit `session-activity-race.test.ts`'s already-documented
load-sensitive flake (lessons.md #24) under the gate's own build+typecheck CPU load; `gate.sh`
reran it standalone and it passed, confirming it, not this change.

**Verification performed here.** `terraform fmt -check` (clean) and `terraform validate` (clean
except the pre-existing, unrelated TF-5 lifecycle warning) against a temp-downloaded
**Terraform v1.9.8** (darwin_arm64; the pinned 1.6.0 cannot `init` — TF-3) with
`init -backend=false`, run against both `security-groups.tf` (unchanged this round) and
`elastic-beanstalk.tf` (this round's `TRUST_PROXY_HOPS` setting). No `plan`/`apply` — no AWS
credentials, no S3 backend access, and the hard safety rule for this ticket forbids both regardless.

**NOT verified — post-deploy human checklist.** All items below are scoped to the AWS blueprint and
apply only if a human ever runs `apply` against it, which per the maintainer is not planned. None of
them block or bear on the Render auto-deploy of `api/src/app.ts`'s change, which needs no post-deploy
verification here: the default (`TRUST_PROXY_HOPS` unset -> 1) is exactly today's live behavior.

- [ ] A direct HTTP request to the ALB (bypassing CloudFront) is refused at the network layer
      (connection refused/timeout), not merely 4xx'd by the app.
- [ ] A real request through CloudFront shows `req.ip` (log it temporarily, or check via
      `X-Forwarded-For` in application logs) equal to the actual client IP, not a CloudFront edge IP.
- [ ] Confirm CloudFront really does insert the true viewer IP into `X-Forwarded-For` for the
      `EB-API` origin regardless of `allViewerAndWhitelistCloudFront`, and that the ALB really does
      append rather than trust incoming XFF content — both assumed from AWS's published behavior,
      not observed here.
- [ ] Decide whether to update `.claude/CLAUDE.md`'s direct-EB-URL health check to the
      CloudFront-fronted `/health` path, since the direct one will stop working (TRO-294).
- [ ] **Before `apply`:** confirm the ALB security group's two new prefix-list-referencing rules
      (80 and 443, both against `com.amazonaws.global.cloudfront.origin-facing`) do not exceed the
      account's "Rules per security group" quota. AWS counts a prefix-list rule against that quota
      as though expanded to one rule per entry in the list, not as one rule — with two rules on the
      same list, this could plausibly exceed the default 60-rule quota outright. Not checked here
      (no AWS credentials/live lookup). See the caution comment above the two ingress rules in
      `terraform/security-groups.tf` and TRO-295 (High — plausible deploy blocker, not cosmetic).
- [ ] `pnpm db:migrate`/deploy itself is unaffected (no schema change here) — this is purely
      infra + one app.ts line.

**CodeRabbit triage (2 findings, both filed as new tickets per `triage.md` — neither is fixable
within this ticket's authorized scope of `terraform/security-groups.tf` + `api/src/app.ts`):**

| Finding | Disposition | Ticket |
|---|---|---|
| `.claude/CLAUDE.md`'s direct-ALB health-check URL goes stale once this ships | NEW TICKET — doc-only, out of scope here | TRO-294 (Low) |
| The two new prefix-list ALB ingress rules may exceed the AWS rules-per-security-group quota | NEW TICKET — real, but the fix needs either live AWS access or editing `elastic-beanstalk.tf`, both out of scope here | TRO-295 (High) |

**Rollback.** `git revert` this commit. By hand: in `terraform/security-groups.tf`, remove the
`cloudfront_origin_facing` data source and restore both ALB ingress rules to
`cidr_blocks = ["0.0.0.0/0"]`; in `terraform/elastic-beanstalk.tf`, remove the `TRUST_PROXY_HOPS`
setting; in `api/src/app.ts`, restore `app.set('trust proxy', 1)` and drop `resolveTrustProxyHops`.
None of this is urgent for the live site — Render is unaffected by any of it, since `app.ts`
already defaults to 1 with `TRUST_PROXY_HOPS` unset and Render's config sets no override. The AWS
pairing rule still applies if that blueprint is ever applied: `TRUST_PROXY_HOPS=2` with the ALB
security group open to `0.0.0.0/0` (i.e. reverting only the SG half) is a spoofable configuration
strictly worse than either the pre-fix state or this fix.

---

## TRO-302 — [API-8] The suspected SHA-256 rate-limiter hash was not the cause of the reported P95 regression

Linear ticket TRO-302 (API-8) asked to confirm and fix a hypothesis from the api-perf compare run
(`audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md`): that `fingerprint()`'s per-request
SHA-256 hash of the session cookie (`api/src/middleware/rate-limit.ts`) explained a +12-18% P95
regression on cheap endpoints at c=25. The compare report itself flagged this as an unverified
hypothesis, not a measurement ("not confirmed with a profiler or a rate-limiter-disabled control
run"). This ticket did that verification. **Verdict: acquitted, on three independent lines of
evidence. No production behavior changed.**

**1. Microbenchmark** (isolated, realistic 64-char session-id cookie): `crypto.createHash('sha256')`
costs **~310 ns/op**; the full `apiRateLimitKey()` path (cookie parse + hash) costs **~650 ns/op** —
about **0.008%** of a 4 ms request.

**2. Live CPU profile** (`node --cpu-prof`, this server, the compare run's own c=25 autocannon load
against `/api/weeks`, 9,000 clean 200-response requests): the server spent **>99% of wall-clock time
idle** (I/O-bound — Postgres round trips dominate, not CPU). Of the small non-idle sliver, functions
matching `fingerprint`/`Hash`/`createHash`/rate-limit accounted for **~0.15%** — smaller than the
tsx/ESM module-loading overhead left over from server startup, itself captured in the same profile.
No `express`/`pg`/`zod`/`compression`/`helmet` function registered meaningfully either.

**3. Controlled live A/B** (same running server, same c=25 autocannon load, back-to-back, on
`documents/:id` / `documents?type=wiki` / `weeks`): three configurations — (a) the real SHA-256
hash, (b) `fingerprint()` patched to a no-op slice (diagnostic only, reverted immediately via
`git checkout`, never committed), (c) **both** rate limiters removed from the chain entirely (also
diagnostic-only, reverted) — produced statistically indistinguishable P50/P97.5/P99. The difference
between any two configurations was smaller than the rep-to-rep noise of *the same unmodified
configuration measured against itself* three times in a row (e.g. `documents/:id` P97.5 ranged
13-31 ms across three consecutive reps of identical code).

**Why the original compare run saw +12-18%: most likely shared-machine measurement noise, not a
code defect.** Supporting evidence, all from artifacts that already existed or were reproduced here:

- The compare report's own recheck of `documents/:id` c=25 swung **+38.4% -> +10.4%** on
  byte-identical code and conditions, same session, minutes apart.
- A fresh, full re-benchmark run in this ticket (below) — same runner methodology, same seed
  data, same code as `main` (nothing changed) — shows P95 deltas **against the phase2-jul30
  compare's own numbers** ranging **-27.2% to +34.8%** across the 18 endpoint/concurrency
  combinations, on code that did not change between the two measurements. That range is as large
  as, or larger than, the originally-reported "regression."
- The regressions were never monotonic with concurrency (present at c10/c25, reversed at c50) and
  not consistent between P50 and P95 (P50 sometimes improved while P95 regressed) — not the
  signature of a fixed per-request CPU cost.
- The machine this ships from is a shared 14-core dev box running 6-10 sibling worktree API
  servers plus this session's own tooling throughout, exactly as both compare runs documented.

**What changed.**

- **No functional/production code changed.** `api/src/middleware/rate-limit.ts`'s `fingerprint()`
  is untouched — a doc comment was added recording this finding (so a future engineer doesn't
  re-chase the same lead; see the DB-1 precedent in this same file for why that matters).
- **Regression-guard tests only** (`api/src/middleware/__tests__/rate-limit.test.ts`, new
  `describe('TRO-302: fingerprint cost stays negligible')`), **pins, not red-before-green** — there
  is no behavior change to prove red first:
  1. `apiRateLimitKey` is synchronous and returns a plain string, not a `Promise` — guards the
     documented design decision that the key generator never verifies the session against the
     database (that would cost a round trip). An `async` key generator would be the first sign that
     decision had quietly been reversed, and would reintroduce a *real* per-request cost.
  2. 100,000 calls to `apiRateLimitKey` complete within a 3000 ms ceiling (measured ~65 ms
     unloaded — >45x headroom, deliberately generous given this suite's documented load-sensitive
     flakes, `ship-factory/references/lessons.md` rule 24). Fails only for a gross regression (a
     slow KDF, a synchronous I/O call), never for ordinary scheduler jitter.
- Full api suite after the change: **664/664 passed** (`pnpm --filter @ship/api test`), up from 662
  — the +2 are the new pins above.

**Re-benchmark — same 6 endpoints, c=10/25/50, `bench-runner-compare.mjs`'s own methodology**
(window-synchronised 900-request bursts, autocannon 8.0.0, 500/20 seed data verified byte-identical
to the compare run's own — `254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20
person / 15 project / 15 weekly_review / 6 standup / 5 program`). No code differs from `main` in
this run — the point is to check whether phase2-jul30's regressions reproduce on a fresh
measurement, not to prove a fix:

| Endpoint | c | Baseline P95 | Phase2-compare P95 (Δ vs baseline) | TRO-302 remeasure P95 (Δ vs phase2) |
|---|---|---|---|---|
| `documents?type=wiki` | 10 | 8.45 | 8.83 (+4.5%) | 9.85 (+11.6%) |
| `documents?type=wiki` | 25 | 17.33 | 20.44 (+17.9%) | 19.50 (-4.6%) |
| `documents?type=wiki` | 50 | 44.93 | 37.86 (-15.7%) | 35.69 (-5.7%) |
| `issues` | 10 | 38.78 | 26.66 (-31.3%) | 26.64 (-0.1%) |
| `issues` | 25 | 94.47 | 65.48 (-30.7%) | 62.62 (-4.4%) |
| `issues` | 50 | 182.00 | 110.26 (-39.4%) | 107.52 (-2.5%) |
| `documents` | 10 | 34.01 | 39.30 (+15.6%) | 40.55 (+3.2%) |
| `documents` | 25 | 75.75 | 85.25 (+12.5%) | 85.98 (+0.9%) |
| `documents` | 50 | 146.54 | 144.51 (-1.4%) | 154.98 (+7.2%) |
| `documents/:id` | 10 | 4.84 | 4.64 (-4.1%) | 6.26 (**+34.8%**) |
| `documents/:id` | 25 | 9.16 | 12.67 (+38.3%) | 12.79 (+0.9%) |
| `documents/:id` | 50 | 46.16 | 30.12 (-34.7%) | 38.54 (**+27.9%**) |
| `team/assignments` | 10 | 11.05 | 12.67 (+14.7%) | 10.82 (-14.6%) |
| `team/assignments` | 25 | 22.89 | 22.15 (-3.2%) | 21.41 (-3.3%) |
| `team/assignments` | 50 | 57.28 | 55.03 (-3.9%) | 45.70 (-16.9%) |
| `weeks` | 10 | 7.06 | 8.02 (+13.6%) | 6.46 (**-19.5%**) |
| `weeks` | 25 | 14.18 | 15.09 (+6.4%) | 10.99 (**-27.2%**) |
| `weeks` | 50 | 41.80 | 41.58 (-0.5%) | 36.38 (-12.5%) |

The rightmost column is the load-bearing one: it compares two measurements of **identical code**,
days apart, same machine, same methodology. If the rate limiter's hash (or anything else in the
middleware chain) were a real, fixed per-request cost, this column should hover near 0%. Instead it
ranges **-27.2% to +34.8%** — wider than the +12-18% this ticket was opened to explain.

**Verified against:** `ship-audit-pg` (postgres:15-alpine, `:5433`), `ship_wt_tro_302`, query
logging off (`log_statement=none`, `log_min_duration_statement=-1`), `NODE_ENV=development` (no
`E2E_TEST` override) for the re-benchmark, matching the compare run's own documented conditions.
Background load average 3.2-6.5 across 14 cores throughout, 10 sibling worktree API dev servers
present (idle), consistent with both prior measurement sessions.

**Not verified.** No profiler/A/B run against production-mode (`NODE_ENV=production`) limits — the
key-generation code path is identical regardless of `NODE_ENV`, so this is not expected to matter,
but it was not measured directly. No repeated (n>3) statistical re-run of the full 18-combination
sweep — a single fresh re-measurement is what's reported, deliberately not smoothed into a
multi-run average, so the noise is visible rather than hidden.

**Rollback.** Nothing to roll back functionally — `git revert` on this branch removes only the doc
comment and the two new pin tests.

---

## TRO-209 — [TS-4] 236 non-null assertions on request auth context, all from one optional declaration

`api/src/middleware/auth.ts:11-12` augmented Express's `Request` with `userId?: string` /
`workspaceId?: string` — optional, so every authenticated handler re-asserted `req.userId!` /
`req.workspaceId!`: **236** occurrences across 21 route files. Worse than hygiene: a route
registered *without* `authMiddleware` type-checked identically to one wired up correctly, so a
middleware-ordering mistake would send `undefined` into a query as a user/workspace id rather than
failing to compile.

**What changed — types only, no runtime-behavior change.**

- **`api/src/middleware/auth.ts` (new exports)** — `AuthenticatedRequest` (extends `Request`,
  `userId`/`workspaceId` required `string`), and `authed(handler)`, a wrapper that narrows a plain
  `Request` handler to one whose auth fields are guaranteed present. Register it **after**
  `authMiddleware` (directly, or behind a `router.use(authMiddleware, …)`); `authed()` does not
  authenticate the request itself. Internally it uses a type-guard function
  (`req is AuthenticatedRequest`), not a cast — no `as` of any kind appears in the new code.
  Both `sessions.workspace_id` (`schema.sql`) and `api_tokens.workspace_id`
  (`migrations/014_api_tokens.sql`) are `NOT NULL` columns, and `authMiddleware` always sets both
  fields together before calling `next()` (the API-token branch, the session-cookie branch) — so on
  every currently-registered route the guard inside `authed()` never rejects a real request; it
  exists only so a *future* route wired up without `authMiddleware` fails closed (401) instead of
  silently forwarding `undefined`. Observable behavior for every existing route is unchanged; this
  is stated rather than assumed because the escalation gate on auth changes requires it, and it was
  verified two ways (see Regression tests, runtime pin).
- **21 route files** (`accountability`, `activity`, `admin-credentials`, `admin`, `ai`,
  `api-tokens`, `auth`, `backlinks`, `comments`, `dashboard`, `documents`, `issues`, `iterations`,
  `programs`, `projects`, `search`, `standups`, `team`, `weekly-plans`, `weeks`, `workspaces`) —
  every handler that used to assert `req.userId!`/`req.workspaceId!` is now wrapped in `authed(...)`,
  with the `!` removed and the handler's `req`/`res` parameter types left to contextual inference
  (an explicit `req: Request` annotation on a wrapped handler would silently defeat the narrowing).
  Mechanical, AST-driven change (TypeScript compiler API located every `req.userId!`/`req.workspaceId!`
  node and its enclosing handler; only that handler's wrapping/annotations were touched) — no
  drive-by refactors. 4 test files that fully replace (`vi.mock`) `../middleware/auth.js` needed a
  matching `authed: (handler: unknown) => handler` passthrough added to their mock, since their fake
  `authMiddleware` already sets both fields before `next()` the same way the real one does.

**Regression tests (`api/src/**/*.test.ts`, run by the gate).**

1. **Compile-time** (`api/src/__tests__/auth.test.ts`, new `describe` blocks) — `expectTypeOf`
   proves `AuthenticatedRequest['userId']`/`['workspaceId']` are `string`, and that a handler passed
   to `authed()` receives them already narrowed. A third case pins a `@ts-expect-error` on
   `const userId: string = req.userId` inside a plain (unwrapped) handler. Verified red for the
   right reason: temporarily deleting that suppression comment and running
   `pnpm --filter @ship/api type-check` fails with `TS2322: Type 'string | undefined' is not
   assignable to type 'string'` at that exact line; restoring the comment returns it to clean. (No
   prior version of `authed()` exists to regress against — it's a new type, not a bug fix to an
   existing one — so this direct compile-error demonstration is the red/green proof.)
2. **Runtime, `authed()` itself** (same file) — invokes the wrapped handler when
   `userId`/`workspaceId` are present, and returns 401 without calling the handler when they are
   missing (the defense-in-depth backstop, unreachable on any current route per above).
3. **Runtime pin, a real route** (`api/src/routes/auth.test.ts`) — `POST /api/auth/extend-session`
   is one of the wrapped handlers. Added `should reject extend-session without a session` (401,
   new); the existing, unmodified `should extend session expiry` test already covers the 200 case.
   Both pass after wrapping, pinning that `authed()` changed nothing observable on a real endpoint.

**Measurement.** The audit's own methodology (`audit/AUDIT_REPORT.md`, TS-4 / Type Safety
Methodology section) defines **three different counts** here, and they move very differently — the
gap matters and is reported rather than smoothed over:

| Metric | Command | Before (`main` @ `42e60d9`) | After |
|---|---|---|---|
| `req.userId!` / `req.workspaceId!` occurrences | `grep -rEn 'req\.(userId\|workspaceId)!' api/src` | **236** | **0** |
| Corrected non-null, `api` (audit's own de-bugged pattern) | `grep -rEn '[a-zA-Z0-9_)]]?!(\.\|\[\|\)\|,\|;\|\s*$)' api` | 286 | **53** |
| Tracked non-null, `api` (`count.sh`'s pattern, the one the 1535-total/384-target is defined on) | `bash ~/.claude/skills/type-safety-audit/scripts/count.sh api` | 42 | **42 (unchanged)** |

All three commands were run with `/usr/bin/grep` explicitly (or via `bash script.sh`, which resolves
`grep` the same way) — the audit's own methodology warns that pasting these into an interactive zsh
resolves `grep` to a `ugrep` shim that parses bracket expressions differently and returns wrong
numbers for the bracket-heavy patterns; confirmed directly (`echo 'req.userId!;' | grep -E
'<tracked-pattern>'` matches under the zsh shim, does not match under real `/usr/bin/grep`).

**The corrected-count delta is -233, not -236**, because 3 of the 236 fixed lines
(`issues.ts:1171,1684,1912`) also contain an unrelated, pre-existing `id!` assertion earlier on the
same line (`logDocumentChange(id!, ...)`), and both the tracked and corrected patterns count
*matching lines*, not occurrences — those 3 lines still match after `req.userId!` is removed, for a
reason this ticket doesn't touch.

**The tracked count is unchanged, and this contradicts the audit's own improvement-plan table and
this ticket's brief — both should be corrected.** The audit's Methodology section documents that
BSD grep's bracket expression in the tracked `non_null_assertions` pattern
(`[a-zA-Z0-9_\)\]]!(\.|\[|\)|,|;|\s*$)`) treats the escaped `)`/`]` inside `[...]` literally, closing
the class early so the pattern effectively requires a literal `]` immediately before `!` — meaning
`req.userId!`/`req.workspaceId!` (no `]` before the `!`) were **never counted by the tracked
pattern in the first place**, before this fix touched them. The audit's own recommended-improvement
table lists "TS-4 | 236" as violations retired toward the 1535-total/384-target, and this ticket's
brief inherited that framing ("TS-1 + TS-4 alone clear the 384-site bar") — both are describing the
*corrected*-metric significance of TS-4 (which the finding's own prose does: "82% of api's 288
corrected non-null assertions") as if it were the *tracked* metric the target is literally defined
on. Measured directly: it is not. This ticket retires all 236 real occurrences and closes the
authz-scoping compile-time hole described in the finding — that result stands — but it moves the
audit's literal 1535/384 tracked-total arithmetic by zero.

A live re-run of `count.sh` across `web api shared` on `main` @ `42e60d9` (i.e., with TS-1/TS-2/TS-3/
TS-6 already merged, before this fix) gives a tracked total of **1747** (60 `any` + 1639 `as` + 47
non-null-tracked + 1 ts-ignore) — *higher* than the audit's original 1535 baseline, because ~30+
unrelated tickets merged since the audit snapshot (confirmed independently by TRO-206/TS-1's own
CHANGES.md entry, which found the same drift reproducing *its* command: 102 baseline errors became
156). This means a live "current total vs. 1535" snapshot cannot cleanly demonstrate the category's
cumulative progress — unrelated development moves it in both directions — so each ticket's
contribution has to be read from its own controlled before/after diff. This ticket's diff, read that
way: 236 real assertions retired (occurrence-exact), 0 movement on the metric the 384 target is
literally defined on, `explicit_any`/`as_any` unchanged (36/128, `api`), and `as_assertions` moved
1107 → 1112 (`api`, +5) — verified by diffing the *content* of every newly-matching line (not just
the line-number-prefixed text, which shifts when unrelated lines above are inserted): all 5 are
comment/test-description prose ("as its own type", "as a required string", …), the same
over-count class the audit's own methodology documents (~15-20% of raw `as` hits are imports/
comments), not real type assertions — `git diff` for `\bas any\b|: any\b|as unknown as` is empty.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api type-check
pnpm --filter @ship/api exec vitest run \
  src/__tests__/auth.test.ts \
  src/routes/auth.test.ts
pnpm test   # full api suite
```

**Rollback.** Revert the commits on `fix/ts-4-nonnull-auth-context`. `authed`/`AuthenticatedRequest`
are additive exports in `api/src/middleware/auth.ts`; reverting the 21 route files and the 4 test
mocks alongside them fully restores the pre-fix `req.userId!`/`req.workspaceId!` state. No schema,
migration, or middleware-ordering change accompanies this fix, so rollback is signature-only.

---

## TRO-183 (DB-6) + TRO-184 (DB-7) + TRO-185 (DB-8) + TRO-187 (DB-10) — the query planner was starved of indexes and honest estimates

Four findings, one root cause: the planner either had no index to use, or had one and could not
see enough to pick it. All four are measured against the audit's seeded volume (500 documents / 20
users / 813 `document_associations` rows, `postgres:15-alpine` on the `ship-audit-pg:5433` Docker
container, via `pnpm db:seed` + `audit/seed-augment.ts`) unless stated otherwise.

**TRO-183 / DB-6 — `GET /api/weeks` collapsed 3 correlated subqueries into 1 indexed lookup.**

`api/src/routes/weeks.ts` computed `has_retro` / `retro_outcome` / `retro_id` (and four more
duplicate blocks at the single-sprint GET, the two PATCH re-queries, and the start-sprint
re-query — five identical occurrences total) with three separate correlated subqueries against
`document_associations`, all sharing the join `related_id = d.id AND relationship_type = 'sprint'`.
Two of the three (`retro_outcome`, `retro_id`) used `LIMIT 1`, and confirmed by EXPLAIN: that LIMIT
made the planner favor a zero-startup-cost `Seq Scan` over the existing
`idx_document_associations_related_type` index — `Rows Removed by Filter: 803`, twice, on every
row, `loops=5` — even though the third subquery (`has_retro`, no `LIMIT`) used that same index
correctly via a `Bitmap Heap Scan`.

**Fix.** All five occurrences now compute all three fields from one `LEFT JOIN LATERAL`, using
`MAX()` instead of `LIMIT 1`. This is deliberate, not cosmetic: an aggregate has to see every
matching row regardless of how many there are, so its cost model prefers the index the same way
`has_retro`'s aggregate always did — a plain `LIMIT 1` rewrite (tried first) removed the duplicate
scan but still picked `Seq Scan` for the same startup-cost reason as before. `MAX(rt.id::text)::uuid`
is required because Postgres has no built-in `MAX(uuid)` aggregate. Correctness rests on a
uniqueness invariant enforced elsewhere in this file (`POST /:id/review` returns 409 if a
`weekly_review` already exists for a sprint), so at most one row can ever match — `MAX()` over
0-or-1 rows is exactly `LIMIT 1`'s result.

**Before/after (EXPLAIN ANALYZE, BUFFERS, sprint_number=14, this workspace's 5 matching sprints):**

| | before | after |
|---|---|---|
| Buffers | 1181 shared hit | 749 shared hit (-36.6%) |
| SubPlans | 8 correlated, `loops=5` each | 5 (retro folded into the main join tree, not a SubPlan) |
| `document_associations` seq scans for retro | 2 (`Rows Removed by Filter: 803` each) | 0 |
| retro access path | `Seq Scan` | `Bitmap Heap Scan` via `idx_document_associations_related_type` |

Note for whoever re-measures this: the augmented seed data has **zero** documents matching the
`outcome IS NOT NULL` predicate at all — `outcome` is written nowhere in the current codebase
(only ever read), so `has_retro` is always `false` today. The buffer savings above are real and
independent of that (Postgres still has to scan for a match whether or not one exists), but the
regression tests below had to insert a synthetic matching row by hand to exercise the "found a
retro" branch at all.

**TRO-184 / DB-7 — no index on `documents.ticket_number`; issue permalinks seq-scanned the whole table.**

`GET /api/issues/by-ticket/:number` (`issues.ts`, `WHERE d.ticket_number = $1 AND d.workspace_id =
$2 AND d.document_type = 'issue'`) had no supporting index, so every lookup scanned the full
workspace regardless of issue count.

**Fix.** Migration `038_documents_ticket_number_index.sql` adds
`idx_documents_ticket_number ON documents (workspace_id, ticket_number) WHERE document_type =
'issue'` — a partial index matching the route's exact predicate.

**Before/after (EXPLAIN ANALYZE, BUFFERS, `ticket_number = 16`, 5 matching rows in this seed):**

| | before | after |
|---|---|---|
| Plan | `Seq Scan` | `Index Scan using idx_documents_ticket_number` |
| Buffers | 66 shared hit | 5 hit + 1 read |
| Rows removed by filter | 495 | 0 |

**TRO-185 / DB-8 — the association batch's `= ANY($1)` misestimated cardinality by 28x.**

`getBelongsToAssociationsBatch` (`api/src/utils/document-crud.ts`, called from `issues.ts`'s list
route) filtered `document_associations` with `da.document_id = ANY($1)`. Postgres cannot see an
array parameter's length at plan time, so it falls back to a fixed low-selectivity guess: measured
at `rows=25` estimated vs `rows=707` actual (this workspace's full 254-issue batch) — a 28x
underestimate — which left `idx_document_associations_document_id` unused in favor of a sequential
scan. The batch itself is correct design (it is what keeps `/api/issues` at a handful of queries
instead of one per issue) — the fix had to keep it, not remove it.

**Both candidates in DB-8's own wording were measured, not guessed:**

- `unnest($1::uuid[]) JOIN` — rejected. Postgres defaults a `Function Scan` on an unnested array to
  a flat `rows=10` estimate regardless of the array's real length, so the misestimate is not fixed
  at all (still `rows=10` vs `rows=707`), and in this measurement it also flipped a downstream join
  from `Hash Join` to a per-row `Nested Loop` + `Index Scan`, raising buffers to 2146 (vs 91 before).
- `JOIN (VALUES ...)` — adopted. A `VALUES` list gives the planner the batch's literal size, so the
  estimate becomes accurate: `rows=635` vs `707` actual (1.1x, down from 28x). At a realistic page
  size (20 ids, matching the opt-in `limit` PR #19/TRO-173 added), buffers fell **90 -> 59 (-34%)**.
  At this workspace's full 254-id batch (an edge case — nearly every issue in one call), the more
  accurate estimate led the planner to a `Nested Loop` + `Memoize`-cached `Index Scan` for the
  `documents` join instead of hashing the whole table once, which cost more buffers in that one
  scenario (91 -> 155) despite fixing the estimate DB-8 is actually about. Recorded here rather
  than hidden: the realistic-page-size case is the one this batch runs at in practice.

Implementation builds the `VALUES` list as `$1::uuid, $2::uuid, ...` — one bind parameter per id,
never interpolated — and de-dupes the input array first, since a repeated id in a `VALUES` join
would (unlike `= ANY`, a set-membership test) multiply output rows.

**TRO-187 / DB-10 — no index on `documents.updated_at` despite `ORDER BY updated_at DESC` in seven route modules.**

`issues.ts`, `documents.ts`, `weeks.ts`, `projects.ts`, `programs.ts`, `dashboard.ts` and
`search.ts` all sort by `updated_at DESC` with no supporting index — invisible at 500 rows (an
unsupported quicksort costs microseconds) but exactly what makes `LIMIT` cheap once a list route
paginates. That sequencing is no longer hypothetical: **API-2/DB-5's opt-in pagination merged as
PR #19** (`limit`/`offset` on `GET /api/issues`, no default limit, verified via `gh pr view 19`),
so this index now has an actual consumer, not just a future one.

**Fix.** Migration `039_documents_updated_at_index.sql` adds
`idx_documents_workspace_updated_at ON documents (workspace_id, updated_at DESC)`.

**Before/after** (representative query: `WHERE workspace_id = $1 AND archived_at IS NULL AND
deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`; "before" reproduced in the same session via
`SET enable_indexscan/enable_bitmapscan = off` rather than dropping the index):

| | before | after |
|---|---|---|
| Plan | `Seq Scan` + top-N heapsort | `Index Scan using idx_documents_workspace_updated_at` |
| Buffers | 69 shared hit | 4 hit + 2 read |

**Regression tests.**

- **`api/src/db/__tests__/db-6-7-8-10-indexes.test.ts`** (DB-7, DB-10) — index-existence, genuinely
  red-before-green: builds a throwaway database, copies every real migration file *except*
  038/039 into a fixture directory, applies it, and asserts both indexes are absent — then applies
  the real (full) migrations directory on the same database and asserts both exist with the
  expected definition (`workspace_id`, `ticket_number`/`updated_at DESC`, and the partial index's
  `document_type = 'issue'` predicate). Confirmed red first: the first `it()` failed
  (`idx_documents_ticket_number` / `idx_documents_workspace_updated_at` both `undefined`) before
  038/039 existed.
- **`api/src/routes/weeks-retro-lookup.test.ts`** (DB-6) — NOT red-before-green; behavior must not
  change, so this pins it. Runs the pre-TRO-183 3-subquery SQL and the new `LATERAL` SQL side by
  side against the same seeded sprint and asserts identical results, for both a sprint with a
  synthetic matching `weekly_review` (`outcome` set, associated via `relationship_type = 'sprint'`)
  and one without (the common case in real data today).
- **`api/src/utils/__tests__/document-crud.test.ts`** (DB-8) — also a pin, not red-before-green.
  Runs the pre-TRO-183 `= ANY($1)` query and the new `VALUES`-join function side by side across a
  document with two associations, one with one, and one with zero, plus a duplicate-id input case
  (proving the de-dupe keeps `= ANY`'s set-membership semantics), and asserts identical `Map`
  contents.
- **Full `api` suite** (`pnpm --filter @ship/api test`, against the worktree's own database):
  48 files / 609 tests, all green, including the pre-existing 46 `weeks.test.ts` and 27
  `issues.test.ts` cases unchanged by this branch.
- **Plan-shape assertion for DB-7 (EXPLAIN showing `Index Scan`), judged too brittle to automate:**
  each api test file's `beforeAll` truncates `documents` and this file's own tests insert only a
  handful of rows before running — a table that small will correctly get a `Seq Scan` regardless of
  the partial index (small-table cost, not a planner bug), so an `EXPLAIN`-based assertion in the
  gate's own environment would be flaky-to-false rather than a real signal. The captured
  EXPLAIN ANALYZE evidence above (at the audit's 500-row seed) is the evidence of record instead.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec vitest run \
  src/db/__tests__/db-6-7-8-10-indexes.test.ts \
  src/routes/weeks-retro-lookup.test.ts \
  src/utils/__tests__/document-crud.test.ts \
  src/routes/weeks.test.ts \
  src/routes/issues.test.ts
```

**Rollback.** Revert the two migrations (both pure additions — `DROP INDEX
idx_documents_ticket_number` / `DROP INDEX idx_documents_workspace_updated_at`, no data changes,
safe to drop anytime) and revert the `weeks.ts` / `document-crud.ts` query changes. No schema
changes to existing columns, no backfill, nothing to undo beyond the two `CREATE INDEX` statements
and the query text.

---

## TRO-207 (TS-2) — the database-to-HTTP response path is no longer implicitly `any`

`@types/pg`'s `query()` defaults its row generic to `any`, and in `api/src` production code
essentially no call site supplied it — so every `.rows` access was implicitly `any` all the way
into the HTTP response. A column rename or a `properties->>'x'` typo would produce `undefined` in a
live API response with zero compile-time signal anywhere in the chain. The only translation layer
between raw rows and the JSON contract the frontend consumes was seven hand-written mappers, all
declared `(row: any)`.

**Verified before touching anything:** the audit's "seven `(row: any)` mappers" claim was accurate
for six; `issues.ts`'s `extractIssueFromRow` had already been typed by an earlier ticket. That fix
was structurally inert, though — none of that file's ~59 `pool.query()` call sites supplied a
generic, so an `any`-typed row satisfied the mapper's typed parameter silently at every call site
(assigning `any` to a typed parameter is always allowed). The real gap wasn't the mapper signature,
it was the query call sites feeding it.

**What changed** — `api/src/routes/{feedback,programs,projects,issues,weeks}.ts`:

- All seven mappers now take a real row interface instead of `any`: `extractProjectFromRow` /
  `extractSprintFromRow` (`projects.ts`), `extractIssueFromRow` (`issues.ts`, parameter now actually
  enforced), `extractProgramFromRow` (`programs.ts`), `extractFeedbackFromRow` (`feedback.ts`),
  `extractSprintFromRow` / `formatStandupResponse` (`weeks.ts`).
- `pool.query<Row>(...)` / `client.query<Row>(...)` added across the five files: **154 call sites**
  newly typed (1 was already typed, in `issues.ts`; 155 of 225 call sites in these files now carry
  an explicit generic). The remaining 70 are bare DML (`INSERT`/`UPDATE`/`DELETE` with no
  `RETURNING`) or transaction control (`BEGIN`/`COMMIT`/`ROLLBACK`) where no `.rows` field is ever
  read downstream — typing the generic there would add nothing, since `.rowCount`'s type doesn't
  depend on it.
- Row interfaces are local to each file (or reuse `api/src/routes/rowTypes.ts`, new — a small shared
  `DocumentRow` plus `document_type`-narrowed variants whose `properties` field is typed against the
  matching `@ship/shared` type: `ProjectProperties`, `IssueProperties`, `ProgramProperties`,
  `WeekProperties`). Verified against `api/src/db/schema.sql` and each query's actual `SELECT` list,
  not guessed. Two facts checked empirically against this project's own Postgres rather than
  assumed: `DATE`/`TIMESTAMP`/`TIMESTAMPTZ` columns come back as real JS `Date` objects, and
  `COUNT(*)`/`SUM(...)` aggregates come back as `string` (bigint/numeric are stringified to avoid
  precision loss) — both now modeled honestly instead of falling through `any`.
- Downstream callbacks fixed: the `.filter((i: any) => ...)` issue-rollup blocks in `projects.ts` —
  **6 sites, not the audit's stated 4** (two identical three-filter blocks, verified by re-counting
  rather than trusting the cited number), plus a 7th, untagged occurrence of the same defect
  (`!['done','cancelled'].includes(i.state)` with no `any` annotation at all, inside
  `generatePrefilledRetroContent`) found and fixed in the same pass. Two more `.filter((i: any) =>
  ...)` in `weeks.ts`'s `/my-week` grouping, plus several `values: any[]` / `params: any[]`
  query-parameter arrays across all five files, now typed to their real unions.
- A handful of `: any` in TipTap-content-building helpers (`generatePrefilledRetroContent` in
  `projects.ts`, `generatePrefilledReviewContent` in `weeks.ts`) were deliberately left — modeling
  TipTap's node structure is finding TS-3, out of this ticket's scope.

**Two narrow, behavior-preserving side effects of typing honestly, not scope creep:**

- Several `row.x === true || row.x === 't'` defensive checks (`has_plan`, `has_retro` in
  `programs.ts`/`weeks.ts`) simplified to `row.x`: once the column is honestly typed `boolean` (SQL
  `CASE WHEN...THEN true ELSE false END` / `COUNT(*) > 0` always return a real JS boolean, never the
  string `'t'`), the `'t'` branch is a compile error (no overlap between `boolean` and a string
  literal) — verified unreachable, not just assumed.
- Two new `client.query('ROLLBACK')` calls in `issues.ts`'s `POST /` (paired with `noUncheckedIndexedAccess`
  guards on `ticketResult`/`createdRow`, which could not previously be written as `!` under G7b).
  Before this fix, an undefined row here would throw and be caught by the route's own `catch`
  block, which already calls `ROLLBACK` and releases the client — so the observable behavior
  (500 response, rolled-back transaction, released connection) is identical; the path is just
  explicit now instead of relying on an uncaught-property-read exception.

**Remainder — explicitly out of scope, for a follow-up ticket:** ~559 bare `pool.query(`/
`client.query(` call sites remain untyped elsewhere in `api/src` (down from ~710), covering routes
outside `projects`/`issues`/`programs`/`weeks`/`feedback` (e.g. `workspaces.ts`, `documents.ts`,
`team.ts`, `dashboard.ts`, `standups.ts`, `admin.ts`, `weekly-plans.ts`, `claude.ts`). None were
touched here per the orchestrator's scope decision.

**How to run it.** `pnpm --filter @ship/api exec tsc --noEmit -p tsconfig.json` (or `pnpm
type-check`) and `pnpm --filter @ship/api test`.

**Measurement (cheap tier — `type-safety-audit`'s counting method, BSD grep, same patterns as
`audit/type-safety/baseline.md`):**

| Metric | Before | After |
|---|---|---|
| `(row\|r): any` mapper signatures | 6 (of 7 — 1 already fixed but inert) | **0** |
| Typed `pool/client.query<...>` call sites, 5 touched files | 1 | **155** (of 225) |
| `pool/client/db.query(` untyped, whole `api/src` prod | 710 | 559 |
| `pool/client/db.query<` typed, whole `api/src` prod | 3 | 157 (158 raw — 1 is the grep matching the phrase "`pool.query<T>(...)`" inside `rowTypes.ts`'s own doc comment, not code) |
| `.rows` accesses, whole `api/src` prod | 771 | 711 |
| `explicit_any` (`count.sh`), whole `api` package | 76 | **55** |
| `as_any`, whole `api` package | 128 | 128 (unchanged — none added, none removed) |
| non-null assertions (tracked pattern), whole `api` package | 42 | 42 (unchanged — none added) |

`as_assertions` moved 1059 → 1086 (+27); verified by grepping the diff's added lines that every one
of those is inside a comment/docstring or an `AS <alias>` SQL clause quoted in a comment (e.g. "COUNT(*)
subqueries — node-postgres returns bigint aggregates **as** strings"), not a real type assertion —
consistent with the baseline's own documented ~15-20% over-count on this pattern.

**Rollback.** Revert the five route files and delete `api/src/routes/rowTypes.ts` and
`api/src/routes/rowTypes.test.ts`. No schema or migration changes; no behavior changes beyond the
two narrow cases documented above.

---

## TRO-289 (ERR-13) — PersonEditor saved title/properties with no error handling at all

**Confirmed against the code, not just the ticket.** `web/src/pages/PersonEditor.tsx` saved the
title (via `useAutoSave`'s `onSave`) and every sidebar property change (`onUpdateProperties`) with a
bare `await apiPatch(...)` — no `.ok` check, no thrown error, no `.status`, no `useMutation`, and no
tag into the write-outcome bus `web/src/hooks/useDocumentWriteStatus.ts` (TRO-190/ERR-3) already
drives every OTHER document type's `SyncStatusIndicator` from. A rejected or throttled person-document
write vanished with zero observable effect: no console error, no toast, no change to the "Saved"
indicator, and (for `onUpdateProperties`) the local optimistic state update happened unconditionally,
even on failure, since nothing ever checked the response.

**What changed.** `web/src/pages/PersonEditor.tsx` gains one `useMutation` (`updatePersonMutation`),
built exactly like `UnifiedDocumentPage.tsx`'s real `updateMutation`:

- `mutationFn` throws an `Error & { status: number }` on a non-ok response (`error.status =
  response.status`), so the shared retry policy (`shouldRetryRequest`/`retryDelayMs` in
  `queryClient.ts`) can back a throttled 429 off on its tuned schedule instead of dropping it, and so
  `isNotFoundError` can tell a 404 apart from any other failure.
- `meta: { operation: 'update person', documentId: id }` tags it into the same document-write-outcome
  bus every other document type's mutation already reports through — no new bus, no new subscriber;
  `Editor.tsx`'s existing `useDocumentWriteStatus(documentId, ...)` call picks it up unchanged and
  flips this document's own `SyncStatusIndicator` to "Not saved" (and raises the existing one-shot
  "document was deleted" notice on a 404), because `PersonEditorPage` already renders through the
  same shared `Editor` (`LazyEditor`).
- The title save (`throttledTitleSave`'s `onSave`) and the property save (`onUpdateProperties`) both
  call `updatePersonMutation.mutateAsync(...)` instead of the bare `apiPatch`. `onUpdateProperties`
  now applies its local optimistic state update only after the write actually succeeds — it is a
  fire-and-forget event handler (`PersonCombobox`'s `onChange` doesn't await it), so the catch also
  swallows the rejection there rather than letting it escape as an unhandled rejection; failure is
  still visible via the shared indicator.

**Regression tests — `web/src/pages/PersonEditor.test.tsx`** (vitest, run by the gate). Renders the
real `PersonEditorPage` against the app's actual `queryClient` singleton (mocking only the
`@/lib/api` network boundary and the lightweight `useAuth`/`useDocuments`/`useWorkspace` context
hooks), paired with a second, independent `useDocumentWriteStatus` subscriber on the SAME
`queryClient` — the same "drive real mutations, don't cast mutation-cache internals" technique
`useDocumentWriteStatus.test.tsx` uses (see commit 9510f8e). Five cases:

1. A successful property save leaves `hasFailedWrite` false.
2. A rejected (400) property save flips `hasFailedWrite` true.
3. A rejected (400) title save (the `useAutoSave`-throttled path) also flips `hasFailedWrite` true.
4. A 404 property save calls the shared `onDocumentGone` notice exactly once, reusing the ERR-4
   deletion notice rather than inventing a second one.
5. A 429 property save is retried on the throttle schedule (`THROTTLE_RETRY_DELAYS_MS`, first retry
   at ≥2s) rather than the generic ~1s exponential schedule any other retryable error gets — confirmed
   under `vi.useFakeTimers()` by asserting no second attempt lands by 1.5s, then that one has by 3s.

Confirmed red first, for the right reason: reverting `PersonEditor.tsx` to its pre-fix version and
re-running this same test file failed 4 of 5 cases with real `AssertionError`s (`hasFailedWrite`
stayed `false`, `onGone` was called 0 times, the 429 case never issued a second `apiPatch` call at
all because there was no mutation/retry policy in play) — not an import error or a typo.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/PersonEditor.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/err-13-err-14-editor-save-paths` touching
`PersonEditor.tsx`. `queryClient.ts` and `UnifiedDocumentPage.tsx` are unaffected by this ticket's
half of the branch (see TRO-290 below).

---

## TRO-290 (ERR-14) — a window-focus refetch on a deleted document unmounted the editor and discarded in-progress text

**Reproduced first, as directed — this is the headline claim.** Wrote a jsdom test rendering the
real `UnifiedDocumentPage` route against the app's actual `queryClient` singleton (so `staleTime` and
the default retry policy are exactly production's, not a relaxed test client), loaded a `wiki`
document successfully, marked the `['document', id]` query stale via `queryClient.invalidateQueries({
refetchType: 'none' })` (stale, but no auto-refetch yet — isolates the trigger), then dispatched a
real `window.dispatchEvent(new Event('visibilitychange'))` — the exact event
`@tanstack/query-core`'s `focusManager` listens for. React-query's own focus-refetch machinery fired
a second fetch, mocked to return 404 (another user deleted the document). **Observed:** the second
`apiGet` call landed, and the mocked editor (`data-testid="editor-mounted"`, holding text standing in
for an in-progress, unsaved draft) disappeared from the DOM, replaced by the "Document not found"
screen. This is REPRODUCED, not derived — the failure was watched happening, not inferred from
reading the code.

**Root cause.** `web/src/pages/UnifiedDocumentPage.tsx`'s top-level `useQuery(['document', id])`
never overrode `refetchOnWindowFocus`, so it gets react-query's default background refetch on window
focus. React-query does not clear cached `data` just because a later background fetch failed — `data`
stays the last good snapshot while `error` becomes set. The render, though, checked
`if (error || !document)` — truthy `error` alone was enough to bail into the "not found" screen,
regardless of whether `document` still held a perfectly good, cached copy — unmounting the entire
editor tree and destroying whatever local (Yjs/TipTap/title) state it held.

**What changed — preferred fix from the ticket: one deletion story, not two.**

- The query's `queryFn` now attaches `.status` to its thrown error (same pattern as ERR-3/ERR-4's
  write-path fix), so a 404 can be told apart from any other fetch failure.
- `web/src/lib/queryClient.ts` gains `notifyDocumentGoneOnRead(documentId)`, a thin wrapper around the
  existing (private) `notifyDocumentWriteOutcome` — the READ-path counterpart to the write-outcome
  bus TRO-190/ERR-3 built. No new bus, no new subscriber.
- `UnifiedDocumentPage.tsx` adds one effect: when a background refetch's `error` is a 404
  (`isNotFoundError`) while `document` (cached data) still exists, it calls
  `notifyDocumentGoneOnRead(id)` — routing the read-path deletion through the exact same bus and
  user-facing notice (`Editor.tsx`'s `alert(DOCUMENT_GONE_MESSAGE)`) ERR-4 already gives a failed
  *write* against a deleted document. `useDocumentWriteStatus`'s existing one-shot guard keeps the
  alert to a single firing even if the query keeps re-attempting the failed refetch.
- The render's error branch changed from `if (error || !document)` to `if (!document)` — a background
  refetch failure (404 or otherwise) no longer unmounts the editor as long as a cached document
  exists; a hard failure on the very first load (no cached data at all) still shows the "not found"
  screen exactly as before.

**Regression tests — `web/src/pages/UnifiedDocumentPage.deletedFocusRefetch.test.tsx`** (vitest, run
by the gate). Same real-`queryClient` / real-focus-event technique as the reproduction above:

1. After the focus-triggered 404, the editor stays mounted with its original in-progress text intact,
   the shared bus's `onGone` fires exactly once and `hasFailedWrite` becomes true, and the doc is
   fetched exactly twice (no retry storm, no repeated notice).
2. A hard 404 with no cached document at all (first load) still shows "Document not found" — the
   existing behavior for that case is unchanged.

Confirmed red first, for the right reason: reverting `UnifiedDocumentPage.tsx` to its pre-fix version
and re-running case 1 failed with `expected "vi.fn()" to be called 1 times, but got 0 times` (the
notice never fired) and the DOM showing "Document not found" — exactly the reproduced bug, not an
import error.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/pages/UnifiedDocumentPage.deletedFocusRefetch.test.tsx
```

**Rollback.** Revert the commit(s) on `fix/err-13-err-14-editor-save-paths` touching
`UnifiedDocumentPage.tsx` and the `notifyDocumentGoneOnRead` addition in `queryClient.ts`.
`PersonEditor.tsx` (TRO-289 above) is unaffected.

---

## TRO-219 (A11Y-5) + TRO-220 (A11Y-6) + TRO-221 (A11Y-7) — page-shell landmark and heading structure

Three findings, one shared root cause per the assignment: missing landmark/heading structure in the
page shells. Each turned out to need a different fix once actually diagnosed.

**A11Y-5 was mis-filed as a landmark bug on two working pages. It is not: `/search` and `/weeks` are
not routes.** The finding assumed real pages missing `<main>`/`<h1>`. Checking
`audit/error-handling/raw/probe1b-routes.json` first (as the ticket required) showed both routes with
`bodyTextLength: 0` - byte-for-byte identical to `/this-route-does-not-exist`, which was included in
that probe specifically because it's guaranteed not to exist. `web/src/main.tsx` had no
`path="/search"` or `path="/weeks"` entry, and there is no `SearchPage`/`WeeksPage` anywhere in
`web/src/pages/` - `/api/weeks` and `/api/search/mentions` are backend endpoints the audit's route
list conflated with frontend pages. `AppRoutes`'s `<Routes>` had no wildcard fallback, so an unmatched
path under `/` didn't match the parent `<Route path="/">` either and the whole tree rendered nothing -
not a page missing a landmark, a routing gap with no landmark, heading, or content of any kind.
Papering `<main>` around that emptiness would have been decoration; a real catch-all is the fix that
also happens to clear the axe rules the finding named.

**What changed - A11Y-5.**

- `web/src/pages/NotFound.tsx` (new) - a real "Page not found" view with its own `<h1>` and a link
  back to `/docs`. It does *not* render its own `<main>`: every route nested under `AppLayout` already
  gets one for free (`pages/App.tsx:542`), and a second `<main>` would be a duplicate landmark - its
  own axe violation.
- `web/src/main.tsx` - added `<Route path="*" element={<NotFoundPage />} />` as the last child of the
  same `<Route path="/">` that renders `<AppLayout />`, lazy-loaded like every other page (BUN-1
  convention). Placement matters: as a sibling of `dashboard`, `my-week`, etc., it inherits
  `AppLayout`'s persistent `<main>` instead of needing its own.

**A11Y-6: the skip is page chrome, not user-authored TipTap content.** A document view's only
page-level heading is the title `<h1>` (`Editor.tsx:888`). `WikiSidebar` renders nothing but
`<label>` property rows and `BacklinksPanel`, whose "Backlinks" header was an `<h3>` with no `<h2>`
anywhere in the chrome - an h1 -> h3 skip, reproduced on a real seeded wiki document with zero body
headings (`audit/a11y/axe/document_view.json`: `heading-order` targeting `h3`; re-confirmed live
against this worktree's own dev server with the same result). Because it reproduces with no user
content at all, this cannot be a TipTap-authored skip, so the fix does not touch the editor's Heading
extension or constrain what levels a user can type into their own document - only the chrome.
`web/src/components/sidebars/PropertiesPanel.tsx`'s `WeeklyDocumentSidebar` had the identical pattern
(an `<h3>` "Weekly Plan"/"Weekly Retro" header with no `<h2>` above it) for weekly_plan/weekly_retro
documents - same root cause, different document type, fixed alongside it.

**What changed - A11Y-6.**

- `web/src/components/editor/BacklinksPanel.tsx` - all three "Backlinks" headers (loading/error/loaded
  states) promoted from `<h3>` to `<h2>`, the first real section heading under the page's single
  `<h1>`.
- `web/src/components/sidebars/PropertiesPanel.tsx` - `WeeklyDocumentSidebar`'s "Weekly Plan"/"Weekly
  Retro" header promoted the same way, and the function is now exported (was module-private) so its
  own regression test can render it without also mocking `useAuth`/`useWorkspace`, which the exported
  `PropertiesPanel` wrapper calls unconditionally regardless of document type.

**A11Y-7: straightforward - wrap the form in `<main>`.** The entire login page (logo, form, dev-hint)
sat in a plain `<div>` with no landmark anywhere on the page. axe reported `landmark-one-main` and
`region` (five separate un-landmarked blocks, including both form field wrappers) -
`audit/a11y/axe/login_unauth.json`. `web/src/pages/Login.tsx`'s single wrapping `<div
className="w-full max-w-[360px]">` is now a `<main>` with the same class - no visual change, since
Tailwind classes fully control the box's appearance and `<main>`/`<div>` carry no differing default
styles.

**Process note the ticket also asked about.** The repo's e2e a11y specs (`e2e/accessibility.spec.ts`)
filter every assertion to `expect(violations.filter(v => v.impact === 'critical' || v.impact ===
'serious')).toHaveLength(0)` - Moderate violations (all three of these rules) pass those specs by
construction, which is exactly how A11Y-5/6/7 went unnoticed by CI. This PR does **not** tighten that
filter - live-measured before/after below (Serious+ column) shows it would stay green on `/search`,
`/weeks`, and `/login` after this fix, but `document view` already carried a pre-existing Serious
`color-contrast` finding unrelated to this ticket (see below), so tightening the filter repo-wide is a
separate decision for a human, not a side effect of this PR.

**Regression tests** (`web/src/**/*.test.tsx`, run by `pnpm --filter @ship/web test`, the tier the
gate actually executes):

- `web/src/pages/NotFound.test.tsx` - renders an `<h1>`, offers a link back to `/docs`, and does
  *not* render its own `<main>`.
- `web/src/main.routes.test.ts` (extended) - pins the catch-all as a lazy-loaded sibling route inside
  the `AppLayout`-wrapping `<Route path="/">`, not a bare top-level route.
- `web/src/components/editor/BacklinksPanel.test.tsx` - asserts the "Backlinks" heading is `h2` in
  both the loading and loaded states.
- `web/src/components/sidebars/PropertiesPanel.test.tsx` - asserts `WeeklyDocumentSidebar`'s header is
  `h2` for both weekly_plan and weekly_retro.
- `web/src/pages/Login.test.tsx` - asserts the sign-in form, both inputs, and the submit button are
  all reachable inside a single `<main>`.

Every test above was confirmed red first (against the pre-fix markup, restored via file copies -
never `git stash`, per this project's standing rule) for the reason claimed - missing `<main>`/`h1`,
or the wrong heading level - then green after the fix, with no other change to the assertion.

**Measurement (a11y DoD).** axe-core 4.11.0 via `@axe-core/playwright`, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, Chromium 1217 headless, 1440x900, against this
worktree's own dev servers (`web :5995`, `api :3822`, seeded fresh), authenticated as `dev@ship.local`
except where noted. The seeded user's "Action Items" modal auto-opens on every navigation and was
dismissed after each one before scanning - an earlier pass here that dismissed it only once (right
after login) produced a false-clean reading on the document view, because the modal was still
covering the page for that scan; re-scanning with the modal dismissed on every navigation reproduced
the real `heading-order` violation and is what these numbers reflect.

| Page / state | Before (C/S/M/m, rules) | After (C/S/M/m, rules) |
|---|---|---|
| `/login` (unauthenticated) | 0/0/2/0 - `landmark-one-main`, `region` | 0/0/0/0 |
| `/search` | 0/0/2/0 - `landmark-one-main`, `page-has-heading-one` | 0/1/0/0 - `color-contrast` (see below) |
| `/weeks` | 0/0/2/0 - `landmark-one-main`, `page-has-heading-one` | 0/1/0/0 - `color-contrast` (see below) |
| document view (seeded wiki doc) | 0/0/1/0 - `heading-order` | 0/0/0/0 |

All four of the named axe rules (`landmark-one-main`, `page-has-heading-one`, `heading-order`,
`region`) clear. `/login` and document view are fully clean after the fix.

**New, honestly-reported: `/search` and `/weeks` now surface a pre-existing Serious `color-contrast`
finding that was never reachable before.** Before this fix those two URLs rendered nothing at all, so
they trivially had zero violations of every kind, not just the two landmark/heading ones. Once
`AppLayout` actually mounts there (via the new catch-all), they inherit the same 4-panel chrome every
other authenticated page uses - and `getActiveMode()` (`pages/App.tsx`) has no match for `/search` or
`/weeks`, so it falls through to its `'dashboard'` default, highlighting the "My Work" nav item in
`DashboardSidebar.tsx:36` (and a second item at line 51) with `bg-accent/10 text-accent` - `accent`
(#005ea2) is a *fill* color, documented in `web/tailwind.config.js` as only 2.89:1 as text, the exact
A11Y-3/TRO-217 failure mode. This exact element is never flagged on the real `/my-week` page only
because that one page hides its whole contextual sidebar (`hideLeftSidebar` in `pages/App.tsx`) for
unrelated layout reasons - the defect was always there, just never visible. This is pre-existing
chrome, not something this PR added, and swapping its color token is a visible change to unrelated,
already-shipped UI - out of a landmark/heading ticket's scope per this project's "no visual redesign;
escalate a visible fix" rule, so it is reported here rather than fixed. Recommend a follow-up finding
(`DashboardSidebar.tsx:36,51`, same class as A11Y-3) rather than silently expanding this PR.
`NotFoundPage.tsx`'s own new "Go to Documents" link had the identical mistake (`text-accent` copied
from `UnifiedDocumentPage.tsx`'s existing, equally-affected "Go to Documents" button) and *was* fixed
here, since it's this PR's own new code: swapped to `text-accent-text` (6.08:1), the token this
codebase already defines for accent-colored text.

**Unverified.** Everything above is DOM/axe evidence (observed) or code-read (derived and marked as
such). No claim is made about what a screen reader announces; VoiceOver verification of the new
`<main>`/`<h1>` structure is owed to a human, per this project's standing rule that only a human
listening can confirm announcement behavior.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/pages/NotFound.test.tsx \
  src/main.routes.test.ts \
  src/components/editor/BacklinksPanel.test.tsx \
  src/components/sidebars/PropertiesPanel.test.tsx \
  src/pages/Login.test.tsx
scripts/factory/gate.sh
```

**Rollback.** Revert the commit(s) on `fix/a11y-5-6-7-landmarks`. The three fixes are independent:
reverting `web/src/main.tsx`'s catch-all route and deleting `NotFound.tsx` undoes A11Y-5 alone;
reverting the two heading-level changes undoes A11Y-6 alone; reverting `Login.tsx`'s `<main>` undoes
A11Y-7 alone.

---

## TRO-211 (TS-6) — a real ESLint config; `pnpm lint` stops being a silent no-op

**Before, observed by running it.** `pnpm lint` printed `None of the selected packages has a
"lint" script` and exited 0 — no `.eslintrc*` or `eslint.config.*` existed anywhere outside
`node_modules`, and none of `api`, `web`, `shared` defined a `lint` script for root's
`pnpm --recursive run lint` to dispatch to. `.github/workflows/ci.yml` did not call `pnpm lint` at
all; a comment there said explicitly to wire it in "when TRO-211 lands."

**What changed.**

- Added `eslint.config.mjs` at the repo root: ESLint 9.39.5 flat config + `typescript-eslint`
  8.65.0, covering `api/src`, `web/src`, `shared/src` only — not `e2e/`, not config/script files
  (`web/tsconfig.node.json` / build-script coverage is the separate, still-open TS-9).
- Added `"lint": "eslint src"` to `api/package.json`, `web/package.json`, `shared/package.json`.
  Root's `"lint": "pnpm --recursive run lint"` needed no change — it was already the right
  dispatcher, just dispatching to nothing.
- Wired a `Lint` step into `.github/workflows/ci.yml`'s `verify` job, right after `Type check` and
  before `Build all packages`.

**Ruleset — ERROR vs WARN, and why, with baseline counts** (`api` / `web` / `shared`, before any
fix):

| Rule | Severity | Baseline (api/web/shared) | Why |
|---|---|---|---|
| `eqeqeq` (`always`, `{null:'ignore'}`) | **error** | 4 / 2 / 0 → **0 / 0 / 0** | All 6 raw hits were the `== null` / `!= null` idiom (e.g. `api/src/collaboration/index.ts:330`, `web/src/components/ActionItems.tsx:67`). Forcing `=== null` would exclude `undefined` and change behavior — that is a bug, not a fix. Configured ESLint's standard exception instead of touching code; every other `==`/`!=` is still an error. |
| `no-fallthrough` | **error** | 0 / 0 / 0 | Passes clean today (tsc's `noFallthroughCasesInSwitch` already covers most of this; ESLint is belt-and-suspenders, catches cases tsc's flag doesn't). |
| `@typescript-eslint/no-floating-promises` | **warn** | 4 / 209 / 0 (213 total) | Real correctness bugs, but far past "few (<~15) and mechanical" — mostly React event handlers across `web/src/pages/*.tsx`. 4 of the api sites are inside `api/src/collaboration/index.ts`, which `ship-backend`'s own brief flags as a stop-for-human zone with a documented history of async-ordering bugs (ERR-1/ERR-2/ERR-10/ERR-11/ERR-12). Fixing those under a lint-config ticket is exactly the drive-by this ticket was told not to do — follow-up ticket material. |
| `@typescript-eslint/no-misused-promises` | **warn** | 5 / 180 / 0 (185 total) | Same call, same reasoning. |
| `@typescript-eslint/no-explicit-any` | warn | 209 / 31 / 0 (240 total) | Per orchestrator scope: the audit's counted, open finding (TS-1/TS-2/TS-8), already being burned down by dedicated tickets and blocked from growing by G7b. Not this ticket's job to fix. |
| `@typescript-eslint/no-non-null-assertion` | warn | 295 / 33 / 0 (328 total) | Same call — the counted, open TS-4 class. |

**Result.** `pnpm lint` now exits **0** with **0 errors, 966 warnings** (513 api + 453 web + 0
shared) — a real check that passes today, not a vacuous one.

**How to run it.**
```bash
pnpm lint                     # all three packages (what CI runs)
pnpm --filter @ship/api lint  # single package
```

**Demonstrated the gate actually gates (not committed).** Appended a scratch function to
`web/src/lib/api.ts` with `if (a == 1) { ... }`, ran `pnpm --filter @ship/web lint`: exit **1**,
`eqeqeq` error reported (`454 problems (1 error, 453 warnings)`). Reverted with
`git checkout -- web/src/lib/api.ts`; re-ran: exit 0, back to 453 warnings, 0 errors.

**Not fixed here — follow-up.** `no-floating-promises` (213 sites) and `no-misused-promises` (185
sites) at warn, counts above. Two safe, mechanical-looking candidates outside the hazard file:
`api/src/db/migrate.ts:58` and `api/src/db/seed.ts:1259` both call an async `main()`/`seed()` at
top level with no `.catch`. The four sites inside `api/src/collaboration/index.ts` should go
through the same review weight as ERR-1/ERR-2, not a mechanical batch fix.

**Rollback.** Delete `eslint.config.mjs`; remove the `lint` script from `api/package.json`,
`web/package.json`, `shared/package.json`; remove the `eslint`/`typescript-eslint` root
devDependencies; remove the `Lint` step from `ci.yml`.

---

## TRO-203 (BUN-7) + TRO-204 (BUN-8) — an unused dependency and a duplicated Radix version leave the tree

Two Low-severity dependency-hygiene findings, one root cause (drift between what
`web/package.json` declares and what pnpm actually resolves), fixed on one branch.

**BUN-7 — `@tanstack/query-sync-storage-persister` was declared and never used.** Re-verified
against current code, not the audit snapshot, because the ticket flagged `web/src/lib/queryClient.ts`
as recently touched by TRO-190/ERR-3: it imports only the **types** `PersistedClient`/`Persister`
from `@tanstack/react-query-persist-client` and implements its own IndexedDB persister with
`idb-keyval` — it never reaches the sync-storage package. `grep -rE "from
'@tanstack/query-sync-storage-persister" web/src --include="*.ts" --include="*.tsx"` returns 0,
matching the audit exactly. Removed from `web/package.json` `dependencies`; `pnpm install`
re-resolved it out of `pnpm-lock.yaml`. 0 shipped-byte change, as predicted — it was never in any
emitted chunk to begin with.

**BUN-8 — `@radix-ui/react-primitive` and `@radix-ui/react-slot` each resolved to two versions.**
Cause, confirmed by reading both packages' own `package.json`s out of the pnpm store: `cmdk@1.1.1`
declares `"@radix-ui/react-primitive": "^2.0.2"` (a caret range), which pnpm resolves to the newest
match — 2.1.4, pulling in `react-slot@1.2.4` — while `@radix-ui/react-dialog`/`-popover`/`-tooltip`
each pin the **exact** older `2.1.3`/`1.2.3` internally. Neither side is a range pnpm can widen on
its own, so both trees shipped. Fixed with a `pnpm.overrides` entry in the root `package.json`
(with an explanatory `"// overrides (BUN-8 / TRO-204)"` comment key beside it, since a real override
key can't hold prose) forcing every consumer onto the newer pair. Converging *up* rather than down
to 2.1.3/1.2.3 was checked, not assumed: diffing the built `dist/index.mjs` for both version pairs
shows `react-primitive`'s logic is byte-identical between 2.1.3 and 2.1.4, and `react-slot` 1.2.4
only *adds* `React.lazy`-child support over 1.2.3 — a strict superset, not a behaviour change.

**Where the audit's own location claim no longer holds on this branch.** BUN-8 was measured against
the pre-BUN-1..6 tree, where the whole app was one entry chunk, so "both copies land in the entry
chunk" was true then. After TRO-197..202 shipped route/vendor splitting, `web/vite.config.ts`'s
`manualChunks` deliberately leaves Radix/cmdk/dnd-kit out of any vendor group (grouping them was
measured to cost 15 kB gzip on `/docs` and `/documents/:id`, because a route needing one primitive
then downloaded all of them), so Rollup's default splitting places them. Today the duplicate bytes
sit in a lazily-loaded **shared** chunk (`assets/index-CmtDBcUa.js` in this build, reached from
`Editor.tsx`, `App.tsx`, `Documents.tsx` and the document-tab components) — not the true entry chunk
`index.html` references. `/login`'s initial payload is therefore untouched by this fix; only `/docs`
and `/documents/:id` shrink, and only once (it's one physical file), not per route.

**Measured**: `pnpm build:web` from the repo root, `node audit/bundle/measure.mjs`, gzip level 9,
kB = 1000 bytes, Node v23.2.0, pnpm 10.27.0 — this branch vs. `main`@`9a15f43` built in an isolated
`git worktree add --detach` copy (never stashed):

| | Before | After | Change |
|---|---:|---:|---:|
| Total dist (raw / gzip) | 3,365.80 / 1,771.39 kB | 3,364.02 / 1,771.31 kB | −1.78 kB raw / −0.08 kB gzip |
| `/login` initial payload (gzip) | 117.49 kB | 117.47 kB | −0.02 kB |
| `/docs` route closure (gzip) | 182.07 kB | 181.98 kB | −0.09 kB |
| `/documents/:id` route closure (gzip) | 211.72 kB | 211.63 kB | −0.09 kB |

Matches the audit's own estimate (~2.1 kB raw / <1 kB gzip) in order of magnitude — this was always
a hygiene fix, not a payload fix, and is reported as one.

**Duplicate-gone proof**: `pnpm why @radix-ui/react-primitive --recursive` and `pnpm why
@radix-ui/react-slot --recursive` (repo root) show a single resolved version — `2.1.4` and `1.2.4`
respectively — on every path, including through `cmdk`. Parsing `pnpm-lock.yaml`'s `packages:` block
for all 25 `@radix-ui/*` entries confirms zero remaining duplicates (down from the 2 named above).

**Regression guard** (BUN-8 has one; BUN-7 removing an unimported package needs no behavioural test):
`web/src/lib/radixVersionDedupe.test.ts` (new) reads the real `pnpm-lock.yaml` and asserts every
`@radix-ui/*` package resolves to exactly one version — scoped to that family, not a blanket claim
about the whole tree, since other packages legitimately carry two majors. Confirmed it fails for the
right reason: run against a copy of the pre-fix lockfile it reports `@radix-ui/react-primitive
resolved to 2 version(s) (2.1.3, 2.1.4)` and the same for `react-slot` (1.2.3, 1.2.4), then passes
clean once the fixed lockfile is restored. Runs inside `pnpm --filter @ship/web test`, which the
factory gate executes.

**Verified nothing broke**: `pnpm install`, `pnpm --filter @ship/web test` (38 files / 390 tests),
`pnpm test` (api: 46 files / 604 tests), `pnpm build` (shared + api + web), `pnpm run type-check` —
all green.

**Rollback**: revert the two `package.json` edits — restore the
`"@tanstack/query-sync-storage-persister": "^5.90.18"` line to `web/package.json`'s `dependencies`,
delete the `"pnpm"."overrides"` block from the root `package.json` — then `pnpm install` to
regenerate `pnpm-lock.yaml`. Delete `web/src/lib/radixVersionDedupe.test.ts`.

---

## TRO-218 (A11Y-4) + TRO-222 (A11Y-8) — /issues Radix popovers open unnamed, and the selection column header is empty

Both are the last two accessibility gaps on /issues, the improvement target for Category 7
(all Critical/Serious axe violations fixed on the 3 most important pages). A11Y-4 was the last
open Serious; A11Y-8 the remaining Minor.

**What was broken — A11Y-4.** axe's "issues menu open" scan reported a Serious `aria-dialog-name`
violation: `<div data-state="open" role="dialog" id="radix-:rj:" class="z-50 w-[var(--radix-...">`
(`audit/a11y/axe/issues_menu_expanded_state.json`). Radix's `Popover.Content` defaults to
`role="dialog"` (`@radix-ui/react-popover` dist/index.mjs:243) with no name unless one is supplied.
`web/src/components/ui/Combobox.tsx:68` (the `Popover.Content` this class string belongs to) never
passed `aria-label`/`aria-labelledby`, so the popover the axe scan actually opened — the "Filter
issues by program" combobox, confirmed by inspecting the live DOM after the click — announced only
as an unnamed dialog.

**The mechanism is a shared wrapper, not a one-off.** `Combobox` is consumed by
`IssuesList.tsx` (program/project/sprint filters), `DocumentListToolbar.tsx` (the sort dropdown —
itself reused by `/issues`, `/projects`, `/programs`, and `/documents`), `IssueSidebar.tsx`
(assignee, week pickers), and `WeekSidebar.tsx` (owner picker). Fixing the one component clears the
unnamed-dialog defect on all of those surfaces. Every existing call site already passes
`aria-label` (verified: `grep -n "<Combobox" -A 12` across all 5 consumer files), so this is a
complete fix in practice; the fallback below is defense for any future caller that omits it.

A second, separate `Popover.Content` on the same page — the "Customize columns" picker inline in
`DocumentListToolbar.tsx:147` — is not the `Combobox` wrapper and had the identical defect
independently (its own unnamed Radix dialog). It shares the same page and the same missing-name
mechanism, so it is fixed alongside rather than left as a second unnamed dialog on /issues.

**What changed — A11Y-4.**
- `web/src/components/ui/Combobox.tsx:69` — `Popover.Content` now gets
  `aria-label={ariaLabel || placeholder}`, naming the dialog from the caller's label (or, if a
  future caller omits it, the always-present placeholder text) instead of leaving it unnamed.
- `web/src/components/DocumentListToolbar.tsx:148` — the column-picker's own `Popover.Content`
  gets `aria-label="Customize columns"`, matching its trigger button's existing label.

**What was broken — A11Y-8.** The same scan reported a Minor `empty-table-header` violation:
`<th class="w-10 px-2 py-2" aria-label="Selection"></th>` (same JSON file). The `<th>` already
carried `aria-label="Selection"` — but axe's `empty-table-header` rule checks only the
`has-visible-text` alternative (axe-core 4.11.1 `axe.js`: `{ id: 'empty-table-header', any:
['has-visible-text'] }` — no `aria-label`/`aria-labelledby` fallback, unlike most other
name-required rules in the same file). That check's evaluator (`hasTextContentEvaluate` →
`subtree_text_default`) walks the element's rendered subtree text; an `aria-label` attribute never
populates it. The header needed actual (visually-hidden) text content, not just an ARIA attribute.

**What changed — A11Y-8.** `web/src/components/SelectableList.tsx:134` — the selection column
`<th>` now wraps a `<span className="sr-only">Select</span>` instead of carrying only
`aria-label="Selection"`. `sr-only` is the repo's existing visually-hidden utility class (already
used nearby, in this same file's selection announcer at line ~192).

**Evidence.** Both measured on this branch, same conditions: worktree ports (`.factory-env`,
API `:3413` / web `:5586`), seeded via `pnpm db:seed` (104 issues), authenticated as
`dev@ship.local` via a fresh `session_id` obtained through `/api/csrf-token` + `/api/auth/login`,
axe-core 4.11.1 via `@axe-core/playwright`, Chromium (Playwright 1.57.0's bundled build), scanning
`/issues` static and after clicking the first `button[aria-haspopup], [aria-expanded]` control
(the same selector `audit/a11y/axe-scan.mjs` uses for its "issues menu/expanded state"). "Before"
was measured by copying the three fixed files aside, `git checkout --` reverting them to `HEAD`,
scanning, then restoring the copies — never `git stash` (this repo's shared-stash hazard, see
`lessons.md`).

| Measurement — /issues | Before | After |
|---|---|---|
| static: all severities | C0 S0 M0 **m1** | C0 S0 M0 **m0** |
| static: `empty-table-header` | 1 node (`th[aria-label="Selection"]`) | absent |
| menu open: all severities | C0 **S1** M0 **m1** | C0 S0 M0 m0 |
| menu open: `aria-dialog-name` | **Serious**, 1 node | absent |
| menu open: `empty-table-header` | Minor, 1 node | absent |

**Regression tests.**
- `web/src/components/ui/Combobox.test.tsx` — renders the real `Combobox`, opens the popover, and
  asserts the `role="dialog"` element has an accessible name (one test with an explicit
  `aria-label`, one exercising the placeholder fallback). Needed two jsdom environment shims
  (`ResizeObserver`, `Element.prototype.scrollIntoView`) that `cmdk` requires and jsdom doesn't
  implement — same class of shim as `EmojiPicker.test.tsx`'s `IntersectionObserver` stub, not a
  stub of the component under test. Confirmed red first: before the fix, both tests failed with
  `Error: expect(element).toHaveAccessibleName() — Received: ""` — not an environment error (the
  shims were already in place at that point) or an import failure.
- `web/src/components/SelectableList.test.tsx` — renders `SelectableList` with `selectable` and
  asserts the selection `<th>`'s `textContent` is non-empty, deliberately checking subtree text
  rather than accessible name so the test fails for the same reason axe's rule does. Confirmed red
  first: `AssertionError: expected '' not to be ''`.

**How to run it.**

```bash
pnpm --filter @ship/web test -- src/components/ui/Combobox.test.tsx src/components/SelectableList.test.tsx
pnpm --filter @ship/web exec tsc --noEmit
```

To re-measure against a browser: start the worktree's API and Vite, log in for a fresh
`session_id` (via `/api/csrf-token` then `/api/auth/login`), open `/issues`, run an axe scan, then
click the program-filter (or sort, or column-picker) button and scan again.

**Roll back.** Revert the three `aria-label`/`sr-only` additions (`git revert` the commit on
`fix/a11y-4-8-issues-page`), or drop them individually — `Combobox.tsx:69`,
`DocumentListToolbar.tsx:148`, `SelectableList.tsx:134-138`. The regression tests fail immediately
if any of them come back unnamed/empty.

**Not established.** What a screen reader actually announces for either fix — this closes the axe
contract violations (a name exists, and discernible text exists), but no human ran VoiceOver
against either surface. The repo's three Playwright a11y specs were not re-run here (not executed
by the factory gate; they also only assert `impact === 'critical'`, and both these findings were
already below that threshold, so they would not have caught either one regardless).

---

## TRO-193 (ERR-6) / TRO-227 (TEST-5) — Abandoning a pending inline comment now always removes its highlight mark

Starting a comment via the bubble menu or `Cmd+Shift+M` sets a `commentMark` — a TipTap **Mark**,
i.e. persisted, Yjs-synced document content (`web/src/components/editor/CommentMark.ts:69`), not a
decoration — before any comment row exists. Only an explicit `unsetComment` call removes it. Before
this fix, the *only* path that ever called `unsetComment` was the pending input's own `keydown`
handler seeing `Escape` with the input itself as `event.target`
(`CommentDisplay.tsx`'s `handleDOMEvents.keydown`, previously ~line 322) — which requires the input
to already hold focus. It is focused in a `requestAnimationFrame` scheduled after the widget mounts
(`CommentDisplay.tsx:259-263`).

**Two confirmed mechanisms, one root cause (unset-on-abandon had no owner):**

- **ERR-6 — blur / click away had no handler at all**, not a race. Grepping
  `CommentDisplay.tsx`/`Editor.tsx` for any blur, click-outside, or `focusout` handling around the
  pending comment found none. `audit/error-handling/raw/probe8-comment-orphan-blur.json` confirms
  this end-to-end: the mark is written into persisted content with **0** backing comment rows and
  survives a reload.
- **TEST-5 — Escape genuinely races the auto-focus `requestAnimationFrame`.** Confirmed, not just
  hypothesized: `e2e/inline-comments.spec.ts:118` failed both attempts in 2 of 3 audit runs
  (`audit/test-quality/runs/e2e-run1-failures.txt`, `-run3-failures.txt`) with the highlight still
  present after `page.keyboard.press('Escape')`, which sends the key to whatever currently has
  focus — not to the not-yet-focused pending input.

**The fix.** Rather than patch each dismissal path separately, `CommentDisplay.tsx`'s
`commentDisplay` ProseMirror plugin gets a `view()` lifecycle that is the single owner of the
"abandon a pending comment" invariant: document-level capture-phase listeners for `keydown`
(Escape) and `mousedown` (outside click), plus a `focusout` listener for a real blur/Tab-away, all
gated only on `storage.pendingCommentId` — never on the event's target or on whether focus has
reached the input. A `destroy()` callback abandons any still-pending comment when the editor itself
goes away (component unmount, or a route change that recreates the editor for a different
document). Submitted comments are tracked (`onSubmitComment` marks the id before clearing
`pendingCommentId`), so `onCancelComment` is a no-op for a comment that was actually created —
the invariant is "a mark may only remain if its comment was created," in both directions. The
Escape branch in `handleDOMEvents.keydown` was removed as dead/duplicate code now that the
document-level listener supersedes it; Enter-to-submit is unchanged.

**Provenance on route-change/unmount:** verified, not just reasoned about. `Editor.destroy()` ->
`EditorView.destroy()` calls `destroyPluginViews()` (which invokes our `destroy()`) *before* it nulls
`docView`, so `editor.commands.unsetComment(...)` still dispatches correctly from inside that
callback (confirmed empirically — see the regression test below, not just read from
`prosemirror-view`'s source).

**Regression tests — `web/src/components/editor/CommentDisplay.test.ts`** (new, vitest, driving a
real `@tiptap/core` `Editor` with the real `CommentMark` + `CommentDisplayExtension`, same pattern as
`DetailsExtension.test.ts`/`MentionExtension.test.ts`):

1. Blur/outside-click (`mousedown` outside the widget) dismissal leaves no `commentMark` in the doc
   JSON (ERR-6).
2. A genuine `focusout` on the pending input itself, to something outside the widget, also leaves no
   mark — exercised directly rather than assuming `mousedown` coverage implies it (see CodeRabbit
   triage below).
3. Escape dispatched with focus still on `document.body` — the pending input rendered via a forced
   decorations recompute but its `requestAnimationFrame` focus callback deliberately never flushed —
   leaves no mark (TEST-5's exact race, reproduced without fake timers by simply never yielding to
   let the rAF run).
4. A normally-submitted comment keeps its mark, including through a subsequent outside click/Escape
   (the "don't strip a real comment" half of the invariant).
5. Bonus: destroying the editor while a comment is still pending (route change/unmount) also
   removes the mark.

**Red before green.** All of 1/3/5 failed against the pre-fix `CommentDisplay.tsx` (copied aside via
`git show HEAD:...`, never `git stash`) with `AssertionError: expected true to be false` on
`hasCommentMark(editor)` — the exact behavior claimed, not an import error or a crash. Case 4 (happy
path) passed both before and after, confirming it was never broken and isn't a false positive. Case 2
was added afterward (see below) and verified red by temporarily disabling only the `focusout`
listener registration — that one test failed while the other four stayed green, confirming it
exercises that listener specifically rather than being redundant with the `mousedown` case. All five
pass against the fix.

**CodeRabbit review (G9), triaged:**

- **Major, applied** — a real click-away fires both the capture-phase `mousedown` and (as its native
  consequence) a `focusout` on the pending input before `storage.pendingCommentId` round-trips back
  to `null` via the React state update that clears it, so both listeners could call
  `onCancelComment` for the same id. Added an `abandonedPendingId` guard so it fires exactly once per
  pending comment — harmless today given `unsetComment`'s idempotency, but a real sharp edge for any
  future non-idempotent `onCancelComment`.
- **Minor, applied (corrected)** — added test case 2 above for direct `focusout` coverage. The
  suggested diff dispatched the event on `editor.view.dom`, which does not satisfy
  `isInsidePendingWidget(event.target)` and would not have exercised the intended branch; dispatched
  on the pending input itself instead, and verified it actually reds when that listener is disabled.
- **Minor, applied** — the "click elsewhere" test target is a plain `div`, not a `button` (no
  interactive semantics needed for an arbitrary outside-click target).
- **Minor, applied** — the e2e reload assertion now waits for the actual persisted text to reappear
  before asserting the highlight is gone, and asserts a DOM count of `0` rather than
  `not.toBeVisible()` (see e2e section below).

**e2e:** `e2e/inline-comments.spec.ts:118` (`canceling a comment removes the highlight`) already
asserted the right thing (`.comment-highlight` not visible after Escape) and needed no strengthening.
Added `dismissing a comment by clicking away removes the highlight` for ERR-6, which had zero e2e
coverage before, including a reload check matching probe8's persistence finding — waits for the
actual persisted text to reappear before asserting the highlight is gone (not just the editor shell
being visible, which could pass vacuously while content is still loading), and asserts a DOM count of
`0` rather than `not.toBeVisible()` (CodeRabbit finding, applied). Not executed as part of this
change — no prebuilt `api`/`web` `dist` exists in this worktree, so `e2e/global-setup.ts` would
trigger a full fresh build of both packages; the jsdom unit tests above already give real
red-before-green proof of both mechanisms, so that cost wasn't justified here.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run src/components/editor/CommentDisplay.test.ts
pnpm --filter @ship/web exec tsc --noEmit -p tsconfig.json
```

**Rollback.** `git checkout main -- web/src/components/editor/CommentDisplay.tsx
e2e/inline-comments.spec.ts && git rm web/src/components/editor/CommentDisplay.test.ts` and drop
this entry. No schema or API change accompanies this fix.

---

## TRO-247 — [RULE-6] One-command local start from a clean checkout

**What changed.** `./start.sh` at the repo root: from a genuinely clean checkout, one command
installs dependencies if needed, ensures the database exists, runs every migration, seeds sample
data, finds free ports, starts both servers, and prints the resolved URLs. Re-running it is safe —
every step is idempotent, so a second run heals a partially-set-up checkout instead of assuming
yesterday's state still holds.

`start.sh` is a thin preflight (Node/pnpm on PATH, with actionable install instructions if not) that
hands off to `scripts/dev.sh`, which now does the actual database bootstrap unconditionally (not
only when `api/.env.local` is missing, as before) and is also what `pnpm dev` runs — one
implementation, not two that can drift apart.

`scripts/dev.sh` previously shelled out to `psql`/`createdb` to create the database, which are
absent on any machine that only runs Postgres via Docker with the port published to the host (this
project's own factory machine is one — `ship-audit-pg` on `:5433`). New `api/src/db/ensureDatabase.ts`
replaces that with a plain `pg` connection to the server's `postgres` maintenance database, which
works identically over TCP for a native install or a Docker container — no shell dependency either
way, and it fails with an actionable message ("start it, then re-run — here's the native command and
the Docker command") when Postgres is unreachable at all, rather than a bare `createdb` error.

New `api/src/db/verifyMigrations.ts` makes the DB-1 (TRO-178) fix's "42/42 applied" claim an
executed check rather than a trusted exit code: it reuses `migrationRunner.ts`'s own
`listMigrationFiles()` — the exact file discovery the fixed runner uses — and compares it against
`schema_migrations`, printing `Migrations: 42/42 applied` or failing loudly, naming the missing
files, if the runner's guarantee is ever violated. `migrate.ts`/`migrationRunner.ts` themselves are
unchanged; DB-1's fix (throw-on-any-failure) was independently re-confirmed live in this tree by
running `migrationRunner.test.ts`'s real-migration-set suite against a throwaway database (7/7
passing) rather than only re-reading the code.

DATABASE_URL resolution (documented in `scripts/dev.sh`'s header): an explicit `DATABASE_URL` env var
always wins; otherwise an existing `api/.env.local` keeps its own value (a plain re-run never
silently switches databases under a configured worktree); otherwise the same default as before
(`postgresql://localhost/$DB_NAME`, native Postgres, no password). The README's new "Cold start"
section documents both bundled Docker Postgres options (`docker-compose.yml` on :5432,
`docker-compose.local.yml` on :5433) with the exact `DATABASE_URL` override for each.

README also corrects one stale claim while updating this: the fork banner's hazard list still
described root `pnpm test` as silently skipping `web/` (TEST-1). That was already fixed by TRO-223
(PR #11, `pnpm run test:api && pnpm run test:web`) — the banner text already said "resolved" in one
place but the "Getting Started" section had not been reconciled with `start.sh`. Both now describe
current behavior only.

**Regression tests.** `api/src/db/__tests__/ensureDatabase.test.ts` (9 cases: identifier validation,
create-when-missing, idempotent no-op, and the actionable unreachable-Postgres message — confirmed
red-before-green by temporarily removing the `CREATE DATABASE` call and observing the exact two
tests fail for the right reason) and `api/src/db/__tests__/verifyMigrations.test.ts` (2 cases: a
fully-migrated database reports N/N, and a DB-1-shaped gap — a `schema_migrations` row deleted out
from under an otherwise-complete database — is detected and named). No `!`, `as any`, or fixed
sleeps anywhere in the diff; the one bounded wait (Postgres connection) uses a `connectionTimeoutMillis`
on the client, not a sleep.

**How to run it.** `./start.sh` from a clean checkout. To target Docker Postgres instead of a native
install: `docker compose -f docker-compose.local.yml up -d postgres && DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_dev ./start.sh`.
A throwaway database name works the same way: `DATABASE_URL=.../a_new_name ./start.sh`.

**Rollback.** Revert the merge of `fix/rule-6-one-command-start`. `scripts/dev.sh` reverts to only
bootstrapping the database when `api/.env.local` is absent, and back to requiring `psql`/`createdb`
on PATH; `pnpm dev`/`pnpm db:migrate`/`pnpm db:seed` are unaffected as standalone commands either way.

---

## TRO-248 — [RULE-7] Retries, timeouts and circuit breakers on outbound calls

Assignment rule 7 asks for an assessment of every outbound-call boundary in the ticket's table,
not just a pile of new retry code — several rows had already been addressed by other merged
tickets since the table was written, and re-verifying that against current code is itself part of
the deliverable.

**Row-by-row verdicts (current code, re-checked, not taken from the ticket text):**

1. **`api/src/db/client.ts:24` `connectionTimeoutMillis: 2000`, hardcoded pool `max` 10/20.**
   Confirmed still hardcoded. **Gap — fixed.** See below.
2. **`statement_timeout: 30000` hardcoded.** Confirmed. **Assessed, no change.** This is a
   runaway-query/DDoS guard (its own comment says so), the same category as `index.ts`'s server
   timeouts below — not a "waiting on a dependency that might be slow" value, so the tunability
   argument for row 1 doesn't apply to it.
3. **`api/src/index.ts:31-33` server timeouts (Slowloris protection).** Confirmed unchanged,
   confirmed deliberate (inline comment says so). **Assessed, no change**, per the ticket's own
   steer.
4. **`web/src/lib/queryClient.ts` 429 handling.** The ticket's premise — "429 is never retried" —
   is **stale**. `shouldRetryRequest`/`retryDelayMs` (added under TRO-172/API-1, commit
   `9f3885c`, well before TRO-248 was written) already retry HTTP 429 with a jittered backoff
   schedule (`THROTTLE_RETRY_DELAYS_MS = [2000, 8000, 20000, 45000]`, summing past the server's
   60s rate-limit window) for **both** `queries` and `mutations` — the client's
   `defaultOptions.mutations.retry`/`retryDelay` are wired to the same predicate, not left on
   react-query's default (which does treat every 4xx, including 429, as permanent). Every other
   4xx (400/401/403/404/409/422) is still correctly treated as permanent.
   `web/src/lib/queryClient.test.ts` (pre-existing, 11 cases) already pins this for both query and
   mutation defaults, including "still retries 5xx", "gives up on 429 eventually", and "backs off
   past the rate-limit window". Checked PR #51 (`fix/err-13-err-14-editor-save-paths`, open) for
   collision: it edits `queryClient.ts` too, but only to add `notifyDocumentGoneOnRead()` after the
   write-outcome bus — it does not touch the retry-policy section, so there is no conflict.
   **No code change; verified only.**
   One adjacent, narrower gap noticed but out of this ticket's table and not fixed here:
   `UnifiedDocumentPage.tsx:79` sets `retry: false` on the top-level document-by-id query, and its
   `queryFn` throws plain `Error`s with no `.status` attached — so even without the override, a
   429 on that specific fetch wouldn't be recognized as throttling by `shouldRetryRequest`. Worth
   its own ticket; not touched here (drive-by fixes outside this ticket's table are out of scope).
5. **`api/src/config/ssm.ts` — no timeout, no retry.** Confirmed: `getSSMSecret` awaited
   `client.send(command)` directly. TRO-243 (`11e93b6`) added a fallback to env-supplied secrets
   *after* a failure, but nothing bounded how long a single attempt could hang or retried a
   transient one. **Gap — fixed.** See below.
6. **Circuit breakers: none, strongest candidate the collaboration WebSocket.** Checked whether
   ERR-1/ERR-2's merged fix already does this job. Two things verified in the current tree, not
   assumed:
   - `y-websocket`'s `WebsocketProvider` (the client the editor uses,
     `node_modules/y-websocket/src/y-websocket.js:158-167`) already reconnects on exponential
     backoff (`2^wsUnsuccessfulReconnects * 100ms`, capped at `maxBackoffTime` = 2500ms by
     default) — a bounded retry schedule already exists for the transient case, from the library,
     with no code in this repo re-deriving it.
   - ERR-1/ERR-2's merged fix (`Editor.tsx:441-495`) sets `wsProvider.shouldConnect = false` on
     the three permanent-failure close codes (4401 session invalid, 4403 access revoked, 4100
     document converted) — i.e. it **opens the breaker and leaves it open** on exactly the
     conditions where retrying could never succeed, rather than reconnecting forever against a
     doomed socket. `SyncStatusIndicator` (ERR-1) then reports the true unsynced state instead of
     a false "Saved". Together, bounded-backoff-for-transient plus stop-forever-for-permanent plus
     truthful state surfacing **is** the behavior a circuit breaker is for.
   **Assessed, no change** — building a second breaker here would duplicate a job already done,
   which the ticket itself flagged as the risk to check for.

**What changed.**

- **`api/src/db/poolConfig.ts` (new).** Pure `resolvePoolTiming(env)` — same pattern as the
  existing `ssl.ts`/`resolveDatabaseSsl` decision file — resolving `connectionTimeoutMillis` from
  `DB_POOL_CONNECTION_TIMEOUT_MS` and pool `max` from `DB_POOL_MAX` (production) /
  `DB_POOL_MAX_DEV` (else), each falling back to today's hardcoded values (2000ms, 20/10) for any
  unset, empty, non-numeric, zero, negative, **or fractional** override — `Number.isInteger`, not
  just `Number.isFinite`, because a pool size or millisecond timeout of `1.5` is as meaningless as
  `"abc"` (CodeRabbit caught the original version accepting fractional overrides). `client.ts` now
  calls it instead of inlining the numbers; **defaults are unchanged**, so behavior does not change
  unless an operator sets one of the three env vars. Failure mode this protects against: `ssl.ts`'s
  own file header already documents what a fixed 2000ms timeout does against a managed Postgres
  with a slow cold start — every connection attempt in that window fails and, under
  restart-on-crash infra, the process crash-loops before the database is ever actually reachable.
- **`api/src/config/ssm.ts`.** `getSSMSecret` now runs each SSM call through `sendWithRetry`: a
  5s per-attempt timeout (`AbortController` passed as `send`'s `abortSignal`, per the
  `@aws-sdk/client-ssm` `HttpHandlerOptions` shape) and up to 3 total attempts, backing off between
  them with full jitter capped at 2000ms (`Math.random() * min(200 * 2^attempt, 2000)`) so that
  the five parameters `loadProductionSecrets` fetches concurrently (`Promise.all`) don't retry in
  lockstep if they all fail on the same underlying blip. The `SSMClient` is now constructed with
  `maxAttempts: 1`, so this file's loop is the **only** retry layer — the SDK's own default
  (`maxAttempts: 3` with its own internal backoff) would otherwise silently compound with it,
  making "3 total attempts" untrue and applying this file's jitter schedule to the wrong layer
  (CodeRabbit caught the first version missing this). `ParameterNotFound` — what the real SSM API
  actually rejects with for a genuinely missing name, not a resolved-with-empty-value response as
  the first version of this fix assumed — is classified as non-retryable and propagates on the
  first attempt; a resolved-but-empty-value response (belt-and-braces, in case that shape is ever
  possible) is also not retried, for the same reason. Exhausting the retryable attempts re-throws
  into the existing `loadProductionSecrets` catch block unchanged, so the already-correct
  fallback-to-env-vars behavior from TRO-243 is untouched. Concurrency note (rule 18): this is a
  bounded, one-shot retry inside a single awaited call, not a `setInterval` —
  `loadProductionSecrets()` is invoked exactly once, in `index.ts`'s `main()`, before the app is
  created, so there is no in-flight-guard question.

**Regression tests (new).**

- `api/src/db/__tests__/poolConfig.test.ts` — 15 cases: defaults match the previous hardcoded
  values; `DB_POOL_CONNECTION_TIMEOUT_MS`/`DB_POOL_MAX`/`DB_POOL_MAX_DEV` overrides apply
  independently per `NODE_ENV`; malformed overrides (empty/non-numeric/zero/negative/**fractional**)
  fall back to the default rather than propagating `NaN` or an unsafe pool size. New capability
  with unchanged defaults, not a bug fix — no pre-existing broken behavior to reproduce red for;
  confirmed green against the implementation.
- `api/src/config/ssm.test.ts` — 7 cases against a mocked `SSMClient`, fake timers driving the
  timeout/backoff (no real waiting): success-first-try; retries-then-succeeds; exhausts all 3
  attempts and throws the last transient error; a hung call is bounded by the per-attempt timeout
  and then retries; a successful-but-"not found" response is never retried; **the real
  `ParameterNotFound` rejection** the live API actually throws is never retried either (1 `send`
  call only); the `SSMClient` is constructed with `maxAttempts: 1`.
  **Confirmed red before the fix**, for the right reason: reverted `ssm.ts` to the pre-fix version
  (copied aside, not stashed — the `git stash` ref is shared across every worktree in this repo per
  `lessons.md`) and re-ran the same test file. 3 of 5 cases present at that point failed: "retries a
  transient failure" failed with the raw `ECONNRESET` propagating (no retry existed); "gives up
  after exhausting attempts" failed on `expected 3 calls, got 1`; "bounds a hung call" failed with a
  `TypeError` reading `abortSignal` off `undefined`, because the old code never passed a second
  argument to `send` at all — a faithful demonstration that no timeout wiring existed, not a typo
  in the test. The other 2 cases passed unchanged on old code (a first-try success and a "not
  found" response were never going to exercise retry logic either way). Restored the fix; all 7
  (after the `ParameterNotFound`/`maxAttempts` additions below) pass.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec vitest run \
  src/db/__tests__/poolConfig.test.ts \
  src/config/ssm.test.ts \
  src/db/__tests__/ssl.test.ts
```

**Rollback.** Revert this ticket's commits. `client.ts` and `ssm.ts` return to their previous
inline values with no functional loss elsewhere — nothing else imports `poolConfig.ts`, and
`loadProductionSecrets`'s fallback behavior (TRO-243) is untouched either way.

---

## TRO-235 (TF-2) — prod had two divergent Terraform roots; converged onto the flat root

**HOLD FOR HUMAN APPROVAL.** This entry documents a deletion of tracked infra config
(`terraform/environments/prod`), which is an escalation-gate-2 item. The PR carries the same
banner; nothing here has been applied to real infrastructure — no `terraform apply`/`destroy`/
live `init` was run, per the hard safety rules for this ticket.

**The problem.** Prod was managed by two independent Terraform root configs with separate state:
the flat `terraform/*.tf` (74 resource blocks) and the modular `terraform/environments/prod` +
`terraform/modules/*` (66 resource blocks). They had already drifted — the flat root had a WAF
(`waf.tf`) and CloudFront realtime logging (`cloudfront-logging.tf`) the modular path lacked
entirely — and nothing prevented both from being applied to the same AWS account, which would
collide on hard-coded resource names. `audit/AUDIT_REPORT.md` (TF-2) and
`audit/terraform/baseline.md` have the full analysis.

**What changed.**

- Deleted `terraform/environments/prod/` (5 files, including its own `.terraform.lock.hcl`) —
  the actual TF-2 duplicate. Confirmed unused by any deploy tooling first: `scripts/deploy.sh`,
  `scripts/deploy-web.sh`, and `scripts/terraform.sh` all route `prod` to the flat `terraform/`
  root unconditionally and never reference `environments/prod`.
- Diffed every one of the 66 modular resource blocks against the flat root by type+name before
  deleting (full reconciliation table in the PR body). Three genuinely missing security-hardening
  arguments were found and ported into the flat root instead of silently dropped:
  - `database.tf` — 5 Aurora parameter-group settings (`max_connections`,
    `idle_in_transaction_session_timeout`, `statement_timeout`, `log_connections`,
    `log_disconnections`) that `modules/aurora/main.tf` had and `database.tf` did not.
  - `elastic-beanstalk.tf` — 8 CPU-based autoscaling trigger/cooldown settings that
    `modules/elastic-beanstalk/main.tf` had and `elastic-beanstalk.tf` did not.
  - `ssm.tf` — `secretsmanager:PutSecretValue` on the EB instance role's Secrets Manager policy.
    Without it, `saveCAIACredentials()` (`api/src/services/secrets-manager.ts:136`) gets
    `AccessDenied` from `PutSecretValueCommand` the first time it updates an *existing* CAIA
    secret under prod's real IAM role — `CreateSecret`/`UpdateSecret` alone do not cover it. This
    is a real, currently-live bug in the flat root that the modular path had already fixed.
- **`terraform/environments/dev`, `terraform/environments/shadow`, and `terraform/modules/*` are
  kept — this is a deliberate deviation from "remove environments/ + modules/ entirely."** TF-2's
  finding is specifically that prod is managed by two configs; dev and shadow are different,
  non-overlapping AWS environments the flat root cannot deploy at all (its resource names are
  hard-coded for prod). `scripts/deploy.sh`/`scripts/deploy-web.sh`/`scripts/terraform.sh`
  currently route dev and shadow exclusively through `terraform/environments/$ENV`, and
  `CLAUDE.md` documents shadow as an active step in the merge workflow ("Deploy to shadow ...
  before merging to master"). Deleting modules/dev/shadow would have silently broken that live
  tooling for no TF-2 benefit — it was never part of the "same infrastructure" collision. See the
  PR body for the full reasoning; this is flagged prominently for human review, not buried.
- `scripts/check-single-tf-root.sh` (new) — fails if a second AWS Terraform root (a directory with
  a `.tf` file declaring `provider "aws"`) exists outside the allowed set (`terraform`,
  `terraform/bootstrap`, `terraform/environments/dev`, `terraform/environments/shadow`), or if
  `terraform/environments/prod` specifically reappears. Wired into `.github/workflows/ci.yml` as
  a step in the `verify` job, right after checkout (pure bash/grep, no dependencies).
- `terraform/README.md` — new "Authoritative config for prod" section explaining the convergence,
  why, and what happened to the modular path (including the dev/shadow exception above); directory
  structure diagram, multi-environment rationale, and Quick Start updated to match (prod is no
  longer under "Environment Directories").

**What did NOT change.** No flat-root resource files were rewritten beyond the three additions
above (`database.tf`, `elastic-beanstalk.tf`, `ssm.tf`); `security-groups.tf` was read for the
reconciliation but not touched (a sibling ticket, TF-7, is editing it concurrently). No provider
version pin or lock file changed (TF-3/TF-4 are separate tickets).

**How to run it.**

```bash
# Terraform binary: temp-downloaded 1.9.8 (matches audit/terraform/baseline.md; the repo's pinned
# 1.6.0 cannot `init` at all — TF-3, expired provider-signing key). Not committed to the repo.
cd terraform
terraform init -backend=false -input=false
terraform validate
terraform fmt -check -recursive .
rm -rf .terraform .terraform.lock.hcl   # leaves git status terraform/ clean, per audit methodology
cd ..

./scripts/check-single-tf-root.sh   # run from repo root; should print "OK: single authoritative Terraform root confirmed"
```

**Verification note.** `terraform validate` was run on the flat root before AND after this change
with the same 1.9.8 binary: both report `Success!` with the same single pre-existing warning
(TF-5, `s3-cloudfront.tf:426`'s uploads lifecycle rule) — this change introduces no new warnings or
errors. `terraform/environments/dev` and `terraform/environments/shadow` were also validated
post-change (unaffected, since neither was edited) and both still pass with the same TF-5 warning.
The guard script was verified to actually fail: tested with a simulated re-added
`terraform/environments/prod` (caught) and a simulated new sibling root directory outside
`terraform/` entirely (also caught), both removed before committing. The audit's cloud-free
drift-demo (`audit/terraform/drift-demo/`) was not re-run — it demonstrates local-provider drift
detection unrelated to this ticket's root-convergence change, so re-running it would not verify
anything this PR touches.

**Rollback.** `git revert` the commit(s) on `fix/tf-2-unify-terraform-roots`. This restores
`terraform/environments/prod` and reverts the three ported arguments in `database.tf`,
`elastic-beanstalk.tf`, and `ssm.tf` — returning to the pre-TRO-235 two-root state (i.e.
un-fixing TF-2). It does not touch any live AWS state, since no `apply` was ever run against
either root.

---

## TRO-299 — [TF-10] Render-provider Terraform config for the deployed fork

Ship's Render deployment (`ship` / `srv-d9kf2t942hec73aofrt0`, `ship-db` /
`dpg-d9kgth6417fc7386hhh0-a`) was hand-built via the dashboard and one-off API calls — the last
piece of Category 8 not backed by Terraform (`memory-bank/techContext.md`: "Not yet
Terraform-managed — the service and database were created by hand and API call."). This adds a
config that can reproduce it.

**What changed.**

- **`terraform/render/`** (new): `versions.tf` pins `render-oss/render` `1.9.1` (verified latest
  stable on the public registry) and `required_version >= 1.9.0`; `postgres.tf`/`web_service.tf`
  declare `render_postgres.ship` (pg16, oregon, free) and `render_web_service.ship` (docker
  runtime, this repo/`main`, oregon, free, health check `/health`); `variables.tf` gives every
  input a description, with `render_api_key`/`session_secret` marked `sensitive = true` and no
  real default. `DATABASE_URL` is derived from `render_postgres.ship.connection_info.internal_connection_string`
  (a resource reference, never a literal). `outputs.tf` deliberately omits anything sensitive.
- **`terraform/render/terraform.tfvars.example`** (new): placeholders only.
- Root `.gitignore` gains `terraform/render/*.tfplan` and `terraform/render/tfplan` — the one
  genuine gap: no existing pattern covered a captured plan file under this new directory.
  `terraform/.gitignore`'s pre-existing, unrelated `*.tfvars` / `.terraform/` / `*.tfstate*`
  patterns (no leading slash, so unanchored — they already apply recursively under `terraform/`)
  turn out to **already cover** `terraform/render/`'s `.terraform/` cache, `terraform.tfvars`, and
  state files, verified empirically against the pre-this-ticket version of that file. **This
  corrects `memory-bank/techContext.md`**, which asserted "a new `terraform/render/terraform.tfvars`
  would NOT be ignored" — that check looked only at the root file's `terraform/`-specific lines and
  missed the nested file's blanket coverage; filed as a memory-bank correction rather than silently
  treated as a non-issue. One negation, `!render/.terraform.lock.hcl` (added to the nested file),
  so this directory's provider lock file is committed — deliberately unlike every other `terraform/*`
  subdirectory, none of which commit theirs (the gap TF-4 flagged for the flat root specifically).
- **`terraform/render/README.md`** (new): verified-vs-on-record fact table, why this directory
  sits inside `terraform/` given PR #41's single-root guard (it wouldn't be flagged either way —
  the guard greps for `provider "aws"`, and this declares `provider "render"`), confirmation that
  `audit/terraform/drift-demo/` already satisfies the local-provider deliverable (2 pinned
  `local_file` resources — no changes needed there), and the import-vs-apply adoption memo.
- **`terraform/render/plan/plan-annotated.md`** (new): the captured, redacted `terraform plan`
  output plus one-sentence-per-resource blast-radius annotations.

**Verified live against the Render API (2026-07-30)**, via `GET /v1/services/{id}`,
`/v1/postgres/{id}`, `/v1/services/{id}/env-vars` (names only), `/v1/owners` — not re-derived from
the memory bank: service id/name/region/runtime/plan/URL, health check path (now set to `/health`,
newer than an older memory-bank note calling it unset), repo/branch/auto-deploy/Dockerfile path,
database id/name/region/version/plan, owner id, and that the three expected env var names
(`DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN`) are the only ones set. One fact only *partially*
confirmed: Postgres `ipAllowList` reads `null` via the API, not `[]` — functionally equivalent per
the provider's docs but not a byte-for-byte match, called out as such in the README rather than
rounded up to "verified."

**What did NOT change / was not run — hard safety rules.** No `terraform apply` or
`terraform import` ran against the live account; `terraform plan` is read-only and was run with
real credentials (`RENDER_API_KEY` sourced from the gitignored repo-root `.env`, never printed,
echoed, or committed). The plan shows `2 to add, 0 to change, 0 to destroy` — Terraform proposing
brand-new resources, because nothing was imported; this is the expected "hand-built resource, empty
state" collision the ticket anticipated, not a defect, and is not "fixed" here. The
adoption-path decision (import vs. a clean-machine apply that creates a parallel service) is a
human call — see the PR body's **"HOLD FOR HUMAN: apply/import decision (gate 2)"** and the memo in
`terraform/render/README.md`.

**Regression test: honestly, none applies.** This ticket's deliverable is Terraform configuration
and documentation — there is no `api/**/*.test.ts` or `web/**/*.test.tsx` change for
`scripts/factory/gate.sh`'s regression-test check (G6) to find, and it is expected to fail
honestly rather than be satisfied by a manufactured vitest case with nothing to regress-test. The
real verification is `terraform validate` (clean, no warnings) + `terraform fmt -check -recursive`
(clean, after one formatting pass) + the live `terraform plan` capture referenced above, all shown
in the PR body.

**How to run it.**

```bash
cd terraform/render
terraform init -input=false          # downloads render-oss/render 1.9.1
terraform validate
terraform fmt -check -recursive .
cp terraform.tfvars.example terraform.tfvars   # fill in session_secret; gitignored
set -a; source ../../.env; set +a              # RENDER_API_KEY
terraform plan -var-file=terraform.tfvars -input=false
```

**How to roll it back.** Delete `terraform/render/`, revert the two `.gitignore` edits. Nothing on
Render itself needs rolling back — no `apply`/`import` ever touched the live account.

---

## TRO-208 — [TS-3] The Yjs <-> TipTap converter — the persistence path for every document's content — was fully untyped

`api/src/utils/yjsConverter.ts` carried 12 `any` in 245 lines, the highest any-per-line density of
any production file, on the only code path that translates collaborative CRDT state into the
durable `documents.content` column: `collaboration/index.ts:151` (`persistDocument()`, right before
the write) and `routes/documents.ts:456` (content served over REST). `api/src/types/y-protocols.d.ts`
added 7 more `any` on the awareness/sync surface underneath. Every exported signature was untyped —
`yjsToJson(fragment): any`, `jsonToYjs(doc, fragment, content: any)`,
`loadContentFromYjsState(yjsState): any | null` — so a shape regression here would silently corrupt
or drop user-authored content with nothing failing to compile.

**What changed — types only, no behavior change.**

- **`api/src/types/tiptap.ts` (new).** One recursive TipTap/ProseMirror JSON node type —
  `TipTapNode` (`type`, optional `attrs`/`content`/`marks`/`text`), `TipTapMark`, `TipTapDoc`, and the
  `TipTapAttrValue` union (`string | number | boolean | null`) node/mark attributes actually hold.
  Kept API-local by design (see "Not done" below).
- **`yjsConverter.ts`** — all five signatures now use these types instead of `any`:
  `yjsToJson(fragment): TipTapDoc`, `jsonToYjs(doc, fragment, content: TipTapNode): void`,
  `loadContentFromYjsState(yjsState): TipTapDoc | null`, plus the internal
  `extractTextWithMarks`/`yjsElementToJson`. A new `typeAttributes()` helper centralizes the one
  existing `Record<string, unknown>` -> typed-attrs conversion (unchanged logic, just typed); a new
  `setAttributeValue()` helper centralizes the one real, documented gap this fix could not type away:
  Yjs's own ambient `XmlElement.setAttribute` pins attribute values to `string`, but this codebase has
  always written some attributes (a numeric heading `level`) using their real JS type and relies on
  Yjs's runtime not enforcing that — a `value as string` assertion there is the one non-`any` cast in
  the diff, isolated and commented rather than repeated at each of the two call sites it used to
  appear at.
- **`y-protocols.d.ts`** — `any` replaced with `unknown` throughout (transaction origins, awareness
  state records, event callback args), except `Awareness.on`/`off`, which gained a real overload for
  the one event this codebase actually listens for (`AwarenessChange { added, updated, removed }`)
  plus a loose `unknown[]` fallback for anything else — a fully untyped variadic callback would have
  accepted a mistyped `'update'` handler just as silently as a correct one.
- **`collaboration/index.ts`** — two type-only edits, no control-flow change: `isTipTapDocContent`'s
  type predicate now asserts `value is TipTapDoc` instead of an inline `{ type: 'doc'; content:
  unknown[] }`, so its narrowed value satisfies `jsonToYjs`'s new parameter type.
- **`collaboration/__tests__/api-content-preservation.test.ts`** — this pre-existing test file calls
  `yjsToJson`/`loadContentFromYjsState` directly and, once they stopped returning `any`, tripped real
  `noUncheckedIndexedAccess` errors on chained array indexing (`convertedBack.content[0].content[0].text`)
  that `any` had been silently swallowing. Fixed with optional chaining (`?.`) and one narrowing
  `if (!result) throw ...` for the nullable `loadContentFromYjsState` case — no assertion was
  loosened; all 18 cases in the file still pass unchanged.

**Found, not fixed (out of scope for a types-only ticket).** Writing the round-trip regression test
below surfaced a real, pre-existing behavioral quirk: `jsonToYjs`/`jsonToYjsChildren` apply text
marks via Yjs's native `YXmlText.format()`, but `yjsToJson`'s read side only recognizes marks
represented as nested `Y.XmlElement` wrapper tags (e.g. `<bold>...</bold>`), which is how the actual
browser TipTap/y-prosemirror binding represents them — not how `.format()` does. `YXmlText.toString()`
(`node_modules/yjs/src/types/YXmlText.js:68-100`) serializes format-delta attributes back as literal
pseudo-XML baked into the plain-text string, so round-tripping a marked text node through
`jsonToYjs` -> `yjsToJson` produces `{ type: 'text', text: '<bold>bold</bold>' }`, not a `marks` array.
This only fires on the one-time JSON->Yjs migration path for documents created via the API and never
opened in the collaborative editor before their first collaboration-server load
(`collaboration/index.ts`'s `loadDoc()`) — verified present, byte-for-byte identical, on both the
unfixed and fixed code (see measurement below), so it predates this ticket and this fix does not
touch it. Worth a follow-up finding; not attempted here per the ticket's explicit "types-only, no
behavior change" scope.

**Not done.** Promoting `TipTapNode`/`TipTapDoc` to `shared/` so the frontend imports the identical
type is a natural next step but is TS-5's business (the `shared/` contract is a separate, open
finding), not this ticket's.

**Regression test — `api/src/utils/__tests__/yjsConverter.test.ts`** (new, vitest, run by the gate).
Two independent parts, per the ticket:

1. Six `expectTypeOf` assertions (`yjsToJson`/`jsonToYjs`/`loadContentFromYjsState` each `.not.toBeAny()`
   plus `.toEqualTypeOf<...>()`) proving the exported signatures are real types. These are
   compile-time-only — `vitest run` transpiles via esbuild and does not evaluate them, so they pass
   silently either way at runtime; verified red **only** via `tsc --noEmit`, by temporarily restoring
   the pre-fix `yjsConverter.ts`/`y-protocols.d.ts`/`collaboration/index.ts` (backed up first, no
   `git stash`) and re-running `pnpm --filter @ship/api exec tsc --noEmit`. Against the unfixed code
   it fails with real, on-point errors — `TS2349: This expression is not callable` on each
   `.not.toBeAny()`, and `TS2344: Type 'TipTapDoc' does not satisfy the constraint 'never'` on each
   `.toEqualTypeOf<...>()` — not an import error or a typo. Restoring the fix returns `tsc --noEmit`
   to clean.
2. Two runtime round-trip tests: a representative document (heading with a numeric `level` attr,
   a paragraph with bold text and a link mark, a nested 2-item bullet list) through
   `jsonToYjs` -> `yjsToJson`, and a second through a real binary Yjs update via
   `loadContentFromYjsState`. Both pin the exact output observed by running the conversion directly
   (`tsx`, no DB) against both the unfixed and fixed `yjsConverter.ts` and diffing — byte-for-byte
   identical — proving the types change altered nothing at runtime, including the marks quirk noted
   above.

**Measurement** (`~/.claude/skills/type-safety-audit/scripts/count.sh`, the audit's own method —
`explicit_any` pattern `:\s*any\b|<any>|\bany\[\]|Array<any>`, BSD grep, counts matching lines):

| Scope | Before | After |
|---|---|---|
| `api/src/utils/yjsConverter.ts` | 12 | **0** |
| `api/src/types/y-protocols.d.ts` | 7 | **0** |
| `api/` package-wide (`explicit_any`) | 78 | **59** (-19) |

The api-wide before (78) matches `audit/type-safety/baseline.json`'s tracked `perPackage.api.anyTotal`
exactly; the -19 delta is precisely the two files' combined reduction, confirmed by isolated
before/after counts on every other file this diff touches (`collaboration/index.ts` and
`api-content-preservation.test.ts` are unchanged on every tracked metric — `explicit_any`,
`as_assertions`, `as_any`, `non_null_assertions` — before vs after). The regex undercounts by its own
documented blind spot (`Record<string, any>` doesn't match `:\s*any\b|<any>`, since `any` isn't
preceded directly by `:`): two such sites in each of `yjsConverter.ts` and `y-protocols.d.ts` were
fixed too and are real reductions the tracked number doesn't reflect.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec tsc --noEmit
pnpm --filter @ship/api exec vitest run \
  src/utils/__tests__/yjsConverter.test.ts \
  src/collaboration/__tests__/api-content-preservation.test.ts
```

**Rollback.** `git checkout main -- api/src/utils/yjsConverter.ts api/src/types/y-protocols.d.ts
api/src/collaboration/index.ts api/src/collaboration/__tests__/api-content-preservation.test.ts &&
git rm api/src/types/tiptap.ts api/src/utils/__tests__/yjsConverter.test.ts` and drop this entry. No
schema, route, or runtime-behavior change accompanies this fix, so rollback is type-signature-only.

---

## TRO-206 (TS-1) — `web/tsconfig.json` now extends the root config; 156 latent type errors fixed

`web/tsconfig.json` re-declared `strict: true` standalone instead of extending `../tsconfig.json`,
so it silently ran without the root's `noUncheckedIndexedAccess`, `noImplicitReturns`, and
`noFallthroughCasesInSwitch` — the only two packages that extend the root (`api`, `shared`) had
them; `web` did not. `research/configs/web/tsconfig.json` (a reference copy in the repo) already
`extends: "../tsconfig.json"`, confirming this was drift, not an intentional divergence.

**Ticket hypothesis vs. observed.** The audit (measured at commit `076a183`) recorded 102 errors
under the restored flags. Reproducing the identical command
(`cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess
--noImplicitReturns --noFallthroughCasesInSwitch`) on this branch's base — `main` had gained ~30
merged tickets since the audit, adding new files (`lib/contrast.ts`, `lib/contrast.test.ts`,
`pages/MyWeekPage.contrast.test.tsx` from TRO-217, plus other unrelated changes) — produced **156**
errors, not 102: 63 TS2532, 41 TS18048, 26 TS2345, 17 TS2322, 8 TS7030, 1 TS18047, across 29 files.
The fix direction held; the count was stale. All 156 are fixed, not just the original 102.

**What changed.**

- `web/tsconfig.json` — added `"extends": "../tsconfig.json"`; kept web's `target`/`lib`/`module`/
  `moduleResolution`/`jsx`/`noEmit`/`baseUrl`/`paths` overrides (all of which differ from or add to
  the root, e.g. `module: "ESNext"` + `moduleResolution: "bundler"` vs. the root's `NodeNext`, and
  `lib` adding `DOM`/`DOM.Iterable`). Dropped the overrides that were byte-identical to the root
  (`strict`, `skipLibCheck`, `esModuleInterop`, `allowSyntheticDefaultImports`,
  `forceConsistentCasingInFileNames`, `isolatedModules`) since inheriting them is the whole point.
- `web/tailwind.config.d.ts` — the hand-written ambient type for `tailwind.config.js` typed
  `colors` as a bare `Record<string, string>`, so every dot-accessed token (`palette.background`,
  `palette.muted`, ...) came back `string | undefined` under the restored flag. Gave the six tokens
  actually dot-accessed by `contrast.ts`/`contrast.test.ts`/`MyWeekPage.contrast.test.tsx` explicit
  (non-optional) properties, kept a `[key: string]: string` index signature so dynamic lookups
  (`palette[name]`) stay honestly optional.
- 28 source files fixed with genuine narrowing — destructure-then-check, explicit `undefined`
  guards, or an `?? null`/`?? ''` fallback at the point a nullable value crosses into a non-nullable
  slot. No `!`, `as any`, `as unknown as`, or `: any` anywhere in the diff (`node
  scripts/factory/review-patterns.mjs` — G7b — reports clean). Densest: `CommandPalette.tsx` (13),
  `hooks/useSelection.ts` (12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12),
  `lib/cn.ts` (12).
- `pages/ReviewsPage.tsx` — the one fix that is more than type-satisfying. Three optimistic-update
  handlers (`approvePlan`, `requestChanges`, `rateRetro`) did
  `updated.reviews[personId][weekNumber] = { ...updated.reviews[personId][weekNumber], patch }`.
  Spreading `undefined` is legal JS and this type-checked before the fix, but for a person/week
  pair with no prior review row it silently produced a `ReviewCell` missing every field except the
  one just patched (`hasPlan`/`hasRetro`/`sprintId`/`planDocId`/`retroDocId` all `undefined` instead
  of their contract). Extracted `emptyReviewCell`/`mergeReviewCellPatch` (both exported) so all
  three handlers merge over a real default instead of a possibly-missing lookup.
  **Reachability, checked rather than assumed:** every UI path that can call these three handlers
  (`ReviewsPage.tsx:919-935`, `:1115`) is gated on `cell.hasPlan`/`cell.hasRetro` already being
  `true`, which requires an already-fetched cell — so this specific corruption was not reachable
  through today's UI. It is a genuine type-safety fix against a real invariant gap, not a
  demonstrated production crash; recorded as such rather than oversold.

**What did NOT change.** No product behavior. `pnpm --filter @ship/web test` is 37 files / 366
tests green before and after (quarantine is already empty per TEST-1); the fixes are narrowing,
not behavior changes, with the one exception above, which changes nothing observable given the
current gating.

**How to run it.**

```bash
source .factory-env
# Reproduce the flag-restoration count (should be 0 now that tsconfig extends root):
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch
# Or just the normal check, since the flags are now inherited permanently:
pnpm --filter @ship/web type-check
# Regression test for the ReviewsPage fix:
pnpm --filter @ship/web exec vitest run src/pages/ReviewsPage.reviewCellMerge.test.ts
```

**Rollback.** Revert the commits on `fix/ts-1-web-tsconfig`. Reverting just
`web/tsconfig.json`'s `extends` line restores the pre-fix (silently non-strict) behavior without
touching the 29 narrowed files, which remain correct either way since the narrowing is a strict
superset of the original logic. `emptyReviewCell`/`mergeReviewCellPatch` can be reverted
independently by inlining the old spread in the three `ReviewsPage.tsx` handlers, which restores
the (unreached, per above) invariant gap.

---

## TRO-286 (TEST-14) — no e2e test can pass without executing an assertion any more

TEST-2 (TRO-224) fixed the 8 vacuous tests that gave false *security* assurance and deliberately
stopped, reporting the boundary. This finishes the job and clears two adjacent defects it surfaced.

**Part 1 — the remaining conditional-only tests: 62 → 0.**

Measured with the repo's own detector, `audit/test-quality/runs/vacuous.mjs`, which finds tests
whose every `expect()` sits inside a conditional branch — i.e. tests that pass with zero assertions
executed. On `main` (`c4e92c2`) it reports `testsWithOnlyConditionalExpects: 62`. On this branch it
reports **0**, across the same 870 scanned test blocks.

Every `if (await x.isVisible()) { …expects… }` became an assertion carrying an actionable message,
per the pattern already in `bulk-selection.spec.ts:793`. Converted tests also record *why* the
precondition holds, so the next reader does not re-derive it — seed data creates sprints from
`currentSprintNumber-2` through `+2` (`e2e/fixtures/isolated-env.ts`), so completed sprints always
exist; `cleanupExtraSprints` in `beforeEach` guarantees an empty future week window.

By file: `program-mode-week-ux.spec.ts` (33), `accessibility-remediation.spec.ts` (6),
`context-menus.spec.ts` (6), `features-real.spec.ts` (5), `performance.spec.ts` (2),
`admin-workspace-members.spec.ts` (2), `ai-analysis-api.spec.ts` (1), plus 7 more not named in the
ticket's table that the detector caught.

Two of these were more than a mechanical conversion. `admin-workspace-members.spec.ts` needed the
fixture work the ticket flagged as risky — `isolated-env.ts` now seeds a second workspace and an
unattached user — and the workspace-switcher and admin-dashboard specs were checked for fallout.
`features-real.spec.ts` turned out to be hiding a **real file-chooser race** behind its guard, which
is exactly the failure mode a silently-passing test conceals.

**Part 2 — a user was being told the wrong rate limit.** `api/src/services/ai-analysis.ts` enforces
`RATE_LIMIT = 120`/hour while `api/src/routes/ai.ts` told the user "Max 10 analysis requests per
hour" — off by 12×. Rather than pick a number, the message is now derived from the constant
(`RATE_LIMIT_MESSAGE`), so the two cannot drift apart again, and `api/src/routes/ai.test.ts` (new)
asserts the 429 body reports the enforced limit.

The e2e test that provoked this is marked `test.fixme()` **with a written reason** rather than left
lying. Asserting the real limit needs either 121 requests — 120 of which attempt Bedrock, blowing
the 60s timeout — or an injectable limit, which is a production seam added solely to enable a test.
That is a maintainer's call, not the factory's, and is left open deliberately.

**Part 3 — `.husky/pre-commit` is now `100755` in the index**, where it was `100644`. It *did* still
run, because `core.hooksPath` is `.husky/_` and husky v9's wrapper **sources** the hook rather than
exec'ing it — but that made the mode a latent trap: if the wrapper ever exec'd instead, every
pre-commit check would stop running silently, including the compliance scan.

The ticket carried an unreproduced report that hooks do not fire in a linked worktree. **That is
now disproved**: committing from `Ship-wt-tro_286` (a linked worktree) fired `check-empty-tests.sh`
and `check-api-coverage.sh` and printed their output, as did every commit from the main checkout
throughout the run. Hooks fire in both.

Unrelated but worth stating plainly: `comply` is not installed in this environment, so the secrets
scan warns and passes. **A successful commit is not evidence that scan ran.**

**Part 4 — CodeRabbit review triage on PR #40.** 22 line comments, all real defects in code this PR
touched, none out of scope — every finding was either fixed here or dismissed with a written reason
in the ledger (`audit/factory/review-findings.jsonl`), never silently dropped.

Six were Majors that reintroduced the exact defect class this ticket exists to fix: two fixed
`waitForTimeout` sleeps standing in for synchronization (`admin-workspace-members.spec.ts`,
`program-mode-week-ux.spec.ts`, plus siblings in `issue-display-id.spec.ts` and
`status-colors-accessibility.spec.ts`), the swallowed-failure pattern
`isVisible().catch(() => false)` in an availability-indicator check, a `dashCount === rowCount`
comparison that could pass while filtering nothing correctly (`td` filtered by `—` also matches
assignee/estimate/due-date cells), a near-tautological "highlight" check that matched every card in
the timeline regardless of active state, and non-deterministic fixture restoration in the carol/Test
Space cleanup (`isVisible().catch(() => false)` could silently skip removing her, leaving the next
test in the worker to find her already attached).

Fixing finding 18 (point-in-time `rows.count()` preconditions) surfaced three tests in
`program-mode-week-ux.spec.ts` — "issue row has quick menu (⋮) button" and its two siblings — that
assert a per-row hover-revealed actions button. Traced the full render path
(`IssuesList.tsx` → `IssueRowContent` → `SelectableList.tsx`): no such button exists in list view,
only a right-click context menu and the bulk "Move to Week" toolbar action already covered
elsewhere. TRO-286 Part 1 had already tightened these from "passes whether the feature exists or
not" to a real assertion, which would now fail hard, not vacuously — same shape as the
team-directory quick-menu gap already `test.fixme()`'d in `context-menus.spec.ts`. Marked
`test.fixme()` with the same reasoning rather than left to fail.

One finding was dismissed rather than fixed: WCAG 3.3.3 recovery guidance on the login-error test.
The message is exactly `"Invalid email or password"` (`api/src/routes/auth.ts`), a deliberate
security choice, and `Login.tsx` has no recovery link at all — tightening the assertion would only
ever fail without a UI change, which is a product accessibility gap, not a test bug. Filed as a
follow-up rather than fixed here.

One derived claim was checked and found not to transfer: CodeRabbit's suggested fix for the fixed
sleeps in `program-mode-week-ux.spec.ts` was `page.waitForResponse(...)` on `/api/issues`. Traced
`IssuesList.tsx:569-570` — the sprint filter dropdown filters already-fetched issues client-side; no
new request fires when it changes. Used a retrying DOM assertion instead, which is what the
mechanism actually calls for.

**How to run it.**

```bash
node audit/test-quality/runs/vacuous.mjs        # expect testsWithOnlyConditionalExpects: 0
git ls-files -s .husky/pre-commit               # expect mode 100755
pnpm --filter @ship/api test src/routes/ai.test.ts
```

The Playwright specs themselves need a live app — use `/e2e-test-runner`, never `pnpm test:e2e`
directly, which produces enough output to crash the session.

**Roll back.** `git revert` this merge commit. The conditional guards return (and with them the 62
silently-passing tests), the 429 message goes back to quoting 10/hour against 120/hour enforcement,
and `.husky/pre-commit` reverts to mode `100644`. No schema, API surface, or product behaviour is
touched by any of it — the only production change is the text of one error message.

---

## TRO-246 (rule 5) — CI builds the image once and pushes it by SHA; Render still rebuilds it a second time (switch prepared, not executed)

TRO-242 made the root `Dockerfile` buildable from a clean checkout (multi-stage: builds
`shared`→`api`→`web` inside the image, instead of requiring pre-built `dist/` in the build context).
That closed the "build on a laptop" problem but not the "build once" one: CI verified the source, and
then Render separately built the *same* Dockerfile itself, on its own infrastructure, at its own
time — two independent builds of the same commit, never proven to be the same artifact.

**What changed.**

- `.github/workflows/ci.yml` gains a `build-image` job that builds the root `Dockerfile` with
  `docker/build-push-action` and pushes to `ghcr.io/troysatchell/ship`, authenticated with the
  workflow's own `GITHUB_TOKEN` (job-scoped `permissions: packages: write`). `needs: verify`, so it
  never runs on code that failed typecheck/build/the test-regression check.
  - Tags: the full git SHA (immutable — the identity a rollback promotes/demotes by) and a moving
    `main` tag.
  - Pushes only on an actual push to `main` (`SHOULD_PUSH` gate). Every pull request still **builds**
    (unauthenticated, no push) — this proves the Dockerfile stays buildable from whatever the PR
    changed, without ever needing registry credentials (which a fork PR's `GITHUB_TOKEN` doesn't have
    write scope for anyway).
  - Third-party actions (`docker/setup-buildx-action`, `docker/login-action`,
    `docker/build-push-action`) are pinned to full commit SHAs, matching this file's existing
    convention for non-`actions/*` steps.
- `docs/deployment-artifact-lifecycle.md` (new): what's built, where it's stored, the tagging
  scheme, and — the actual "promote" and "roll back to a previous SHA" procedures — plus a
  ready-to-run Render switch runbook.
- `docs/application-architecture.md`: one-line pointer from the (stale, AWS-only) Deployment section
  to the new doc and to `memory-bank/techContext.md`'s Render facts, so the two don't silently
  diverge further. The AWS-only diagram/infra list itself is untouched — out of scope here.

**What did NOT change — the Render switch itself is prepared, not executed.** Changing the live
`ship` service (`srv-d9kf2t942hec73aofrt0`, currently `runtime: docker` building the Dockerfile on
Render's own infrastructure) from a repo-build to an image-deploy is an outward-facing, largely
irreversible action against the graded submission URL (`https://ship-rr6m.onrender.com`) —
escalation gate 2. No Render API call was made, no credential was read or moved, and the repo-root
`.env` was not touched. `docs/deployment-artifact-lifecycle.md`'s runbook is the exact procedure for
whoever runs it, including the parts that could not be independently verified from here (Render's
`image` field on the Update Service API is documented to exist but its full sub-schema was not
reachable this session — flagged explicitly, with a documented dashboard fallback that needs no
schema guessing).

**Regression test: honestly, none applies.** This ticket's deliverable is a CI workflow change plus
documentation — there is no application code path for a vitest regression test to exercise, and
`scripts/factory/gate.sh`'s regression-test check (G6, which counts added `it(`/`test(` cases in
`*.test.ts`/`*.test.tsx`/`*.spec.ts`) is expected to fail honestly rather than be satisfied by a
manufactured, vacuous test. YAML validity of the workflow file was checked instead — see PR body for
the exact method (the repo's own `js-yaml` dependency, since `actionlint` is not installed here).

**How to run it.**

```bash
# Local build proof — same Dockerfile path CI runs, from a clean tree:
docker build -t ship:tro-246-local -f Dockerfile .
docker images ship:tro-246-local   # 482 MB, observed this session

# YAML-validate the workflow (repo's own transitive js-yaml dep, no actionlint installed):
node -e "require('./node_modules/.pnpm/js-yaml@4.1.1/node_modules/js-yaml') \
  .load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('ok')"

# The real test of the CI behavior itself is derived, not run here — the first push to `main`
# after this merges is the live test of build-image actually pushing to GHCR.
```

**How to roll it back.**

- CI job: revert the `build-image` addition to `.github/workflows/ci.yml`; `verify`/`inventory` are
  untouched and keep running exactly as before.
- Docs: delete `docs/deployment-artifact-lifecycle.md` and revert the one-line pointer in
  `docs/application-architecture.md`.
- Nothing to roll back on Render — the switch was never executed.

---

## TRO-216 — [A11Y-2] `aria-expanded` on a plain `<div>` in the editor wrapper

**What was broken.** axe reported a Critical `aria-allowed-attr` violation on `.tiptap-wrapper >
div`: `<div style="position: relative;" aria-expanded="false">` — a plain `<div>` with no role,
carrying an ARIA attribute that role does not support. It only appeared in the "editor focused"
state, which is why the repo's own axe specs (which scan static viewports) never caught it.

**The mechanism — found, not guessed.** `.tiptap-wrapper > div` is the `<div>` `@tiptap/react`'s
`<EditorContent>` renders to host the ProseMirror view; once mounted it is also
`editor.options.element`. The comment `<BubbleMenu>` in `Editor.tsx` (~line 1008) is implemented by
`@tiptap/extension-bubble-menu`'s `BubbleMenuPlugin`, whose `BubbleMenuView.createTooltip()`
(2.27.2, `dist/index.js:122-136`) calls `tippy(editorElement, { interactive: true, ... })` the
first time the selection or doc changes after mount — i.e. `editorElement` **is**
`editor.options.element`, the same div. tippy's default `aria: { expanded: 'auto' }` combined with
`interactive: true` makes it call `referenceEl.setAttribute('aria-expanded', ...)` on that div
unconditionally (`tippy.js`'s `handleAriaExpandedAttribute`, `dist/tippy.cjs.js:801-813`), whether
or not the bubble menu is ever shown. The `position: relative;` inline style on the same node is a
second, independent library write to the identical element — `DragHandleExtension`
(`web/src/components/editor/DragHandle.tsx:206`) sets it on `view.dom.parentElement`, which is the
same wrapper — confirming both clues in the axe `html` string point at one node for two unrelated
reasons.

The div itself does not expand or collapse anything; it is only tippy's positioning anchor for the
floating "Comment" button. This is subtraction, not a role fix — there was never a widget here.

**What changed.** `web/src/components/Editor.tsx`: the comment `<BubbleMenu>`'s `tippyOptions` is
now a named export, `commentBubbleMenuTippyOptions`, with `aria: { expanded: false }` added. That
tells tippy never to manage `aria-expanded` on its reference element for this instance. No
behavioural change: the bubble menu still shows and hides identically on selection; only the
ARIA bookkeeping attribute on the unrelated wrapper div is suppressed. The element does not become
focusable and no keyboard behaviour changes, so this does not require the escalation path for a
user-perceivable interaction change.

**Evidence.** Both ends measured on this branch, same conditions: `http://localhost:5906`
(worktree ports), Chrome for Testing (Playwright 1217 build) headless, 1440×900, axe-core 4.11
(`@axe-core/playwright`), authenticated as `dev@ship.local` via a fresh `session_id`, wiki document
`7b254b07-e251-46bc-8e14-d4e10b76dd2b` ("Welcome to Ship"), editor focused by clicking into
`.ProseMirror`. Each measurement restarted the Vite dev server first and the served module content
was diffed directly (`curl .../src/components/Editor.tsx`) to confirm which code path was live
before scanning — Vite's dev transform cache does not always invalidate on save alone.

| Measurement — "document editor focused" | Before | After |
|---|---|---|
| axe `aria-allowed-attr` | **Critical, 1 node** (`.tiptap-wrapper > div`) | **absent** |
| axe all severities | **C1** S0 M0 m0 | **C0** S0 M0 m0 |

**Regression test.** `web/src/components/Editor.bubbleMenuAria.test.tsx` imports the real
`commentBubbleMenuTippyOptions` from `Editor.tsx` (not a copy) and calls the same `tippy(...)`
invocation `BubbleMenuView.createTooltip()` makes, against a stand-in `.tiptap-wrapper > div`,
asserting no element carries `aria-expanded`. It does not mount the real `<BubbleMenu>` +
`<EditorContent>` + a driven selection change: `@tiptap/extension-bubble-menu` is only a transitive
dependency of `web` (not resolvable directly from a test file), and its prebuilt ESM bundle's own
`import tippy from 'tippy.js'` does not interop cleanly through vitest's module runner reached via
that path — confirmed by direct experiment (`tippy` resolves to the whole CJS exports object, not
the callable, only through that nested import chain; a direct `import tippy from 'tippy.js'`
in a test file resolves correctly). That is a pre-existing environment limitation of this
dependency chain, not a defect under test — the same class `LazyEditor.test.tsx` already documents
("mounting real TipTap + Yjs in jsdom proves ... a great deal about jsdom").

Confirmed red first, for the right reason: with the unfixed (no `aria` key) options object, the
test failed with `AssertionError: Expected the element not to have attribute: aria-expanded /
Received: aria-expanded="false"` — not an import error or a locator failure.

**How to run it.**

```bash
pnpm --filter @ship/web test src/components/Editor.bubbleMenuAria.test.tsx
pnpm --filter @ship/web exec tsc --noEmit
```

To re-measure against a browser: start the worktree's API and Vite (`.factory-env` ports), log in
for a fresh `session_id`, open a wiki document, click into `.ProseMirror` to focus the editor, then
run an axe scan and check `aria-allowed-attr` is absent.

**Roll back.** Remove `aria: { expanded: false }` from `commentBubbleMenuTippyOptions` in
`Editor.tsx` (or `git revert` the commit on `fix/a11y-2-editor-aria`). The regression test fails
immediately if it comes back.

**Not established.** What a screen reader announces about the comment bubble menu — this fix only
removes an invalid ARIA attribute axe can detect; no human ran VoiceOver against it. The repo's
three Playwright a11y specs were not re-run here (not executed by the factory gate; they also only
assert `impact === 'critical'`, which this finding already was, so they would have caught it had
they scanned the focused-editor state — they scan static viewports only).

---

## TRO-190 (ERR-3) + TRO-191 (ERR-4) — the sync indicator stops claiming "Saved" over a write it never confirmed

Both findings are the same lie from two different causes. ERR-3 is a rejected title/property write
(429/500 on a PATCH). ERR-4 is a write against a document someone else already deleted (404).
Neither reaches the Yjs collaboration socket `SyncStatusIndicator` (TRO-188/ERR-1) watches — title
and properties are not CRDT content, they go straight over REST — so both used to leave the
indicator reading "Saved" with a rejected value still sitting in the field. `probe6-mixed.json`
(6.1/6.2): forced 429 then 500 on a rename, DB title unchanged both times, indicator stayed
"Saved". `probe7-retry-and-revocation.json` (7a): 14 PATCH attempts, a transient "Failed to update
document" toast fires, indicator still "Saved". `probe4-concurrency.json` (4c): another user
deletes the open document; this user's own typing keeps failing with 404, with **no** notice beyond
a console error on backlinks the user never sees.

**What changed.**

- `web/src/lib/queryClient.ts` gains `isNotFoundError`/`NOT_FOUND_STATUS` (same shape as the
  existing `isThrottleError`/`THROTTLE_STATUS` from API-1) and a small document-write-outcome bus
  (`subscribeToDocumentWriteOutcome`), fed from the real `MutationCache`'s `onError` (extended) and a
  new `onSuccess`, for any mutation tagged `meta.documentId`.
- `web/src/hooks/useDocumentWriteStatus.ts` (new) subscribes to that bus filtered to one
  `documentId`, exposing `hasFailedWrite` and calling `onDocumentGone` exactly once per document
  when a write 404s — so a retry storm (probe7a's 14 attempts) cannot open 14 blocking alerts.
- `web/src/components/editor/SyncStatusIndicator.tsx` — reused, not replaced: `deriveSyncIndicator`
  gains one optional input, `hasFailedWrite`, checked ahead of `isSynced`. A rejected write now
  overrides an otherwise-fully-synced Yjs socket and returns the exact same "Not saved" (red) view
  ERR-1 already built. No new state, no new copy in the indicator itself.
- `web/src/components/Editor.tsx` calls `useDocumentWriteStatus(documentId, () => alert(...))` and
  passes `hasFailedWrite` into the indicator. The one-time notice reuses the exact `alert()` pattern
  already in this file for the 4403 (access revoked) and 4100 (document converted) WebSocket close
  codes — not a new toast/modal system.
- `web/src/pages/UnifiedDocumentPage.tsx`'s `updateMutation` now attaches `.status` to the thrown
  error (it previously threw a bare `Error`, so `errorStatus()` could not see 429 vs 404 vs 500 at
  all) and tags `meta: { operation: 'update document', documentId: id }` so the bus above fires for
  it.

**New user-facing copy** — `Editor.tsx`, shown once per document, via the same blocking `alert()`
ERR-1's sibling fixes already use for this class of event:

> This document was deleted by someone else. Your changes here were not saved - copy anything you
> want to keep before leaving this page.

No other new copy or flow. The indicator itself reuses ERR-1's existing "Not saved" label and
detail text verbatim — this PR adds no new indicator copy.

**What did NOT change.** The field keeping the user's typed-but-unsaved text is pre-existing
`Editor.tsx` behaviour (`hasLocalChangesRef` / the `initialTitle` sync effect) and is untouched here
— rolling back the optimistic query-cache entry on a failed write never overwrote it, before or
after this fix. This PR only changes what the indicator is allowed to claim.

**Correcting TRO-190's own cross-reference.** TRO-190 describes ERR-3 as blocked on API-1's retry
predicates returning `false` for every 429/500. API-1 (TRO-172) is merged and that is no longer
true: `shouldRetryRequest` (`web/src/lib/queryClient.ts`) already retries 429 up to 4 times (delays
summing past the 60s rate-limit window) and plain 5xx/network errors up to 3 times, globally, as
the default for every mutation. The gap this PR closes is downstream of that: once retries
genuinely exhaust, nothing told the indicator. Separately, `UnifiedDocumentPage.tsx`'s mutation had
no `.status` on its thrown error, so a 429 hitting *this* mutation specifically fell back to the
generic 3-retry/1-2-4s schedule instead of the tuned one — too short to outlast the 60s window —
which this PR also fixes as part of attaching `.status` for the 404 case.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/components/editor/SyncStatusIndicator.test.tsx \
  src/hooks/useDocumentWriteStatus.test.ts \
  src/lib/queryClient.test.ts
scripts/factory/gate.sh
```

**Verification note.** `probe6.1/6.2/7a/4c` need a live app with forced 429/500/404 responses; they
were not re-run here. The tests above drive the real `queryClient` `MutationCache` config directly
(the same technique `MutationErrorToast.test.tsx` already used for API-1) rather than a mock or a
mounted page, so they prove the actual production wiring reacts correctly — that is mutation-layer
proof, not a rerun of the original browser-level probes.

**Rollback.** Revert the commit(s) on `fix/err-3-err-4-silent-write-failure`. To disable
independently: pass `hasFailedWrite={false}` (or omit it) from `Editor.tsx` to restore ERR-1's
original indicator behaviour without touching `UnifiedDocumentPage.tsx`; or remove the
`meta: { documentId }` line there to stop the bus from ever firing for document writes.

---

## TRO-282 — [TEST-13] Program Weeks tab linked to a dead `/sprints/` route and bounced the user out

**Reproduced first, as the ticket required.** The finding was derived (read from `main.tsx` and
`UnifiedDocumentPage.tsx`, "nobody has reproduced this in a browser"). A component test rendering the
real route tree (`documents/:id/*` -> `UnifiedDocumentPage` -> the real program tab config -> the
real `ProgramWeeksTab`) and clicking a week card confirmed it: the app logged
`Invalid tab "sprints" for document type "program", redirecting to base URL` and the location became
the bare `/documents/:id` — no tab, no selected week. The bug was real, not rescued by a fallback.

**Root cause.** `web/src/components/document-tabs/ProgramWeeksTab.tsx` (lines 28, 34, 71 as of this
branch) navigated to `/documents/:id/sprints/:sprintId` on selecting or opening a week, and back to
`/documents/:id/sprints` from the week detail view. Commit 7713ef0 renamed the program tab's id from
`sprints` to `weeks` in `web/src/lib/document-tabs.tsx`, but the tab's own navigation calls were never
updated. `UnifiedDocumentPage.tsx`'s tab-validation effect (~line 93-102) treats any URL tab segment
absent from `tabConfig` as invalid and redirects to the bare document URL — so every click bounced.
Same root commit as five of the thirteen TEST-1 failures; TRO-223 fixed the tab *label* half, this is
the navigation half, which no unit test covered.

**What changed.**

- `ProgramWeeksTab.tsx` — all three navigate targets now point at `weeks` instead of `sprints`.
- `UnifiedDocumentPage.tsx` — added a small `LEGACY_TAB_ALIASES` map (`{ program: { sprints: 'weeks' } }`)
  consulted by the invalid-tab effect. A URL segment matching a known legacy alias now redirects to
  the tab's current id (preserving any nested path, e.g. the sprint/week id) instead of being treated
  as a plain invalid tab and dropped to the document root.

**Decision: redirect, not 404, for old `/sprints/` links.** The rename already shipped, so a bookmark
or shared link from before it is a normal, expected case — a 404 would be a second, quieter defect (a
link that silently stopped working) layered on top of the first. Redirecting keeps those links alive
with the same behavior a fresh rename-aware click gets.

**Regression test — `web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx`** (vitest, run by the
gate; this is the tier that actually executes, per `ship-qa`). Two cases:

1. Clicking a week card lands on `/documents/:id/weeks/:sprintId`, not the document root.
2. A bookmarked `/documents/:id/sprints/:sprintId` URL redirects to the equivalent `/weeks/` URL.

Confirmed red first, for the right reason: both cases failed with
`AssertionError: expected '/documents/prog-1' to be '/documents/prog-1/weeks/a1b2c3d4-…'`, and the
console carried the real `Invalid tab "sprints"...redirecting to base URL` warning — not a crash, not
a bad selector. After the fix, both pass with no warning.

**Also updated, additive only.** `e2e/program-mode-week-ux.spec.ts:369-417` asserted the stale
`/sprints/` URL after clicking/double-clicking a week card; updated to expect `/weeks/`. This suite is
not run by the gate or CI (`ship-qa`), which is exactly why the stale assertions never caught the
break — the vitest test above is the actual proof.

**How to run it.**

```bash
cd <worktree> && source .factory-env
pnpm --filter @ship/web test -- src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx
```

**Roll back.** `git checkout main -- web/src/components/document-tabs/ProgramWeeksTab.tsx
web/src/pages/UnifiedDocumentPage.tsx e2e/program-mode-week-ux.spec.ts && git rm
web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx` and drop this entry.

---

## TRO-288 — [TEST-15] session-activity-race's "did the burst race" precondition was a scheduling hope, not a guarantee

**Not one of the audit report's 68 baseline findings** — a merge-queue blocker introduced by the
DB-2/API-6 work (TRO-179/TRO-177, PR #13) that landed on `main` afterward.

**What was broken.** `api/src/middleware/__tests__/session-activity-race.test.ts` fires a burst of
10 concurrent `authMiddleware()` calls via `Promise.all` and expects all 10 to read the session's
stale `last_activity` before any of them writes it. On an idle box `Promise.all` starting all 10
calls in the same synchronous tick is normally enough. It is not a guarantee: this repo's CI job
runs on a 2-vCPU `ubuntu-latest` runner with Postgres as a co-located service container sharing
those same 2 vCPUs (`.github/workflows/ci.yml`) — a far more contended environment than a dev
box — where connection acquisition and query dispatch can serialize enough that a later request's
SELECT lands after an earlier request's UPDATE has already committed. That request then correctly
reads the just-refreshed row and correctly skips writing, collapsing `updateStatements` to 1 and
failing the test's own "did the burst actually race" precondition
(`session-activity-race.test.ts:216-219`, `toBeGreaterThan(1)`). Because the test lives on `main`,
the factory gate compared this against the quarantine baseline and reported it as a *new* failure on
branches that never touch auth — observed blocking PR #29 (failed CI, then passed on a plain re-run
of the identical commit) and PR #11 (failed CI on this single identity, `newFailures: 1`).

**Correcting the ticket's own framing.** The ticket (and this test's name) describes the fragile
half as "modifies the session row exactly once." Confirmed directly, not inferred: reproducing the
non-overlapping case (a throwaway experiment invoking the burst fully sequentially instead of via
`Promise.all`, deleted before this commit) produced `updateStatements=1, rowsModified=1` —
the *precondition* check failed while the *exactly-once* check still passed. The exactly-once
assertion held in every timing pattern tried (fully concurrent, half-staggered, fully sequential);
Postgres's `WHERE ... AND last_activity < $3` predicate arbitrates correctly regardless of arrival
order, exactly as DB-2 intended. The fragile half was never "exactly once" — it was "did the burst
race at all."

**What changed — `api/src/middleware/__tests__/session-activity-race.test.ts` only.** Added
`createArrivalBarrier()`, installed as a plain property reassignment of `pool.query` *underneath*
the existing `vi.spyOn` (not through `mockImplementation`, which would collapse `pool.query`'s
overloaded signature to its last — callback-style — form, the wrong shape for this codebase's
promise-based calls). Also added two dedicated, database-free unit tests for the barrier helper
itself (`describe('createArrivalBarrier ...')`) — the release-on-count-reached behavior and the
passthrough for non-matching SQL — so a regression in the barrier's own logic fails fast rather than
only showing up as a reintroduced flake in the concurrent-burst test. The barrier holds every
session-lookup SELECT until all 10 concurrent callers
have asked to send one, then releases them together.

**Concurrency argument.** While any of the 10 calls is waiting at the barrier, none of them has yet
sent its SELECT, so none has read anything, so none can have decided a write is due, so no UPDATE
can exist yet. That makes it structurally impossible for any of the 10 SELECTs to observe anything
other than the original stale `last_activity` — not "unlikely under contention" but unreachable by
construction, independent of how slow or reordered the surrounding scheduling is. Validated by
instrumenting the barrier with an arrival counter and confirming all 10 arrivals fire before release
(temporary, removed before this commit) — the mechanism engages on the real SQL, it is not a no-op.

No fixed sleep was added or would help — this is a timing-determinism fix, and a sleep only
narrows a race, it does not close it.

**Not touched:** `api/src/middleware/auth.ts` — the throttle and its `WHERE`-clause predicate are
correct and unchanged. Verified by temporarily reverting the predicate to the pre-DB-2 unconditional
`UPDATE sessions SET last_activity = $1 WHERE id = $2` (file copied aside, never `git stash`d, and
restored — `git diff` against this branch shows zero changes to `auth.ts`): the barriered test goes
red for the right reason, `AssertionError: expected 10 to be 1`, i.e. all 10 requests now
deterministically raced and all 10 landed a write against the broken code. Restored immediately
after.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/session-activity-race.test.ts
```
10 consecutive runs passed under deliberate load: 14 CPU-bound busy-loop worker processes (pure
`Math.sqrt` summation, no I/O) saturating all 14 physical cores of the host (load average
~40-54 on a 14-core machine), plus 3 concurrent full `pnpm --filter @ship/api test` suite runs
against a separate scratch database on the shared `ship-audit-pg` container, generating simultaneous
Postgres contention alongside the CPU load. All scratch load (busy-loop processes, the extra
database) was torn down after measurement. Standalone (no artificial load) and the full local api
suite (592/592) also pass. **Not verified**: reproducing the original CI failure directly on this
14-core dev machine — 20+ standalone/loaded attempts under busy-loop and concurrent-suite load did
not reproduce a failure against the pre-fix test, consistent with the mechanism needing CI's
specific 2-vCPU-shared-with-Postgres constraint rather than raw CPU contention on a larger box. The
fully-sequential white-box experiment (above) is the direct confirmation of the failure mode in lieu
of that reproduction.

**How to roll it back.** Revert this commit; the prior test file returns with the same
scheduling-dependent precondition. No production code, migration, or other file changes to undo.

---

## TRO-223 (TEST-1) — the web unit suite is green, and `pnpm test` now actually runs it

**13 web unit tests failed, in 3 files, and the root `pnpm test` never ran them.** Root `"test"` was
`pnpm --filter @ship/api test`, so `pnpm test` reported green while those 13 stayed red. CI *did*
run the web suite (`.github/workflows/ci.yml:105-118`, under `continue-on-error` with a quarantine
diff), so the failures were visible there — they were invisible to anyone running the suite locally,
which is where they needed to be caught. The suite
was 151 tests when the factory captured its baseline and 172 by the time this branch measured it —
the same 13 failing in both. They were five months of accumulated drift that a suite nobody ran
could not catch.

**The judgement this ticket turned on: for each failure, was the test wrong or the source wrong?**
It was not uniform, and it did not fall the convenient way. Of the 13: **11 were stale
assertions**, **1 was a source defect**, and **1 was a defect in the test harness**.

*Stale tests — 11 (source was right, assertions were corrected — a correction, not a weakening):*

- **`sprints` → `weeks` (5 assertions).** `7713ef0` renamed the tab id in both the project and
  program configs. `e2e/project-weeks.spec.ts:121` navigates to `/documents/:id/weeks`, confirming
  the new id is the live contract. Tests still asserted `'sprints'`.
- **Project tabs reordered (1 assertion).** `b1e4c5a` ("streamline navigation") moved `details`
  below `issues`, so a project opens on its issue list. The test asserted `details` was first.
- **Sprint documents gained tabs (2 assertions).** `9f77237` added a status-aware sprint tab set,
  landing *after* the test file was written. The tests asserted sprints had none.
- **`DetailsExtension` content model (1 assertion) and schema construction (2 errors).** The node's
  `content` is `'detailsSummary detailsContent'`; the test asserted `'block+'` and built an `Editor`
  without the two child nodes, so ProseMirror threw `No node type or group 'detailsSummary' found`.
  `Editor.tsx:628-630` registers all three together — the test now does the same.

*Source defect — 1 (the test was right; the product was fixed):*

- **`web/src/lib/document-tabs.tsx` — the project Weeks tab stopped showing its count.** In one
  hunk, `7713ef0` renamed the id *and* collapsed `label` from a count function to the bare string
  `'Weeks'` — while leaving the identical function intact on the program tab beside it. That
  asymmetry inside a single commit is the fingerprint of an accident, and
  `UnifiedDocumentPage.tsx:133,141` still fetches project weeks and computes `weeks:
  projectWeeks.length` for a consumer that no longer existed. Label function restored; the two
  callbacks are now byte-identical.

*Test-harness defect — 1 (no product code changed):*

- **`web/src/hooks/useSessionTimeout.test.ts` — the stub, not the hook, caused the phantom logout.**
  `lib/api.ts` reads `response.headers.get('content-type')`; the stub had no `headers`, so `apiPost`
  threw a `TypeError`, and `resetTimer` catches every throw as "network error — force logout".
  Observed, not inferred: stderr printed `Network error extending session - forcing logout` — the
  `catch` branch — and never `Failed to extend session`, the `!response.ok` branch. **The assertion
  was correct and is untouched, and the hook's fail-closed logout was deliberately left alone**: a
  session that cannot be extended *should* end. Only the stubs changed — they now hand the code
  under test a real `Response`. Two new tests assert the logout still fires when extend-session
  returns non-ok or rejects, so "fixed the stub" and "neutered the logout" cannot be confused.

**Also changed.** Root `"test"` is now `test:api && test:web`, with `test:api`/`test:web` for
single suites. CI already ran both (`.github/workflows/ci.yml:105-118`) and diffs them against the
quarantine baseline, so this closes the *local* gap only — it does not duplicate CI. All 13
entries were removed from `audit/factory/quarantine.json`; both suites are now green on arrival.
`README.md:43`, which documented this finding as open, is updated.

**Run it.**

```bash
pnpm test:web                    # 345 passed / 345 total, 33 files
pnpm test                        # api (needs DATABASE_URL), then web
scripts/factory/gate.sh          # full evidence gate
```

Those totals are measured on this branch *after* merging `main` a second time (`main` moved from
`84f05ff` to `f7b15c9`, nine more PRs, including route-level code splitting and a deferred editor).
That merge brought in another round of web test files written by other tickets. Sequence of
measurements on this branch: 186 tests before the first `main` merge, 214/214 across 24 files
after it, 345/345 across 33 files after this second one — the 13 identities this ticket fixes did
not change across any of those merges, only the file count around them did.

15 test cases were added to the three repaired files: sprint status-aware tab selection (previously
uncovered — which is how `getTabsForDocumentType('sprint')` drifted from `[]` to four tabs
unnoticed), project/program week count-label symmetry, the zero-count convention asserted across
every count-aware label, a guard that no config exposes a `'sprints'` id again, `setDetails`
document structure, and the two session fail-closed tests. Assertions in the three repaired files
went from 131 to 147.

**Correction post-merge.** The `fix(web): drop test-side casts` commit's message claimed both
test-side casts flagged by CodeRabbit were removed. Only the `useSessionTimeout.test.ts` fetch cast
was; `DetailsExtension.test.ts`'s pre-existing `(editor.commands as any).setDetails` — inside the
same quarantined test this ticket claims to have fixed, `should allow inserting details via
command` — was untouched and still present after merging `main`. Removed now (no cast needed:
`setDetails` is typed via module augmentation, same as the sibling test already relied on).
`node scripts/factory/review-patterns.mjs main` reports clean before and after, because the cast
predates this branch and G7b only diffs added lines — it would not have caught this on its own.

**Roll back.** `git revert` the commits on `fix/test-1-web-suite-green`. Reverting restores the 13
failures, so the `knownFailing` list in `audit/factory/quarantine.json` must come back too —
otherwise the gate reads them as new regressions and fails every branch.

`previousCapture` now carries the 13 identities directly, under `previousCapture.webKnownFailing`.
Copy them back into `packages.web.knownFailing`; no git archaeology required.

Two traps were found while writing this, both worth knowing:

- `previousCapture` originally held only `capturedAt`, `capturedAtCommit` and `totals` — so the
  earlier instruction to "restore from `previousCapture`" pointed at data that was not there.
- The obvious replacement was equally wrong. `capturedAtCommit` (`ae2a00e`) is the commit the
  **measurement** was taken against; `audit/factory/quarantine.json` **did not exist yet** at that
  commit, so `git show ae2a00e:…` fails outright. The file was introduced at `ea2dcd3`, now recorded
  as `previousCapture.fileAtCommit`.

That is why the identities are stored inline rather than referenced: a rollback instruction is read
under pressure, and two successive versions of this one pointed somewhere that could not answer.

---

## TRO-284 (ERR-11) + TRO-285 (ERR-12) — the collaboration server stops dropping frames and serving blank documents during its own document load

**The user-facing cost.** Two ways a collaborative editor could load and simply show nothing, with
no error anywhere. ERR-11: a client's very first sync message could vanish silently, so the editor
sat empty forever with no server reply. ERR-12: a second person opening the same not-yet-open
document at the same moment as a first could get a blank document that never fills in. Observed for
ERR-12, non-deterministically, at `--workers=1 --retries=0`: run 1 clean, run 2 the weekly **plan**
opened blank, run 3 the **retro** opened blank.

**Root cause — one mistake, found three times.** `wss.on('connection')` in
`api/src/collaboration/index.ts` is `async` and `await`s a database round trip before the socket is
fully wired up. Everything registered after that `await` — a message listener, a shared cache entry
— is exposed to whatever arrives in the gap between the moment a connection becomes reachable and
the moment it can actually respond. This is the same defect class as the already-merged ERR-10 (an
`'error'` listener attached after an `await`); ERR-11 and ERR-12 are the `'message'`-listener and
document-cache versions of it, found independently by two different agents on the same day.

- **ERR-11**: `ws.on('message')` was registered only after `await getOrCreateDoc()`. A
  `y-websocket` client sends sync step 1 on the very first tick after `'open'`; a frame landing in
  the gap had no listener, and Node's `EventEmitter` discards an event with no listener **silently**
  — no error, no log, nothing. The server never replies with step 2, so the client never learns the
  server's state. Observed deterministically on loopback before the fix: frames received were
  `[3, 0, 1, 1]` (cache-clear, the server's own step 1, two awareness updates) and no step 2, ever.
- **ERR-12**: `getOrCreateDoc()` (`api/src/collaboration/index.ts`) published a brand-new `Y.Doc`
  into the shared `docs` map **before** awaiting the database read and the JSON→Yjs conversion, and
  attached the broadcasting `doc.on('update')` handler only afterwards. A second connection arriving
  in that gap found the doc already cached — so it triggered no load of its own — received the
  **empty** doc as its server state, and had no listener yet attached to notice when the real
  content landed a moment later.

**What changed.**

- **ERR-11.** `ws.on('message')` is now registered as a **bounded buffering handler** right after
  ERR-10's error-listener registration (still the first statement) and, like it, before the `await`.
  Frames that arrive before the document has
  loaded are queued, not processed — processing them early against a `doc`/`Awareness` that do not
  exist yet would just move the bug. Once the load finishes, the buffering listener is swapped for
  the real one and the queue is drained, in order — all within the same uninterrupted synchronous
  stretch of code that already sent the server's own sync step 1, so replying to a drained client
  step 1 remains race-free, the same invariant `concurrent-merge.test.ts` already relied on for the
  server's outbound step 1. The buffer is bounded at **1 MiB of buffered bytes**
  (`MAX_PRELOAD_BUFFER_BYTES`): this handler sees attacker-controlled bytes before their content can
  be validated (ERR-10's own finding), so an unbounded queue during the load window is a
  memory-exhaustion vector. Exceeding the bound closes the socket with a new code,
  `WS_CLOSE_PRELOAD_BUFFER_FULL` (4429, mnemonic HTTP 429), rather than growing further.
- **ERR-12.** The `docs` map now stores the **load promise**, not the eventual `Y.Doc`
  (`loadDoc()` / `getOrCreateDoc()`). A second caller arriving while the first is still loading
  awaits that same promise and is guaranteed a fully-loaded doc — there is no intermediate step at
  which an unloaded doc is ever handed to anyone, which removes the window rather than narrowing it.
  `doc.on('update')` is attached before the database read / JSON→Yjs conversion, not after, so the
  very first update — the one that carries the loaded content — has a listener. A failed database
  read now **rejects** (previously it was swallowed and the doc silently stayed empty) and
  **evicts** its own map entry, but only if it is still the current entry — a caller that arrived
  after the failure may already have published a fresh attempt of its own, and an unconditional
  delete would tear that down instead. Malformed *stored data* (a corrupt `yjs_state` blob,
  unparsable JSON `content`) is deliberately **not** treated the same way: retrying decodes the exact
  same bytes again, so those two branches keep their own try/catch and fall back to an empty
  document, matching this function's behavior before ERR-12.

**Concurrency argument.** Both fixes close the window instead of narrowing it. ERR-11 no longer
depends on the message listener winning a race against the database read, because every frame that
can arrive before the doc is ready is captured (bounded) and replayed in order — there is no gap
left in which a frame has nowhere to go. ERR-12 no longer depends on one connection's read of the
`docs` map happening to land after another's load completes, because the map holds the one promise
every concurrent caller converges on; "the doc is in the map but not yet loaded" is no longer a
state the map can be in.

**Provenance, marked.** ERR-11's mechanism was reproduced directly (not merely reasoned about): a
regression test connects and writes in the same tick as `'open'`, red on the pre-fix module with the
exact `[3,0,1,1]` frame signature the ticket predicted. ERR-12's two-concurrent-caller mechanism was
also **observed directly** — a test issues two `getOrCreateDoc()` calls back to back and shows the
second one returning an empty doc on the pre-fix logic, an `AssertionError`, not a crash — which is a
step up from "derived from code, not instrumented," the state this finding was in when picked up.
What was **not** independently instrumented is a live two-socket connection count in a running
server outside the test harness; the two-real-socket regression test below is the closest evidence
of that shape and it is described as such, not as proof of a separately-measured connection count.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/preload-message-buffer.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-doc-load.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts
```

`preload-message-buffer.test.ts` (ERR-11): a frame sent in the same tick as `'open'` is processed,
not dropped; flooding past `MAX_PRELOAD_BUFFER_BYTES` closes the socket with
`WS_CLOSE_PRELOAD_BUFFER_FULL` instead of growing the queue. Both cases force a **real** load delay
(no mocked timing) by seeding the target document with a large `content` value, which measurably
slows the one database read `loadDoc()` issues (~70-110ms observed locally for a 20MB value, versus
well under 1ms for a small row) — long enough to reliably land inside the window without touching
production internals.

`concurrent-doc-load.test.ts` (ERR-12): two `getOrCreateDoc()` calls issued back to back resolve to
the same, fully-loaded doc; a load failure (a syntactically invalid UUID — a real Postgres error,
not a mock) rejects and evicts, proved by observing that a second call issues a **fresh** query
rather than reusing a cached rejection; two real clients connecting simultaneously to the same
not-yet-loaded document both receive the seeded content rather than a blank one.

`concurrent-merge.test.ts` (TRO-226/TEST-4, already on `main`) documented the ERR-11 drop as a
workaround: it withheld a client's sync step 1 until after the server's first frame, specifically to
dodge the bug. That workaround is now removed — the acceptance signal for ERR-11 — and the file
still passes: red first (2 of 4 cases timed out waiting for sync step 2, frame signature
`[3,0,1,1]`), green and **faster** after the fix (10.5s vs 44.5s wall time, no timeouts).

No fixed sleeps (TEST-11 / TRO-233): every wait is an observable — a socket `'close'` event, a
database row polled until a predicate holds, or a Yjs `update` event.

**How to roll it back.**

```bash
git revert <commit>
```

No schema change, no migration, no config, no API surface change for a well-behaved client. Reverting
restores both windows: `ws.on('message')` moves back after the `await`, and `docs` goes back to
storing the doc directly instead of its load promise.

---

## TRO-279 — [DB-12] Concurrent `pnpm db:migrate` is broken — 5 of 6 simultaneous schema applies failed

**What was broken.** `CREATE TABLE IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`) is
check-then-create, not atomic. Two `pnpm db:migrate` processes racing against the same database
could both pass the existence check and both attempt the create; one loses on the catalog's unique
index. `Dockerfile:35` runs migrations on every container boot, so a rolling deploy, a scale-out, or
a crash-restart overlapping a fresh boot runs this concurrently against one database — this is not a
theoretical race, it is the normal shape of this deployment.

**Why it was worse than a failed deploy.** `applySchema` runs `schema.sql` as one simple query, so
Postgres executes it as a single implicit transaction: a duplicate-object error at statement *k*
rolls back statements 1..*k*-1 too. PR #8 (TRO-178) put `42710` in the tolerated-error set and added
a retry, which recovers *that* case — but the raw race mostly raises **23505** (`unique_violation` on
`pg_type_typname_nsp_index`), which is deliberately *not* tolerated (23505 is the generic
unique-violation code; tolerating it would also swallow a genuine data conflict). Left unfixed, a
losing run under a still-tolerant retry policy could apply nothing and still exit 0 — DB-1's exact
failure mode, reachable only through this race.

**What changed.** `api/src/db/migrationRunner.ts` — `runMigrations` now takes one Postgres
**session-level advisory lock** (`pg_advisory_lock` / `pg_advisory_unlock` on a fixed key,
`MIGRATION_ADVISORY_LOCK_KEY = 0x53686970`, spelling "Ship" in hex) around the entire run: `applySchema`,
`ensureMigrationsTable`, and the migration loop in `runPendingMigrations`. The lock is acquired
**before** anything else touches the database — in particular before `runPendingMigrations`' first
query, the `schema_migrations` read — because locking after that read would preserve the exact race
this closes.

- A single `PoolClient`, checked out once for the whole run, now flows through
  `applySchema`/`ensureMigrationsTable`/`runPendingMigrations` instead of each call going through
  `pool.query(...)` independently. `runPendingMigrations` no longer opens its own connection per
  migration file; each migration's transaction now runs sequentially on the one client that holds
  the lock. This means the fix does not depend on the pool having a second connection free while the
  lock-holder is checked out — it works even against a pool sized for exactly one connection.
- The lock is released in a `finally` on every exit path, success or failure. The unlock call is
  wrapped in its own inner `try/catch` so that if unlocking itself fails, it cannot mask a real error
  already propagating from the migration work. If the explicit unlock did not run or failed, the
  connection is force-destroyed (`client.release(true)`) instead of returned to the pool — ending the
  session is the backstop that still releases the lock even when the explicit unlock command could
  not be sent.
- **Concurrency argument.** A second `pnpm db:migrate` process blocks at `pg_advisory_lock` until the
  first releases (or its session ends), so the two runs' critical sections cannot overlap in time —
  this closes the window rather than narrowing it. A runner that dies while holding the lock does not
  wedge every future run: session-level advisory locks are released when their session ends, cleanly
  or otherwise (documented Postgres behaviour), and this is verified directly — not just assumed —
  by a test that opens a lock, ends that connection without unlocking, and confirms a second
  connection can then acquire it immediately.
- **`applySchema`'s duplicate-object retry (from PR #8) is left in place, not removed.** With the
  lock held, only one session is ever inside `applySchema` at a time, so the concurrent case it was
  added for should no longer reach it — but it is still the correct response to a genuine
  non-concurrent duplicate-object error (a stray manual `psql` session, a future caller that bypasses
  the lock), and removing a defensive path that is merely believed-unreachable is out of scope here.
- **The tolerated-error set is unchanged — 23505 is still not in it.** Widening it would swallow a
  real data conflict the day `schema.sql` stops having zero DML; the lock removes the need to
  tolerate the concurrent case at all, which is the point of fixing this at the actual race instead
  of widening what errors are forgiven.
- Regression tests: `api/src/db/__tests__/migrationLock.test.ts` (new). `MIGRATION_ADVISORY_LOCK_KEY`
  is now exported from `migrationRunner.ts` so tests can assert the lock is actually free via
  `pg_try_advisory_lock`, rather than only inferring release from a second run's success.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate
pnpm --filter @ship/api test src/db/__tests__/migrationLock.test.ts
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts   # DB-1 regressions, unaffected
```

**Verified**, all against PostgreSQL 15 in the `ship-audit-pg`-style container on `:5433`, using the
real `tsx src/db/migrate.ts` entry point (what `pnpm db:migrate` invokes) unless noted:

- **Before the fix** (pre-fix `migrationRunner.ts` restored from `main`, six `tsx src/db/migrate.ts`
  processes launched concurrently against one fresh throwaway database): 1 of 6 exited 0, 5 of 6
  exited 1, all five with SQLSTATE `23505` on `pg_type_typname_nsp_index` — reproducing the ticket's
  numbers with this branch's own harness before trusting it.
- **After the fix**, same harness, a fresh throwaway database: all six processes exited 0,
  `schema_migrations` held exactly 42 distinct rows, no duplicate-object or unique-violation output
  in any of the six logs.
- A single, non-concurrent `tsx src/db/migrate.ts` against a fresh throwaway database: exit 0, 42/42
  migrations recorded.
- A genuine failure (a deliberately broken migration file added temporarily, removed immediately
  after) via the real CLI: exit 1, naming the failure — DB-1's exit-non-zero guarantee still holds
  and is unaffected by this change (`migrate.ts` itself was not modified).
- `api/src/db/__tests__/migrationLock.test.ts`, run against the **pre-fix** runner first: the
  six-concurrent-runs test failed with five real `23505` `unique_violation` errors (red for the
  right reason); the two lock-semantics tests failed too, but because `MIGRATION_ADVISORY_LOCK_KEY`
  does not exist on the pre-fix module — expected, since those tests exercise a lock that does not
  exist yet. Restoring the fix turned all three green.
- `pnpm --filter @ship/api test` (full suite, factory database `ship_wt_tro_279`): 43 files, 595
  tests, all green.
- `pnpm --filter @ship/api exec tsc --noEmit`: clean.

**Not verified.** No run against PostgreSQL 16 (production; CI and this work run pg15 — see the pin
in `.github/workflows/ci.yml`), and no run against production or shadow. The advisory-lock mechanism
itself is standard Postgres behaviour independent of major version, but this was not measured against
16 directly.

**Rollback.** `git revert` the commit(s) on `fix/db-12-migrate-advisory-lock`, or restore
`api/src/db/migrationRunner.ts` from `main` and delete `api/src/db/__tests__/migrationLock.test.ts`.
Rolling back returns `pnpm db:migrate` to PR #8's retry-only mitigation — `42710` recovers, `23505`
does not, and the race described above is live again. No database state is affected by rolling back;
the lock itself leaves no persistent artifact (advisory locks are session-scoped, never written to
disk).

---

## TRO-240 — [DB-11] The application's database pool negotiated no TLS while migrate and seed did

**What was broken.** Three pools connect to Ship's database with three different SSL policies.
`api/src/db/migrate.ts:32` and `api/src/db/seed.ts:44` each carried their own copy of
`ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false`.
`api/src/db/client.ts:17-26` — the pool the entire running application uses — had **no `ssl` key at
all**. A fourth pool, `api/src/db/scripts/orphan-diagnostic.ts:34`, had none either.

An absent `ssl` key is not "let pg decide sensibly". `pg`'s `ConnectionParameters` does
`this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`, and
with `PGSSLMODE` unset that resolves to `defaults.ssl`, which is `false`
(`pg/lib/connection-parameters.js:100`, `pg/lib/defaults.js:43`). So the app pool connected in
**plaintext**, unconditionally, in production.

**Why it never surfaced on AWS.** Aurora is in-VPC and the connection is internal, so plaintext
works. The gap only appears against a managed Postgres that requires TLS on a public endpoint —
i.e. every PaaS, including the Render deployment.

**Why the failure signature misdirects.** `Dockerfile:35` is
`node dist/db/migrate.js && node dist/index.js`. `migrate.ts` *did* configure SSL, so it connected,
ran, exited 0, and the `&&` proceeded — then `index.js` started and `client.ts` failed to connect.
The logs read "migration succeeded, database unreachable", which looks like a database problem
rather than a client-config one. `connectionTimeoutMillis: 2000` turned it into a fast crash-loop
instead of a legible TLS error.

**What changed.** The drift was the defect, so the fix is one decision in one place rather than a
fourth copy of the ternary. New `api/src/db/ssl.ts` exports `resolveDatabaseSsl(nodeEnv?)`, and all
four pools under `api/src/db/` now call it:

- `api/src/db/client.ts:23` — **the actual bug**; previously passed nothing.
- `api/src/db/migrate.ts:33`, `api/src/db/seed.ts:45` — inline ternary replaced by the helper.
- `api/src/db/scripts/orphan-diagnostic.ts:37` — previously passed nothing; same defect class.

The returned value is unchanged from what the scripts already did: `{ rejectUnauthorized: false }`
in production, `false` otherwise. A fresh object per call, so no two pools share a mutable TLS
config. `nodeEnv` is a parameter defaulting to `process.env.NODE_ENV` purely so the decision is
testable without env stubbing; production code calls it with no arguments.

**Behaviour outside production is byte-for-byte identical.** Local dev, CI and the factory
databases previously got `false` by pg's default and now get `false` by explicit decision.

**`rejectUnauthorized: false` was carried over deliberately, not endorsed.** It encrypts the
connection but does not verify the server certificate chain — it stops passive eavesdropping, not an
active man-in-the-middle. Managed providers sign with their own CA, absent from Node's trust store,
so verification fails without the provider bundle. A federal deployment probably wants
`rejectUnauthorized: true` plus an explicit `ca`. Tightening it here would be a silent posture
change that no test in this repo can verify, so it is left as a follow-up that needs the CA bundle
decided first. This is called out in the header comment of `api/src/db/ssl.ts`.

**Precedence — the helper is not the only input, and not the strongest.** There is a third SSL
surface besides these pools and the helper: the connection string. Raised by CodeRabbit, then
established by reading pg rather than inferring it from the finding above, and confirmed empirically
against pg 8.16.3 / pg-connection-string 2.9.1.

`pg/lib/connection-parameters.js:56` does
`config = Object.assign({}, config, parse(config.connectionString))` — the parsed URL is the **last**
source, so its `ssl` key overwrites the caller's; the comment on `:54` says so outright.
`pg-connection-string/index.js:76` sets `ssl = {}` whenever `sslmode` is present, and `:133-135` sets
`ssl = false` for `disable`. `connection-parameters.js:81` then uses that value as-is.

Effective order, weakest to strongest: **pg defaults → `PGSSLMODE` → the `ssl` option this helper
returns → `sslmode` in the connection string.**

Measured, passing an explicit `{ rejectUnauthorized: false }` throughout:

| `sslmode` in URL | effective `ssl` | on the wire |
|---|---|---|
| absent | `{ rejectUnauthorized: false }` | encrypted — our option survives |
| `disable` | `false` | **plaintext — our option is discarded** |
| `prefer` / `require` / `verify-ca` / `verify-full` | `{}` | encrypted |
| `no-verify` | `{ rejectUnauthorized: false }` | encrypted |

So `DATABASE_URL=...?sslmode=disable` silently defeated the fix, in exactly the way these strings
arrive — copied from a provider dashboard. The helper would report the right value, every test would
pass, and production would be in the clear.

The `ssl` option can never win that argument, so `resolveDatabaseSsl` **refuses to start** instead:
in production, an `sslmode` that pg resolves to plaintext throws with the parameter named and the
remedy stated. `disable` is the only such value — the other five all encrypt, and are allowed
through untouched. Outside production `sslmode=disable` is still fine, because local Postgres and
the CI container are plaintext-only.

It deliberately does **not** rewrite the URL. Silently editing an operator's explicit instruction is
the same class of mistake as the original bug: the code would report one thing and do another.

Note in passing: `sslmode=require` resolves to `{}`, which leaves Node's `rejectUnauthorized` at
`true` — stricter than this helper, and it will **fail** against a provider using a private CA. That
is a loud connection error rather than a silent downgrade, so it is left alone.

**Deployment precondition — check this before rolling out.** If the production `DATABASE_URL` in SSM
already contains `sslmode=disable`, this turns a currently-working in-VPC deploy into a startup
failure with the message above. The value lives in SSM and could not be inspected from here, so this
is stated as a risk, not a cleared check. If plaintext is genuinely intended for that deployment,
that is a decision for a human to make explicitly.

**Out of scope, deliberately.** `api/scripts/migrate-shadow.ts:32`, `api/scripts/create-test-user.ts:35`
and `api/scripts/check-db-user.ts:10,19` set `ssl: { rejectUnauthorized: false }`
**unconditionally** — a fifth and sixth policy. They are operator scripts outside
`api/tsconfig.json`'s `include: ["src/**/*"]`, always pointed at a remote AWS endpoint. Routing them
through a `NODE_ENV`-conditional helper would silently **downgrade** them to plaintext whenever
`NODE_ENV` is unset, which is how they are normally invoked. Changing them needs its own ticket and
its own verification.

**Evidence.** `pnpm --filter @ship/api test` against
`postgresql://ship:***@localhost:5433/ship_wt_tro_240` (docker `ship-audit-pg`, postgres:15-alpine),
`NODE_ENV` unset in the shell so vitest sets `test`. 31 files, **491 passed, 0 failed**.
`pnpm --filter @ship/web test`: 13 failed / 186 passed — the same 13 identities quarantined as
TEST-1 / TRO-223, in the same three files; nothing in `web/` was touched. `pnpm type-check` clean
across shared, api and web.

The regression test is `api/src/db/__tests__/ssl.test.ts` (22 cases), covering four things:

1. the decision per `NODE_ENV`, including that `production` is matched exactly, so a deploy setting
   `NODE_ENV=Production` cannot silently drop to plaintext;
2. that `client.ts`'s pool actually applies it — re-imported under a stubbed env, since the pool is
   built at module scope. **7 failed / 8 passed** against the unfixed call sites, every failure an
   `AssertionError` on the claimed behaviour, the headline being
   `expected undefined to deeply equal { rejectUnauthorized: false }` — DB-11 stated as a test;
3. the precedence above: two tests **characterise pg itself**, pinning that `sslmode=disable`
   discards the explicit option and that the other five values do not. If a future pg makes the
   option win, those tests fail, which is the signal the throw can be relaxed. Then the guard:
   **2 failed / 6 passed** against the unguarded helper, both `expected [Function] to throw an
   error`. Only two of the eight went red on purpose — the other six assert behaviour that must
   *not* change (dev still permits `sslmode=disable`, encrypting modes still pass, a malformed URL
   is still pg's to report);
4. that **no** pool under `api/src/db/` sets `ssl` to anything other than `resolveDatabaseSsl()`.
   This is what prevents recurrence — a future file adding `new Pool(...)` with its own policy fails
   the suite rather than quietly adding a fifth policy.

Beyond the suite, the **compiled** artifact was exercised directly, since `Dockerfile:35` runs
`dist/`, not the TypeScript: `NODE_ENV=production` with a clean URL yields
`{"rejectUnauthorized":false}`; with `?sslmode=disable` importing `dist/db/client.js` throws the
guard message; `NODE_ENV=development` with `?sslmode=disable` still yields `false`.

**How to run it.**

```bash
source .factory-env                                             # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test src/db/__tests__/ssl.test.ts       # 22 cases, the regression test
pnpm --filter @ship/api test                                    # full api suite: 491/491
pnpm type-check

# the guard, on the compiled artifact (throws; prints the remedy)
pnpm --filter @ship/api build
cd api && NODE_ENV=production DATABASE_URL='postgresql://u:p@h:5432/d?sslmode=disable' \
  node -e "import('./dist/db/client.js').catch(e => console.log(e.message))"
```

**Rollback.** `git revert` the commits on `fix/db-11-pool-ssl`, or by hand: delete
`api/src/db/ssl.ts` and `api/src/db/__tests__/ssl.test.ts`, drop the `ssl:` line and the import from
`client.ts` and `scripts/orphan-diagnostic.ts`, and restore the inline ternary in `migrate.ts` and
`seed.ts`. Reverting reinstates plaintext connections from the application pool. To keep the fix but
drop only the startup guard, delete the `PLAINTEXT_SSL_MODES` check in `resolveDatabaseSsl` — that
restores the state where `sslmode=disable` in `DATABASE_URL` silently wins.

**Not verified — do not read this as a fixed deployment.** No test here proves TLS actually
negotiates. Proving that needs a managed Postgres endpoint that *requires* TLS on a public address;
there is none in this repo's test environment, and the local docker Postgres speaks plaintext only,
so a passing local suite is silent on the real failure mode. What is verified is the decision logic
and its propagation to all four call sites — everything up to the socket. The claim "Render now
starts" remains **untested**; confirming it means deploying and reading the startup logs.

---

## TRO-226 — [TEST-4] Concurrent multi-client editing / Yjs merge had no executing test

**What was missing.** The CRDT is the entire justification for the Yjs architecture
(`docs/unified-document-model.md`), and nothing verified it. A regression that silently dropped one
collaborator's edits would have shipped green. Two tests looked like they covered this and did not:

- `api/src/collaboration/__tests__/collaboration.test.ts:144` "should merge concurrent Yjs updates
  correctly" exchanges updates between two bare `Y.Doc`s with `Y.applyUpdate`. That is a test of the
  yjs library. No server, no socket, no persistence — a bug in
  `api/src/collaboration/index.ts` cannot fail it.
- `e2e/mentions.spec.ts:374` is the only two-client test. It uses `browser.newPage()` (one browser,
  sequential), every assertion sits inside `if (await option.isVisible())`, and it synchronizes with
  `waitForTimeout(2000)`/`waitForTimeout(3000)`. It is also in `e2e/`, which neither `gate.sh` nor
  `.github/workflows/ci.yml` executes.

**What changed.** One new file, `api/src/collaboration/__tests__/concurrent-merge.test.ts`, in the
vitest project the gate actually runs. Four tests drive two independent Yjs clients — separate
`Y.Doc`s, separate WebSockets, separate sessions — against the real `setupCollaboration()` over real
sockets, speaking the real `y-protocols` sync protocol in **both** directions, and assert on the
`documents` row.

- **control** — one client's edit reaches `content` and `yjs_state`. Without this, a broken harness
  and a broken merge look identical.
- **different regions** — both clients append a paragraph in one synchronous block, so neither
  update is in the other's causal history. Concurrency is *asserted*, not assumed: each replica must
  not yet contain the other's marker at edit time. Then both replicas must converge to a
  byte-identical document containing both edits, and both edits must be in `yjs_state`.
- **same region** — the crux. A seeded paragraph is the contested text; both clients insert at the
  same character offset in the same `Y.XmlText`. Asserts both inserts survive, the replicas converge
  on one identical string, and the pre-existing text is intact. The interleaving *order* is
  deliberately not asserted — Yjs breaks the tie by client id, which is not stable across runs.
- **offline divergence** — one client's socket is closed, it edits anyway, the other edits online,
  then it reconnects. Asserts the offline edit is merged in rather than discarded, the online edit is
  not clobbered, and the result persists. This is the expensive regression: a user's work silently
  lost on reconnect.

Persistence is checked by decoding `documents.yjs_state` into a fresh `Y.Doc` in the test process,
not by trusting the `content` JSON mirror. `api/src/collaboration/index.ts` is **not modified** —
this is coverage only, and three branches are in flight against that file.

**Plus an additive browser spec, clearly labelled as not run by CI.**
`e2e/concurrent-editing.spec.ts` does the same two scenarios through two real
`browser.newContext()`s — separate cookie jars, separate sessions, separate IndexedDB — logged in as
two different users, typing concurrently via `Promise.all` on two keystroke streams. It covers the
one layer the vitest test cannot reach: TipTap and the real `y-websocket` client rather than a
hand-rolled protocol client. It is **additive, not the proof** — `.github/workflows/ci.yml` has no
Playwright job and `gate.sh` executes only the two vitest projects, so a test living only in `e2e/`
satisfies the gate's added-test check while never running. That is the TEST-2 failure mode, and the
file's header says so.

**No fixed sleeps.** Convergence is awaited on Yjs `update` events. Persistence — which emits no
event — is awaited by re-reading the row until a predicate holds, with a 50ms gap between reads and
a hard deadline. Every wait is a condition, never a duration guessed to be long enough (TEST-11 /
TRO-233).

**How to run it.**

```bash
cd <worktree> && source .factory-env      # api tests TRUNCATE 16 tables
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts

# the additive browser spec — deliberate, never as part of the full suite
pnpm build && npx playwright test e2e/concurrent-editing.spec.ts --workers=1 --retries=0
```

**Evidence — the test was proved capable of failing.** New coverage has no bug to go red on, so the
server was temporarily sabotaged twice (both reverted; `git diff main -- api/src/collaboration/index.ts`
is empty on this branch).

1. *Merge sabotage* — `handleMessage` was made to silently discard `messageYjsUpdate` frames from any
   client that is not the first connection in the room. Both concurrent tests failed; the control and
   offline tests still passed, so the harness was provably fine. Failure text:
   `clientA never received clientB's concurrent edit (BOB_…) — local replica:
   <paragraph></paragraph><paragraph>ALICE_…</paragraph> frames received: [3,0,1,0,1]`.
2. *Persistence sabotage* — the `UPDATE documents SET yjs_state = …, content = …` in
   `persistDocument()` was reduced to writing only `properties`. In-memory merge still worked; all
   four tests failed on the database assertion:
   `merged content never reached documents.content: database predicate never held within 30000ms
   (576 reads)`.

Both are `AssertionError`/explicit-condition failures naming the missing edit, not import or setup
errors.

The **e2e spec was proved capable of failing too**, under the same merge sabotage (rebuilt through
`pnpm --filter @ship/api build`, since the e2e harness runs `api/dist/index.js`). Both browser tests
failed with `Error: clientA lost clientB's concurrent edit / Expected substring: "BBB-…" / Received
string: "AAA-…"`, then passed again after the source was restored and rebuilt.

**Stability.** 5 consecutive standalone runs of the vitest file, 4/4 passing each time, ~10.4s per
run. Full api suite green: 473 passed / 31 files (up from 469 / 30). The e2e spec: 2/2 passing,
verified with `--retries=0` so a retry cannot mask a flake, ~33-51s for the pair on one worker.

**Coverage delta on `api/src/collaboration/index.ts`.** v8 provider, full api suite
(`vitest run --coverage`), factory database `ship_wt_tro_226` on the `ship-audit-pg` container at
`:5433`, macOS, measured twice under identical conditions with the new file present and absent:

| | statements | branches | functions | lines |
|---|---|---|---|---|
| without this test | 60.68% | 40.57% | 67.24% | 62.07% |
| with this test | **62.50%** | **45.41%** | **70.68%** | **63.04%** |

The ticket's "25.0% function coverage (7 of 28)" figure is **not reproducible today** and is not the
baseline above: `session-revocation.test.ts` (ERR-2 / TRO-189) landed on the same file earlier the
same day and had already lifted functions to 67.24%. The v8 provider also counts closures, so its
denominator is not 28. `@vitest/coverage-v8` is not a dependency of this repo; it was installed to
take the measurement and `api/package.json`/`pnpm-lock.yaml` were reverted afterwards, so
`--coverage` will not run without installing it again.

**Second new finding, not fixed here, and it probably affects other e2e specs.**
`web/src/components/ActionItemsModal.tsx` is a Radix `Dialog`, and the seeded workspace has 32
overdue accountability items, so it opens on load over the document editor. While it is open it both
covers the editor — `locator.click()` never passes hit-testing and dies as a bare 60s timeout with no
assertion — and traps focus, so `document.activeElement` can never become the editor. Observed
directly: three failed e2e runs before the dialog was identified. Any e2e test that drives the editor
after a direct `page.goto('/documents/:id')` has to dismiss it first; the new spec does. Derived, not
verified: this is a plausible contributor to the existing editor-spec flakiness in TEST-11 / TRO-233.

**New finding, not fixed here.** Building the test surfaced a real race in the server.
`wss.on('connection')` in `api/src/collaboration/index.ts` `await`s `getOrCreateDoc()` — a database
round trip — and registers `ws.on('message')` only afterwards. A client frame that arrives inside
that window has no listener and is dropped by the EventEmitter. A y-websocket client sends sync step
1 immediately on `open`, so on a low-latency link its step 1 is lost, the server never replies with
step 2, and **the client never receives the server's document state** — the editor stays empty while
the client's own state is pushed up. Observed deterministically on loopback (frames received were
`[3,0,1,1]`: cache-clear, the server's own step 1, two awareness updates, and no step 2). Derived,
not measured, for production: over a real network the client's step 1 normally arrives after the DB
read completes, so this reads as a dev/loopback defect — but the window is real and widens with
database latency. The test client works around it by sending its step 1 only after the server's first
frame, which is race-free because the server sends that frame in the same synchronous block that
attaches the listener.

**Roll back.** `git rm api/src/collaboration/__tests__/concurrent-merge.test.ts
e2e/concurrent-editing.spec.ts` and drop this entry. Nothing else on this branch touches product
code.

---

## TRO-277 — [TEST-12] Load-sensitive api flake: leaking mock queues and an unguarded shared test database

**What was broken.** The api suite failed an otherwise-good branch four times in one day, on a
different test each time, and passed on standalone re-run. `audit/factory/quarantine.json` records
api as `knownFailing: 0`, so each occurrence burned a gate attempt against the 3-retry cap. One
occurrence was on a branch touching only `web/` and `vite.config.ts`, which cannot break an api
DELETE test — so the cause was never in the ticket's diff. Two independent defects were found.

**Defect 1 — `vi.clearAllMocks()` does not drain queued once-values.** Confirmed on vitest 4.0.17:
`clearAllMocks` wipes call records but leaves unconsumed `mockResolvedValueOnce` responses queued.
A test that queues more responses than its handler consumes therefore leaves one behind, and the
next test receives that stale response first — shifting every subsequent mock in that test by one
and surfacing as a failure in an unrelated place. Five api test files combined the two.

**Defect 2 — nothing stopped two api suites from sharing one database.**
`api/src/test/setup.ts` `TRUNCATE`s 16 tables in the `beforeAll` of *every* api test file, and each
file then builds fixtures it depends on for the rest of the file. `fileParallelism: false` makes
that safe within one process and does nothing across processes. Two suites on one `DATABASE_URL`
delete each other's fixtures mid-file. Reproduced deliberately by running two suites against one
database: **18 and 20 failures**, dominated by `expected 401 to be 200` (the session row was
truncated away) and `violates foreign key constraint "documents_workspace_id_fkey"` in nested
`beforeAll` hooks — the exact shapes of all four recorded flakes.

**This also explains the phantom skips.** Two full runs had previously reported
`450 passed | 6 skipped (456)` with no `.skip`/`.todo`/`.fixme` marker anywhere in
`api/src/**/*.test.ts`. When a `beforeAll` hook fails, vitest reports that describe's tests as
**skipped, not failed** — an intermittently-absent assertion that reads as a pass. The two-suite
run reproduced it at scale: **11 and 33 skipped**, same zero markers.

**What changed.**

- `api/src/test/setup.ts` — takes a session-level Postgres advisory lock, held for the duration of
  each test file, before truncating. Concurrent suites now serialize at file granularity instead of
  corrupting each other; on timeout it fails with a message naming the cause rather than producing a
  mystery 401. Advisory lock spaces are per-database, so worktrees with their own database never
  contend, and the lock is released on disconnect so a crashed run cannot wedge the next one. The
  hook timeout is raised above the lock deadline deliberately: a hook that vitest abandons keeps
  running and would truncate outside vitest's control — that hole caused a residual failure in
  testing before it was closed.
- `api/src/routes/issues-history.test.ts`, `api/src/routes/iterations.test.ts`,
  `api/src/__tests__/activity.test.ts`, `api/src/__tests__/auth.test.ts`,
  `api/src/__tests__/transformIssueLinks.test.ts` — `resetAllMocks` in place of the clear-only
  variant. Mock factories in the first two were rewritten from `vi.fn().mockResolvedValue(x)` to
  `vi.fn(impl)`, because `resetAllMocks` restores an implementation passed to `vi.fn()` but wipes one
  chained on afterwards; a naive conversion would have turned those mocks into undefined-returning
  stubs. `issues-history.test.ts` also drops three now-redundant re-establishment lines, one of
  which was an `as any` cast.
- `api/src/__tests__/mock-isolation.test.ts` — new. Pins the four vitest semantics the fix rests on,
  and scans every api test file to fail the suite if the clear-plus-once-queue combination returns.

**Defect 3 — deadlines sized for an idle machine.** With the two mechanisms above fixed, 20 api runs
under concurrent build load still failed 6 times, and half of those failed on nothing but
`Test timed out in 5000ms` — on tests that take 10-70ms unloaded. A deadline 80x a test's normal
duration says nothing about correctness on an oversubscribed machine, and it cost a gate attempt each
time. Separately, `rate-limit.test.ts`'s 320-request burst was the single most frequent failure in
the suite, because `request(app)` binds a throwaway server per call and the burst created 320 of
them; it failed as `socket hang up` and as a 5s timeout.

- `api/vitest.config.ts` — `testTimeout` 5s → 15s, `hookTimeout` 10s → 30s. No assertion is raised or
  removed and nothing is skipped. The hook deadline is the more consequential one, because a hook
  that merely misses its deadline reports its describe's tests as *skipped* — silently dropping
  assertions instead of flagging anything.
- `api/src/middleware/__tests__/rate-limit.test.ts` — the burst binds one server for all 320
  requests, measuring the limiter instead of the ephemeral-port supply. The assertion is byte-for-byte
  unchanged: still 320 requests on one session key, still zero tolerated 429s.

**Evidence.** Red-before-green for the guard test: with two pre-fix files restored it fails with an
`AssertionError` naming `__tests__/activity.test.ts` and `routes/issues-history.test.ts`. Everything
else here is proven by repetition, since converting a mock-reset call has no meaningful unit test.

| Condition | Before | After |
|---|---|---|
| Two api suites, one database | 18 and 20 failures; 11 and 33 phantom skips | 1 failure in 950 tests; **0 skips** |
| 20 api runs under concurrent build load (load avg ~29 on 14 cores) | 6 runs failed | **1 run failed** |
| Phantom skips across those 20 runs | — | **0, in all 20** |
| `rate-limit.test.ts` alone, 25 runs under the same load | failed 3 times in 20 full runs | 25/25 |

**What is still broken, and is not fixed here.** Two residual failures remain, each seen once, and
neither is the mechanism above:

- `sprint-reviews.test.ts > POST /api/weeks/:id/review > returns 403 without auth (CSRF check first)`
  exceeded even the 15s deadline once in 20 runs — a hung request, not a slow one, so a larger
  deadline is not the answer.
- `workspaces.test.ts > POST /api/admin/workspaces > should return 403 for non-super-admin` returned
  **200** once in the two-suite run. An authorization assertion failing open deserves its own
  investigation on its own merits, separately from any flake question.

Both need their own ticket. Neither was reproduced twice, so no mechanism is claimed for either.

**How to run it.**

```bash
source .factory-env    # api tests TRUNCATE 16 tables; never run them without this

# The guard, and the four vitest semantics the fix rests on.
pnpm --filter @ship/api test --run src/__tests__/mock-isolation.test.ts

# Defect 2, directly: two suites against one database. Both must now pass.
# Before the lock they reported 18 and 20 failures, and 11 and 33 phantom skips.
pnpm --filter @ship/api test --run & (sleep 4; pnpm --filter @ship/api test --run); wait

# The repetition the flake actually needed: build load in parallel with the suite.
for i in 1 2 3 4; do (while :; do pnpm --filter @ship/api type-check; done >/dev/null 2>&1) & done
for n in $(seq 1 20); do pnpm --filter @ship/api test --run >/dev/null 2>&1 || echo "run $n FAILED"; done
kill %1 %2 %3 %4
```

**Rollback.** `git revert` the commits. The lock is confined to the test setup file and the
converted files are self-contained; nothing in `api/src` production code changed.

---

## TRO-181 (DB-4) + TRO-176 (API-5) — dashboard standups collapsed from one request per active week to one

Both findings are the same client-side fan-out seen from two sides — DB-4 from the SQL layer, API-5
from the HTTP layer — and share one fix.

**What was broken.** `web/src/pages/Dashboard.tsx:69-85` mapped the 5 active weeks returned by
`GET /api/weeks` to one `fetch('/api/weeks/${sprint.id}/standups')` each inside a `Promise.all` — 5
of the dashboard's 12 requests, each returning exactly 2 bytes (`[]`), and 25 of the flow's 42
steady-state queries (5x sprint access check, 5x standups `SELECT`, 5x the auth trio). The audit's
hypothesis held on direct inspection: the handler originally at `api/src/routes/weeks.ts:1833`
(now `:1927`, shifted down by the new route added above it) already batches issue-link lookups via
`batchLookupIssues` — the N+1 was entirely client-side, not a server defect. The per-week query also had no `LIMIT` and
shipped every standup's full `content`, though `Dashboard.tsx:92` immediately discarded everything
but the 10 most recent across all weeks.

**What changed.**

- `api/src/routes/weeks.ts` — new `GET /api/weeks/standups?week_ids=uuid,uuid,...`, registered
  *before* `GET /api/weeks/:id` so Express doesn't swallow `standups` as an `:id`. `week_ids` is
  validated with zod (`.split(',')` piped through `z.array(z.string().uuid()).min(1).max(50)`),
  rejecting anything malformed with **400** before it reaches SQL — the ids are only ever bound via
  parameterized `= ANY($1)`, never interpolated. One query narrows the requested ids to sprints that
  exist and are visible to the caller; one query fetches standups for all of them via
  `parent_id = ANY($1)`, `ORDER BY created_at DESC LIMIT 10` — server-side, so the endpoint stops
  shipping rows the client only ever discarded. Issue-link transformation reuses the existing
  `batchLookupIssues`/`transformIssueLinks` helpers, now batched once across every sprint's standups
  instead of once per sprint.
- `api/src/openapi/schemas/weeks.ts` — registered `GET /weeks/standups` (schema + zod, tags,
  summary/description) so Swagger and the generated MCP tool both pick it up.
- `web/src/hooks/useWeeksQuery.ts` — new `useRecentStandupsQuery(weekIds)`, one `react-query` call
  to the batched endpoint instead of the page doing its own fan-out.
- `web/src/pages/Dashboard.tsx` — replaced the `useState`/`useEffect`/`Promise.all` fan-out with
  `useRecentStandupsQuery`; `sprint_title`/`program_name` are now attached client-side from the
  already-fetched `activeWeeks` list (unchanged UI, unchanged `Standup` shape).
- The old `GET /api/weeks/:id/standups` route is untouched — nothing else that calls it (if
  anything does) is affected.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/weeks.test.ts -t "batched"
pnpm --filter @ship/web exec vitest run src/pages/Dashboard.standupsFanout.test.tsx src/pages/Dashboard.test.tsx
scripts/factory/gate.sh
```

The api tests assert the batched response shape, that a non-UUID or missing `week_ids` 400s, that
an unauthenticated call 401s, and that hitting the endpoint with 1 vs. 5 week ids costs the same
number of `pool.query` calls (spied directly — no query-count scaling with the number of weeks
requested). The web test does not mock `useWeeksQuery`; it lets the real hooks run against a mocked
`global.fetch` and asserts exactly one request matches `/api/weeks/standups`, and fails the test if
any request matches the old per-week shape.

**Measured, same seeded database (`ship_wt_tro_181`, postgres:15-alpine in the `ship-audit-pg`
Docker container on `:5433`), 5 active weeks x 1 standup each, one session, sequential requests, no
concurrent load from the measurement itself.** Because the old per-week route was left in place,
both sides were measured against the same running server rather than estimated: 5 sequential
`GET /api/weeks/:id/standups` calls (the old client behaviour) cost **5 requests / 30 queries**; one
`GET /api/weeks/standups` call for the same 5 ids costs **1 request / 6 queries** — an 80% cut in
both, for the standups portion of the flow specifically. The audit's own baseline (12 total dashboard
requests, 5 of them this fan-out; 42 total flow queries, 25 of them this fan-out) was not
re-measured end-to-end here — combining it with this delta (12 − 5 + 1 = 8 requests) reproduces the
audit's projected 8, which is a consistency check on the audit's number, not an independent
re-verification of the other 7 requests.

**Rollback.** Revert the commits on `fix/db-4-api-5-dashboard-fanout`. To roll back just the client
(keeping the server endpoint): revert the `Dashboard.tsx`/`useWeeksQuery.ts` changes only — the old
`GET /api/weeks/:id/standups` route still exists and still works. To remove the endpoint entirely:
delete the `router.get('/standups', ...)` block in `api/src/routes/weeks.ts` and its
`registry.registerPath` counterpart in `api/src/openapi/schemas/weeks.ts` — nothing else depends on
either.

---

## TRO-192 (ERR-5) + TRO-195 (ERR-8) — malformed path/query params returned 500 instead of 400/404

Both findings are one root cause: request **bodies** are validated up front with zod and return a
clean 400 (`createDocumentSchema.safeParse(req.body)` in `routes/documents.ts`), but path and query
params bypassed that layer entirely. `GET /api/documents/not-a-uuid` reached Postgres, failed an
`invalid input syntax for type uuid` cast, and surfaced as an uncaught 500
(`audit/error-handling/raw/probe3-api.txt`) — same for `GET /api/documents/:id/backlinks`,
`GET /api/weeks/:id`, and `?type=bogus` on the documents list (ERR-5). Separately, `?limit=-1` and
`?limit=999999999` on the documents list both returned the full ~300 KB payload, because the route
never read `limit` from the query at all (ERR-8).

**What changed.**

- **`api/src/middleware/paramValidation.ts` (new)** — the shared fix, extending the repo's existing
  body-validation pattern to params/query instead of inventing a new one:
  - `validateUuidParam` — an Express `router.param` callback. Registered once per router
    (`router.param('id', validateUuidParam)`), it guards **every** route using `:id` in that router
    against a malformed uuid, returning `{ error: 'Invalid input', details: [...] }` (the same shape
    body validation already used) instead of letting the pg cast error reach the client as a 500. A
    well-formed but nonexistent id is untouched and still falls through to the route's own 404.
  - `limitQuerySchema(max)` — a zod schema for an optional `limit` query param. Absent → unchanged
    behavior (no default cap introduced, so callers that never pass `limit` are unaffected).
    Non-numeric or non-positive (`-1`, `0`, `"abc"`) → fails validation (400). Above `max` → clamped
    down to `max` rather than rejected (ERR-8's "cap at a sane maximum").
- **`api/src/routes/documents.ts`** — `router.param('id', validateUuidParam)` guards `GET /:id`,
  `GET /:id/content`, `PATCH /:id/content`, `PATCH /:id`, `DELETE /:id`, `POST /:id/convert`,
  `POST /:id/undo-conversion`. `GET /` (list) gets a `listDocumentsQuerySchema` validating `type`
  against the full `document_type` Postgres enum (10 values, matching the already-registered
  OpenAPI `DocumentTypeSchema` — **not** the narrower 8-value set `createDocumentSchema` accepts for
  creation, since `standup`/`weekly_review` documents are created via their own routes but are real
  rows this filter already matched) and `limit` via `limitQuerySchema(100)`. When `limit` is
  provided, it is now applied as a real SQL `LIMIT`; `parent_id` handling is untouched.
- **`api/src/routes/backlinks.ts`** — `router.param('id', validateUuidParam)` guards
  `GET /:id/backlinks` and `POST /:id/links`.
- **`api/src/routes/weeks.ts`** — `router.param('id', validateUuidParam)` guards all 18 `:id` routes
  (`GET/PATCH/DELETE /:id`, `/:id/plan`, `/:id/issues`, `/:id/standups`, `/:id/review`,
  `/:id/carryover`, `/:id/approve-*`, `/:id/request-*-changes`, `/:id/scope-changes`, `/:id/start`).
  The probe's literal `GET /api/weeks/not-a-number` targets this same uuid path param — "number" was
  the malformed test string, not the field's real type.
- **`api/src/openapi/schemas/documents.ts`** — added `limit` to `GET /documents`'s documented query
  params and a `400` response, since that param is new. The `:id` uuid path params were already
  typed `UuidSchema` in every registration touched here (documents, backlinks, weeks) — the
  documented contract didn't change, only the runtime now enforces what was already promised.
  Regenerated `api/openapi.yaml` / `api/openapi.json` (additive only — `git diff --stat` shows +92/-0).

**Left alone on purpose.** `api/src/routes/issues.ts` has the identical `GET /:id` gap
(`GET /api/issues/not-a-uuid` also 500s per the probe) but was **not** touched: it has an open PR
against it right now, and both findings are fully covered by the routers above without it. Same
root cause, same fix (`router.param('id', validateUuidParam)`) would apply as a fast-follow.
`api/src/routes/associations.ts` (mounted at `/api/documents`) has the same `:id` gap and is outside
the audit's reproduced evidence — also not touched here.

**Frontend impact: none.** The only call site for `/api/documents?type=` sends `type=wiki`
(`web/src/hooks/useDocumentsQuery.ts:29`) — a valid enum value, still 200. No web code sends
`limit` to this endpoint, so the new validation and the `LIMIT` clause only activate for a query
string no current caller sends.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/param-validation-regression.test.ts
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/paramValidation.test.ts
scripts/factory/gate.sh
```

`param-validation-regression.test.ts` hits the live routes via supertest (not the middleware in
isolation), covering both tickets: malformed uuid → 400 on `/api/documents/:id`,
`/api/documents/:id/backlinks`, and `/api/weeks/:id`; well-formed-but-absent uuid → 404 on the same
two GET-by-id routes (unaffected by this change); `?type=bogus` → 400 and `?type=wiki` → 200 on the
list; `?limit=-1`/`0`/`abc` → 400; `?limit=5` against 12 seeded documents → exactly 5 rows back
(proving the `LIMIT` is real, not just accepted); `?limit=999999999` → 200, no crash.
`paramValidation.test.ts` unit-tests the two helpers directly, including clamping against a small
`max` to prove the cap logic independent of the 100-row default.

**Rollback.** Revert the commits on `fix/err-5-err-8-param-validation`, or by hand: remove the three
`router.param('id', validateUuidParam)` lines (documents.ts, backlinks.ts, weeks.ts), remove
`listDocumentsQuerySchema`'s use in `documents.ts`'s `GET /` (restore the raw `req.query`
destructure and drop the `LIMIT` clause), delete `api/src/middleware/paramValidation.ts` and its
three imports, and revert the `limit`/`400` additions in
`api/src/openapi/schemas/documents.ts` (then re-run `pnpm --filter @ship/api openapi:generate`).

---

## TRO-197 (BUN-1) + TRO-198 (BUN-2) + TRO-199 (BUN-3) + TRO-200 (BUN-4) + TRO-202 (BUN-6) — the app stops shipping as one 2 MB file

Five findings, one root cause: `web/dist/index.html` referenced exactly **one** module script —
2,074.98 kB raw / 588.62 kB gzip — because nothing in the app split at a route boundary. Everything
else followed from that. There was no seam at which to defer the editor (BUN-2), the syntax
grammars (BUN-3) or the emoji picker (BUN-4), and no vendor chunk to cache (BUN-6). They ship as one
branch because fixing any one of them alone moves almost nothing.

**What a user actually downloads now**, by route. This is the static-import closure of the entry
chunk plus that route's chunk — not the `index.html` figure, which code splitting improves by
construction and therefore flatters any change of this kind:

| Route | Before | After | Change |
|---|---:|---:|---:|
| `/login` (unauthenticated first paint) | 601.47 kB gzip | **117.34 kB** | −484.13 (−80.5%) |
| `/docs` (4-panel layout + list) | 601.47 kB gzip | **181.92 kB** | −419.55 (−69.8%) |
| `/documents/:id` (layout + editor shell) | 601.47 kB gzip | **211.39 kB** | −390.08 (−64.9%) |

The audit's target was 600.75 → ≤ 480.60 kB gzip. Every route clears it. Total emitted bytes are
essentially unchanged (1,761.82 → 1,770.55 kB gzip, +0.5%) — as the audit predicted, this moves
bytes rather than deleting them, and total-bundle size is the wrong yardstick for it.

**The metric itself was corrected before these numbers were trusted.** The first version of
`audit/bundle/measure.mjs` derived each route's closure by walking `import "./x.js"` specifiers out
of the emitted chunks. That walk cannot see stylesheets, so CSS belonging to a lazy chunk was
omitted and every route read smaller than it is — the replacement for a flattering metric was
flattering in the same direction (CodeRabbit finding 1 on PR #14). It now reads
`dist/.vite/manifest.json` and follows `imports` while collecting `css` at every node, which is the
same graph Vite uses to emit modulepreload and stylesheet links.

Re-measured, the correction moves the numbers by **+0.05 kB gzip on `/login`, +0.02 on `/docs`,
+0.05 on `/documents/:id`** — the 80.5% headline stands. It is small for a specific reason worth
recording rather than glossing: this app's only lazy stylesheet is `assets/vendor-editor-*.css`
(1.41 kB raw / 0.53 kB gzip, the editor's Tippy styles), and it hangs off `vendor-editor`, which is
reachable only through the editor's dynamic import — so it was never inside any route's *static*
closure, and the entry stylesheet was already counted via the `index.html` `<link>`. The old method
was wrong; today's answer happened to be nearly right. The fix is what stops the next CSS-bearing
lazy chunk from going unmeasured silently.

**Conditions** (all figures): Node v23.2.0, pnpm 10.27.0, gzip level 9, kB = 1000 bytes, baseline
`main` at `4d74602`. Reproduce from the repository root:

```bash
cd web && pnpm build && cd .. && node audit/bundle/measure.mjs web/dist
# deploy churn also needs a previous dist to compare against:
#   node audit/bundle/measure.mjs web/dist --baseline /path/to/previous/dist
```

**Build from `web/`, not the repo root** — Tailwind's `content` globs resolve against the CWD, so
building from the root silently under-generates the CSS. The `cd ..` matters too: the script's paths
are relative to the repository root, so running it from `web/` cannot find `web/dist`.

The baseline was rebuilt from `main` in an isolated `git archive` copy rather than by mutating this
worktree, so every before/after pair comes from the same tool and the same machine.

**TRO-197 / BUN-1 — route-level code splitting** (`web/src/main.tsx`, `web/src/pages/App.tsx`,
`web/src/components/RouteFallback.tsx`). All 23 page components were statically imported, so a
visitor on `/login` downloaded the admin dashboard, the org chart, the reviews queue and the whole
TipTap/Yjs stack before the login form could paint. Every page is now `React.lazy`; most use named
exports, hence `.then(m => ({ default: m.X }))`. **`LoginPage` deliberately stays static** — it is
the first paint for an unauthenticated visitor, and deferring it would trade one oversized download
for two round trips before the form appears.

Two Suspense boundaries, and the placement is the whole risk: the outer one (in `main.tsx`) covers
the standalone routes and `AppLayout` itself; the inner one sits **inside `<main>` in
`pages/App.tsx`**, so the Icon Rail, Contextual Sidebar and Properties Sidebar stay mounted while a
page chunk loads. A single boundary above `AppLayout` would tear the 4-panel layout down and rebuild
it on every navigation — the flash the audit warned about.

Measured on its own (2, 3, 4 and 6 reverted on the final tree): /login 601.47 → 112.40 (−489.07),
/docs 601.47 → 176.86 (−424.61), /documents/:id 601.47 → 530.49 (−70.98) kB gzip.

**TRO-198 / BUN-2 — the editor loads when an editor is shown** (`web/src/components/LazyEditor.tsx`;
consumers `UnifiedEditor.tsx`, `pages/PersonEditor.tsx`). `@tiptap/*` + `prosemirror-*` + `yjs` +
`lib0` + `y-*` + `linkifyjs` are 726.5 kB raw / 208.7 kB gzip and were pulled statically by every
route that *could* show an editor — including project, program and week documents, which render a
tab component and never mount one. `LazyEditor` is **not a second editor**: it is the same shared
`components/Editor` behind a dynamic import, with the prop type derived from it so the contract
cannot drift.

Safe because `Editor` creates its own `Y.Doc`, `WebsocketProvider` and `IndexeddbPersistence` inside
its own effects and neither consumer holds a ref to it — deferring the mount defers the whole
collaboration setup as a unit rather than interleaving it. `initialTitle` is forwarded verbatim, so
the `"Untitled"` placeholder contract is untouched. Measured on its own (static import restored on
the final tree): **/documents/:id 442.95 → 211.39 kB gzip, −231.56**, the largest single win here.

**TRO-199 / BUN-3 — 37 syntax grammars down to 12** (`web/src/components/editor/lowlight.ts`,
`Editor.tsx:12`). `createLowlight(common)` registered arduino, vbnet, objectivec, r, lua, perl,
wasm and 30 others. Kept: **bash, css, diff, javascript, json, markdown, python, shell, sql,
typescript, xml (covers html), yaml**. Verified no seeded document is affected: zero of the 523
documents in the seeded database contain a `codeBlock` node (in `content` or in `yjs_state`), and
neither `api/src/db/seed.ts` nor `welcomeDocument.ts` emits one; the only language named anywhere in
the repo is `javascript`, in `e2e/syntax-highlighting.spec.ts`.

**Correction to what this entry first claimed.** It said a dropped language "renders as plain
monospace rather than throwing". That was inferred from a grep of the extension's guard, not from
running it, and it is wrong. Reading `getDecorations` in
`node_modules/@tiptap/extension-code-block-lowlight/dist/index.js` in full, the fallback is
`lowlight.highlightAuto(text)`, not "no highlighting":

```js
const nodes = language && (languages.includes(language) || registered(language) || lowlight.registered?.(language))
  ? getHighlightNodes(lowlight.highlight(language, text))
  : getHighlightNodes(lowlight.highlightAuto(text));
```

So a code block tagged `arduino` is **still highlighted**, by auto-detection among the grammars we
kept — observed, not derived: rendering that block through the real extension produces
`<span class="hljs-keyword">void</span>`. The degradation is better than reported, and the regression
risk of BUN-3 is correspondingly lower. Two further things that grep hid: `registered()` consults
highlight.js's *own* singleton bundled inside the extension, not our instance, so
`languages.includes()` off `lowlight.listLanguages()` is the check that actually carries our curated
list; and the author's `language-arduino` class is preserved on the `<code>` element, so re-adding a
grammar later restores exact highlighting. All three facts are now pinned by tests that drive
`CodeBlockLowlight` itself rather than the raw lowlight instance (CodeRabbit finding 2).

Measured on its own: the grammar chunk drops 52.22 → 22.56 kB gzip (−29.66), and total emitted bytes
fall 29.52 kB. It does not move any route's payload (211.38 vs 211.39 on `/documents/:id`, i.e. noise),
because BUN-2 already moved the editor off every route's static closure — BUN-3's win is in the chunk
that arrives when the editor mounts.

**TRO-200 / BUN-4 — the emoji picker loads on click** (`web/src/components/EmojiPickerBody.tsx`,
`EmojiPicker.tsx`). `emoji-picker-react` shipped on every page load, `/login` included, for one
consumer: the project-icon `PropertyRow` in `ProjectSidebar`. The package import now lives in its
own module — that, not the `React.lazy` call, is what creates the boundary; naming the package at
value level in `EmojiPicker.tsx` (for its `Theme` enum, say) would pull it all back while the code
still looked correct. The fallback is sized 300×350 so the popover does not resize under the cursor.
Measured on its own (static import restored on the final tree): **/documents/:id 274.75 → 211.39 kB
gzip, −63.36**, for a component behind a click.

**TRO-202 / BUN-6 — a vendor split, judged on bytes changed per deploy** (`web/vite.config.ts`).
The config had no `build` key at all, so stable dependency code shared a content hash with volatile
app source. **This does not reduce the initial payload — it costs about 5 kB gzip per route** — and
scoring it on `initialGzipKb` would read as a no-op or a regression. The right measurement is what a
returning user with a warm cache re-downloads after a routine deploy. Editing one string in
`web/src/pages/Login.tsx` and rebuilding:

| Route | Before | BUN-1..4 only | After (with BUN-6) |
|---|---:|---:|---:|
| `/login` | 588.61 kB gzip (97.9% of route) | 99.87 kB (88.9%) | **31.70 kB (27.0%)** |
| `/docs` | 588.61 kB gzip (97.9%) | 164.09 kB (92.8%) | **67.23 kB (37.0%)** |
| `/documents/:id` | 588.61 kB gzip (97.9%) | 193.13 kB (93.6%) | **96.31 kB (45.6%)** |

BUN-6's own contribution is the last column against the middle one: **−68.17 kB on `/login`, −96.86
on `/docs`, −96.82 on `/documents/:id`** per deploy, for +4.96 to +5.09 kB on a first visit
(/login 112.40 → 117.34, /docs 176.86 → 181.92, /documents/:id 206.30 → 211.39).

Two rules are encoded in the config and both were found by measuring, not by reasoning. **Never
merge a lazily-reachable package into an eagerly-reachable chunk** — a manual chunk loads as soon as
anything in it is statically reachable, so a catch-all `vendor` would have silently undone BUN-2 and
BUN-4 while the split still existed on disk. And **Rollup's CommonJS interop helpers must be pinned**:
left unassigned they landed in `vendor-highlight`, which every chunk then imported, dragging 22.6 kB
gzip of syntax grammars back into first paint. A `vendor-ui` group for Radix/cmdk/dnd-kit was tried
and **rejected on measurement** — it cost 15.0 kB gzip on `/docs` and `/documents/:id`, because a
route needing one primitive then downloads all of them.

**Build config also now emits a manifest.** `build.manifest: true` is what lets
`audit/bundle/measure.mjs` see the CSS graph. It ships `dist/.vite/manifest.json` to S3/CloudFront
with the rest of `dist`; it exposes chunk names, which are already enumerable from the entry chunk,
and no source paths beyond the module ids already present in the bundle. Keeping it on means the
build that is measured is the build that is deployed.

**New dependency:** `highlight.js` is now an explicit dependency of `@ship/web`. It was already in
the tree via `lowlight`, but importing individual grammars from it without declaring it would be a
phantom dependency. No new package entered the lockfile's resolution set.

**Regression tests** (all in `web/src/**`, so `scripts/factory/gate.sh` actually executes them — an
`e2e/` spec satisfies the gate's "test added" check while never running):

- `web/src/test/sourceImports.ts` + `sourceImports.test.ts` — **the guard behind the guards.** Three
  tests below assert that a module is never statically imported, which is the only thing keeping a
  split boundary from silently re-merging. Each originally carried its own narrow regex, and review
  found two of them (CodeRabbit findings 3 and 4) matched only the single form that was written at
  the time. Verified by injecting a static page import into `main.tsx` in seven forms — named with
  double quotes, default, namespace, multi-line braces, side-effect, relative path, re-export: **the
  old regex missed all seven; the shared detector catches all seven.** 30 tests cover the forms it
  claims to catch and the type-only/dynamic/commented forms it must ignore.
- `web/src/main.routes.test.ts` — no page may be statically imported except `Login`; every lazy
  loader names a real export; the child-route Suspense boundary stays inside `<main>`. **Red before
  the fix** (4 assertion failures against `main`'s `main.tsx`/`App.tsx`).
- `web/src/components/editor/lowlight.test.ts` — two blocks. The registry block asserts the grammar
  list is exactly the curated 12: **red before the fix** (9 assertion failures against
  `createLowlight(common)`). The integration block drives a real `Editor` with
  `CodeBlockLowlight.configure({ lowlight })` and asserts on rendered DOM, because nothing in the
  registry block proved the extension ever reaches our registry (CodeRabbit finding 2). Its
  discriminating case: for `+added line`, the `diff` grammar emits `hljs-addition` while
  auto-detection emits `hljs-selector-tag`, so a silent fall-through to `highlightAuto` fails the
  test where a language-class check would pass. It also pins that a dropped language does not throw
  and that the code survives byte-for-byte. Regression guard, not red-before-green — `common`
  contains those grammars too.
- `web/src/components/EmojiPicker.test.tsx` — picker opens on click, closes on Escape, clears
  through `onChange`, the package import stays out of `EmojiPicker.tsx` and stays in
  `EmojiPickerBody.tsx`. The import assertions were **red before the fix**; the interaction tests are
  regression guards and passed both ways, which is their purpose.
- `web/src/components/LazyEditor.test.tsx` — the editor still mounts, `"Untitled"` is forwarded
  verbatim, `documentId`/`roomPrefix` reach the editor unchanged, and the fallback is the panel
  variant. Regression guards.
- `web/src/components/RouteFallback.test.tsx` — the surrounding 4-panel chrome stays mounted while a
  lazy child resolves. Regression guard for the layout-flash risk.

**Rollback.** Per finding, in decreasing order of risk: revert `LazyEditor.tsx` and repoint
`UnifiedEditor.tsx`/`PersonEditor.tsx` at `@/components/Editor` (BUN-2); delete
`build.rollupOptions` and the `manualChunks` function in `web/vite.config.ts` — but **keep
`build.manifest: true`**, which is measurement infrastructure rather than part of BUN-6, and without
which `audit/bundle/measure.mjs` cannot run (BUN-6); restore `createLowlight(common)` in `Editor.tsx` and delete
`components/editor/lowlight.ts` (BUN-3); restore the static `emoji-picker-react` import in
`EmojiPicker.tsx` (BUN-4); replace the `React.lazy` declarations in `main.tsx` with static imports
and drop both Suspense boundaries (BUN-1). BUN-1 must be reverted last — the others depend on the
seam it creates.

**Still open, deliberately.** Vite still prints its >500 kB warning: `vendor-editor` is 577.5 kB raw.
The warning limit was *not* raised — silencing it would remove the only signal in the build about
this class of problem. BUN-5 (245 icon chunks, 209 unreferenced), BUN-7, BUN-8 and BUN-9 are
untouched and remain open.

**Found while measuring, not fixed here.** `web/tailwind.config.js` scans `./src/**/*.{js,ts,jsx,tsx}`,
which includes test files, so utility classes that exist only in a test inflate the shipped
stylesheet — the tests added by this branch grew `index-*.css` by 0.32 kB raw / 0.04 kB gzip. The fix
is to narrow the glob (e.g. exclude `*.test.*`), but `tailwind.config.js` was just modified by
TRO-217 and this is not the branch to contend for it. Filed rather than folded in.

---

## TRO-178 — [DB-1] `pnpm db:migrate` silently skipped 32 of 42 migrations and exited 0

**What was broken.** `api/src/db/migrate.ts:103-111` wrapped *both* the `schema.sql` application
and the migration loop in one `try`, and its handler matched any error message containing the
substring `already exists`. `010_oauth_state.sql:8` created `oauth_state` without `IF NOT EXISTS`
while `schema.sql:90` had already created it, so the migration threw `relation "oauth_state"
already exists` — indistinguishable, to that handler, from a benign `schema.sql` re-run. It logged
`Database schema already exists, continuing...`, returned normally, abandoned the remaining 32
files, and the process exited **0**. A second run behaved identically; it did not self-heal.

The report's hypothesis held exactly, including its list of the other blocking files.

**What changed.**

- `api/src/db/migrationRunner.ts` (new) — the migration logic, extracted from `migrate.ts` so it
  can be exercised by tests. `migrate.ts` is now the CLI wrapper: env, pool, exit code.
- The `already exists` tolerance now lives inside `applySchema` and covers only the `schema.sql`
  call, so a failure in the migration loop can no longer be mistaken for one. It matches Postgres
  SQLSTATE duplicate-object codes (`42P04`, `42P06`, `42P07`, `42701`, `42710`, `42723`) instead of
  a substring — substring matching on `already exists` would also swallow, for example, a failed
  `ALTER ... ADD CONSTRAINT` in a data migration.
- A failing migration is rethrown with its filename in the message, and `migrate.ts` exits 1.
- `applySchema` no longer swallows the duplicate-object error it tolerates — it **re-applies**
  `schema.sql` and lets the second attempt decide. `pool.query` sends the file as one simple query,
  so Postgres runs it as a single implicit transaction: an error at statement *k* rolls back
  statements 1..*k*-1 too, meaning nothing was applied. Returning normally there was DB-1 inside
  the DB-1 fix. A clean second pass proves every object exists (verified by the file itself, not by
  a hardcoded list that could drift); a second failure propagates and exits 1.
- Migrations `010`, `025`, `033`, `035` are now idempotent against the `schema.sql` end state
  (`IF NOT EXISTS`; a `pg_constraint` lookup for the CHECK constraint; `DROP TRIGGER IF EXISTS`
  before `CREATE TRIGGER`, the pattern `schema.sql:193` already uses; a `pg_enum`-guarded loop for
  the three `ALTER TYPE ... RENAME VALUE` statements). These four files are edited rather than
  superseded by a new migration, because a new migration cannot stop `010` itself from throwing,
  and databases that already recorded these versions never re-read them.
- Migration filenames are validated against `NNN_description.sql` — exactly three digits, an
  optional single letter (`007b_`, `014b_`, `015b_`, `018b_`, `020b_` all exist), then an
  underscore. The runner sorts the validated names **lexicographically**; that equals numeric
  order only because the pattern forces a zero-padded three-digit prefix, which is the whole
  reason the pattern is enforced. Anything outside it — an unnumbered `hotfix.sql`, or a
  four-digit `1000_` that would sort before `999_` — throws and names the offender before any
  migration is applied. The runner does not infer an order for such a file; it refuses to guess.
- Regression tests: `api/src/db/__tests__/migrationRunner.test.ts`.

**New ways `pnpm db:migrate` can now fail — all deliberate.** It previously exited 0 in every one
of these cases:

| Condition | Behaviour |
|---|---|
| any migration raises | exit 1, naming the file |
| migrations directory missing or unreadable | exit 1 |
| a `.sql` file there is not `NNN_description.sql` | exit 1, naming the offender |
| `033`: `document_type` has both `sprint_*` and `weekly_*` **and** documents still use the old label | exit 1 with the row count and the remedy |
| `033`: `document_type` has neither label of a pair | exit 1 |

The one state `033` deliberately tolerates is both labels present with **no** rows using the old
one — that is the normal outcome on a fresh database, because `schema.sql:100` declares the
post-rename labels and `017_standup_sprint_review_types.sql:14` then re-adds `sprint_review` via
`ADD VALUE IF NOT EXISTS`. Raising there would fail every fresh install.

**What the 32 previously-skipped migrations mean for an existing database.** Reported, not executed
against anything but a factory database — this is the part that needs an operator's eyes before the
next production deploy. Measured over `011`–`037` (31 files; `010` is the 32nd):

| | count |
|---|---|
| `ALTER TABLE` | 19 |
| of which `DROP COLUMN` | 3 |
| `CREATE TABLE` | 7 |
| `ALTER TYPE` | 4 |
| `UPDATE` / `INSERT` / `DELETE` statements | 27 / 8 / 3 |

`schema.sql` contains **zero** `ALTER TABLE` and **zero** DML, so on a database that already exists
these 31 files are the only mechanism that would ever have changed it. Notable: `027`/`029` drop
`documents.sprint_id`, `documents.project_id`, `documents.program_id`; `033` renames three
`document_type` enum labels `sprint_* → weekly_*` and rewrites matching `properties` JSON; `014b`,
`028` and `034` are backfills. **The first deploy after this change will apply all 32 at once.**
Take a snapshot first and run `pnpm db:migrate` against a restore of production before running it
against production.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate                          # now exits non-zero on any migration failure
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts
```

Verify with `select count(*) from schema_migrations;` — it should equal the number of `.sql` files
in `api/src/db/migrations/` (42 today), not 10.

**Verified** against PostgreSQL 15-alpine in the `ship-audit-pg` container on `:5433`:

- fresh database → 42 rows in `schema_migrations`, exit 0
- second run on it → clean no-op, still 42, exit 0
- `ship_wt_tro_178`, stuck at 10 rows (the state DB-1 had left it in) → 32 applied, 42 rows, exit 0
- a database seeded with the *pre-*`033` enum labels → renamed to `weekly_*`, 42 rows, exit 0
- both enum labels present plus one stale document → exit 1, naming the count and the remedy
- `document_type` missing both labels of a pair → exit 1
- applying `schema.sql` three times in a row against one database → no error any time, so the
  duplicate-object tolerance in `applySchema` is unreachable **sequentially** for the current file
  (17/17 `CREATE TABLE` and 59/59 `CREATE INDEX` guarded, both `CREATE TYPE`s in guarded `DO`
  blocks, function `OR REPLACE`, trigger preceded by `DROP TRIGGER IF EXISTS`)
- applying `schema.sql` from **6 connections at once** → 5 of 6 failed, so it is emphatically
  reachable **concurrently**: `CREATE TABLE IF NOT EXISTS` is check-then-create and not atomic.
  Mostly SQLSTATE 23505 on the catalog index `pg_type_typname_nsp_index`, sometimes 42710. 23505 is
  deliberately not tolerated; the concurrency defect itself is TRO-279
- `pnpm --filter @ship/api test` against the fully-migrated database → 475 tests passed

**Not verified.** No run against production or shadow, and no run against PostgreSQL 16 (production
runs pg16; CI and this work run pg15 — see the pin comment in `.github/workflows/ci.yml`). Proving
the production path needs a restore of a production snapshot.

**Rollback.** `git revert` the commits on `fix/db-1-migration-runner`, or, to restore only the old
runner behaviour, delete `api/src/db/migrationRunner.ts` and restore `api/src/db/migrate.ts` from
`main`. Rolling back the runner alone leaves migrations `010`/`025`/`033`/`035` idempotent, which is
harmless. Note that rollback does **not** un-apply migrations already recorded in
`schema_migrations`; reversing those requires a database restore.

---

## TRO-276 (ERR-10) — one malformed WebSocket frame no longer kills the API for everyone

**The user-facing cost.** Any authenticated user could send four bytes down a collaboration socket
and the entire API process died — every open editor in every workspace disconnected, every in-flight
request dropped, until the container restarted. It did not need malice: a truncated frame from a
flaky connection does it. Measured against a real running server, 5 of 7 malformed frames produced
an uncaught exception.

**Root cause.** `handleMessage()` in `api/src/collaboration/index.ts` decodes attacker-controlled
bytes with raw lib0 readers, which throw on truncated input. It was called from `ws.on('message')`
with no try/catch anywhere in the chain, and there was no `process.on('uncaughtException')` handler
in `api/`, `web/` or `shared/`. A `ws` 'message' listener is an I/O callback: a throw there escapes
to the process, and Node's default for an unhandled `uncaughtException` is to terminate.

**What changed.**

- `runFrameHandler()` wraps the **entire** body of both `ws.on('message')` handlers — the
  collaboration socket and the events socket. On a throw it logs structured context and closes that
  one socket with code **1002** (RFC 6455 protocol error). No other connection is affected. The
  whole body is guarded, not just the `handleMessage()` call, so the rate limiter and any future
  addition are covered too. It composes with the ERR-2 `revoked` check rather than duplicating it:
  the revocation short-circuit is now the first statement *inside* the guard, so a revoked socket is
  not even decoded. It also contains a **rejected promise**: `() => void` accepts an `async` function
  in TypeScript, so an async handler added later would reject after the `try/catch` had exited and
  escape as an unhandled rejection — ERR-10 again by the back door. A thenable result is routed
  through the same log-and-close path, and a test pins it.
- On the events channel the `catch` around `JSON.parse` no longer spans the response as well. It
  previously swallowed anything raised while replying, so an error there was discarded instead of
  reaching the guard's log-and-close path — a `catch {}` covering more than its comment claims is how
  a guarded handler quietly stops being guarded.
- `attachSocketErrorHandler()` covers a second vector of the same class. `ws` reports framing and
  transport failures by emitting `'error'` on the WebSocket, and `EventEmitter` throws an `'error'`
  event that has no listener — so a peer sending a frame with a reserved bit set crashed the process
  without ever reaching `handleMessage()`. It is attached as the **first statement** of the
  connection handler, before any `await`: that handler is `async` and loads the document from
  Postgres, and a frame arriving during that window found the socket unguarded. This was found by
  the regression test, against the first version of this fix. The events handler registers it first
  too — there, honestly, as defence in depth rather than a live fix: that handler is synchronous, and
  `ws.send()` with no callback does not emit `'error'` on a closed socket (`sendAfterClose` builds the
  error only `if (cb)`), so nothing could slip in ahead of a later registration. "Error listener
  first" is simply cheaper to hold as an invariant than to re-derive.
- `api/src/process-safety.ts` — `installProcessSafetyNet()`, wired in at `api/src/index.ts` only
  (the entrypoint, so importing the app never hijacks a test runner's error handling). It takes
  ownership of `uncaughtException` / `unhandledRejection`, logs full structured context, stops
  accepting new connections, and exits **1** after a bounded 5s drain.

**Why the safety net exits rather than continuing.** By the time it fires, the exception has escaped
every guard, so nothing is known about the state left behind — Node's own guidance is that resuming
is undefined behaviour. Continuing would trade a fast restart for an indefinitely, silently wrong
server. It is also not an availability regression, which is the decisive point: with no handler
installed, Node **already** terminates on an uncaught exception, and (since v15) on an unhandled
rejection too. This cannot make the process die more often than it does today. What it changes is
everything around the death — structured context instead of a bare stack, the listening socket
closed first, a bounded window for in-flight work, and a deliberate non-zero code for the supervisor
(`Dockerfile:75` runs `node dist/index.js` as the container command, so a non-zero exit is a
restart). The availability win comes entirely from the try/catch; the safety net only makes failures
legible.

One trap worth recording, because it already cost this project a ticket: **the stack trace lies.**
lib0 builds `errorUnexpectedEndOfArray` as a module-scope singleton `Error` whose stack is captured
at module *load*, so every one of these crashes points at whatever first imported lib0 rather than
at the throw site. Both the frame log and the fatal log therefore carry an explicit caveat on the
stack field, and the frame log identifies the input by other means.

**What the frame log does and does not contain.** It records frame *identity*, never frame content:
a truncated SHA-256 digest, the byte length, and the protocol message type. The first version of
this fix logged a 32-byte hex prefix of the frame, which was wrong — a frame that failed to decode
has usually been *partially* decoded, so its leading bytes can carry fragments of document text, and
logs get shipped, aggregated and retained. A digest preserves the property that matters for triage
(the same frame sent twice yields the same identity, so a repeated or automated attack is visible)
without the log holding the payload. Stated limit: for a very short frame the digest is reversible
by brute force, which is acceptable precisely because a four-byte frame cannot contain document
content, and the frames long enough to carry any are far too large to enumerate. The cost is that a
byte-exact replay can no longer be reconstructed from a log line; error name, length and message
type localize the failing decode path well enough to rebuild the frame by construction.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/malformed-frames.test.ts
pnpm --filter @ship/api exec vitest run src/__tests__/process-safety.test.ts
```

`malformed-frames.test.ts` drives the real collaboration server over real sockets with each frame
from the audit table plus a raw hand-rolled WebSocket frame with RSV1 set, and asserts that nothing
reaches the process level, that the offending socket is closed **with code 1002**, that a co-tenant
editor on the same document keeps working, and that new connections still persist edits afterwards.
It also pins the two frames that were always survivable (`[0,1]`, `[9,9,9]`) as still survivable, so
an over-broad fix that hangs up on legitimate traffic fails.

It contains **no fixed sleeps** (TEST-11 / TRO-233). Every wait is an observable: socket closures are
awaited as `'close'` events, and liveness is proved by pushing a write through a socket and reading
it back out of `documents`. The one polling helper reads the database until the row appears, because
`persistDocument()` is debounced inside the server and emits no external signal — it returns as soon
as the condition holds and the caller asserts on the value, so a timeout surfaces as a real
assertion about content rather than as "waited long enough". Each malformed frame gets its own fresh
attacker connection, so no case is ever asserting against a socket a previous case already closed.
`process-safety.test.ts` uses vitest fake timers, which is what lets it prove the *absence* of a
second exit after the drain window elapses.

Red before green, with `api/src/collaboration/index.ts` restored to the version on `main`:
**8 failed / 3 passed**, every failure a clean assertion — five naming the escaped exception
(`Unexpected end of array`, `Invalid typed array length: 5`), one naming
`Invalid WebSocket frame: RSV1 must be clear`, one `expected undefined to be 1002` for the missing
close-code constant, and one `expected false to be true` for the socket that was never closed. With
the fix: **12 passed** (the twelfth is the async-escape case, which has no unfixed counterpart —
verified red by removing only the thenable branch, giving
`unhandledRejection -> Error: async frame handler rejected`).

Note for anyone repeating that check: reverting with `git checkout HEAD -- <file>` stops working once
the fix is committed, because `HEAD` then *contains* the fix. Use `git show main:<file>`.

**How to roll it back.**

```bash
git revert <commit>   # or, per piece:
```

Reverting `api/src/process-safety.ts` plus its two lines in `api/src/index.ts` restores Node's
default crash behaviour without touching the frame guards — the guards are independent and are the
part that matters. Reverting `runFrameHandler` / `attachSocketErrorHandler` in
`api/src/collaboration/index.ts` restores the crash. No schema change, no migration, no config, no
API surface change; the only observable difference for a well-behaved client is that a client
sending undecodable bytes is now disconnected with close code 1002 instead of taking the server with
it.

---

## TRO-179 (DB-2) + TRO-177 (API-6) — authenticated reads stop rewriting the session row once per request

One statement, measured from two sides. `authMiddleware` ran
`UPDATE sessions SET last_activity = $1 WHERE id = $2` **unconditionally on every authenticated
request** (`api/src/middleware/auth.ts:205-208` on `main`), so a page that only *reads* still
produced one row-locking, WAL-generating write per request — and a single page load fires 5-13 of
them, all against the same row.

- **TRO-179 / DB-2 (SQL side):** three statements ran before any application data — a session+user
  SELECT, a workspace-membership SELECT, and the write. That was 16 of 17 queries on "List issues"
  and 34 of 51 on "Load sprint board". The write ran 121 times during capture and was the slowest
  statement in five of six flows (peak 4.764 ms) against an isolated EXPLAIN of 0.178 ms.
- **TRO-177 / API-6 (HTTP side):** `GET /api/documents/:id` returned ~2.2 KB from one indexed PK
  lookup yet cost P50 2.6 ms / P95 4.8 ms at c=10.

**What changed.** The fix was already written three lines below the bug: the sliding-cookie refresh
had always been throttled to once per 60s ("throttled to avoid overhead"); the same threshold was
simply never applied to the database write. Both halves of the sliding expiration now share one
throttle (`SESSION_ACTIVITY_UPDATE_THRESHOLD_MS`, 60s).

**Precisely what the throttle does and does not do.** Reads *within* the 60s window issue no write
at all. The first read *after* the window still refreshes `last_activity` — the sliding expiration is
intact, so a session in continuous use never expires. What is gone is the one-write-per-request
pattern, not the write.

**The throttle is enforced twice, and both placements are load-bearing.** The application-side check
uses the value the request already SELECTed, so when it says "not due" no statement is sent — that is
what removes the query from the hot path. But that value can already be stale: a page load fires 5-13
requests in parallel, and when the burst straddles the threshold they all read the same pre-write
`last_activity` and all conclude the write is due. So the predicate is repeated in SQL —
`UPDATE ... WHERE id = $2 AND last_activity < $3` — and Postgres arbitrates: under READ COMMITTED the
losers re-evaluate the qualification against the committed row version, fail it, and affect zero
rows. Measured below: without the SQL predicate a 10-request burst produced **10** row versions;
with it, **1**. Dropping either placement re-opens half the finding.

The expiry invariant survives the conditional write. A no-op leaves the row at its previous value,
and the UPDATE no-ops *only* when `last_activity >= now - threshold` failed the predicate — which is
exactly the bound the grace below assumes. In all three cases (application check skipped, write
applied, write no-opped) the stored `last_activity` is `>= requestTime - threshold`, so the lag is
still capped at one threshold. The conditional form is in fact strictly stronger: the unconditional
version could move `last_activity` *backwards* when two concurrent requests wrote timestamps captured
microseconds apart.

**Session expiry semantics — read this before changing the threshold.** Throttling the write means
the recorded `last_activity` trails real request activity by up to 60s. Comparing a lagging value
against a bare `SESSION_TIMEOUT_MS` would end sessions *early* — a user idle 14:01 could be logged
out of a 15-minute window. That is the unsafe direction, for two reasons:

1. The web client runs its own 15-minute idle timer off real user interaction
   (`web/src/hooks/useSessionTimeout.ts:295-305`) and does not heartbeat the server. A server window
   that can close before 15 minutes produces an unexplained 401 while the client still believes it
   is logged in.
2. The collaboration server reads `last_activity` on a 30s sweep and deliberately never refreshes it
   (see TRO-189 below). A tighter bound there would tear down the socket of a user whose REST
   requests are still being served — and the socket is where unsaved editor state lives.

So the enforced inactivity window is `SESSION_INACTIVITY_LIMIT_MS = SESSION_TIMEOUT_MS +
SESSION_ACTIVITY_UPDATE_THRESHOLD_MS` (16 min), applied identically by the REST middleware, the
refreshed cookie's `maxAge`, and the collaboration server's `isSessionRowValid()`. **True idle
logout now lands in [15:00, 16:00] instead of [14:00, 15:00]** — the rounding error extends a
session rather than ending one. The 12-hour absolute cap (`ABSOLUTE_SESSION_TIMEOUT_MS`) is
untouched, and 16 minutes remains well inside NIST SP 800-63B AAL2's 30-minute inactivity guidance.

**Measured** — `GET /api/documents/:id`, 12 sequential authenticated reads inside the throttle
window, `NODE_ENV=test`, vitest + supertest, concurrency 1, worktree PostgreSQL 15:

| | statements | per request | `last_activity` writes | auth share |
|---|---|---|---|---|
| before (`main`) | 60 | 5.00 | 12 | 60% |
| after | 48 | 4.00 | **0** | 50% |

20% fewer statements per read; the session-row write is gone from the hot path entirely. This is a
query-**count** measurement — the audit's c=10/c=50 latency numbers need a running server and a load
generator, and were not reproduced here.

**Measured, concurrent** — 10 parallel authenticated requests on one session parked 61s back, so the
whole burst straddles the threshold. Same conditions, plus a pre-warmed connection pool (a cold pool
serializes the burst and hides the effect entirely):

| | UPDATE statements | row versions written |
|---|---|---|
| application-side gate only | 10 | 10 |
| gate + SQL predicate | 10 | **1** |

The statement count is identical — all ten requests read the same stale row and all ten ask — but
only one row version, and therefore one row lock and one WAL record, results. Row-lock and WAL
contention on this single shared row is what the audit measured as the 0.178 ms → 4.764 ms gap.

**Files:** `api/src/middleware/auth.ts` (throttle + the two window constants),
`api/src/collaboration/index.ts` (mirrors the window).
**Tests:** `api/src/middleware/__tests__/session-activity-throttle.test.ts` (write skipped inside the
window, written after it, the SQL predicate's shape, and both expiry boundaries),
`api/src/middleware/__tests__/session-activity-race.test.ts` (one row version under a concurrent
burst), `api/src/routes/documents-query-count.test.ts` (statements per authenticated read).

**Rollback:** revert the commits on `fix/db-2-api-6-session-write`. No migration, no schema change,
no data change — sessions written under either version are interpreted correctly by the other.

---

## TRO-173 (API-2) + TRO-182 (DB-5) — the issue list stops shipping every issue's document body

Two findings, one cause, one change. API-2 measured it at the socket (`GET /api/issues` was the
slowest endpoint at every concurrency level and sent 379,907 bytes for 254 issues); DB-5 measured
the same thing in the planner (`width=1023` per row, against `width=300` for the `/api/documents`
projection that omits `content`). The list and detail views shared **one** SELECT projection
(`api/src/routes/issues.ts:126`, `content: row.content` at `:99`), so the list carried each issue's
full TipTap body, and there was no `LIMIT`/`OFFSET` anywhere in the file.

**Not a query problem.** The handler already batches associations in one `ANY($1)` query
(`api/src/utils/document-crud.ts:148-180`) — no N+1 — and the plan is a seq scan over 254 rows
costing ~142. The cost was `JSON.stringify` plus socket writes. No index was added; none was
missing.

**What changed.**

- `extractIssueFromRow` split into `extractIssueListItemFromRow` (shared fields) plus a thin
  `extractIssueFromRow` wrapper that adds `content` back. `GET /api/issues/:id`,
  `/by-ticket/:number` and `/:id/children` still return the body and are byte-identical.
- `d.content` removed from the list SELECT.
- `limit` (1-500) and `offset` (0-100,000) added to `GET /api/issues`. Both are bounded at both
  ends: unparseable, negative, fractional or over-maximum values get **400**, never silent
  truncation. `offset` is capped because an unbounded one is scanned and discarded inside Postgres —
  `OFFSET 1e9` buys a full scan that returns nothing.
- The route validates with `IssueListPaginationSchema` **imported from the OpenAPI schema module**,
  not a second copy, so the bounds Swagger advertises and the bounds the route enforces cannot
  drift.
- Both extractors take declared row types (`IssueListRow` / `IssueDetailRow`) instead of `any`. From
  PR review: an `any` *annotation* silences every field read, which on a projection extractor meant
  the exact thing this change touched — which columns the SELECT returns — was the one part not
  type-checked. Verified by introducing `row.titel` and getting
  `TS2551: Property 'titel' does not exist on type 'IssueListRow'`; under `any` that compiled.
  What it does not buy: TypeScript still cannot read the SQL string, so deleting a column from a
  query is not a compile error.

**The pagination contract, stated deliberately: there is NO default limit.** Omit both params and
you get every matching row, in the same order, exactly as before. That is not laziness — two
consumers read the response as a complete set, and a default limit would have returned *wrong*
lists rather than shorter ones:

- `web/src/hooks/useIssuesQuery.ts:137-143` filters by project **client-side** over the whole array
  (the API has no `project_id` filter — see the follow-up below).
- `web/src/components/IssuesList.tsx:310-330` groups, counts and merges the full array, including
  the "Show All Issues" path.

No web caller passes `limit` or `offset` today, so no existing caller changes behaviour. New
callers (and the generated MCP tool) can now bound a response; a caller knows it has the last page
when it receives fewer rows than it asked for.

**Contract change is registered with OpenAPI.** `GET /issues` now responds with a new
`IssueListItem` component — `Issue` minus `content` — and documents `limit`, `offset` and the 400.
`api/openapi.{json,yaml}` regenerated, so Swagger and the runtime-generated MCP tools describe the
shape the route actually returns. `Issue` (27 properties, with `content`) still backs the detail
paths.

**Evidence.** Same machine, same worktree, same deterministic dataset for every number below:
PostgreSQL 15-alpine in Docker (`ship-audit-pg`, `:5433`), API on `:3155` via `tsx watch` with
`NODE_ENV=development`, `pnpm db:seed` + `audit/seed-augment.ts` → **500 documents / 254 issues /
20 users** (the audit's volumes; the seed is fixed-seed so before and after ran against identical
bytes — `sum(pg_column_size(content))` = 158 kB / 64.5% of issue row bytes both times, matching
DB-5's figure). Before/after were measured by swapping only `api/src/routes/issues.ts`.

| | before | after | |
|---|---|---|---|
| `GET /api/issues` payload (254 issues) | 379,907 B | **241,338 B** | 1.57× smaller |
| `EXPLAIN` row width | `width=1023` | **`width=335`** | 3.05× narrower |
| p95 @ c=10 | 42.0 ms | **28.6 ms** | |
| p95 @ c=25 | 90.4 ms | **59.1 ms** | |
| p95 @ c=50 | 184.0 ms | **107.9 ms** | |
| p99 @ c=50 | 228.4 ms | **161.2 ms** | |
| throughput ceiling (Little's law) | ~311-325 rps | **~490-546 rps** | |
| `GET /api/issues?limit=50` | 379,907 B (ignored) | **47,608 B** | |
| `GET /api/issues/:id` | 1,802 B | 1,802 B | unchanged |

Latency: autocannon 8.0.0 installed into a session scratchpad (never into the repo), 600 requests
per level — a fixed request count rather than a duration, because
`api/src/middleware/rate-limit.ts:89` caps one session identity at 1000 requests / 60 s in
development. Each level logged in fresh for its own bucket; `non2xx=0, errors=0` on every level, so
no 429 is hiding in these numbers. Percentiles come from per-response latencies on autocannon's
`response` event. A second `after` run put p95 @ c=25 at 55.5 ms and @ c=50 at 110.2 ms, so read
these as ±5%. The `before` column reproduces the audit baseline (its c=25 p95 was 94.5 ms, c=50 p95
182.0 ms), which is the reason to trust the `after` column.

**Where the ticket's estimate was wrong.** TRO-173 predicted ~2.6× payload shrink and p95 @ c=25
falling to 35-40 ms. Actual: 1.57× and 59 ms. The estimate applied content's **database** share
(64.5% of row bytes) to the **JSON** payload, but in the response body `content` was only 146,015 of
379,907 bytes — **38.4%**. The other 25 fields carry per-row overhead (UUIDs, ISO timestamps,
repeated key names) that dominates at 254 rows. The mechanism held exactly; the magnitude did not.
The largest remaining component is now `belongs_to` at 80,900 bytes (**33.5%** of the response) —
association objects carrying `title` for every program/project/sprint/parent. That is the next
payload win on this endpoint and it has no ticket.

**How to run it.**

```bash
source .factory-env                                   # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test -- src/routes/issues.test.ts
pnpm type-check
pnpm --filter @ship/api openapi:generate              # should be a no-op diff
```

**Roll back.** `git revert` the commits on `fix/api-2-db-5-issues-payload`. By hand: put
`d.content,` back in the list SELECT, call `extractIssueFromRow` instead of
`extractIssueListItemFromRow` in the list handler, drop `listPaginationSchema` and the
`LIMIT`/`OFFSET` block, restore `z.array(IssueResponseSchema)` on the `/issues` 200 response, and
regenerate the spec. The five new cases in `api/src/routes/issues.test.ts` fail if the body comes
back or pagination stops being honoured.

**Not verified.** Only api-tier tests and this endpoint were exercised — no browser pass confirms
the issues list still renders correctly against the narrower payload (it should: the web `Issue`
interface at `web/src/hooks/useIssuesQuery.ts:25-48` never declared `content`, and no `.tsx` reads
it off an issue). `/api/issues/:id/children` still returns `content` for sub-issues; it has the
same shape of waste, bounded by children per issue, and was left alone deliberately rather than
widening this change.

**Found, not fixed.** `web/src/components/sidebars/ProjectContextSidebar.tsx:148` requests
`/api/issues?project_id=<id>`, but the list route never reads `project_id` — the parameter is
silently ignored and that sidebar receives every issue in the workspace. Pre-existing, unrelated to
these two findings, and worth its own ticket.

---

## TRO-174 — [API-3] No response compression anywhere; the largest list payload shipped 15× larger than needed

**What was broken.** `api/src/app.ts` never registered any compression middleware, and
`compression` was not a dependency of `api/package.json`. Every JSON response went out
uncompressed even when the client explicitly advertised `Accept-Encoding: gzip`. `GET /api/issues`
was the worst case at **379,907 bytes**. On a 10 Mbps agency link that body alone is ~304 ms of
transfer time, paid by every user on every list load. The gap is invisible in local development
and in the api-perf benchmark because loopback transfer is effectively free — it only costs users
on a real WAN link.

**What changed.** `compression` is registered as the first middleware in `createApp()`, ahead of
every route, so all response bodies pass through it: API JSON, the Swagger UI, and the static SPA
on single-origin deployments.

Settings, and why:

- **`threshold: 1024`** — the library default, written out explicitly to document it. Below roughly
  one MTU there is nothing to win; gzip framing plus the CPU makes a small body marginally larger
  and slower. `/health` (15 bytes) is correctly left alone.
- **Compression level: zlib's default (6), not 9.** Measured on the real 379,907-byte body, level 9
  yields 24,091 bytes against level 6's 25,050 — **3.8% smaller for materially more CPU per
  response**, on a path that runs on every list request. Note this means the honest ratio is
  **15.17×**, not the 15.4× the audit projected from `gzip -9`.
- **Filter delegates to `compression.filter`**, which consults `mime-db` and so already declines
  already-compressed types — the images, PDFs and archives served by `/api/files/:id` keep their own
  encoding rather than being wastefully re-compressed. Three additions on top:
  - the conventional `x-no-compression` request opt-out;
  - a `text/event-stream` guard. There is no SSE endpoint in this codebase today (verified by grep
    for `text/event-stream` and `flushHeaders`, 2026-07-29); the guard is there because compression
    buffers, which would silently stall the first SSE endpoint someone adds. Note mime-db would
    happily compress `text/*`, so this guard is doing real work rather than restating the default.
  - an `application/octet-stream` guard. mime-db reports octet-stream as **compressible**, but it is
    the "unknown binary" fallback, and the one route that emits it is `GET /api/files/:id`, which
    echoes a client-declared `mime_type` verbatim (`files.ts:309`) for an upload validated only
    against a filename extension blocklist (`files.ts:80-84` — any mime string is accepted).
    Speculatively gzipping an arbitrary, likely already-compressed user binary on every download
    costs CPU for no benefit.

  Both guards compare against a **lower-cased** media type. RFC 9110 §8.3.1 makes media types
  case-insensitive, so `Text/Event-Stream` and `Application/Octet-Stream` are legitimate headers.
  A case-sensitive comparison would defeat both guards silently, and for octet-stream the bypass
  would be **client-controlled** — the same client-declared `mime_type` that reaches
  `files.ts:309` would decide whether the guard applied to its own download. Caught in PR review;
  see the exclusion tests below.

  **`compression.filter`'s own mime-db lookup is already case-insensitive** — verified against a
  real server: `Application/JSON` and `APPLICATION/JSON` compress exactly as `application/json`
  does, `Image/PNG` and `Application/PDF` pass through exactly as their lower-case forms do, and
  a `; Charset=UTF-8` parameter changes nothing. **So normalisation belongs only in the two
  additions above — do not add it to the library path.** Recorded here because the natural
  "fix" for a case bug is to normalise everywhere, and here that would be wasted work.

  The Yjs collaboration WebSocket is unaffected — `ws` handles the upgrade off the HTTP response
  path, so this middleware never sees it.

  Filter behaviour was verified against a real HTTP server using the exact filter from `app.ts`,
  across 22 content types. Compressed: `application/json`, `text/html`, `application/javascript`,
  `text/css`, `text/csv`, `text/plain`, `application/xml`, `image/svg+xml`. Passed through:
  `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `application/zip`, `application/gzip`,
  `application/x-7z-compressed`, `video/mp4`, the four Office formats (docx/xlsx/doc/xls), plus the
  two guarded types above. **That 22-type matrix was run lower-case only, and is manual
  verification, not automated coverage** — mime-db's own behaviour is the library's business. The
  two guards this change adds are a different matter: they are safety guards with a client-reachable
  input, so they now have assertions (11 cases, mixed-case included) rather than a hand-run matrix.

**⚠️ DO NOT "DISPROVE" THIS FIX WITH A LOCALHOST BENCHMARK.** Enabling gzip does **not** reduce P95
over loopback and may raise it slightly. Localhost transfer time is ~0, so the only thing a local
benchmark can measure is the compression CPU that was added. A compare-mode `/api-perf-audit` run
against `audit-baseline` will therefore show this fix as **flat or marginally worse**, and that
result is not evidence against it. This is a bytes-on-the-wire fix: validate it by **payload size**,
or over a **bandwidth-shaped link**. This is standing rule 13 in the factory lessons, and it exists
because of this exact finding.

**Evidence — payload bytes, not loopback timing.** Local Express server (`tsx api/src/index.ts`,
port 3154, `NODE_ENV` unset i.e. development) against PostgreSQL 15 in Docker `ship-audit-pg` on
`:5433`, database `ship_wt_tro_174`, seeded with `pnpm db:seed` followed by `audit/seed-augment.ts`
to the volumes in `audit/shipshape.config.yaml` — 500 documents (254 of them issues) / 20 users.
Bytes counted by `curl -w '%{size_download}'`, which does not decompress when `Accept-Encoding` is
set by hand. The "before" column is the same server answering `Accept-Encoding: identity`; that is
byte-for-byte what the pre-fix code returned regardless of request headers, and it is independently
confirmed by the `x-no-compression` opt-out returning the identical 379,907.

| endpoint | before (identity) | after (gzip, level 6) | reduction |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | **25,050 B** | **15.17× / −93.4%** |
| `GET /api/documents` | 293,822 B | **28,227 B** | 10.41× / −90.4% |
| `GET /api/openapi.json` | — | 18,039 B | compressed |
| `GET /health` (15 B) | 15 B | 15 B | under threshold, untouched |

The 379,907-byte "before" figure reproduces `audit/AUDIT_REPORT.md`'s number **exactly**, which
confirms the dataset here is byte-identical to the one the finding was measured against.

Transfer time at 10 Mbps is **derived arithmetic from those measured byte counts, not an observed
WAN measurement**: 379,907 B → ~304 ms, 25,050 B → ~20 ms, a saving of ~284 ms per issue-list load.

**Interaction with TRO-173/TRO-182 — do not double-count.** That branch removes `content` from the
`/api/issues` list projection, shrinking the same payload. Measured on the identity body from this
branch, the `content` field is **36.5%** of those 379,907 bytes. The two fixes compose, and the
honest attribution is:

| | identity | gzip level 6 | compression's own factor |
|---|---|---|---|
| this branch (`content` present) | 379,907 B | 25,050 B | **15.17×** |
| after TRO-173 (`content` stripped) | 241,338 B | 19,894 B | **12.13×** |

So compression alone is worth 15.17× today and still 12.13× once TRO-173 lands; the *combined*
379,907 → 19,894 is **19.10×** and belongs to both tickets, not to either one. Neither ticket
should claim it alone.

**CloudFront in the deployed stack — does it already do this?** Partly answered from config, and
the answer is "no, and the win is not double-counted" — but the deployed-stack half is **derived
from Terraform, not observed against the live distribution**.

*Observed in the repo:* the `/api/*` cache behaviour does set `compress = true`
(`terraform/s3-cloudfront.tf:154`, `terraform/modules/cloudfront-s3/main.tf:172`), and all three
environments (dev/prod/shadow) use `modules/cloudfront-s3`. But that behaviour attaches
`aws_cloudfront_cache_policy.api_no_cache`, whose
`parameters_in_cache_key_and_forwarded_to_origin` block sets `header_behavior = "none"` and sets
**neither `enable_accept_encoding_gzip` nor `enable_accept_encoding_brotli`** — a repo-wide grep for
`enable_accept_encoding` returns no matches at all.

*Derived from AWS's documented behaviour:* CloudFront automatic compression requires the attached
cache policy to enable Accept-Encoding gzip/Brotli support; with both unset (Terraform default
`false`), `compress = true` is inert. So `/api/*` was very likely **not** being compressed at the
edge, and the 15.17× measured here is a real production win rather than a re-count of something
CloudFront was already doing. The fix is also robust either way: the origin request policy uses
`header_behavior = "allViewerAndWhitelistCloudFront"`, so the viewer's `Accept-Encoding` does reach
Express, and CloudFront relays an origin response that already carries `Content-Encoding: gzip`
without re-compressing it.

*Unverified:* no `curl` was run against `https://ship.awsdev.treasury.gov` to observe an actual
`Content-Encoding` header on a deployed response. The deployed-stack claim above rests on config
plus documented behaviour only.

**Regression test.** `api/src/routes/compression.test.ts` — 17 cases, in a vitest file the gate
actually executes (an `e2e/*.spec.ts` would satisfy the gate's added-test grep while never running).

Three integration cases over the real app via supertest: `Content-Encoding: gzip` appears on
`/api/issues` when the client advertises gzip, does **not** appear when the client sends
`Accept-Encoding: identity`, and does not appear on a sub-threshold response. Each also asserts the
decoded body is intact, because a `Content-Encoding` header over a corrupted body would otherwise
read as a pass.

Fourteen unit cases over `isCompressionExcluded`, exported from `app.ts` as a test seam: both
guarded types in four case variants each, the `x-no-compression` opt-out, ordinary compressible
types (which must fall *through* to mime-db, so over-excluding would lose the whole fix), absent /
numeric / array `Content-Type` values, and three decoy-parameter cases (below).

**Review fix — media type must be matched by equality, not substring.** CodeRabbit's review of PR
#20 caught that the exclusion check compared the excluded media types against the **whole**
`Content-Type` header via `.includes()`, parameters and all. A value like
`text/plain; note="application/octet-stream"` is genuinely `text/plain` and should compress, but the
old check saw `application/octet-stream` inside the parameter text and wrongly excluded it —
matching the parameter, not the media type. Fixed by splitting on the first `;`, trimming, and
comparing the resulting media type by exact equality (mirrored per-element for array `Content-Type`
values, since Express can in principle return one). Three new cases cover it: a `text/plain` decoy
mentioning `application/octet-stream`, an `application/json` decoy mentioning `text/event-stream`,
and — the mirror case, so the fix isn't just "never exclude anything" — a genuine
`application/octet-stream` that also carries parameters, which must still be excluded. Confirmed red
first: against the substring-matching code, the two decoy cases failed with
`AssertionError: expected true to be false` (the decoy in the parameters was wrongly triggering
exclusion), while the genuine-octet-stream-with-parameters case already passed — proof the two new
assertions were exercising the actual bug and not some unrelated setup problem.

One deliberate design choice: the negative case additionally asserts the uncompressed
`Content-Length` **exceeds** the 1024-byte threshold, with an actionable failure message. If a
future payload reduction takes `/api/issues` under the threshold, the gzip assertion would start
passing for the wrong reason — nothing to compress rather than compression working. The test fails
loudly instead. The seeded payload is padded via long **titles**, not `content`, precisely so
TRO-173 removing `content` cannot make it vacuous.

Confirmed red first, twice. With the middleware absent the gzip case failed with
`AssertionError: expected undefined to be 'gzip'` at the `content-encoding` assertion — the right
reason, not an import or setup error — while the other two cases passed. Then the case-insensitivity
fix was driven the same way: against the case-sensitive comparison, exactly the six mixed-case
assertions failed with `AssertionError: expected false to be true` while all four lower-case cases
passed, which is what proves the refactor that introduced the seam changed no behaviour on its own.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/compression.test.ts

# Reproduce the payload measurement (NOT a latency benchmark — see the warning above).
pnpm --filter @ship/api db:seed && api/node_modules/.bin/tsx audit/seed-augment.ts
PORT=3154 api/node_modules/.bin/tsx api/src/index.ts &
# then, with a valid session cookie for a seeded user:
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: identity' \
  http://localhost:3154/api/issues -w 'identity=%{size_download}\n'
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: gzip' \
  http://localhost:3154/api/issues -w 'gzip=%{size_download}\n'
```

Setting `Accept-Encoding` by hand matters: `curl --compressed` would decompress transparently and
report the identity size for both, hiding the entire effect.

**Rollback.** Delete the `app.use(compression({...}))` block and the `import compression` line from
`api/src/app.ts`; optionally drop `compression` and `@types/compression` from `api/package.json`.
Deleting `api/src/routes/compression.test.ts` reverts the test. No schema, route, or API-contract
change; nothing to migrate.

**Found, not fixed.** The inert `compress = true` on the `/api/*` CloudFront behaviour is a latent
config inconsistency worth its own ticket: enabling `enable_accept_encoding_gzip` on the
`api_no_cache` cache policy would make the edge setting mean what it appears to mean. It is a
Terraform change, out of scope here, and origin-side compression is the more robust fix anyway
because it also covers single-origin deployments and direct-to-Elastic-Beanstalk access, which do
not pass through CloudFront at all.

---

## TRO-224 — [TEST-2] 68 e2e tests could pass without executing a single assertion

**What was broken.** A brace-scan of 866 static test blocks found **3 tests with no `expect()` at
all** and **65 whose every `expect()` sat inside a conditional** — 7.9% of the suite reporting
success while observing nothing (`audit/test-quality/runs/e2e-vacuous-tests.txt`). Two of them were
the only automated coverage of a security control:

- `security.spec.ts:217` *XSS via data: URI in links* typed `[Click](data:text/html,…)` into a new
  document, then looped over `editor.locator('a')` asserting only inside
  `if (href?.startsWith('data:'))`. **TipTap ships no markdown-link input rule**, so the typed text
  stayed literal, zero `<a>` elements existed, and the loop body never ran. Its sibling *XSS via
  markdown link injection* (`:197`) had the same hole without the `if`. Neither could tell "the app
  sanitised the URI" from "the app rendered nothing" — and the truth was the latter, for the whole
  life of both tests.
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs* buried
  `expect(response.status()).toBe(403)` inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` skipped the entire authorization
  check silently.

The guards had been added to stop tests failing on missing seed data — the same failure mode
`.claude/CLAUDE.md` already forbids for `test.skip()`. The rule was written for `test.skip()` and
never extended to `if`, so the practice migrated instead of stopping.

**What changed.** Nine vacuous tests rewritten, three new tests added, and — because
`gate.sh` runs neither vitest project over `e2e/` — the two security properties were **also** pinned
in tiers the gate executes.

*Security, non-negotiable (both proven red-first — see Evidence):*

- `web/src/components/editor/linkOptions.ts` **(new)** — the app's link-href policy, named and
  exported: `protocols: []` plus an explicit `isAllowedUri` that denies
  `javascript`/`data`/`vbscript`/`file`/`blob` after `defaultValidate`. Behaviourally a **no-op
  today**: `@tiptap/extension-link` 2.27.2 already rejects all five in its default `isAllowedUri`
  and strips the `href` during `renderHTML`. The point is that the protection was *inherited
  silently* — adding a scheme to `protocols`, or overriding `isAllowedUri`, would have removed it
  with no test failing anywhere. Wired into `web/src/components/Editor.tsx:588` and all three
  `Link.configure` calls in `web/src/components/StandupFeed.tsx`.
- `web/src/components/editor/linkOptions.test.ts` **(new, 27 cases, runs in the gate)** — content
  loaded as TipTap **JSON**, which is the stored-XSS path (`Mark.fromJSON` does not run
  `parseHTML`'s href guard). Asserts a benign `https` href survives *and* that
  `javascript:` / `data:text/html` / `data:image/svg+xml` do not, plus scheme-obfuscation cases
  (`jav\tascript:`, `java\nscript:`, `j a v a s c r i p t:`).
- `api/src/routes/workspaces.test.ts` — three cases added beside the existing member→403 check: the
  403 body must not carry `"logs"`, an unauthenticated request is refused, and a member is refused
  the audit log of a workspace they are not a member of.
- `e2e/security.spec.ts` — the two link tests are replaced by *stored dangerous link hrefs are not
  rendered live*, which opens a seeded document whose `content` already holds link marks with
  dangerous hrefs and asserts unconditionally; plus *markdown link syntax does not create a link at
  all*, which pins the fact the old tests were unknowingly relying on, so that adding a
  markdown-link input rule later fails loudly instead of silently re-opening the vector.
- `e2e/authorization.spec.ts` — every precondition is its own assertion with an actionable message,
  so a setup failure now fails *as a setup failure*; plus a companion test for a foreign workspace's
  audit log.

*The rest, working outward from security:*

| file | test | was |
|---|---|---|
| `e2e/file-attachments.spec.ts:161` | should validate file type | **0 `expect()`** — uploaded a `.exe`, slept 1 s, listed three acceptable outcomes in a comment. Now asserts the blocked-file dialog fired, that **no request reached `/api/files`** (the bytes never leave the browser), and that no attachment node was inserted. |
| `e2e/file-attachments.spec.ts:422` | should block dangerous executable files (.exe) | assertions lived *inside* `page.on('dialog')`, so they never ran if the dialog never fired. Messages are collected and asserted outside the handler. |
| `e2e/check-aria.spec.ts` | check aria-expanded elements | **0 `expect()`** — a diagnostic script with 19 `console.log`s and `return`-on-missing-data. Now asserts the A11Y-1 contract: `aria-expanded` sits on a real `<button>`, is named, and (new second test) tracks the children and survives navigating into one. |
| `e2e/accessibility-remediation.spec.ts:1398` | code blocks have language indication | **0 `expect()`** — ran on `/docs`, which renders no code block, and discarded the computed result. Now opens a seeded document with one code block and asserts count **and** language. |
| `e2e/admin-workspace-members.spec.ts:87` | can change member role | whole body inside `if (await roleSelect.isVisible())`. Now asserts the seeded member row exists, and reloads to prove the PATCH reached the server rather than only moving a local `<select>`. |

**Fixture work, never a conditional skip.** `e2e/fixtures/isolated-env.ts` gains
`seedRenderingFixtures()`: a *Link Sanitization Fixture* document (one benign control href + three
dangerous ones stored as link marks) and a *Code Block Fixture* document (one code block with
`language: 'javascript'`). Both are seeded at `position` 90/91 so they sort last and never become
the document `/docs` auto-opens. Titles and hrefs are exported as constants so a rename cannot
orphan a spec. `e2e/fixtures/test-helpers.ts` gains `openFixtureDocument(page, title)`, which
resolves the id through `GET /api/documents` and asserts the fixture exists with an actionable
message.

**The positive control is the mechanism.** Every rewritten test that inspects rendered elements now
asserts *first* that the thing it will inspect is present. Without that, "the page rendered nothing"
is indistinguishable from "the check passed", which is exactly what 68 tests were doing.

**Evidence.** Red-before-green, both security properties, under `pnpm --filter @ship/{web,api} exec
vitest run <file>` against the branch's own worktree database
(`postgresql://…@localhost:5433/ship_wt_tro_224`):

| deliberate break | result |
|---|---|
| `linkOptions.ts` → `isAllowedUri: () => true` + `protocols: ['javascript','data']` | **4 failed / 23 passed.** `AssertionError: javascript: must not survive into a rendered href`, same for `data:text/html` and `data:image/svg+xml`, plus `"javascript" must never be an allowed link protocol`. The benign-control case stayed **green**, which is what shows the failure is the vulnerability and not a broken test. |
| `workspaces.ts:1021` → `workspaceAdminMiddleware` removed from `GET /:id/audit-logs` | **3 failed / 25 passed**, each `expected 200 to be 403`. Includes the foreign-workspace case, i.e. without the middleware the handler itself does no scoping. |
| both reverted | 27/27 and 28/28 pass. |

**Gate result, and how it got there.** Before this branch merged `main`, `scripts/factory/gate.sh`
reported `tests:not-weakened FAIL — 6 removed test/assertion line(s)`. That check counted removed
`expect(` lines with no comparison to added ones, so it could not distinguish deleting an assertion
from *replacing a vacuous one*. All six removed lines were the vacuous assertions this ticket exists
to delete:

```
e2e/authorization.spec.ts    expect(response.status()).toBe(403)        # was inside two nested ifs
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('.exe')      # was inside page.on('dialog')
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('blocked')   # was inside page.on('dialog')
e2e/security.spec.ts         expect(href).not.toContain('javascript:')       # was inside a loop over 0 elements
e2e/security.spec.ts         expect(href).not.toContain('text/html')         # was inside `if (href?.startsWith('data:'))`
e2e/security.spec.ts         expect(href).not.toContain('<script')           # was inside `if (href?.startsWith('data:'))`
```

Each is replaced by a stronger unconditional assertion in the same test; `regression-test` reports 13
added cases. After merging `main` (`86b5231`), `gate.sh`'s G5 had independently been changed to a net
comparison of removed vs. added test lines — motivated by this exact false-positive class on other
tickets (TRO-223, TRO-179) — and now reports `tests:not-weakened PASS — -6 / +51 test line(s) — net
gain, reviewer should confirm the removals are corrections`. No edit to `gate.sh` was made on this
branch; the fix landed on `main` independently and this entry is corrected to match the gate this PR
actually merges against. Every other gate is green, including `review-patterns` (G7b, also new from
`main`) and both vitest projects.

Three separate gate runs have each failed `tests:api` on a *different* untouched test
(`backlinks.test.ts`, `rate-limit.test.ts`, then `weeks.test.ts`'s "should reject review approval
without rating"); all three pass standalone and the full api suite is 472/472 each time — that is
TRO-277's load-sensitive flake (documented to appear under CPU load, right after `type-check` +
`build`), not this branch.

**Attempted, then reverted — and it found two bugs.** `e2e/ai-analysis-api.spec.ts:209`
*"POST /api/ai/analyze-plan returns 429 after 10 rapid requests"* guards its assertions with
`if (!allSucceeded)`, so the single outcome it exists to catch — the limiter doing nothing — is the
one outcome it excuses. Making the assertion unconditional produced, **observed**,
`Got: 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200` — eleven admissions, no `429`. Two
findings fall out, neither of them a test bug:

1. **The test's premise is false.** `api/src/services/ai-analysis.ts:39` sets `RATE_LIMIT = 120`
   per hour, not 10. Eleven requests cannot trip it, and never could.
2. **The user is told the wrong number.** `api/src/routes/ai.ts:34` returns *"Rate limit exceeded.
   Max 10 analysis requests per hour."* while 120 is enforced. Whoever hits the ceiling is given a
   figure off by 12×.

The file is reverted to its original state. Asserting truthfully would need 121 requests — 120 of
which each attempt a Bedrock call and would likely blow the 60 s test timeout — or making the limit
injectable, which is a production change to enable a test. Neither belongs in a test-integrity
ticket. The 10-vs-120 inconsistency needs its own ticket; the vacuous guard stays on the TEST-2 list
until it does.

**Not done, deliberately.** 60 of the 68 remain. `program-mode-week-ux.spec.ts` alone holds 33
(sprint-filter and quick-menu UX, no security content); `accessibility-remediation.spec.ts` has 6
more, `context-menus.spec.ts` 6, `features-real.spec.ts` 5, `performance.spec.ts` 2, and
`ai-analysis-api.spec.ts` keeps 1 (see above), and
`admin-workspace-members.spec.ts` keeps 2 (`selecting user from search…`, `can add existing user…`)
which are guarded on a **"test space" workspace and a "carol" user that the isolated fixture does
not create** — converting those guards needs a second seeded workspace and more users, which risks
the workspace-switcher and admin-dashboard specs and belongs in its own ticket. See TRO-225's entry
for the retries decision.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database

# The tiers the factory gate actually executes
pnpm --filter @ship/web exec vitest run src/components/editor/linkOptions.test.ts   # 27 pass
pnpm --filter @ship/api exec vitest run src/routes/workspaces.test.ts               # 28 pass

# The e2e specs, targeted. Never the whole suite: 600+ tests, per-worker containers.
pnpm exec playwright test e2e/security.spec.ts       --workers=1 --retries=0        # 18 pass
pnpm exec playwright test e2e/authorization.spec.ts  --workers=2 --retries=0        # 18 pass
pnpm exec playwright test e2e/file-attachments.spec.ts --workers=2 --retries=0      # 13 pass
pnpm exec playwright test e2e/check-aria.spec.ts e2e/admin-workspace-members.spec.ts --workers=2 --retries=0
pnpm exec playwright test e2e/accessibility-remediation.spec.ts --workers=2 --retries=0 \
  -g "code blocks have language indication"                                          # 1 pass
```

To see the security tests fail, reintroduce the vulnerability: set
`isAllowedUri: () => true` in `web/src/components/editor/linkOptions.ts`, or drop
`workspaceAdminMiddleware` from `api/src/routes/workspaces.ts:1021`.

**Rollback.** `git revert` the branch. The only production code touched is the new
`linkOptions.ts` and the four `Link.configure` call sites that spread it; reverting restores
reliance on `@tiptap/extension-link`'s default `isAllowedUri`, which blocks the same five schemes
today.

---

## TRO-225 — [TEST-3] Retries hid a test that failed first-attempt in 100% of runs

**What was broken.** `playwright.config.ts:60` sets `retries: process.env.CI ? 2 : 1`. Across three
identical 869-test runs, counting **first attempts only**, 8 / 5 / 3 tests failed; after retries the
runner reported 1 / 0 / 1. Retries erased 7 / 5 / 2 failures
(`audit/test-quality/runs/e2e-flake-union.txt`). The worst case,
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`, **failed or
timed out on the first attempt in all three runs and was reported as passing all three times.**

**The recorded diagnosis was wrong.** That spec's header blamed Yjs persistence timing — "the retro
document IS created … but its Yjs content isn't persisted … even with a 10s wait … Needs
investigation on a separate branch." Two runs settle it (observed, `--workers=1 --retries=0`, this
worktree):

| invocation | result |
|---|---|
| `playwright test e2e/my-week-stale-data.spec.ts` | plan **passes**, retro **fails** — `getByText('Completed the API refactoring')` never appears |
| `playwright test e2e/my-week-stale-data.spec.ts -g "retro edits"` | retro **passes** (22.5 s) |

The retro test does not fail on its own merits. It fails **because the plan test ran first in the
same worker's database** — the "shared state inside a worker's database" root cause the finding
names, demonstrated rather than inferred.

**Mechanism** (read from the code, consistent with the above). When a weekly plan already exists for
the same person+week, `POST /api/weekly-retros` (`api/src/routes/weekly-plans.ts:641-656`) swaps
`WEEKLY_RETRO_TEMPLATE` for `buildRetroTemplateWithPlanItems(...)`: heading, then a `planReference`
node plus an empty `paragraph` per plan item, then an "Unplanned work" heading and a 3-item bullet
list. The old test clicked the editor's **centre**, so in that taller document the caret landed in a
top-level paragraph rather than inside a list item — and `extractPlanItems`
(`api/src/routes/dashboard.ts:279-309`) collects only `listItem`/`taskItem` text. The typed line
never reached the `/my-week` card. The failure screenshot confirms it: the retro card renders as a
**link** to a real document (so the document exists) whose body still reads "+ Create retro for this
week" (so `items` is empty).

**What changed** in `e2e/my-week-stale-data.spec.ts`:

1. **The cross-test dependency is gone.** `typeIntoFirstListItem()` places the caret in the first
   empty list item explicitly, so the typed text lands in the node type `/my-week` reads whichever
   template the API produced. Both tests use it.
2. **The fixed sleep is gone.** `await page.waitForTimeout(3000)` — a guess at how long persistence
   takes, and the second root-cause smell the finding lists — is replaced by
   `waitForMyWeekToContain()`, which polls `GET /api/dashboard/my-week` until the item is actually
   readable. This also *localises* the failure: a genuine persistence problem now fails at the poll
   with the API's own payload in the message, not 15 s later at a DOM assertion.
3. **Assertions are scoped to their card.** `myWeekSection(page, 'Weekly Retro')` prevents the retro
   assertion from being satisfied by the plan card.
4. The misleading "KNOWN FLAKY / needs investigation" header is replaced by the two-run evidence
   above.

**Decision on `retries`: left at `CI ? 2 : 1`, and here is why.** This branch fixed **1 of the 11**
tests on the flake list. Lowering retries — or setting `failOnFlakyTests: true`, which is the better
end state because it keeps the retry's trace artifact while refusing to score a retry-rescued test
as a pass — would immediately turn a misleadingly-green suite into a permanently-red one with ten
root causes still outstanding, and a permanently-red suite gets ignored exactly as fast as a
falsely-green one. It is a one-line change that costs nothing to defer and belongs with the *last*
flake fix, not the first. What has changed is that the choice is no longer invisible:
`playwright.config.ts` now carries the 8/5/3-vs-1/0/1 measurement, the pointer to
`e2e-flake-union.txt`, and the exact switch to flip. **No claim is made that the other ten flakes
are fixed.** They are:

`inline-comments.spec.ts › canceling a comment removes the highlight` (failed final in 2 of 3 runs —
the strongest remaining candidate), `mentions.spec.ts › should sync mentions between collaborators`,
`weekly-accountability.spec.ts › Allocation grid shows person with assigned issues…`,
`bulk-selection.spec.ts › shift+down then shift+up contracts selection`,
`my-week-stale-data.spec.ts › plan edits…` (flaky once; its fixed sleep is removed here too),
`performance.spec.ts › many images do not crash the editor`,
`programs.spec.ts › program cards show emoji or initial badges`,
`project-weeks.spec.ts › project link in Properties sidebar navigates back to project`,
`status-overview-heatmap.spec.ts › displays split cells for plan/retro status`,
`team-mode.spec.ts › clicking collapsed header expands the group`.

**Second finding, and the more serious one: the editor sometimes never receives a new document's
content.** Once the test asserted that the template had *arrived* — rather than typing into whatever
happened to be on screen — it began failing for an entirely different reason. **Observed**, three
repeat runs at `--workers=1 --retries=0`: run 1 clean, run 2 the *plan* document opened blank, run 3
the *retro* document opened blank. To a user that is a brand-new weekly plan opening as an empty
editor instead of the template.

**Derived** from code reading, not instrumented: `getOrCreateDoc`
(`api/src/collaboration/index.ts:220-226`) publishes the new `Y.Doc` into the shared `docs` map
*before* awaiting the database read and the `jsonToYjs` conversion at `:231-266`, and registers the
broadcasting `doc.on('update')` handler only afterwards. A second connection for the same document
arriving inside that window is handed the empty doc, is sent `writeSyncStep1` from it, and never
receives the conversion update — and `freshFromJsonDocs.delete(docName)` after the first client means
it does not get the cache-clear signal either. The shape of the fix is to store the load *promise* in
the map so concurrent callers await the same load. Needs its own ticket.

This also explains the **other** my-week entry on the flake list (`plan edits are visible on /my-week
…`, flaky in 1 of 3 audit runs), which the plan/retro template coupling does not — and it is very
probably what the original file header was reaching for when it blamed "Yjs persistence".

Until it is fixed, `typeIntoTemplateList` tolerates it with **one bounded reload** (`toPass`, the
construct `e2e/AGENTS.md` sanctions) and a failure message that names the finding and the file:line.
That is a workaround in the *setup* phase of a test whose subject is something else; it is not a
guard, because the assertion still has to pass, and it is not silent.

**Third finding, reported not fixed.** `extractPlanItems` exists in three copies with **divergent**
behaviour: `api/src/routes/dashboard.ts:279-309` collects only `listItem`/`taskItem`, while
`api/src/routes/weekly-plans.ts:63-95` and `api/src/services/ai-analysis.ts:69` also collect
top-level paragraphs longer than 10 characters. Consequence for a real user: an auto-populated retro
puts an empty `paragraph` under each `planReference` block *specifically so you write your update
there* — and `/my-week` then shows an **empty retro card**, because the dashboard reader ignores
paragraphs. That is a product bug, not a test bug; fixing it changes what `/my-week` displays, which
is out of scope for a test-integrity ticket. Needs its own ticket.

**Evidence.** Targeted specs only — the full suite was not run (600+ tests, per-worker containers,
not in the gate). Commands and results are in the PR body / final report; the decisive pair is the
two-run table above.

**How to run it.**

```bash
source .factory-env

# The configuration that reproduced the deterministic failure. 4 consecutive clean runs
# after the fix; before it, the retro test failed every time this way.
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0

# The two-run experiment that identified the cross-test dependency (run against `main`):
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0 -g "retro edits"
```

**Rollback.** `git revert` the branch. `playwright.config.ts` changes are comment-only, so reverting
restores the previous behaviour exactly.

---

## TRO-217 — [A11Y-3] `/my-week` failed colour contrast, the landing page of the app

**What was broken.** `/` redirects to `/my-week`, and it was the only key page Lighthouse failed on
accessibility: **95**, one failing audit, `color-contrast`. axe reported it **Serious** on 18 nodes
(24 in the audit baseline; the count tracks how many future standup rows the current week still
has, so it moves with the weekday).

The finding named two causes. There were **three**, and one of the two named was misattributed:

| Cause | Nodes | Resolved colour | Ratio |
|---|---|---|---|
| `opacity-40` on future standup rows (`MyWeekPage.tsx:339`) | 12 | `#3f3f3f` on `#0d0d0d` | **1.84:1** |
| `text-muted/50` on the 11px plan/retro ordinals | 4 | `#4c4c4c` on `#0d0d0d` | **2.26:1** |
| `text-accent` used as a *foreground* colour | 2 | `#005ea2` on `#0a1d2b` / `#0c1114` | **2.55:1** / 2.82:1 |

The dominant cause — two thirds of the nodes — was `opacity-40`, which the finding never mentioned.
And `bg-accent/20`, which the finding did blame, is not the defect: `accent` (`#005ea2`) is
**2.89:1 as text on the page background before any badge is involved**; the translucent fill only
takes it from 2.89 to 2.55. The fill was fine. Using a fill colour as text was not.

A **fourth** pair, in neither the finding nor either axe run: the "Unsubmitted" badge puts
`text-muted` on a `bg-border` fill at **4.38:1**. It renders only when a plan or retro has content,
is unsubmitted, and is not yet due — a state neither scan happened to hit. It is not a guess: axe
recorded that identical pair on the command palette's `esc` key
(`audit/a11y/axe/command_palette_open.json`).

**What changed.**

- `web/tailwind.config.js` — added `accent-text: #2491ff` (USWDS blue-40v, verified against
  `@uswds/uswds/.../tokens/color/_blue.scss`): **6.08:1** on `background`, 5.37:1 on a
  `bg-accent/20` badge, 5.94:1 on `bg-accent/5`. `accent` itself is **unchanged**, so every
  `bg-accent` fill in the app looks exactly as it did. blue-50v (`#0076d6`) was tried and rejected —
  4.22:1, still failing. Also corrected the `muted` comment, which claimed 5.1:1 where the
  arithmetic gives 5.63:1, and recorded the `bg-border` caveat next to it.
- `web/src/pages/MyWeekPage.tsx` — `opacity-40` removed from future rows in favour of a dimmer
  border; `text-muted/50` → `text-muted` on the two ordinals; `text-accent` → `text-accent-text` on
  the "Current" badge and today's day label; `text-muted` → `text-foreground` on the two
  "Unsubmitted" badges.

**Why the levels differ, since a global token change was the obvious move.**

- `opacity-40` was **page-level** because `MyWeekPage.tsx:339` was its *only* occurrence in
  `web/src`. Nothing else could be affected.
- `text-muted/50` was **page-level** because 10 of its 12 occurrences are on other pages
  (`PlanQualityBanner`, `DashboardVariantC` at `/dashboard`, `WorkspaceSettings`,
  `AdminWorkspaceDetail`, `Programs`, `MergeProgramDialog`, `HypothesisBlockComponent`). They fail
  too — 2.26:1 is a property of the token pair, not of this page — but they are outside A11Y-3 and
  are filed as a follow-up rather than swept in silently.
- `accent-text` was added at **token level** but applied only here. Adding a token cannot regress a
  page that currently passes; mutating `accent` could, because `accent` is a fill under white text
  in 80 places across 45 files. That mutation is a visual-identity decision, not a contrast fix.

**The tradeoff, stated because it is visible.** Future standup rows are no longer ghosted. They now
read as ordinary muted rows, distinguished by a dimmer border, the italic "Upcoming" label and the
absent status dot. This was not avoidable by tuning the opacity value: `text-muted` only clears
4.5:1 above roughly **86%** opacity, at which point nothing looks dimmed at all. Likewise the
ordinals lost their extra-quiet tier — on `#0d0d0d`, AA bottoms out around `#7a7a7a`, a 16-step
band below `muted`, so a perceptibly quieter *compliant* grey does not exist on this background.
Contrast won, as the ticket directed.

**Evidence.** Both ends measured on this branch, same conditions, not inherited from the audit:
`http://localhost:5683`, Chrome for Testing headless, 1440×900, `--preset=desktop`,
`--only-categories=accessibility`, authenticated as `dev@ship.local`, 523 seeded documents,
`ship_wt_tro_217`. Flags identical to `audit/a11y/run-lighthouse.sh` and `audit/a11y/axe-scan.mjs`.

| Measurement on `/my-week` | Before | After |
|---|---|---|
| Lighthouse accessibility | **95** | **100** |
| Lighthouse failing audits | 1 (`color-contrast`, 18 items) | **0** |
| axe `color-contrast` nodes | **18 Serious** | **0** |
| axe all severities | C0 **S1** M0 m0 | C0 S0 M0 m0 |

The audit baseline recorded 24 nodes and the ticket said 25; **18** is what the same page produced
here. The gap is the weekday (four remaining future days instead of six), not a different defect —
the per-node causes and ratios match the baseline artifact exactly.

**Regression test.** `web/src/pages/MyWeekPage.contrast.test.tsx` resolves the effective foreground
and background *colours* out of the rendered DOM and asserts the WCAG ratio, rather than asserting
a class string — so it survives a markup refactor and fails if a palette hex drifts back under
4.5:1. It renders four data states, because three of the page's pairs only exist under specific
data; a single-state check would have declared the page fixed while the 4.38:1 badge sat behind a
common plan state. `web/src/lib/contrast.test.ts` pins the resolver against numbers this project
did not compute — the exact `fgColor`/`bgColor`/`contrastRatio` values axe recorded in
`audit/a11y/axe/`.

Confirmed red first on the unfixed page: 6 failures, every one an `AssertionError` on the ratio
(21 of 39 pairs below 4.5:1 in the first state; named failures at 2.26:1, 1.85:1, 2.82:1, 4.38:1).
No import or locator errors.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 24 new tests; 13 known failures are TEST-1/TRO-223, unchanged
pnpm --filter @ship/web type-check
```

To re-measure against a browser, start the worktree's API and Vite, log in for a fresh
`session_id` (sessions expire in 15 minutes), then run Lighthouse and axe with the flags above.

**Roll back.** `git revert` the commits on `fix/a11y-3-contrast`, or by hand: restore `opacity-40`
on the future-row branch of `rowClass`, put back `text-muted/50` on the two ordinals,
`text-accent` on the "Current" badge and today's day label, `text-muted` on the two "Unsubmitted"
badges, and drop `accent-text` from the palette. The two new spec files fail if any of it comes
back, which is the point.

**Not established.** That a low-vision user can now read the page. Contrast ratios and axe output
are measured; the user-facing benefit is *derived* from them, and no human with low vision has
looked at this build. Also not established: that the repo's three Playwright a11y specs still pass
— they are not run by the factory gate and were not run here. One of them,
`e2e/accessibility-remediation.spec.ts:738` ("no color contrast violations on main pages"), runs
axe right after login, which lands on `/my-week`; it was almost certainly failing before this
change and should now pass, but that is a prediction, not a result.

**Found and not fixed** (filed as follow-ups, all measured):

1. `text-muted` on a `bg-border` fill is **4.38:1** and co-occurs in ~109 places in `web/src`.
   Raising `muted` from `#8a8a8a` to `#929292` (4.86:1 on `#262626`, 6.25:1 on `#0d0d0d`) fixes the
   whole class in one line and cannot lower contrast on any dark surface. Out of scope here because
   it is an app-wide tone change driven by pairs outside this page.
2. `text-accent` is **2.89:1** as small text on the page background wherever it renders — 80
   occurrences in 45 files. Only the two on `/my-week` were observed failing by axe; the rest is
   computed from the token, so treat the count as derived. `accent-text` now exists for them.
3. `bg-surface` is used in three files including `MyWeekPage.tsx`, but `surface` is **not a palette
   token**, so the class generates no CSS and those "cards" are painted with the page background.
   Harmless today; it silently changes the contrast maths for anything inside them if `surface` is
   ever defined.
4. `getContrastTextColor` in `web/src/lib/cn.ts` carries a second copy of the WCAG luminance
   formula now also in `web/src/lib/contrast.ts`. Collapsing them changes a shipped helper's
   behaviour on malformed input, so it was left alone.
5. `pnpm db:migrate` stopped after `010_oauth_state.sql` on a partially-migrated database and still
   reported success, leaving 10 of 42 migrations applied — the swallowed `already exists` catch at
   `api/src/db/migrate.ts:103-110`. This is **DB-1** reproducing; worked around by cloning a
   fully-migrated database rather than by touching the runner.

---

## TRO-215 — [A11Y-1] Navigation sidebars claimed `role="tree"` without a tree keyboard model

**What was broken.** `web/src/pages/App.tsx:637` declared
`<ul role="tree" aria-label="Workspace documents">`, which tells assistive technology "this is a
composite widget, enter interaction mode and navigate with arrow keys." Nothing implemented that
contract: no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`/`aria-posinset`
anywhere in `DocumentTreeItem.tsx` or `App.tsx`. The same pattern appeared in four more places.
Because `role="tree"` also overrides the `<ul>`'s list role, the two bare `<li>` children of that
list — the empty state and the "N more..." overflow link — became roleless orphans, producing axe
**Critical `aria-required-children`** plus **Serious `listitem`**.

**What changed.** Subtraction. `role="tree"`, `role="treeitem"` and `role="group"` are gone from
the document/context/project navigation sidebars, along with `aria-expanded`/`aria-selected` on
the `<li>` elements. The native `<ul>`/`<li>`/`<a>` structure is unchanged and needs no ARIA.

- `web/src/pages/App.tsx` — workspace + private document lists, the local `DocumentTreeItem`, and
  the projects list. `DocumentsTree` is now exported as a unit-test seam.
- `web/src/components/DocumentTreeItem.tsx` — the shared item used by the /docs tree view.
- `web/src/pages/Documents.tsx` — the container for the above; it had to move with the items,
  because a `role="tree"` whose children stop being treeitems is a *new* Critical.
- `web/src/components/ContextTreeNav.tsx`, `web/src/components/sidebars/ProjectContextSidebar.tsx`.

State that used to live on the `<li>` moved to where it is valid ARIA: `aria-expanded` is now on
the expand/collapse `<button>`s, and the active document was already marked with
`aria-current="page"` on its `<a>`.

**One behaviour change, from PR review.** Moving `aria-expanded` onto the buttons exposed that the
person row in `ProjectContextSidebar` was a `<button aria-expanded="false">` even for a person with
**no weeks** — controlling nothing, and with a provably no-op click (`togglePerson` writes
`expandedPeople`, read only by `isExpanded && hasWeeks`). That row is now a plain `<div>`: still
readable, no longer a phantom tab stop. People *with* weeks are unchanged — chevron, week count,
working `aria-expanded`. Reverting restores the focusable no-op button.

**Deliberately kept.** `aria-live="polite"` on the two document lists. It is the WCAG 4.1.3
mechanism for announcing create/delete and is asserted by
`e2e/accessibility-remediation.spec.ts` ("document tree updates are announced"). Whether it is
too verbose on expand/collapse is a screen-reader question, and removing it on a prediction is
the exact error A11Y-1 itself was — see the follow-up note below.

**Out of scope, deliberately.** `web/src/pages/OrgChartPage.tsx` keeps `role="tree"`: it is the
one real tree widget in the codebase (roving `tabIndex` at `:664`, `onKeyDown` at `:462`).

**Evidence.** axe-core 4.11 via `@axe-core/playwright`, Chromium 1223 headless, 1440×900, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, logged in as `dev@ship.local` against a locally
seeded database. Counts are Critical/Serious/Moderate/minor.

| page | before | after |
|---|---|---|
| `/docs` | **C1 S1** M0 m0 — `aria-required-children`, `listitem` | **C0 S0** M0 m0 |
| `/documents/:id` | **C2 S1** M1 m0 | **C1 S0** M1 m0 |
| `/issues` | C0 S0 M0 m1 | C0 S0 M0 m1 |

The Critical remaining on the document view is `aria-allowed-attr` on the editor `<div>` — that is
**A11Y-2**, a separate finding, untouched here.

**Reproduction precondition (worth knowing).** The violation is data-dependent: it only fires when
a sidebar section has **more than `SIDEBAR_ITEM_LIMIT` (10)** root documents, which renders the
bare `<li>` "N more..." overflow link, or **zero**, which renders the bare `<li>` empty state. A
freshly seeded database has 5 and shows **no** violation. The audit environment had more than 10.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 5 new specs, 26 assertions, all green
pnpm type-check
```

**Rollback.** `git revert` the commits on `fix/a11y-1-sidebar-aria`, or by hand: restore the five
`role="tree"`/`role="treeitem"` sites listed above, and restore the person row in
`ProjectContextSidebar.tsx` to a single `<button>` for both the has-weeks and no-weeks cases. The
five new `*.test.tsx` files fail if either comes back, which is the point.

**Still owed — do not mark this fully verified.** Nobody has listened to it. A human found on
2026-07-28 that VoiceOver did not announce the document titles *at all* under the old markup;
this change makes the DOM use native list semantics and axe agrees, but **no screen-reader pass
has been run on the fixed build.** That verification, plus a judgement on the retained
`aria-live`, is outstanding.

---

## TRO-188 (ERR-1) + TRO-189 (ERR-2) — the editor stops lying about "Saved", and a revoked session stops writing

Both findings live in the collaboration path and ship as one change: TRO-189 makes the server hang
up on sockets whose session is gone, and TRO-188 makes the editor say so instead of showing
"Saved" over work that is not saved. Fixing one without the other would have produced a *silently*
disconnected editor — a worse version of ERR-1.

**What changed — TRO-189 / ERR-2 (security: logged-out user kept write access).**

The collaboration socket was authenticated exactly once, during the HTTP upgrade
(`api/src/collaboration/index.ts`, `server.on('upgrade')`), and never re-checked. Deleting or
expiring the session left the socket writing to `documents` indefinitely while REST correctly 401'd
(audit `probe7c`, `probe6.4`).

- Each connection now records the `sessionId` that authorized it (`DocConnection` / `EventConnection`).
- `revalidateLiveSessions()` re-checks every session backing a live socket on an interval
  (`DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000`), in **one batched query** for all distinct
  sessions, applying the same two windows as the REST middleware (`SESSION_TIMEOUT_MS`,
  `ABSOLUTE_SESSION_TIMEOUT_MS`). Invalid → the socket is closed with code **4401**.
- It **fails open** on a database error: a transient outage must not disconnect every open editor.
- `closeSocketsForSession()` is called directly from `POST /api/auth/logout` and from the
  session-fixation rotation on login, so logout takes effect at once rather than up to 30s later.
- Connections are marked `revoked` *before* `ws.close()`, and inbound frames from a revoked
  connection are dropped — `close()` only starts the closing handshake, so without this an edit
  already in flight could still be persisted.

Behaviour change to be aware of: a session that has passed the 15-minute inactivity window now
loses its collaboration socket, where before only REST rejected it. Collaboration traffic
deliberately does **not** refresh `last_activity` — doing so would let an open tab keep a session
alive forever, which is a larger hole than the one being closed.

**What changed — TRO-188 / ERR-1 (data loss under a "Saved" label).**

`Editor.tsx` treated the WebSocket `status: connected` event as proof of persistence. It is not:
audit `probe2d-ws-unavailable.json` records **three** `connected` events and **zero** `sync` events,
with the indicator reading "Saved" for 60 s while `inDb=false`, ending in a document whose content
was `""`. `probe2-ws-drop` and `probe2e` show the same lie under the "Cached" label.

- The header indicator moved out of `Editor.tsx` into `web/src/components/editor/SyncStatusIndicator.tsx`
  with the derivation as a pure function (`deriveSyncIndicator`).
- "Saved" now requires `isSynced` — the y-websocket `sync` event, the only evidence the document
  reached the server. `status: connected` no longer sets it, and `sync(false)`/`disconnected`
  clears it.
- The unsynced state renders as **"Not saved"**, red, with a title that names the consequence
  ("changes … will be lost if you reload"). The reassuring "Cached" label is gone.
- A neutral "Connecting" state covers the first connection attempt only, so a normal page load does
  not flash a warning.
- Close code 4401 (TRO-189) stops the reconnect loop and drives the indicator to "Not saved",
  which is how a revoked session becomes visible to the user.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api  exec vitest run src/collaboration/__tests__/session-revocation.test.ts
pnpm --filter @ship/web  exec vitest run src/components/editor/SyncStatusIndicator.test.tsx
scripts/factory/gate.sh
```

The api test drives the real collaboration server over a real WebSocket and asserts on the
`documents` table, not on a mock. It runs with a 200 ms revalidation interval via
`setupCollaboration(server, { sessionRevalidationIntervalMs })`.

**Rollback.** Revert the commits on `fix/err-1-err-2-collab-socket`. Independently:
for TRO-189 alone, delete the `revalidateLiveSessions`/`closeSocketsForSession` block in
`api/src/collaboration/index.ts` and its two call sites in `api/src/routes/auth.ts` — nothing else
depends on them, and `setupCollaboration`'s second argument is optional. For TRO-188 alone, pass a
permanently-true `isSynced` to `SyncStatusIndicator`, which restores the old "connected means
Saved" behaviour.

---

## TRO-172 — [API-1] Rate limiter no longer caps production at 100 req/min per IP

**What changed.** Two halves, server and client.

*Server* — `api/src/middleware/rate-limit.ts` (new) replaces the single `apiLimiter` that lived in
`api/src/app.ts`. `/api/` is now guarded by two chained limiters over the same 60 s window:

| Limiter | Key | Production limit | Purpose |
|---|---|---|---|
| `perSourceIpLimiter` | source IP | 6,000 / min (100 req/s) | anti-flood floor; makes the identity key unspoofable in aggregate |
| `perIdentityLimiter` | `session_id` cookie → `Bearer` token → source IP | 600 / min (10 req/s) | the budget users actually feel |

The old configuration was **100 / min keyed on IP**. Both numbers in it were wrong:

- *Unit.* The ceiling was sized as if one page view were one request. The audit's browser trace
  measured 63 `/api` requests across 8 flows (login 16, dashboard 12, document view 10, sprint
  board 10), so a user exhausted the window after ~6–10 navigations per minute.
- *Key.* With CloudFront → Elastic Beanstalk and `trust proxy 1`, every user behind one agency NAT
  egress resolved to the same IP, so a whole team shared one 100 req/min budget.

600 is justified against the measurement: the worst single-user burst is 16 XHRs × 20 navigations
per minute = 320 req/min, so 600 leaves ~1.9× headroom and still caps one session at 10 req/s.
6,000 accommodates ~187 simultaneously-active users behind one NAT egress at the measured average
of ~32 req/min per active user, while staying far below the 299–4,049 req/s this API was measured
to serve — a single-source flood is still capped. Test (10,000) and dev (1,000) budgets are
unchanged. Session ids and tokens are SHA-256 fingerprinted before use as bucket keys.

*Client* — `web/src/lib/queryClient.ts` now retries HTTP 429 for **queries and mutations** with a
2 s / 8 s / 20 s / 45 s backoff plus additive jitter. The schedule sums to ≥75 s so at least one
attempt lands after the server's 60 s window rolls over; React Query's default 1/2/4 s backoff
would exhaust itself inside the same window. Every other 4xx is still treated as permanent. If the
retries are exhausted the write is genuinely lost, so `MutationErrorToast` now raises a **sticky**
toast (`web/src/components/ui/Toast.tsx` gained `duration: 0` = no auto-dismiss) naming rate
limiting as the cause instead of a generic three-second message.

**Measured, NODE_ENV=production, concurrency 10, `GET /api/documents?type=wiki`, in-process listener:**

| Scenario | Before | After |
|---|---|---|
| 1,000 requests, no session cookie | 100 served / 900 throttled (90%) | 600 served / 400 throttled (40%) |
| 2,000 requests, 20 distinct sessions behind one IP | 100 served / 1,900 throttled (95%) | **2,000 served / 0 throttled** |

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts
pnpm --filter @ship/web test src/lib/queryClient.test.ts src/components/MutationErrorToast.test.tsx
```

**Rollback.** Revert the commits, or by hand: delete `api/src/middleware/rate-limit.ts` and restore
the single `apiLimiter` (`windowMs: 60_000`, `max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100`) plus
`app.use('/api/', apiLimiter)` in `api/src/app.ts`; restore the two inline `retry` predicates in
`web/src/lib/queryClient.ts` and drop `retryDelay`. The `Toast` `duration: 0` support and the
sticky-toast branch in `MutationErrorToast` are additive and safe to leave.

---

## Factory visibility — status command, published board, cost analysis (no ticket: tooling)

**What changed.** Three additions, all reading from sources of truth rather than a status file:

- `scripts/factory/lib/state.mjs` — reconstructs factory state from git worktrees, `.factory-env`,
  `.factory/gate-result.json`, `gh pr list`, `scorecard.jsonl`, and Claude Code session
  transcripts. No state file is written, because one that drifts reads as authoritative while
  being wrong.
- `scripts/factory/status.mjs` — one-screen terminal view. `--json` feeds the board.
- `scripts/factory/board.mjs` — renders a self-contained HTML control panel (cream ground,
  British racing green, severity carried by stripe + wash + text colour, all contrast-measured
  against WCAG AA rather than estimated). Single-theme by choice: both `data-theme` values are
  pinned to the cream tokens so the viewer's toggle cannot flip it.
- `scripts/factory/serve.mjs` — local server that rebuilds the board from live state on every
  request. This is the surface for *operating* the factory: free to refresh, no agent needed.
  The published Artifact can only be updated by an agent calling a tool, so it is for *sharing*
  a milestone, not for watching a run.
- `scripts/factory/cost-report.mjs` — the graded "AI cost analysis" deliverable
  (`projectbrief.md:63`), derived retroactively from transcripts that already record per-message
  token usage.

**Decision: not LangGraph.** The workers are Claude Code sub-agents with their own tool loops in
git worktrees, so a graph framework would orchestrate opaque subprocesses — the interesting
internals are exactly what it cannot see. The durable state (branch, gate result, PR, Linear
ticket) already exists; a checkpointer would duplicate it and then disagree with it.

**How to run it.**

```bash
node scripts/factory/status.mjs
node scripts/factory/board.mjs > audit/factory/board.html   # then republish to the same URL
node scripts/factory/cost-report.mjs > audit/factory/COST_ANALYSIS.md
```

**Rollback.** Remove `scripts/factory/{status,board,cost-report}.mjs`, `scripts/factory/lib/state.mjs`,
and `audit/factory/{board.html,COST_ANALYSIS.md}`. Nothing else depends on them.

---

## TRO-244 — CI pipeline with source-code inventory

**What changed.** Added `.github/workflows/ci.yml`: typecheck, build, and unit tests for both
packages on every PR and every push to `main`, plus a source-code inventory job that emits a
per-SHA manifest (files and lines per package, dependency tree, licenses) as a retained artifact.

Web unit tests run with `continue-on-error` because 13 are known-failing (TEST-1 / TRO-223). The
real gate is the step after them, which compares failure *identities* against
`audit/factory/quarantine.json` and fails only on **new** breakage.

`pnpm lint` is deliberately **not** wired in: finding TS-6 (TRO-211) established there is no
ESLint config anywhere, so the script exits 0 having checked nothing. Adding it would make CI
advertise a quality gate that does not exist.

**How to run it.** Automatic on PR and push to `main`; `workflow_dispatch` for a manual run.
Locally, the same checks are `scripts/factory/gate.sh`.

**Rollback.** Delete `.github/workflows/ci.yml`. Nothing else depends on it.

---

## Factory harness — ticket remediation infrastructure (no ticket: tooling)

> Exempt from this file's ticket-ID join-key rule. This is sprint tooling, not a fix for an audit
> finding, so it has no entry in `AUDIT_REPORT.md` and no Linear ticket to join to. Every *code*
> change below this line does carry its ID.


**What changed.** Added the machinery that drives audit findings to merged fixes:

- `scripts/factory/worktree.sh` — provisions an isolated worktree, a dedicated database, and
  per-ticket ports. Necessary because `api/src/test/setup.ts` TRUNCATEs 16 tables in the
  `beforeAll` of every api test file; agents sharing a database corrupt each other's runs.
- `scripts/factory/gate.sh` — the per-ticket eval: typecheck, build, unit tests vs the quarantine
  baseline, tests-not-weakened, regression-test-present, `CHANGES.md` entry, scope, CodeRabbit
  capture. Writes `.factory/gate-result.json`.
- `scripts/factory/lib/testdiff.mjs` — compares failure identities, not counts. Verified against a
  forged run where one test broke and one was fixed: totals unchanged at 13, gate correctly failed.
- `audit/factory/quarantine.json` — the 13 known-failing web tests, so agent regressions are
  distinguishable from pre-existing red.
- `.coderabbit.yaml` — review configuration with path instructions tied to Ship's conventions.
- `.claude/skills/ship-factory/` — orchestration, agent contract, eval tiers, escalation gates.

**How to run it.**

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
cd ../Ship-wt-tro_178 && source .factory-env
scripts/factory/gate.sh          # --fast for the inner loop
```

**Rollback.** Remove `scripts/factory/`, `audit/factory/`, `.coderabbit.yaml`, and
`.claude/skills/ship-factory/`. Clean up worktrees with `git worktree remove`, and drop the
per-ticket databases (`ship_wt_*`) from the `ship-audit-pg` container.

---

## TRO-243 — Secrets loading hard-failed on any host that is not AWS

**What changed.** `loadProductionSecrets()` fetched from AWS SSM with no error handling under
`NODE_ENV=production` and overwrote `DATABASE_URL`. Off AWS it threw and killed the process before
the database was ever contacted. It now falls back to environment secrets when they are present
and rethrows when they are not. AWS behaviour is unchanged.

**How to run it.** Set `DATABASE_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` in the environment and
start with `NODE_ENV=production`.

**Rollback.** Revert the merge of `fix/ssm-fallback` (`5b72a79`) — verified with
`git diff bace770 5b72a79 -- api/src/config/ssm.ts`: the merge wraps the SSM calls in a
`try`/`catch` that falls back to `DATABASE_URL`/`SESSION_SECRET` already present in the
environment, and rethrows only when neither is set. Reverting removes that `catch` entirely and
restores the bare `Promise.all([getSSMSecret(...), ...])` call, so **this re-breaks non-AWS
deployment**: any host without AWS credentials or SSM access (Render, Fly, a plain container)
throws on startup and never contacts the database again, exactly as TRO-242's Dockerfile changes
made possible for the first time.

---

## TRO-242 — Build the image from source and serve the SPA from the API

**What changed.** Multi-stage `Dockerfile` so the image builds from a clean checkout — the
previous one copied `shared/dist/` and `api/dist/`, both gitignored and untracked, so it only
worked in the build-locally-then-ship AWS flow. Express now serves `web/dist` after all `/api`
routes. Same-origin is required by `sameSite: 'strict'` session cookies and by the collaboration
WebSocket URL being derived from `window.location.host`.

**How to run it.** `docker build -t ship . && docker run -p 3000:3000 ship`, or deploy to Render,
which builds from the repository.

**Rollback.** Revert the merge of `feat/render-deploy` (`bace770`) — verified with
`git diff 149873a bace770 -- Dockerfile`: the prior single-stage image did
`COPY shared/dist/ ./shared/dist/` and `COPY api/dist/ ./api/dist/` directly from the build
context, both gitignored and untracked. Reverting restores that image, which means **the old image
needs a local `pnpm build` before `docker build`** — it can no longer build from a clean checkout,
only from a working tree that already has `shared/dist/` and `api/dist/` populated (the
build-locally-then-ship AWS flow this ticket's own "What changed" section describes).


---

## TRO-316 — FG-11: agent service deployed, destroy-and-redeploy proof captured

**What changed.** `terraform apply` (previously only `plan`-verified, no credentials available)
created `render_web_service.agent` ("ship-agent") for real: 1 add, 0 changes to the existing
`ship`/`ship-db` resources. Verified live `/health` and `/ready` both `200`. Then ran the ticket's
required destroy-and-redeploy proof scoped to the agent resource only
(`-target=render_web_service.agent`): destroyed (confirmed 404, `ship` unaffected), re-applied from
config alone with no `import` and no manual step, verified `/health`/`/ready` `200` again on the
newly-created instance (a different service id/URL, confirming genuine recreation, not a cached
response). Full command sequence and captured output in
`terraform/render/plan/tro-316-destroy-redeploy-proof.md`.

**Known caveat, not hidden.** `SHIP_API_TOKEN` is a placeholder — `agent/src/config.ts`'s
`isConfigComplete()` only requires the three secrets non-empty, doesn't validate them, so `/ready`
genuinely passes without a working token. Minting the real per-user token and deciding which Ship
instance the agent points at belongs to TRO-341 (FG-23), per FLEETGRAPH.MD's "no service account"
design.

**How to run it.** `cd terraform/render && terraform init && terraform plan -var-file=terraform.tfvars`
(tfvars is gitignored — see `terraform.tfvars.example`).

**Rollback.** `terraform destroy -target=render_web_service.agent -var-file=terraform.tfvars` — the
proof above already confirms this only ever removes the agent service, never `ship`/`ship-db`.
