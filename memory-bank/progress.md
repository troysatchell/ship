# Progress — Status Log

*What works, what's left, what changed. Append-style updates with dates; newest section first.*

## Status board

| Workstream | Status |
|---|---|
| Codebase orientation | ✅ done (2026-07-27) — full repo map, leads recorded in systemPatterns + config notes |
| Audit skill set (8 skills) | ✅ built at `~/.claude/skills/` (2026-07-27) |
| Repo audit config | ✅ `audit/shipshape.config.yaml` written with verified facts |
| Memory bank | ✅ initialized (2026-07-27) |
| Seed augmentation | ✅ 500 docs / 20 users, deterministic, verified by row count |
| Baseline: type-safety / bundle / tests (Group A) | ✅ done (2026-07-27) — 29 findings |
| Baseline: api-perf → db-query (Group B) | ✅ done (2026-07-27) — 16 findings, 2 Critical |
| Baseline: error-handling / a11y (Group C) | ✅ done (2026-07-27) — 9 + 8 findings, 2 more Critical (ERR-1, ERR-2) |
| Baseline: Terraform/IaC (Category 8) | ✅ done (2026-07-27) — 6 findings (2 High), `audit/terraform/` |
| Live dashboard + defense brief | ✅ published (URLs in log below); dashboard at checkpoint `report-complete` |
| AUDIT_REPORT.md assembled + submitted | ✅ `audit/AUDIT_REPORT.md` — **68 findings, 4 Critical, 8 categories** |
| Findings → Linear tickets | ✅ done (2026-07-28) — 8 epics + 68 sub-issues, `TRO-164`–`TRO-239` |
| Audit baseline committed + published | ✅ done (2026-07-28) — dual remotes, raw captures gitignored |
| Improvement phase (compare loops) | ⬜ Fri Jul 31 |
| Submission deploy (provider undecided) | ⬜ Render vs Railway — see 2026-07-28 log |
| Final polish + presentation | ⬜ Sun Aug 2 |

## Log

### 2026-07-28 (Tue) — Day 2, later — assignment PDF re-read; brief was incomplete

- **Read `/Users/troy/Documents/G.Assignments/GFA_Week_4_ShipShape_Updated.pdf` (13 pp) in full.** `projectbrief.md` had been a partial transcription — it captured the 7 category targets, deadlines, and audit rules but **missed the 11 implementation rules, the 10-row submission deliverable table, and the grading weights**. Brief rewritten from the source; it now points at the PDF path as the authority.
- **Render vs Railway: SETTLED — Render.** Not a judgment call; Category 8 states deployment is via Render with its official first-party provider (`render-oss/render`) and that **no AWS account or cloud credentials are required**. Also: the Render service must be **created by `terraform apply` from a clean checkout**, so it must not be hand-built in the dashboard.
- **Topology forced to one Render web service** (API + SPA same-origin). Verified in code: session cookie `sameSite: 'strict'` (`api/src/middleware/auth.ts:217`, `api/src/routes/auth.ts:188`), collab WS URL from `window.location.host` (`web/src/components/Editor.tsx:334`), `VITE_API_URL` defaults to `''` (`Editor.tsx:330`). A static-site + separate-API split silently breaks auth and collaboration. **The API does not serve `web/dist` today** — required code change before any deploy works.
- **Newly surfaced graded scope, none of it in the 68 findings:** CI pipeline w/ source-code inventory (rule 4), regression tests per audit bug (rule 3), build-once/promote artifacts tagged with git SHA (rule 5), one-command local start (rule 6), retries/timeouts/circuit breakers (rule 7), `CHANGES.md` (rule 8) — plus non-code deliverables: improvement docs, discovery write-up (3 things w/ file:line), 3–5 min demo video, AI cost analysis, social post tagging @GauntletAI, orientation notes. Listed in activeContext.md; not yet ticketed.
- **Grading recorded:** audit report is pass/fail (met). Implementation scored — measurable improvement 40%, technical depth 25%, TypeScript quality 15%, documentation 10%, commit discipline 10%. Rule 11 and the 10% weight both say the git history is read directly, so improvements go on their own labeled branches from here.
- **Incidental:** the upstream target repo is `github.com/US-Department-of-the-Treasury/ship` — **already public**. The infra-topology exposure weighed before publishing our fork was therefore already public upstream. Also note the submission deliverable is the **GitLab** repo while rule 4 mandates **GitHub Actions** — the dual-remote setup from earlier today happens to satisfy both.

### 2026-07-28 (Tue) — Day 2 — findings → Linear, repo published, deploy target opened

- **All 68 findings decomposed into Linear tickets.** Team `Troysatchell` (`TRO`), project **ShipShape Audit Remediation**. Structure is 8 category "epic" parents with each finding as a sub-issue — parents `TRO-164`–`TRO-171`, sub-issues `TRO-172`–`TRO-239`. Full ID map is in `activeContext.md`; finding IDs stay the join key between report, tickets, and compare runs.
  - **Ticket convention adopted:** lead with the user-facing cost, keep the measurement underneath as proof. The report is measurement-first by design (it has to be re-runnable and diffable); that makes a poor ticket title but the right ticket body. In practice the "Estimated impact" paragraph became the lede and "Evidence" the body.
  - Cross-cutting root causes wired as Linear **relations** (DB-2⇄API-6, DB-4⇄API-4/API-5/ERR-7, API-2⇄DB-5, ERR-6⇄TEST-5, ERR-1⇄ERR-2, BUN-1⇄BUN-2/3/4/6) rather than deduplicated. True dependencies as **blocks**: API-1→API-2/API-3, TF-3→TF-4, TF-2→TF-1.
  - The unpinned boot-crash hypothesis rides inside `TRO-188` (ERR-1) rather than getting its own ticket — it needs a clean repro before it can be called a 5th Critical.
- **Audit baseline + memory bank committed and published** (`c73e621`). `audit/` tracked at ~700 KB: `AUDIT_REPORT.md`, per-category `baseline.json`/`baseline.md`, and the scan scripts. The ~9 MB of raw captures (server logs, probe JSON, EXPLAIN dumps, screenshots, Lighthouse/axe reports, analyzer stats) is **gitignored and regenerable** from the per-category Methodology sections. Pre-commit hooks (`comply opensource`, empty-test, api-coverage) passed — no `--no-verify`.
- **Repo now publishes to two remotes from one push.** `origin` fetches from GitLab `troysatchell/Ship` (internal) and has two push URLs — that project plus **public** GitHub `troysatchell/ship`. `upstream` is the original `byronmackay/ship`. Chose dual push URLs over CI mirroring: no extra machinery, and the remotes can't silently drift. See techContext.md.
  - Public was a deliberate call after a clean secret scan (no credentials in tree or in 557 commits of history; two previously-committed-then-ignored files verified harmless). Exposure that *is* published: the unfixed 68-finding report, Terraform VPC/WAF/Aurora topology, a Route53 zone ID, and `*.awsdev.treasury.gov` hostnames. Reaffirmed after being shown the specifics — **decided, don't re-litigate.**
- **Verified 2026-07-28: AWS prod is not publicly reachable.** `ship.awsdev.treasury.gov` → 403; `ship-api-prod...elasticbeanstalk.com/health` → no response. Reviewers can't reach a running app there, which is an independent argument for the submission deploy.
- **Opened: Render vs Railway for the submission deploy.** Undecided. The brief frames Render, and Category 8's improvement target is specifically a *Render-provider* config (`render-oss/render`, pinned, `terraform apply` from a clean machine — `AUDIT_REPORT.md:1673`). Railway has no first-party Terraform provider, so it can host the app but can't produce the graded artifact. Decision hinges on whether the deploy must satisfy Category 8 or is only a demo URL.

### 2026-07-27 (Mon) — Day 1, latest — Category 8 (Terraform/IaC) baseline
- Added an 8th audit category: **Terraform Plan Review**. Artifacts in `audit/terraform/baseline.{json,md}` + `raw/` + `drift-demo/`. 6 findings (2 High / 3 Medium / 1 Low), 0 Critical.
- **Scope reality:** `terraform/` is **AWS** (Elastic Beanstalk + Aurora Serverless v2 + VPC + CloudFront/S3 + WAF + SSM), NOT the Render setup the brief assumes — no Render provider exists in the repo. A live `terraform plan` is **not runnable** (S3 remote backend whose bucket name lives in SSM + no AWS creds), so blast radius was reasoned statically from the code + `terraform validate`.
- **Tooling gotcha (TF-3):** the pinned Terraform `1.6.0` (`.terraform-version`) can't `init` — its bundled provider-signing key has expired (`openpgp: key expired`). Used 1.9.8 (allowed by `required_version >= 1.6.0`) to validate; downloaded to a temp bin, not added to repo.
- **Top findings:** TF-1 (High) prod Aurora + uploads bucket have no `deletion_protection`/`prevent_destroy` — only the TF *state* bucket is guarded; TF-2 (High) two divergent root configs (flat `terraform/*.tf` with WAF+realtime-logging vs modular `environments/prod` without) manage the same infra with separate state + colliding names.
- **Drift demo (cloud-free):** `audit/terraform/drift-demo/` with `hashicorp/local` 2.5.2 — clean plan `No changes`; after a manual out-of-band file edit, `plan` recreates both files back to declared content (before/after = `raw/drift-2-clean-plan.txt` → `raw/drift-3-drift-plan.txt`).
- Cleaned up: removed the `.terraform` cache + root lock file `init` created, so `git status terraform/` is empty (infra source untouched). Folded Category 8 into `AUDIT_REPORT.md` → now **68 findings / 4 Critical / 8 categories**.

### 2026-07-27 (Mon) — Day 1, late — baseline COMPLETE
- Resumed the terminated `/shipshape-audit baseline` from Group C. Both remaining categories now measured; **full baseline done, 62 findings (4 Critical / 21 High / 25 Medium / 12 Low)**.
- **error-handling (9 findings, 2 Critical):** synthesized from the already-captured probe1–8 raw JSON (`audit/error-handling/raw/`). ERR-1 (collab-WS-unreachable silent data loss, false "Saved") and ERR-2 (session revocation not enforced on live sockets) are both Critical, both in `api/src/collaboration/index.ts`. Positives verified: no exploitable XSS, clean API 400 validation, browser-offline recovery works. Boot-crash note (uncaught lib0 Yjs decode loading `yjs_state`) flagged for clean repro.
- **a11y (8 findings, 3 High):** measured live. Lighthouse 11.7.1 via `npx` + Playwright Chromium (no system Chrome), authenticated by cookie in `--extra-headers` → my-week 95, others 100. axe-core 4.11 across pages **+ interactive states** found what Lighthouse and the repo's *critical-only* specs miss: 2 axe-Critical (`aria-required-children` sidebar tree; `aria-allowed-attr` editor) + 3 Serious (25-node contrast on /my-week; `listitem`; unnamed dialog). Keyboard nav healthy once the auto-opening "Action Items" modal is Escape-dismissed. 508 framing (treasury.gov) added. Runner scripts saved with the live session token scrubbed to env vars.
- **AUDIT_REPORT.md assembled** (`audit/AUDIT_REPORT.md`, 1,562 lines): exec summary, 62-row cross-category ranking (Criticals first, cross-refs noted), improvement plan with shared-root-cause map, all 7 `baseline.md` sections embedded verbatim (H1s demoted so the report keeps one title).
- **Dashboard republished** to the same URL at checkpoint `report-complete` (viewed remote first to confirm no divergence, then published): claude.ai/code/artifact/7a2310eb-6cce-4da6-a83f-5c5b8d3f2c6c

### 2026-07-27 (Mon) — Day 1, evening
- Baselines complete for 5/7 categories: type-safety (9 findings), bundle (9), api-perf (6), db-query (10), test-quality (11) — 45 findings, 2 Critical (DB-1 migrations, API-1 rate limiter). Artifacts in `audit/<cat>/baseline.{json,md}`.
- **Group C (error-handling, a11y) terminated before baseline — unmeasured.** Decision pending: re-run vs. submit as NOT MEASURED.
- Prerequisite gate had already exposed DB-1; db-query reproduced it independently on a throwaway DB.
- Live dashboard wired into the orchestrator skill and published (checkpoint `group-b-complete`): claude.ai/code/artifact/7a2310eb-6cce-4da6-a83f-5c5b8d3f2c6c
- Architecture defense brief built from the five baselines (charts, Criticals, systemic causes, remediation plan): `audit/defense.html` → claude.ai/code/artifact/c73766aa-3005-42e7-801a-19248f92f8d5

### 2026-07-27 (Mon) — Day 1
- Cloned repo (`labs.gauntletai.com/byronmackay/ship` → `/Users/troy/repos/GAUNTLET/Ship`).
- Built the ShipShape skill architecture: 7 generic category skills + thin orchestrator + shared conventions, after analyzing the skillsets.cc audit skill as prior art. Decision: per-category skills because phase 2 re-invokes categories individually for before/after evidence.
- Mapped the codebase (tsconfigs, build, routes, schema/indexes, seed volumes, test infra, existing a11y specs). Key leads: web tsconfig weaker than root; 433 `as` in web; coverage package missing; no route-level code splitting; no index on ticket_number/created_by; seed short of brief volumes.
- Smoke-tested `count.sh` against `web/` — works.
- Published usage-guide artifact (color-coded diagrams) and initialized this memory bank.
