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
| Improvement phase (compare loops) | ⬜ Fri Jul 31 |
| Final polish + presentation | ⬜ Sun Aug 2 |

## Log

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
