# FleetGraph

A project intelligence agent for Ship, the project management tool built by the U.S. Department
of the Treasury.

**Status:** Phase 1 (agent definition) complete. Phase 2 (graph architecture) not started.
Sections marked *Pending* are honestly empty rather than filled with placeholders.

Last updated: August 3, 2026

---

## Agent Responsibility

### What the agent is for

Ship asks people to write down what happened — standups, weekly plans, weekly retros, weekly
reviews, project retros. Its accountability engine computes ten kinds of missing paperwork,
deterministically, and chases people for it.

That engine works. It also cannot tell whether any of the paperwork is true. The content check
strips three known template headings and passes if a single non-whitespace character remains, so a
weekly plan whose entire body is the word "stuff" is fully compliant.

The obvious response is to grade the writing. We tried that framing and rejected it. An agent that
tells a federal employee their standup looks thin — on a document that feeds a performance rating
— is a surveillance tool aimed at the least powerful person in the room. It also solves the wrong
problem. **People write "stuff" because writing it properly is tedious and they are busy.**
Enforcement does not change that. Removing the tedium does.

> **Ship asks people to write down what happened. FleetGraph already knows — so it writes the
> first draft, and it tells you what needs you.**

The agent saves time and surfaces obligations. It does not audit compliance.

### What it monitors proactively

Ship has no event bus. "Events" means observed state changes, found by comparing each document's
last-updated timestamp against a saved cursor and reading the document history table where entries
exist.

| Event | How it is observed | What the agent does with it |
|---|---|---|
| An issue changes state | A history row on the state field | Material for a standup draft |
| An issue changes assignee | A history row on the assignee field | Someone's list changes |
| A comment is posted | A new comment row | Draft material; possibly a mention |
| A document body is edited | The last-updated timestamp moves | Draft material |
| Someone is mentioned | Walking the changed body for mention markers | Goes into that person's list |
| A plan or review approval flips | The approval status field changes | Unblocks someone, or starts a clock |
| A week crosses a boundary | Date arithmetic on the week number | Opens the retro drafting window |

**Nothing in Ship writes a row when a week ends.** There is no change to detect, which is why a
purely change-driven design is insufficient and the agent needs a scheduled pass as well.

### What it reasons about on demand

The document you have open **seeds** the question. It does not fence it.

This corrects an earlier draft that treated the current view as a boundary and had the agent
refuse to look further. The brief says the chat "uses that as the **starting point** for its
reasoning." A starting point and a boundary are different things.

**The boundary is what you are allowed to see. The view only decides where to start.**

From the open document the agent walks outward as far as the question requires — the project, the
week, the program, the issues and their history, the people and their other work, documents that
mention it and documents it mentions, and what changed recently in any of those.

**It names every document it pulled in and why.** That is the trust mechanism: the reach of an
answer is always visible, so following the graph never feels like the agent went wandering.

### What it does without approval, and what always needs a human

The gate is **where the fact came from**, not how large the write is. The important part is what
the agent produces when it is not certain.

**It acts, when a query proves it** — each of these is a structured lookup with no interpretation:

- Resolving mentions to people to user accounts, and assembling those into someone's list
- Linking a document to the issue or week it refers to, when the reference is unambiguous
- Writing its own drafts and items, attributed to the agent
- Clearing its own item when the condition ends

**It drafts, when a model inferred it.** The second output mode is a draft the human edits and
posts. It never posts as the human, and never leaves an opinion the human is expected to act on.

**It never does these at all:**

- Writing a performance rating. These are federal performance ratings on the standard five-level
  scale. Not at any confidence, not for any reason.
- Setting an approval state, week status, or ownership.
- Applying an issue state transition. It may *propose* one with its evidence attached; a person
  accepts it.
- Creating, archiving, or deleting any document.
- Writing anything that would read as though a person wrote it.

> **Every output is either an action a query proved, or a draft a human confirms. The agent never
> has an opinion it expects you to act on.**

That rule is what structurally prevents the agent becoming a complaint generator.

### Who it notifies, and when

Ship has no notification infrastructure at all — no notifications table, no email service, no push
mechanism. So the agent reaches people by writing into Ship itself.

The surface is **one list per person: what needs you.** Not a stream of individual pings.
Everything a person is on the hook for, assembled and ranked, presented when they arrive:

1. Mentions of them they have not seen
2. Approvals they are blocking — someone else's week cannot start
3. Work assigned to them that is waiting on something they control
4. Drafts the agent has prepared for them

Ranked by who else is blocked and for how long. Every item carries a direct action, not just a
description. Escalation to a manager exists but is last, and only after several periods with no
resolution — and because only half the people in the system have a manager recorded, that path
degrades gracefully when the link is absent. The agent never broadcasts to the workspace.

### Precision, and why the bar moved

A wrong draft costs a few seconds of editing, and the person was going to write the document
anyway. A wrong accusation, on a document feeding a performance review, costs trust permanently.

The earlier detection design optimised hard against the second and ended up doing almost nothing.
Changing the output format from criticism to draft removes most of that risk, which lets the
confidence bar come down, which lets the agent do considerably more. **The precision obsession was
downstream of a bad output format, not a fundamental constraint.**

The quality signal is also better than detection ever had: **how much of a draft survives to the
posted version.** A draft posted unedited was a good draft; one rewritten from scratch was not.
That is measurable in production with no labelling effort.

### How it knows who is on a project and what their role is

Ship keeps this in three places, and confusing them is the trap.

The workspace membership table has a role column, but it holds only "admin" or "member", and the
schema comment says in capitals that it is for authorization only. Using it to work out someone's
job is wrong.

Person documents hold the real data: a link to a user account, a link to a manager, and a free-text
job role. That job role is unreliable — free text with no fixed values, and in the current database
not one of the twenty people has it filled in.

Project membership lives in a separate associations table, alongside owner and assignee fields.

Roles are derived from structure, never read from a field:

| Role | How it is derived |
|---|---|
| Director | People reporting to them two or more levels deep; owns programs |
| Project manager | Owns projects or weeks; appears as approver on plans |
| Engineer | Has issues assigned; nobody reports to them |

---

## Graph Diagram

**Pending — Phase 2 not started.** Node design, parallel fetch structure and conditional edges are
the Phase 2 deliverable. Filling this in now would be guesswork.

Four things are already settled and will constrain it:

- Both modes run through the same graph; only the entry trigger differs.
- The proactive path accumulates material continuously but composes drafts **once per person per
  window**, not once per change. The graph therefore branches on "is a window open for this
  person" as well as on what changed.
- The on-demand path expands outward from a seed document along associations, mentions and
  history, with a hard cap on documents pulled in. That expansion loop is the main source of
  genuinely different execution paths between runs.
- One human-in-the-loop gate is required and already identified: every draft terminates at a
  human, and the retro path must never set the approval state itself.

---

## Use Cases

Every one either saves time or removes a lookup. None grade anybody.

| # | Role | Trigger | Agent detects / produces | Human decides |
|---|---|---|---|---|
| 1 | Engineer | The standup window opens on a working day for someone with assigned issues in an active week | A draft standup assembled from what actually happened — issues that changed state, comments written, documents edited, blockers hit. Where nothing moved, it says so and names what has been sitting | Edit and post, or discard. Accept or reject any proposed issue state changes individually |
| 2 | Anyone | The person opens Ship, or opens the panel | One ranked list: mentions they have not seen, approvals they are blocking, work waiting on them, drafts prepared for them — each with why it matters and a direct action | What to act on, and in what order |
| 3 | Engineer or PM | The retro window opens for a week whose plan carries at least one success criterion | The delivered section pre-filled from issues that actually closed, mapped against each criterion, with unmatched criteria called out so they can be explained rather than quietly dropped | Edit, add unplanned work the agent cannot see, submit |
| 4 | Director | A weekly plan is edited after it was approved | What materially changed, before and after side by side, plus a drafted re-approval request or a drafted question to the author | Re-approve, or send the question |
| 5 | Director or PM | An issue blocks work in two or more projects whose blocked people sit in different reporting lines | The full impact, the lowest manager with authority over everyone blocked, and a drafted message to them | Send it, or step in directly |
| 6 | Anyone | The person opens the chat panel anywhere in Ship | An answer seeded by the open document and expanded along whatever the question requires, naming every document pulled in and why | What to do about it |

**Notes**

**Use case 1 absorbs what used to be a separate "your standup is thin" detection.** The drift
signal still gets delivered — it is just delivered as help. Removing that detection as a
standalone use case was a deliberate decision: it was the only case where the agent criticised a
person directly, on a document feeding a performance rating, and it is the notification users mute
first.

**Use case 2 replaces per-mention notifications.** An earlier design pinged on each mention event.
That is dribble. What a person wants on arrival is everything that needs them, in one place,
ranked — an inbox, not a stream.

**Use cases 1 and 2 need no language model for their hardest parts.** Mention resolution and
approval-blocking are structured lookups. The model composes prose and ranks; the floor underneath
it is deterministic.

**Use case 5 depends on work not yet done.** Ship cannot express "issue A blocks issue B" — the
relationship types are only parent, project, sprint and program, and the backlinks table is empty.
Ship has a containment tree and an org chart but no dependency graph. The decision is to add the
missing relationship to Ship rather than design around it; scoped in
`memory-bank/fleetgraph-backlog.md`.

---

## Trigger Model

### The decision: hybrid, with polling as the backbone

| Tier | How often | What it does | Latency |
|---|---|---|---|
| **Fast** | The moment a document is saved | Mentions and assignment changes land in the affected person's list. No model. | ~3 seconds |
| **Steady** | Every 60 seconds | Collect what changed; hold the material each person's next draft will be built from | ~80 seconds |
| **Deep** | Per person, before their window opens | Compose the drafts — standups in the morning, retros at week end | Scheduled |

The steady tier used to be where the model ran, once per suspicious change. Under drafting it
mostly **accumulates material**, and the model runs once per person per window instead. That is
cheaper per unit of value and produces better output — a standup written from a whole day of
activity beats six separate observations.

The five-minute detection requirement binds only on the fast tier, which is deterministic and runs
in about three seconds.

Polling works as the backbone because Ship's collaborative editor saves on a two-second delay and
always stamps the last-updated time when it does, making that timestamp a complete signal for
every content change. The document history table is only partial by comparison — it records field
changes broadly but body text only for weekly plans and retros.

### The tradeoffs

| | Polling only | Webhooks only | Hybrid (chosen) |
|---|---|---|---|
| Changes needed in Ship | One read endpoint | Emission code in 2+ places | One read endpoint plus one in-process hook |
| Coverage | Complete | Only where emission was added | Complete |
| Missed events | Self-correcting — next tick re-reads | Permanent. A dropped delivery is gone | Polling backstops the fast path |
| Week boundaries | Detected — the schedule is the trigger | Never fires. Nothing changes when a week ends | Detected |
| Mention reaching a list | Up to 60 seconds | ~1 second | ~3 seconds |
| Cost when idle | One indexed query returning nothing | Nothing | One indexed query returning nothing |
| Coupling to Ship's uptime | None | Ship's save path waits on your endpoint | None — the hook is fire-and-forget |
| Testability | Replay a time range | Must simulate emission | Both |

**Webhooks alone fail for two verified reasons.** Ship has no outbound webhook mechanism and no
database notification channel, so emission would need adding both to the REST write path and to the
collaborative editor's save path — and missing the second blinds the agent to the document edits
its drafts are built from. And a week ending produces no change at all, so there is nothing to
hook.

**Polling alone is genuinely viable** and was the runner-up, costing up to 60 seconds before a
mention reaches someone's list. The hybrid buys that back for the price of one hook, and if the
hook fails the poll still catches it within a minute. **The fast path is an optimisation on top of
a correct baseline, not something the design depends on.**

### Reliability

**The cursor must lag.** Asking for everything updated since a saved timestamp permanently misses
rows whose transaction commits after the cursor moved past their timestamp. An auto-incrementing
history ID has the same flaw — those numbers are handed out before commit. The fix is to lag the
cursor behind real time and de-duplicate.

**Both of Ship's rate limiters fail open.** On a cache outage the server-side ceiling disappears
entirely, so the agent cannot treat it as a safety net and must throttle itself.

### The blocking dependency

**Ship's API has no way to ask what changed.** No "since this time" parameter exists anywhere. The
main document listing endpoint sorts by position and creation date, so recently-updated documents
never surface at the top. Paging is offset-only, and a source comment states proper cursor paging
is a known gap. The endpoints that do sort by last-updated are fixed-purpose and take no time
filter.

An agent deployed separately cannot go around this — the production database sits in private
subnets reachable only from the application's own servers.

The decision is to **add a change-feed endpoint to Ship** rather than move the agent inside the
network, because keeping permission enforcement inside Ship's own API matters in a system carrying
federal performance ratings. The supporting index already exists — created by a migration that came
directly out of the Week 4 audit, which found seven route modules sorting by last-updated with no
index behind them.

---

## Test Cases

**Trace links pending — nothing is built yet.** Ship state and expected output are defined; traces
follow as each is implemented.

**Graded-database fixture status (TRO-341/FG-23, 2026-08-04) — seeded, with one real gap found, not
hidden.** `pnpm db:seed` ran against the graded `ship-db` (external connection, temporary IP
allowlist, reset immediately after). Pre-seed sanity check: 257 documents / 11 users / 0
`document_history` rows, matching the documented 2026-07-28 snapshot exactly — confirming this
database's existing rows really were produced by this same seed script, the precondition the
seeding plan itself named. Post-seed:

- **Test Cases 2 and 4 fixtures created successfully** — document ids below, real and resolvable
  in the graded database today.
- **Test Case 3's fixture ran but produced 0 closed issues, not the 3 its own row requires.** The
  fixture logic picks issues to close from the *current* sprint as Postgres's `NOW()` resolves it
  today (2026-08-04) — six days after this database's issues were originally created
  (2026-07-28) — and this database's specific existing issue set apparently has none eligible in
  whatever sprint that now is. Recorded, not fixed here: this ticket's scope was seeding and
  environment, not redesigning the fixture's sprint-selection logic.
- **Test Case 1's fixture did not fire at all** — same root cause, sharper effect. Its precondition
  (`SELECT ... WHERE state != 'done' GROUP BY assignee ... HAVING count >= 3` against the current
  sprint) found no engineer meeting the threshold *in the current sprint specifically*, so the
  `if (engineerRow && cnt >= 3)` guard silently skipped the entire block — no error, no console
  output, confirmed by reading `api/src/db/seed.ts` directly rather than guessing from the absent
  log line. Verified (observed) that engineers with 3+ non-done issues DO exist in this database in
  *some* sprint (a direct query found two), just not the one the fixture insists on. **Test Case 1's
  row stays `Pending` below — a real gap for whoever runs the graded demo to know about, not
  something this seeding pass could silently paper over.**

Document ids that DID resolve, against the graded `ship-db` (not this worktree's local scratch
database):

| Fixture | Document id |
|---|---|
| Test Case 2 — mention 1 | `65f499b2-8e8c-417c-8372-f60ff4ba8c75` |
| Test Case 2 — mention 2 | `a8a08536-d4ef-44a9-a9c1-12d1efe39dc4` |
| Test Case 2 — blocked week | `e5adadd7-e574-4f6b-9893-3da2261cf463` |
| Test Case 3 — week (0 issues closed within it — see gap above) | `c8dfb32e-5b08-47d4-8150-af7728543ac4` |
| Test Case 4 — week (approved then edited) | `0e44bc95-6ee9-4aa7-a6c0-41205bf87e85` |

These are document ids the fixture states live at, not LangSmith trace links — the `Trace Link`
column below stays `Pending` until PR-C's graph actually runs against them.

| # | Ship State | Expected Output | Trace Link |
|---|---|---|---|
| 1 | An engineer with 3 assigned issues; since their last standup, one moved to in review, they commented on another, and the third has not moved in 6 days | A draft standup naming the two that moved and what changed, flagging the third as sitting for 6 days, with a proposed state change on the one in review | Pending |
| 2 | A person mentioned in two documents they do not own, blocking one approval on someone else's week, with a standup draft waiting | A four-item ranked list, approval first because another person's week cannot start, each item carrying a direct action | Pending |
| 3 | A week whose plan lists 4 success criteria; 3 issues closed during the week, mapping to 2 of them | A delivered section pre-filled from the 3 closed issues, mapped to their criteria, with the 2 unmatched criteria called out | Pending |
| 4 | A weekly plan approved at version N, then edited to remove one success criterion | A before-and-after on the removed criterion plus a drafted question to the author, routed to the approver | Pending |
| 5 | An issue in Project A blocking two issues in Project B whose assignees report to different managers | The impact fan-out, the lowest common manager, and a drafted message | Pending — requires the `blocks` relationship |
| 6 | A user opens the chat on an issue and asks why it is stalled; the answer requires its week, its blocking issue, and a comment on a different document | An answer drawing on all four documents, each named with the reason it was pulled in | Pending |

**Most of these have no reachable trigger state today.** The development database is a load-testing
fixture built to a Week 4 specification, and it records none of the activity these drafts are built
from: the document history table is empty, comments are empty, issue start and completion
timestamps are unset on all 254 issues including all 71 marked done, and plan approval state is
unset on all 35 weeks. The code that writes all of this exists and runs in normal use, so this is
fixture work rather than a research problem — and the brief explicitly asks for "the Ship state
that should trigger the agent," which makes constructing them part of the assignment.

---

## Architecture Decisions

### Framework

**Pending.** LangGraph is recommended by the brief and is the presumptive choice; anything else
requires manual instrumentation to produce equivalent traces. Not yet committed.

### Node design rationale

**Pending — Phase 2.** Two principles are fixed. Proactively, material accumulation and draft
composition are separate stages running on different clocks — the graph collects continuously and
composes per person per window. On demand, expansion from the seed document is an iterative loop
with a hard cap, and that loop is the main source of different execution paths between runs.

### State management

**Pending — Phase 2.** Three requirements are known. Between proactive runs the graph carries a
lagged cursor. Between the steady and deep tiers it carries per-person accumulated material, keyed
by person and window. Within a run, anything derived from a document is cached on the combination
of document and content version — so ten people asking about the same week do not each re-read it.
That cache key is load-bearing: keying it by viewer instead would change how the whole system
scales.

### Deployment model

**Settled (TRO-341 / FG-23).** Topology: **Ship-on-Render (`https://ship-rr6m.onrender.com`) +
agent-on-Render (`https://ship-agent-t0zy.onrender.com`, current URL — see the redeploy note below,
it changes on every clean-machine `apply`) + the Render Postgres `ship-db`
(`dpg-d9kgth6417fc7386hhh0-a`) as the graded database.** This is the ticket's own recommended
default, adopted without deviation: no AWS credentials have existed in this environment all sprint
(re-verified this ticket: no `aws` CLI, no `AWS_*` env vars), so the AWS stack was never a live
option to weigh against it.

**Authentication does not expire.** Ship's session timeouts — fifteen minutes idle, twelve hours
absolute — apply only to browser sessions. API tokens are handled first and bypass that logic;
they are bounded only by their own expiry, which can be unset, and by explicit revocation. A
headless agent needs no re-authentication schedule.

**There is no service account.** Every API token belongs to a real user, so the agent runs under
each person's own token. This matters more under the current design than it did before — following
the graph outward from the open document means reaching documents the person did not open, and
running as them is what makes that safe by construction. **It can reach anything you could reach,
and nothing you could not.**

**Private documents are currently hypothetical.** All 523 documents are workspace-visible and none
are private. The risk is real in the schema and absent from the data. That count is the local
development database's; the graded `ship-db` is a **separate, smaller** dataset — 257 documents as
of its last verified snapshot (`memory-bank/techContext.md`, 2026-07-28) — and does not
automatically track a local worktree's seed. Closing that gap for the Test Case fixtures
specifically is this ticket's seeding-plan section below.

**Network path.** Production traffic must go through the content delivery network; the load
balancer accepts nothing else.

**Terraform, `/health` + `/ready`: done, including `apply` (TRO-313, TRO-315, TRO-316).** `agent/`
is a Render docker web service (`terraform/render/agent_service.tf`), deployed in the same Render
root as `ship` itself — target platform is Render, not AWS, per the standing no-AWS-credentials
fact above. `terraform apply` and a full destroy-and-redeploy proof both ran on 2026-08-04 with
explicit human sign-off, scoped only to the new agent service
(`terraform/render/plan/tro-316-destroy-redeploy-proof.md`): create → verified `/health`/`/ready`
200 → targeted `destroy` of the agent alone (verified `ship`/`ship-db` untouched) → re-`apply` from
config alone, no import → verified `/health`/`/ready` 200 again on the newly generated URL. **One
piece that proof deliberately left open, now closed:** `SHIP_API_TOKEN` was applied as a placeholder
string; a real per-user token has since been minted (see "Login and the 403" below) and wired into
the live agent — see the "Done, 2026-08-04" paragraph under "Login and the 403" for exactly how
(not via a second `terraform apply`, which hit a provider bug — worked around via the Render REST
API directly).

**Confirmed (not assumed): which branch Render deploys, and whether merged code actually reaches
it.** `git_branch` defaults to `"main"` in `variables.tf` for both services, and the live
`terraform.tfstate` (main checkout, refreshed 2026-08-04) matches: both `render_web_service.ship`
and `render_web_service.agent` show `runtime_source.docker.branch = "main"`,
`auto_deploy = true`. Cross-checked directly against the Render API
(`GET /v1/services/srv-d9kf2t942hec73aofrt0`): `autoDeploy: yes`, `branch: main` — config is
correct. **But the live `ship` service has not actually redeployed since 2026-07-30**, observed
three independent ways: (1) `GET /v1/services/.../deploys` and `.../events` list the last
`deploy_ended`/`succeeded` at `2026-07-30T22:00:22Z`, commit `09a6895a` ("...ALB SG locked to
CloudFront..."), triggered by an API call (this repo's own TF-10 verification session) — zero
deploy events of any kind since, despite `main` receiving PR-A (`2f198f6`, 2026-08-03 20:07 EDT)
and PR-B (`0db1fd0`, 2026-08-03 21:54 EDT) in the interim; (2) `GET /` on the live service returns
`last-modified: Thu, 30 Jul 2026 21:59:21 GMT` on its static asset, consistent with the same stale
build; (3) `GET /api/change-feed` (a PR-A route, `api/src/app.ts:401`) returns a bare `404 Cannot
GET`, not an auth error — the route itself is absent from what's running. **So PR-A's change feed
and `blocks` endpoints, and PR-D's UI surfaces, are not yet live on the graded Ship**, despite both
being on `main` and despite `auto_deploy` being correctly configured — auto-deploy is not firing.
Root cause not fully diagnosed: `gh api repos/troysatchell/ship/hooks` returns `[]` (no classic
webhooks), which is suggestive but not conclusive, since Render's GitHub integration commonly runs
through a GitHub App installation rather than a classic repo webhook, and this session's `gh` token
cannot list App installations to check that directly.

**Done, 2026-08-04, with explicit human sign-off.** The remediation call below was run by the
orchestrator against `srv-d9kf2t942hec73aofrt0`. Result: deploy `dep-d9ouj9jl550s73feh900` reached
`live`, commit `ef9d9c7` (current `main` at the time). Verified after, not just trusted: `GET
/api/change-feed` unauthenticated now returns `401` (auth required — the route exists) instead of
the prior bare `404`, and `GET /`'s `last-modified` header moved from `2026-07-30` to
`2026-08-04T13:31:47Z`. **PR-A's routes are now live on the graded Ship.** Root cause of why
`auto_deploy` itself never fired is still not diagnosed — this was a manual workaround, not a fix to
the underlying trigger, so the same gap will recur on the next push unless someone with Render
dashboard access checks the GitHub App installation.

**Standing operational procedure until that root cause is fixed:** after merging anything to `main`
that the graded demo depends on (PR-D, PR-E, PR-F, PR-G), do not assume `auto_deploy` fired.
Manually verify — `GET https://ship-rr6m.onrender.com/` and check its `last-modified` header against
the merge time, or probe a route the merge actually added (the same pattern used above,
`/api/change-feed`). If it's stale, trigger the same remediation call this ticket used:
```bash
curl -X POST https://api.render.com/v1/services/srv-d9kf2t942hec73aofrt0/deploys \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{}'
```
The identical procedure applies to the agent service (`srv-d9otunmgekts73eqs0h0` as of this ticket
— re-check the current id via `terraform output agent_service_url`/state, since it changes on every
clean-machine `apply`) whenever `agent/` code changes land on `main`.
```bash
curl -X POST https://api.render.com/v1/services/srv-d9kf2t942hec73aofrt0/deploys \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{}'
```
This triggers a deploy of the service's configured branch (`main`) HEAD — equivalent to what
`auto_deploy` should already be doing on every push. Confirm after with `GET .../deploys?limit=1`
(expect `status: "live"`, a `createdAt` after this call, `commit.id` matching current `main`) and
`GET /api/change-feed` (expect no longer a bare 404 once the new code is live and reachable with
auth).

**Rollback trigger and procedure.** Two layers, neither of which is a bespoke script:
1. **CI gates merge, not just deploy.** `.github/workflows/ci.yml`'s own header states it is "the
   merge gate the ticket factory depends on — a factory PR is not eligible for merge until this is
   green." Render's `git_branch = "main"` (both `web_service.tf` and `agent_service.tf`) means
   Render only ever builds from a branch that already passed CI to get there — a failing CI run
   never reaches `main` in the first place, so it never reaches Render's `auto_deploy` trigger
   either. This is the primary rollback: prevention before promotion, not correction after.
2. **Render's own health-check-gated promotion is a liveness safety net, not a readiness one.**
   `/health` (`health_check_path`, from FG-2) returns 200 whenever the process is up — it makes no
   config check and no Ship-dependency check (`agent/src/server.ts`). Per Render's documented
   zero-downtime deploy behavior, a new deploy is only promoted to receive live traffic once
   `/health` returns healthy within the deploy's startup window; if it never does — the process
   crashes on boot, or hangs — Render keeps the **previous** successful deploy serving traffic and
   marks the new one failed. That much is genuinely automatic and requires no Terraform beyond
   setting `health_check_path` correctly, which `agent_service.tf` does.
   **What this does NOT catch:** a deploy that boots cleanly but is missing
   `ANTHROPIC_API_KEY`/`SHIP_API_TOKEN`, or cannot reach Ship, still passes `/health` and is still
   promoted to live traffic — none of this is a readiness gate. `/ready` (config complete AND Ship
   reachable, FG-4's resilient client) reports that case as `503`, but `/ready` is deliberately NOT
   what Render's platform check points at, and no separate readiness check is currently configured
   or validated for that purpose — a deploy with a missing secret or an unreachable Ship still
   receives traffic today. `/ready` can also legitimately be false on a healthy, freshly-promoted
   instance if Ship itself is briefly down, and that specific case must not be read as "the deploy
   failed."

**Login and the 403 (TRO-341 / FG-23) — root-caused, not a WAF.** Two prior curl attempts against
`POST https://ship-rr6m.onrender.com/api/auth/login` returned a platform-looking `403 Forbidden` —
generic HTML body, `ratelimit-*` headers, `server: cloudflare`. Reproduced directly and traced to
source, not guessed: the `ratelimit-*` headers are `loginLimiter`'s own (`api/src/app.ts:88-101`,
`5;w=900` matches exactly), and `app.use('/api/auth', conditionalCsrf, authRoutes)`
(`api/src/app.ts:371`) applies CSRF protection to **every** `/api/auth/*` route, login included, for
any request that isn't already carrying a `Bearer` token (`conditionalCsrf`, `app.ts:64-71`). A bare
POST with no prior `GET /api/csrf-token` (which sets the session cookie the sync check needs) fails
that check; `csrf-sync` throws with no route-local handler to catch it, so the error falls through
to Express's default `finalhandler`, which is exactly where the generic `<pre>Forbidden</pre>` HTML
comes from — not a Cloudflare/Render edge rule. `cloudflare`/`cf-ray` headers appear on **every**
response from this host, 200 or 403 alike (verified) — present, but not the actor. Proven by fixing
it: `GET /api/csrf-token` with a cookie jar → `POST /api/auth/login` with that cookie plus
`x-csrf-token: <token>` → `200`, real session, `dev@ship.local` (`isSuperAdmin: true`). A real
per-user API token was then minted through that session (`POST /api/api-tokens`,
`api/src/routes/api-tokens.ts`), name `fleetgraph-agent-tro-341`, no expiry, and verified working via
`Authorization: Bearer` against both a plain route (`/api/auth/me`) and a `conditionalCsrf`-guarded
one (`/api/documents` — Bearer correctly bypasses CSRF, `app.ts:66-68`). The raw value is not in this
file or in git: it was folded into the main checkout's gitignored `terraform/render/terraform.tfvars`
and wired into the live agent — see the "Done, 2026-08-04" paragraph immediately below.

**On the choice of identity, deliberately not changed here.** `dev@ship.local` is this repo's
established seed-fixture super-admin, already the login this entire sprint's manual verification
work has used and the identity "20+ e2e specs" (per this codebase's own prior convention) build on
— using it to mint the agent's token is consistent with that, not a new pattern. This is **not** the
"no service account" design being violated: FLEETGRAPH.MD's own stance is that every token belongs
to a real person, and `dev@ship.local` is a real (seeded) person's account, not a synthetic service
identity. A narrower, least-privilege, non-admin person's token would still be a legitimate future
tightening — deliberately not done under today's deadline pressure, and the token has no expiry,
which is worth a follow-up ticket for graded/demo-lifetime credential hygiene (rotation, an
expiration, and secret-manager storage instead of a gitignored `.tfvars` file) rather than blocking
this one.

**Done, 2026-08-04, with explicit human sign-off — but not via `terraform apply` as planned.** The
real token was folded into the main checkout's `terraform.tfvars` and `terraform plan` confirmed
exactly one change (`SHIP_API_TOKEN` on `render_web_service.agent`, 0 changes elsewhere). `terraform
apply` itself failed both before and after adding `maintenance_mode` to `agent_service.tf`'s
`lifecycle.ignore_changes` (matching `web_service.tf`'s existing `pull_request_previews_enabled`
precedent for the identical reason): `Could not update service, unexpected error: could not update
service: maintenance mode can only be configured for non-free tier services`. This is a
render-oss/render provider bug — `ignore_changes` only changes what Terraform's *plan diff* shows,
not what the provider's `Update` call sends in its API request body, and this provider appears to
unconditionally include `maintenance_mode` on every update to this resource type regardless of
whether it changed. **Worked around by calling Render's REST API directly for this one field**
(`PUT /v1/services/{id}/env-vars/SHIP_API_TOKEN`, confirmed `200` with the new value's real length),
then a manual redeploy (`POST .../deploys`, since an env-var PUT alone doesn't restart the running
process — confirmed by checking `GET .../deploys?limit=1` still showed the prior deploy after the
PUT). New deploy `dep-d9ouuar7uimc73a8vrkg` reached `live`; `GET /health` → `200`, `GET /ready` →
`200`, both against the live agent with a real, working per-user token. **Terraform's own state
now agrees with reality** (the `.tfvars` value matches what's live), but this is a standing landmine,
not a one-off: **`terraform apply` cannot currently update `render_web_service.agent` at all, for
any field, on the free tier.** `ignore_changes` only suppresses what shows in the plan *diff* — it
does not stop the provider's `Update` call from unconditionally including `maintenance_mode` in its
request body, so the failure reproduces identically for any change (a new env var, a plan tier
change, anything). The `pull_request_previews_enabled`/`maintenance_mode` `ignore_changes` entries
added here are harmless and worth keeping (they do suppress real diff noise from *other* drift), but
they are not the fix. Until the provider is patched or the service moves off the free tier, **any
future change to this resource's config must go through the Render REST API directly** — a
`PUT`/`PATCH` to `/v1/services/{id}` or its `/env-vars` sub-resource, following the pattern used
above — not `terraform apply`. Filed as a follow-up rather than solved here: adding automated
integration coverage for this specific provider failure mode isn't practical (it requires a live
Render API call against a free-tier resource, not something a unit/vitest suite can exercise), but
someone should re-check `terraform apply` against this resource each time the provider version pins
forward, since that's the actual fix path.

**Seeding the graded database with FG-3's fixture states (TRO-341 / FG-23) — plan, not executed.**
`api/src/db/seed.ts`'s FG-3 block (`TRO-314`, merged to `main` 2026-08-03) is additive and
self-gating: it checks `COUNT(*) FROM document_history` for the workspace first and no-ops if
non-zero (`seed.ts:1262-1271`), same as every other block in the file ("already exists" checks
before every insert) — this is what makes re-running the full `pnpm db:seed` against an
already-seeded database safe rather than a duplicate-everything risk, *provided* the target
database's existing rows were themselves produced by this same seed script, which `ship-db` is
(`memory-bank/techContext.md`: seeded 2026-07-28, 257 documents, 11 users, 1 workspace — the same
shapes `seed.ts` checks for). Two things stand between "safe in principle" and "runnable today":

1. **`ship-db` has no public network path.** `ipAllowList` is unset (verified in
   `terraform/render/plan/tro-316-agent-plan-annotated.md`'s import notes and re-confirmed by the
   provider default) — "no IP addresses provided ⇒ private-network connections only." Reaching it
   from outside Render requires the documented temporary-allowlist pattern
   (`memory-bank/techContext.md:139-146`):
   ```bash
   curl -X PATCH https://api.render.com/v1/postgres/dpg-d9kgth6417fc7386hhh0-a \
     -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
     -d '{"ipAllowList":[{"cidrBlock":"<your-ip>/32","description":"temporary-fg23-seed"}]}'
   # ...seed run below...  then immediately reset:
   curl -X PATCH https://api.render.com/v1/postgres/dpg-d9kgth6417fc7386hhh0-a \
     -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
     -d '{"ipAllowList":[]}'
   ```
2. **Migrating/seeding against Render needs `NODE_ENV=production`** — that's the branch that turns
   on SSL in `migrate.ts`/`seed.ts`, and requires `SESSION_SECRET` set or `app.ts` throws on boot
   (`memory-bank/techContext.md:148`). The SSM fallback (`TRO-243`) is what lets that path work off
   AWS.

Full sequence, run 2026-08-04 (writes to the live graded database, so it required explicit human
sign-off — see the "Done" paragraph below):
```bash
# 1. Get the external connection string (dashboard, or GET /v1/postgres/{id}/connection-info)
#    after the temporary ipAllowList PATCH above has taken effect.
export DATABASE_URL="<ship-db external connection string>"
export NODE_ENV=production
export SESSION_SECRET="<same value already in terraform.tfvars — required for app.ts's boot check
                         even though seed.ts itself is the only thing actually running>"
pnpm db:migrate   # idempotent, schema_migrations-tracked — confirms PR-A's schema is present;
                   # likely a no-op today since the live `ship` service's own boot command already
                   # runs `node dist/db/migrate.js` on every deploy (Dockerfile:75), but the pending
                   # deploy above hasn't happened yet, so this is the one path that's certain either way.
pnpm db:seed       # additive; prints "📋 FG-3 test case document ids (FLEETGRAPH.MD Test Cases 1-4)"
                   # with the real ids for THIS database on success.
```
**Done, 2026-08-04, with explicit human sign-off.** Pre-seed sanity check (257 documents / 11 users
/ 0 `document_history` rows) confirmed this database's rows really were produced by this same seed
script before running anything against it. `pnpm db:migrate` reported "All migrations already
applied" (the `ship` redeploy above had already run it on boot). `pnpm db:seed` ran additively — see
the Test Cases section above for exactly which fixtures resolved, which didn't, and why. The
temporary `ipAllowList` PATCH was applied, the seed ran over the external connection string, and the
allowlist was reset to `[]` immediately after — confirmed via a second `GET` on the postgres
resource showing `ipAllowList: null` again.

---

## Cost Analysis

### Development and Testing Costs

**Instrumented as of TRO-339 (FG-21), 2026-08-05.** Every real `model.invoke()` call in
`agent/src/graph.ts` (the `respond`, `composeAnswer`, and `composeStandupDraft` nodes — the only
three that ever call the model) now records its real input/output tokens, model, and which node
served it, to `agent/.cache/cost-ledger.jsonl`. The table below is that recorded data, reproduced
verbatim by running `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` from the worktree — not an estimate.

| Item | Amount |
|---|---|
| Claude API — input tokens | 33 |
| Claude API — output tokens | 37 |
| Total invocations during development | 1 |
| Total development spend | $0.000218 |

**Reconciliation.** The one recorded invocation was cross-checked directly against LangSmith's own
usage reporting for the same trace (`fleetgraph-agent` project, queried via the LangSmith API,
2026-08-05): LangSmith independently reports `prompt_tokens: 33`, `completion_tokens: 37`,
`total_cost: 0.000218` for that exact call — an exact match, not a coincidence of rounding.

**Why the total is this small.** Querying LangSmith's full history for this project (not just this
ticket's own invocation) turned up only two prior real model calls, ever, in this sprint: one
`trace-invoke.ts` smoke-test call from TRO-313/FG-2 (33 in / 38 out, $0.000223) and one failed call
against a stale model id (0 tokens, $0). Both predate this ticket and were never captured anywhere.
FG-5's proactive chain, FG-6's standup-draft composition, and FG-7's on-demand expansion have never
once been invoked against the real Anthropic API this sprint — every test for all three uses a
stable fake model, by design (`graph.test.ts`'s own docstring). So "no agent invocations yet" (this
section's prior text) was accurate, not merely honest-but-stale: real spend really has been
near-zero, and this ticket's instrumentation was landed before that changes, per its own premise —
"instrumentation added after the fact cannot recover spend that was never recorded."

**Per-tier measured cost**, to replace the projected $0.021 standup / $0.015 inbox / $0.052 retro /
$0.065 on-demand figures below with observed ones once real traffic exists: only the bare on-demand
chat path (`respond`, no seed document) has a real measurement yet — $0.000218/run. `composeAnswer`
(the on-demand-with-expansion tier the $0.065 projection actually describes) and
`composeStandupDraft` (the standup-draft tier) are fully wired to record the moment either one is
invoked for real — `composeAnswer` additionally records documents-pulled-per-run (cost cliff #2) —
but neither has ever run against the real API, so neither has a measured number to report yet. This
is a real gap, not a placeholder: producing one requires a live Ship API and seeded database
(`composeAnswer`) or a scheduled trigger nobody has built yet (`composeStandupDraft`, `graph.ts`'s
own module docstring — "there is no scheduler in this file... that decides whose window is open").

### Production Cost Projections

| 100 Users | 1,000 Users | 10,000 Users |
|---|---|---|
| **~$450/month** | **~$4,470/month** | **~$44,700/month** |

**Assumptions**

Unit ratios come from the live database — 15 projects, 523 documents, 254 issues, 20 people —
giving roughly 35 documents, 17 issues and 1.33 people per project. So 100 users is about 75
projects.

- **Proactive runs per project per day:** 1,440 polls (one per minute, mostly returning nothing),
  plus one draft composition per person per window — about 1.3 standup drafts and 1.3 inbox
  assemblies per project per working day, and roughly 1.3 retro drafts per project per week.
- **On-demand invocations per user per day:** 2
- **Average tokens per invocation:** 4,000 in / 600 out for a standup draft; 3,000 / 400 for an
  inbox assembly; 6,000 / 900 for a retro draft; 9,000 / 800 for an on-demand answer, which is
  larger than the old design because the agent now follows the graph outward.
- **Cost per run:** $0.021 standup draft, $0.015 inbox, $0.052 retro draft, $0.065 on-demand
  answer.
- **Estimated runs per day, per 1,000 users:** ~1,000 standup drafts, ~1,000 inbox assemblies,
  ~200 retro drafts, 2,000 on-demand answers.

Model tiering: high-volume drafting runs on the cheaper model; the reasoning tiers run on the more
capable one.

| Tier | Scales with | $/user/month |
|---|---|---|
| Standup drafts | People | $0.46 |
| Inbox assembly | People | $0.32 |
| Retro drafts | People | $0.23 |
| Nightly cross-project pass | Projects | $0.60 |
| On-demand answers | People | $2.86 |
| **Total** | | **$4.47** |

### Three things that matter more than the totals

**This is about a third more expensive than the detection design it replaces.** That is the correct
trade — the earlier design was cheaper mainly because it declined to do anything.

**On-demand dominates at 64% of spend, and it grew.** Following the graph outward costs more input
tokens than answering from a single document. That is the price of treating the current view as a
starting point rather than a fence, and it is worth paying.

**The rate limit runs out long before the budget does.** Ship's per-source-IP limiter allows 6,000
requests a minute across every user the agent serves. At roughly 2,000 users the agent begins
throttling itself, while the bill is still under $9,000 a month. **The 10,000-user column is a cost
projection, not a capacity claim** — reaching it requires multiple egress addresses or a raised
limit, which is an infrastructure conversation rather than a budget one.

### Cost cliffs, worst first

1. **Which model answers on-demand questions.** Moving that tier to the cheaper model takes the
   per-user cost from $4.47 to $3.32 — a 26% cut from one configuration change.
2. **How far on-demand expands the graph.** Following every edge from every document is unbounded.
   Relevance ranking with a hard cap on documents pulled in is what keeps this line finite, and it
   is the single most important implementation constraint in the design.
3. **Drafting for people who never read the drafts.** If someone ignores their drafts for two
   weeks, stop generating them and let them ask. Trivial to implement, and it removes the largest
   single source of waste.
4. **How the derived-content cache is keyed.** Keyed by document and content version, ten people
   asking about the same week read it once. Keyed by viewer, that work multiplies by readers.

---

## A note on the data behind these numbers

Everything measured comes from Ship's development database: 523 documents, 254 issues, 20 users,
20 people, 35 weeks spanning weeks 11 to 17.

It was built to a Week 4 specification — "seed the database with realistic data: 500+ documents,
100+ issues, 20+ users, 10+ sprints." It is a load-testing fixture, made to give benchmarking tools
enough rows to produce meaningful latency numbers, not to model how people behave. Weekly plans and
retros are drawn from eleven fixed content pools; confidence values are computed from how far in
the past a week is plus random noise.

**So counts from it measure the fixture, not Ship's users.** The unit ratios in the cost model are
safe, because documents and issues per project are exactly what the fixture was built to be
realistic about. Behavioural claims are not, and none are made here.
