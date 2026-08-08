# Requirements Audit — Ship (GAUNTLET)

**Commit:** 279fb8e6ffd7 (dirty tree) · **Date:** 2026-08-08T18:09:20Z · **Docs:** W4 `GFA_Week_4_ShipShape_Updated.pdf` (p.1–11) · **Mode:** baseline

## Summary

- **VERIFIED:** 2
- **IMPLEMENTED-UNVERIFIED:** 41
- **PARTIAL:** 10
- **ASSUMED:** 1

Every one of the 54 active W4 requirements is represented below. The one dimension missing from this sweep is ticket coverage: the Linear connector is unauthorized, so no requirement could be matched to a TRO ticket and no orphan tickets could be detected. That is recorded as a blocked dimension, not as absent tickets.

> **Ticket mapping BLOCKED.** Linear MCP server is unauthorized: only mcp__linear__authenticate / complete_authentication are exposed, and authenticate returned an OAuth URL requiring browser action. No ticket query tools available. **To unblock:** Authorize the Linear connector in claude.ai connector settings or via /mcp, then re-run the sweep. Requirement -> code tracing is unaffected.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| W4-R1 | Orientation checklist answers exist as a saved notes document in the repo. | BLOCKED | `audit/ORIENTATION.md:1`<br>`audit/ORIENTATION.md:9`<br>+10 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R2 | The orientation notes from W4-R1 are committed and referenced by the submis... | BLOCKED | `README.md:26`<br>`README.md:29` | `IMPLEMENTED-UNVERIFIED` |
| W4-R3 | audit/AUDIT_REPORT.md exists with a baseline section per category. | BLOCKED | `audit/AUDIT_REPORT.md:137`<br>`audit/AUDIT_REPORT.md:341`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R4 | Each category baseline in AUDIT_REPORT.md has a Methodology subsection with... | BLOCKED | `audit/AUDIT_REPORT.md:145`<br>`audit/AUDIT_REPORT.md:360`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R5 | Each category's deliverable table in AUDIT_REPORT.md is filled with measure... | BLOCKED | `audit/AUDIT_REPORT.md:202`<br>`audit/AUDIT_REPORT.md:440`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R6 | Each category baseline lists concrete findings. | BLOCKED | `audit/AUDIT_REPORT.md:249`<br>`audit/AUDIT_REPORT.md:477`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R7 | Findings in AUDIT_REPORT.md carry severity ranks. | BLOCKED | `audit/AUDIT_REPORT.md:34`<br>`audit/AUDIT_REPORT.md:251`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R8 | No application-code changes in the commit range of the audit phase. | BLOCKED | `audit/AUDIT_REPORT.md:2`<br>`audit/AUDIT_REPORT.md:26` | `IMPLEMENTED-UNVERIFIED` |
| W4-R9 | The type-safety baseline table in AUDIT_REPORT.md is complete (all 7 metrics). | BLOCKED | `audit/AUDIT_REPORT.md:206`<br>`audit/AUDIT_REPORT.md:207`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R10 | Post-improvement violation count ≤ 75% of baseline with meaningful types; s... | BLOCKED | `audit/type-safety/baseline.json:32`<br>`docs/IMPROVEMENTS.md:24`<br>+5 more | `PARTIAL` |
| W4-R11 | The bundle baseline table in AUDIT_REPORT.md is complete. | BLOCKED | `audit/AUDIT_REPORT.md:444`<br>`audit/AUDIT_REPORT.md:446`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R12 | Vite build output (web/) shrinks per one of the two thresholds with analyze... | BLOCKED | `docs/IMPROVEMENTS.md:119`<br>`docs/IMPROVEMENTS.md:122`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R13 | api/src/db/seed.ts (or an augmenting script) produces at least those row co... | BLOCKED | `audit/seed-augment.ts:5`<br>`api/src/db/seed.ts:90`<br>+8 more | `VERIFIED` |
| W4-R14 | AUDIT_REPORT.md names 5 endpoints with the tracing method recorded. | BLOCKED | `audit/AUDIT_REPORT.md:609`<br>`audit/AUDIT_REPORT.md:611`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R15 | The API baseline table has P50/P95/P99 per endpoint at the three concurrenc... | BLOCKED | `audit/AUDIT_REPORT.md:645`<br>`audit/AUDIT_REPORT.md:615`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R16 | Two endpoints' P95 drop ≥20% under identical-conditions re-benchmark, with... | BLOCKED | `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md:101`<br>`audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md:47`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R17 | The DB baseline table covers the 5 named flows with counts, slowest-query t... | BLOCKED | `audit/AUDIT_REPORT.md:825`<br>`audit/AUDIT_REPORT.md:826`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R18 | One flow's query count or the slowest query improves per threshold with EXP... | BLOCKED | `audit/db-query/compare-phase2-jul30/after-phase2-jul30.md:54`<br>`audit/db-query/compare-phase2-jul30/after-phase2-jul30.md:56`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R19 | The test baseline table (totals, pass/fail/flaky, runtime, uncovered critic... | BLOCKED | `audit/AUDIT_REPORT.md:1074`<br>`audit/AUDIT_REPORT.md:1075`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R20 | Coverage tooling runs for api and web packages and per-package numbers are... | BLOCKED | `api/vitest.config.ts:24`<br>`web/vitest.config.ts:39`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R21 | Three new regression-catching tests (or 3 flaky-test RCAs) exist, each with... | BLOCKED | `docs/IMPROVEMENTS.md:362`<br>`docs/IMPROVEMENTS.md:378`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R22 | The error-handling baseline table is complete with repro steps for silent f... | BLOCKED | `audit/AUDIT_REPORT.md:1511`<br>`audit/AUDIT_REPORT.md:1512`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R23 | Three error-handling fixes landed, one covering a data-loss/confusion path,... | BLOCKED | `docs/IMPROVEMENTS.md:439`<br>`docs/IMPROVEMENTS.md:442`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R24 | The a11y baseline table is complete across the app's major pages. | BLOCKED | `audit/AUDIT_REPORT.md:1573`<br>`audit/AUDIT_REPORT.md:1574`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R25 | One of the two a11y thresholds is met with before/after scanner output. | BLOCKED | `audit/a11y/compare-phase2-jul30/after-phase2-jul30.md:70`<br>`audit/a11y/compare-phase2-jul30/after-phase2-jul30.md:72`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R26 | terraform/ inits and plans locally; the full plan output is saved as an art... | BLOCKED | `terraform/render/plan/plan-annotated.md:32`<br>`terraform/render/plan/tro-316-agent-plan-annotated.md:96`<br>+4 more | `ASSUMED` |
| W4-R27 | Every resource in the saved plan carries a one-sentence annotation + risk/b... | BLOCKED | `terraform/render/plan/plan-annotated.md:116`<br>`terraform/render/plan/tro-316-agent-plan-annotated.md:264`<br>+2 more | `PARTIAL` |
| W4-R28 | A documented drift demo exists (local provider file edit or Render dashboar... | BLOCKED | `audit/terraform/baseline.md:63`<br>`audit/terraform/raw/drift-1-apply.txt:1`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R29 | A local-provider .tf config managing ≥2 local resources exists and plans cl... | BLOCKED | `audit/terraform/drift-demo/main.tf:6`<br>`audit/terraform/drift-demo/main.tf:17`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R30 | A Render-provider .tf config declaring the fork's web service exists and pl... | BLOCKED | `terraform/render/versions.tf:5`<br>`terraform/render/web_service.tf:9`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R31 | required_providers blocks pin exact versions in both configs. | BLOCKED | `audit/terraform/drift-demo/main.tf:11`<br>`terraform/render/versions.tf:9`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R32 | terraform apply alone deploys the fork; no manual deploy scripts required f... | BLOCKED | `terraform/render/plan/tro-316-destroy-redeploy-proof.md:88`<br>`terraform/render/plan/IMPORT-LOG.md:21`<br>+4 more | `PARTIAL` |
| W4-R33 | Every category's improvement target (W4-R10/12/16/18/21/23/25 and Terraform... | BLOCKED | `audit/requirements/inventory.md:6`<br>`docs/IMPROVEMENTS.md:618` | `PARTIAL` |
| W4-R34 | Each improvement has paired before/after measurements under identical condi... | BLOCKED | `docs/IMPROVEMENTS.md:1`<br>`audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md:11`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R35 | The suite is green at every improvement merge point. | BLOCKED | `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md:25`<br>`audit/db-query/compare-phase2-jul30/after-phase2-jul30.md:22`<br>+1 more | `PARTIAL` |
| W4-R36 | Each audit finding ID maps to a regression test; external-service mocks are... | BLOCKED | `CHANGES.md:9724`<br>`CHANGES.md:11142`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R37 | .github/workflows/ contains workflows running all seven checks on PR + push... | BLOCKED | `.github/workflows/ci.yml:6`<br>`.github/workflows/ci.yml:92`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R38 | package.json files use exact versions; pnpm-lock.yaml committed. | BLOCKED | `pnpm-lock.yaml:1`<br>`package.json:41`<br>+7 more | `PARTIAL` |
| W4-R39 | A CI step emits a package/version/license inventory artifact. | BLOCKED | `.github/workflows/ci.yml:306`<br>`.github/workflows/ci.yml:334`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R40 | Skipped/altered CI checks are documented with reasons. | BLOCKED | `CHANGES.md:7576`<br>`CHANGES.md:7640`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R41 | CI builds once, tags with SHA, deploys promote that artifact; lifecycle doc... | BLOCKED | `docs/deployment-artifact-lifecycle.md:1`<br>`.github/workflows/ci.yml:441`<br>+7 more | `PARTIAL` |
| W4-R42 | A single script boots app + database from clean checkout; README documents it. | BLOCKED | `start.sh:68`<br>`scripts/dev.sh:78`<br>+5 more | `PARTIAL` |
| W4-R43 | Outbound calls (pg pool, WebSocket, external) have assessed retry/timeout/b... | BLOCKED | `CHANGES.md:10769`<br>`CHANGES.md:10810`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R44 | CHANGES.md at repo root covers every improvement with run/test/rollback notes. | BLOCKED | `CHANGES.md:1`<br>`CHANGES.md:10828`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R45 | Per-improvement reasoning write-ups exist (CHANGES.md or improvement docs). | BLOCKED | `docs/IMPROVEMENTS.md:22`<br>`docs/IMPROVEMENTS.md:67`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R46 | Improvement commits contain substantive changes tied to category targets. | BLOCKED | `CHANGES.md:4941`<br>`CHANGES.md:10769` | `IMPLEMENTED-UNVERIFIED` |
| W4-R47 | Git history shows per-improvement branches/commits with descriptive messages. | BLOCKED | `.git/refs (branch listing):1`<br>`CHANGES.md:10769`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R48 | A discovery write-up with 3 entries, each carrying the 4 elements incl. fil... | BLOCKED | `docs/submission/DISCOVERY.md:6`<br>`docs/submission/DISCOVERY.md:30`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R49 | The fork hosts improvement branches with clear names; README has a setup gu... | BLOCKED | `README.md:22`<br>`README.md:149` | `IMPLEMENTED-UNVERIFIED` |
| W4-R50 | Per-category improvement docs contain those 5 elements. | BLOCKED | `docs/IMPROVEMENTS.md:22`<br>`docs/IMPROVEMENTS.md:117`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R51 | Not code-traceable; an external video deliverable. | BLOCKED | `docs/submission/DEMO-SCRIPT.md:1`<br>`docs/submission/FLEETGRAPH-DEMO-SCRIPT.md:1` | `PARTIAL` |
| W4-R52 | Not code-traceable; a written analysis deliverable. | BLOCKED | `docs/submission/AI-COST-ANALYSIS.md:34`<br>`docs/submission/AI-COST-ANALYSIS.md:68`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W4-R53 | The fork is deployed at a public URL. | BLOCKED | `docs/submission/FLEETGRAPH-DEMO-SCRIPT.md:6`<br>`docs/submission/DEMO-SCRIPT.md:69`<br>+2 more | `VERIFIED` |
| W4-R54 | Not code-traceable; external post. | BLOCKED | `docs/submission/SOCIAL-POST.md:1`<br>`docs/submission/SOCIAL-POST.md:16` | `PARTIAL` |

## Gaps

### W4-R10 — `PARTIAL`
- **Requirement:** Post-improvement violation count ≤ 75% of baseline with meaningful types; s...
- **Partial evidence:** `audit/type-safety/baseline.json:32`, `docs/IMPROVEMENTS.md:24`, `docs/IMPROVEMENTS.md:35`
- **Missing:** DEVIATING from the dispatch instruction to default this to IMPLEMENTED-UNVERIFIED, because the numeric-threshold question is independently checkable without any forbidden command: I re-ran the audit's own read-only count.sh (bash ~/.claude/skills/type-safety-audit/scripts/count.sh api web shared) at current HEAD (279fb8e6, 2026-08-08, branch main) and got api 27 any / 1212 as / 42 non-null / 5 ts-ignore, web 23/659/5/3, shared 0/11/0/0 -> tracked total = 1987. That is HIGHER than both the 1535 baseline and the repo's own docs/IMPROVEMENTS.md figure of 1778 (measured 2026-07-31) -- the trend across the whole remediation window is upward, not a 25% reduction. No compare artifact exists at all under audit/type-safety/ (only baseline.json/baseline.md). Individual tickets (TS-1..TS-10, ~10 tickets) do real, well-evidenced, narrowly-scoped type-safety fixes with genuine before/after diffs (e.g. api explicit_any 78->36, req.userId!/req.workspaceId! 236->0) -- this is not fabricated work -- but the category's own literal acceptance test ('post-improvement violation count <=75% of baseline') has not been true at any point measured, including today. This is exactly the unmarked-inference pattern .claude/CLAUDE.md warns about: the project's own doc asserts 'Verdict: met' while its own adjacent table shows the tracked number went up, not down. Controller re-measured this at HEAD rather than trusting the repo's claim, because docs/IMPROVEMENTS.md records the type-safety target as met. It is not met — the tracked total moved the wrong way. Re-ran the audit's own instrument (`bash ~/.claude/skills/type-safety-audit/scripts/count.sh web api shared`, the exact command baseline.md:14-18 records) and summed by baseline.md:77's own formula (any + as + ! + ts-ignore, as-any not double-counted): any 50, as 1882, non-null 47, ts-ignore 8 = 1987 tracked violations, against a recorded baseline of 1535 (audit/type-safety/baseline.json metrics.violationsTotal). That is +452 (+29%), where the requirement asks for -25% (about -384). The honest nuance, which the headline number hides: explicit `any` actually halved (102 -> 50), a real improvement in the most meaningful sub-metric; the rise is driven almost entirely by `as` assertions (1385 -> 1882), a metric baseline.md:62 itself documents as over-counting by 15-20% because it catches import/export aliases, comments, and `as const`. So the direction of the tracked total is not in doubt, but the tracked total is a noisy proxy. Separately, the other half of this requirement's acceptance evidence: `pnpm type-check` is green (exit 0, all 4 packages), `pnpm test` exits 1 with 2 failures (see W4-R35).

### W4-R27 — `PARTIAL`
- **Requirement:** Every resource in the saved plan carries a one-sentence annotation + risk/b...
- **Partial evidence:** `terraform/render/plan/plan-annotated.md:116`, `terraform/render/plan/tro-316-agent-plan-annotated.md:264`, `terraform/render/plan/post-import-plan-no-changes.txt:1`
- **Missing:** PARTIAL under either reading of R26. Best single case is terraform/render/plan/plan-annotated.md at 2/2 resources annotated with individual blast-radius rows. Across all saved plan artifacts in the repo, coverage is uneven: 2/2 (plan-annotated.md), ~1/3 fully individuated (tro-316-agent-plan-annotated.md), 0/2 (post-import-plan-no-changes.txt). The larger AWS inventory (74 root + 66 module resource blocks) is accounted for by category/tier, not literally 'every resource' with its own sentence -- roughly 13-15 of 74 root blocks get an individual annotation, the rest share grouped sentences. No single document annotates every resource of a full plan output for the whole infrastructure.

### W4-R32 — `PARTIAL`
- **Requirement:** terraform apply alone deploys the fork; no manual deploy scripts required f...
- **Partial evidence:** `terraform/render/plan/tro-316-destroy-redeploy-proof.md:88`, `terraform/render/plan/IMPORT-LOG.md:21`, `terraform/render/README.md:9`
- **Missing:** Partial capability, not full satisfaction. What exists: one resource (the agent service) was proven genuinely reproducible via terraform apply alone on a clean state (destroy + recreate + live health check). What is missing: (1) the primary fork service was only ever imported, never created by a clean apply -- the clean-apply path is documented but unexercised for it; (2) the repo's own README explicitly disclaims replacing scripts/deploy.sh/deploy-frontend.sh, so AWS manual deploy scripts remain unreplaced; (3) the agent service has a documented provider bug that forces manual Render REST API calls for real field updates on the free tier; (4) the live/graded deployment's actual recent deploys were manual Render API calls because auto_deploy is broken (TRO-361, open). 'Deployable from a clean machine using only terraform apply, replacing manual deploy steps' is not true in current practice.

### W4-R33 — `PARTIAL`
- **Requirement:** Every category's improvement target (W4-R10/12/16/18/21/23/25 and Terraform...
- **Partial evidence:** `audit/requirements/inventory.md:6`, `docs/IMPROVEMENTS.md:618`
- **Missing:** Roll-up over the 7 non-Terraform categories this cluster traced: Bundle (R12), API perf (R16), DB query (R18), Tests (R21), Error handling (R23), and A11y (R25) each clear their stated target per the evidence above -- 6/7 met. Type safety (R10) does NOT clear its target: the project's own docs/IMPROVEMENTS.md claims 'met' via a sum-of-controlled-diffs accounting, but the literal tracked violation total the target is defined on has only ever been measured going UP (1535 baseline -> 1778 on 2026-07-31 -> 1987 on a live recheck today, 2026-08-08 at HEAD 279fb8e6), never down. So 'improve all 8 categories' is not satisfied as written, regardless of which of the two 7-vs-8 readings is used (type-safety is common to both readings, so the ambiguity noted in the inventory header does not change this verdict -- no ASSUMED/needs_ruling emitted for that reason). Terraform (category 8) is outside this cluster's assigned IDs and was only spot-checked, not fully traced; its 'met' claim in docs/IMPROVEMENTS.md should be confirmed by whichever cluster owns W4-R26..R32.

### W4-R35 — `PARTIAL`
- **Requirement:** The suite is green at every improvement merge point.
- **Partial evidence:** `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md:25`, `audit/db-query/compare-phase2-jul30/after-phase2-jul30.md:22`, `memory-bank/activeContext.md:25`
- **Missing:** Multiple point-in-time snapshots in CHANGES.md and the compare artifacts show the suite green immediately after various improvement commits, and memory-bank/activeContext.md records a recent green CI pipeline (2026-08-07). None of this is a live run at the current HEAD (279fb8e6, 2026-08-08) performed by me -- that is explicitly the controller's job per the dispatch instructions. Suite is NOT green: `pnpm test` exits 1 with 830/832 tests passing and 2 failures, both in api/src/db/__tests__/migrationRunner.test.ts (lines 167 and 184). Cause confirmed by direct observation, not inferred: the test compares a Postgres-ordered result (`SELECT version FROM schema_migrations ORDER BY version`, line 115) against a JavaScript `[...expected].sort()`, and the two orderings genuinely disagree on the pair 020_document_associations / 020b_sprint_assignee_ids — Postgres returns 020b first, JS `.sort()` returns 020_ first. Environment caveat that must not be dropped: an earlier run of the same command failed all 77 files with 'DATABASE_URL must be set' because the shell lacked the env var; the 830/832 figure is from the re-run with api/.env.local loaded. `pnpm type-check` is separately green (exit 0, all 4 packages). E2E (`pnpm test:e2e`) was NOT run this sweep — 600+ Playwright tests requiring the /e2e-test-runner protocol — so no claim is made about it either way.

### W4-R38 — `PARTIAL`
- **Requirement:** package.json files use exact versions; pnpm-lock.yaml committed.
- **Partial evidence:** `pnpm-lock.yaml:1`, `package.json:41`, `package.json:46`
- **Missing:** Missing part: 'must be pinned' is not met for package.json versions. Counted every dependencies/devDependencies entry across the 5 actual workspace package.json files (root, api, web, shared, agent — pnpm-workspace.yaml:1-5 confirms only api/web/shared/agent are workspace members): 153 total entries, 142 use caret (^) range specifiers, only 9 are exact pins, 2 are internal `workspace:*` references. That is roughly 93% unpinned — widespread, not a nitpick, matching the requirement's own framing. Only the lockfile-committed half of R38 is satisfied. (research/configs/package.json is a leftover starter-template file, not a pnpm-workspace member per pnpm-workspace.yaml, and was excluded from this count as out of scope for 'the workspace'; it is itself 2/2 ranges if included.)

### W4-R41 — `PARTIAL`
- **Requirement:** CI builds once, tags with SHA, deploys promote that artifact; lifecycle doc...
- **Partial evidence:** `docs/deployment-artifact-lifecycle.md:1`, `.github/workflows/ci.yml:441`, `.github/workflows/ci.yml:491`
- **Missing:** Missing part: the CI half of build/release/run separation is real and well-built (build-image job builds the Docker image exactly once per commit, only after `verify` passes, tags it immutably by full git SHA, and only pushes on an actual main push — ci.yml:430-513) and the lifecycle is genuinely documented in dev docs (docs/deployment-artifact-lifecycle.md, satisfying that clause on its own). But 'the artifact produced in CI must be the artifact that runs in production' is not true today on either deploy path this repo has: (1) the Render/GHCR path this doc was written for has its promotion step explicitly held/not executed — Render still does its own from-source build, independent of CI's image; (2) the AWS EB/CloudFront scripts (scripts/deploy.sh, scripts/deploy-frontend.sh) — the ones documented as the operative deploy commands elsewhere in this repo's conventions — explicitly rebuild from source on every invocation and never touch the CI-built, SHA-tagged artifact at all, which is a direct contradiction of 'never rebuilt per environment.' The lifecycle doc itself is honest about this gap (it says so plainly at lines 15-25 and 219-225), which is why this is scored PARTIAL rather than MISSING: the pieces exist and are documented, they are just not wired together into an actual promoted-artifact production deploy on either path.

### W4-R42 — `PARTIAL`
- **Requirement:** A single script boots app + database from clean checkout; README documents it.
- **Partial evidence:** `start.sh:68`, `scripts/dev.sh:78`, `api/src/db/ensureDatabase.ts:53`
- **Missing:** PARTIAL. Everything downstream of an already-reachable Postgres server is genuinely one-command and self-healing: dependency install, shared build, database creation, migration, migration verification, seeding, dynamic port selection, and starting both servers — all idempotent, all in scripts/dev.sh, all documented in README's 'Cold start' section. But the script only creates/migrates/seeds a database ON a Postgres SERVER that is already running; it does not start the Postgres server process itself. From a truly clean checkout on a machine with no Postgres running (native service stopped, no Docker container up), `./start.sh` fails immediately with the exact message observed today ('ERROR: Cannot reach PostgreSQL at localhost:5433. Start it, then re-run ./start.sh' — produced by api/src/db/ensureDatabase.ts:53-61's unreachableMessage(), thrown at line 93) and requires a manual step (start a local Postgres service, or `docker compose -f docker-compose.local.yml up -d postgres`) before re-running — which is manual setup beyond 'installing dependencies' under a strict reading of the quote. The README is honest about this (README.md:55-70) rather than hiding it, so the documentation half of R42 is fully met; the 'single command boots app + database... without manual setup beyond installing dependencies' half is not, for the database-server-startup step specifically. No mock external services were found to be needed for local dev (the only external call, AWS SSM, is gated behind NODE_ENV=production in api/src/index.ts:15-17), so that clause of the quote is not in play.

### W4-R51 — `PARTIAL`
- **Requirement:** Not code-traceable; an external video deliverable.
- **Partial evidence:** `docs/submission/DEMO-SCRIPT.md:1`, `docs/submission/FLEETGRAPH-DEMO-SCRIPT.md:1`
- **Missing:** Missing: the actual recorded video (or a link/embed to one). grep across README.md and docs/submission/*.md for youtube/vimeo/loom/.mp4/video-link turned up nothing outside an unrelated Notion-feature-research doc. The repo is plainly the intended home for this deliverable (dedicated docs/submission/ dir, script references a companion Claude-artifact visual aid), so MISSING/PARTIAL is more accurate than N/A per the cluster orientation; scored PARTIAL because the script/material groundwork is fully done and sourced from real measurements, only the recording+link is absent.

### W4-R54 — `PARTIAL`
- **Requirement:** Not code-traceable; external post.
- **Partial evidence:** `docs/submission/SOCIAL-POST.md:1`, `docs/submission/SOCIAL-POST.md:16`
- **Missing:** Missing: a link to (or other confirmation of) the post actually having been published. grep across README.md and docs/submission/*.md for x.com/twitter.com/linkedin.com post URLs returned nothing. The draft content and image assets are fully prepared and ready to post, including the required @GauntletAI tag, so PARTIAL (not N/A) -- the repo is plainly the intended home for this deliverable and the only missing piece is the actual-post link.

## Orphan tickets

Not determinable this sweep — ticket mapping is BLOCKED (see Summary). Re-run after authorizing the Linear connector to populate this section.

## Blocked / assumed

_No individually blocked requirements_ (the ticket dimension is blocked globally — see Summary).

- **W4-R26** `ASSUMED` — traced under: Traced R26's 'Navigate to terraform/ and run terraform init followed by terraform plan. Save the full plan output' as referring to the local-provider and Render-provider exercises the same quote just described (terraform/render/, audit/terraform/drift-demo/), not the pre-existing AWS terraform/*.tf root -- because a genuine full plan output was only ever captured for the former; the AWS root's live plan is structurally blocked (S3 backend + AWS credentials, neither available in this exercise) and only the blocking error was saved, never a full plan.

### Open ambiguity rulings needed

Each of these is a yes/no question whose answer changes a verdict. They were traced under a stated assumption rather than guessed silently; a ruling recorded in `interpretations.md` will make future sweeps decide them automatically.

- **W4-R26** — Does W4-R26's 'Navigate to terraform/ and run terraform init followed by terraform plan. Save the full plan output' refer to the local-provider/Render-provider exercise directories (terraform/render/, audit/terraform/drift-demo/), where genuine full plan output was captured and saved, or to the pre-existing AWS terraform/*.tf root, where a live plan is structurally blocked (S3 remote backend + AWS credentials, neither available) and only the blocking error was saved (audit/terraform/raw/root-plan-attempt.txt)?
  - Traced under: Assumed it refers to the local/Render exercise directories, since that is the only place a full plan output actually exists; if it means the AWS root specifically, W4-R26 drops from ASSUMED(satisfied) to PARTIAL.

## PM handoff

Config `pm_skill: ship-pm` resolved to `.claude/skills/ship-pm/SKILL.md` and the handoff ran actively: the gaps above were passed through that skill's scope gate. The resulting disposition per gap — what ships now, what is deferred with which condition, and what is an owner action rather than engineering work — is in [`pm-triage.md`](pm-triage.md). This audit opened no tickets and modified no application source; the triage is a judgement, not a work order.

## Verification performed

Commands the controller actually ran this sweep, with what they proved:

- **W4-R13** — `pnpm db:seed && npx tsx audit/seed-augment.ts  # then row-count query against ship_standup`

  ```
          metric         | actual 
  -----------------------+--------
   documents (floor 500) |    500
   issues (floor 100)    |    255
   users (floor 20)      |     20
   sprints (floor 10)    |     35
  ```

- **W4-R53** — `curl -sS -w '%{http_code}' --max-time 25 https://ship-rr6m.onrender.com/health`

  ```
  HTTP 200 in 0.227139s
  body: {"status":"ok"}
  ```

