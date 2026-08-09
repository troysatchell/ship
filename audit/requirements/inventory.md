# Requirements Inventory — W4 (GFA_Week_4_ShipShape_Updated.pdf)

Extracted 2026-08-08 by requirements-audit. Format: `~/.claude/skills/requirements-audit/references/inventory-format.md`.
User edits to this file are authoritative over extraction.

Note (not a requirement): the document titles 8 categories (Category 8: Terraform Plan Review) while the audit-gate and submission passages say "all 7 categories" — quoted verbatim below wherever each occurs; expect an interpretation ruling at sweep time.

## W4-R1
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "Before you audit anything, complete the Appendix: Codebase Orientation Checklist at the end of this document."
- **Meaning in code:** Orientation checklist answers exist as a saved notes document in the repo.
- **Type:** process
- **Acceptance evidence:** an orientation-notes doc in the repo (root or docs/) covering the appendix's 8 sections
- **Status:** active

## W4-R2
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "Your orientation notes become part of your final submission."
- **Meaning in code:** The orientation notes from W4-R1 are committed and referenced by the submission materials.
- **Type:** process
- **Acceptance evidence:** notes file committed + referenced from README or submission doc
- **Status:** active

## W4-R3
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "You must submit a written audit report with baseline measurements for all 7 categories below."
- **Meaning in code:** audit/AUDIT_REPORT.md exists with a baseline section per category.
- **Type:** process
- **Acceptance evidence:** audit/AUDIT_REPORT.md contains baselines for every category (see note on 7-vs-8)
- **Status:** active

## W4-R4
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "Describe how you measured it (tools, commands, methodology)"
- **Meaning in code:** Each category baseline in AUDIT_REPORT.md has a Methodology subsection with exact commands.
- **Type:** process
- **Acceptance evidence:** Methodology subsection present per category in audit/AUDIT_REPORT.md
- **Status:** active

## W4-R5
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "Provide concrete baseline numbers"
- **Meaning in code:** Each category's deliverable table in AUDIT_REPORT.md is filled with measured values, no blanks.
- **Type:** process
- **Acceptance evidence:** filled deliverable tables per category in audit/AUDIT_REPORT.md
- **Status:** active

## W4-R6
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.2
- **Quote:** "Identify the specific weaknesses or opportunities you found"
- **Meaning in code:** Each category baseline lists concrete findings.
- **Type:** process
- **Acceptance evidence:** findings list per category in audit/AUDIT_REPORT.md
- **Status:** active

## W4-R7
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.3
- **Quote:** "Rank the severity or impact of each finding"
- **Meaning in code:** Findings in AUDIT_REPORT.md carry severity ranks.
- **Type:** process
- **Acceptance evidence:** severity column/labels on findings in audit/AUDIT_REPORT.md
- **Status:** active

## W4-R8
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.3
- **Quote:** "You do not fix anything during the audit."
- **Meaning in code:** No application-code changes in the commit range of the audit phase.
- **Type:** process
- **Acceptance evidence:** git history: audit-phase commits touch only audit artifacts
- **Status:** active

## W4-R9
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.3
- **Quote:** "Total any types" — "Total type assertions (as)" — "Total non-null assertions (!)" — "Total @ts-ignore / @ts-expect-error" — "Strict mode enabled?" — "Strict mode error count (if disabled)" — "Top 5 violation-dense files"
- **Meaning in code:** The type-safety baseline table in AUDIT_REPORT.md is complete (all 7 metrics).
- **Type:** process
- **Acceptance evidence:** filled Category 1 table in audit/AUDIT_REPORT.md (cross-check audit/type-safety/baseline.json)
- **Status:** active

## W4-R10
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.3
- **Quote:** "Eliminate 25% of type safety violations. Every fix must preserve existing functionality (all tests still pass). Superficial fixes do not count. Replacing any with unknown without proper type narrowing is not an improvement."
- **Meaning in code:** Post-improvement violation count ≤ 75% of baseline with meaningful types; suite green.
- **Type:** functional
- **Acceptance evidence:** verify.typecheck + verify.test green; audit/type-safety compare artifact showing ≥25% reduction
- **Status:** active

## W4-R11
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.4
- **Quote:** "Total production bundle size" — "Largest chunk" — "Number of chunks" — "Top 3 largest dependencies" — "Unused dependencies identified"
- **Meaning in code:** The bundle baseline table in AUDIT_REPORT.md is complete.
- **Type:** process
- **Acceptance evidence:** filled Category 2 table (cross-check audit/bundle/baseline.json)
- **Status:** active

## W4-R12
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.4
- **Quote:** "15% reduction in total production bundle size, or implement code splitting that reduces initial page load bundle by 20%. Provide before/after bundle analysis output. Removing functionality to shrink the bundle does not count."
- **Meaning in code:** Vite build output (web/) shrinks per one of the two thresholds with analyzer proof.
- **Type:** functional
- **Acceptance evidence:** audit/bundle compare artifact with before/after analyzer output meeting a threshold
- **Status:** active

## W4-R13
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.4
- **Quote:** "Seed the database with realistic data: 500+ documents, 100+ issues, 20+ users, 10+ sprints. Use pnpm db:seed or write your own seed script"
- **Meaning in code:** api/src/db/seed.ts (or an augmenting script) produces at least those row counts.
- **Type:** functional
- **Acceptance evidence:** row-count query after pnpm db:seed meets all four floors
- **Status:** active

## W4-R14
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.4
- **Quote:** "Identify the 5 most important API endpoints by tracing the frontend's network requests during common user flows"
- **Meaning in code:** AUDIT_REPORT.md names 5 endpoints with the tracing method recorded.
- **Type:** process
- **Acceptance evidence:** endpoint list + tracing methodology in audit/AUDIT_REPORT.md
- **Status:** active

## W4-R15
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.4
- **Quote:** "Benchmark each endpoint using a load testing tool (autocannon, k6, hey, or similar). Record P50, P95, and P99 response times" — "Test under concurrent load: 10, 25, and 50 simultaneous connections"
- **Meaning in code:** The API baseline table has P50/P95/P99 per endpoint at the three concurrency levels.
- **Type:** process
- **Acceptance evidence:** filled Category 3 table (cross-check audit/api-perf/baseline.json)
- **Status:** active

## W4-R16
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.5
<!-- quote-verify-exception: source-W4.md renders "P95" as "a95" on this bold line (font-encoding damage in extraction); quote verified against PDF p.5 visually -->
- **Quote:** "20% reduction in P95 response time on at least 2 endpoints. You must provide before/after benchmarks run under identical conditions (same data volume, same concurrency, same hardware). Document the root cause of each bottleneck."
- **Meaning in code:** Two endpoints' P95 drop ≥20% under identical-conditions re-benchmark, with root-cause notes.
- **Type:** functional
- **Acceptance evidence:** audit/api-perf compare artifact meeting threshold on ≥2 endpoints
- **Status:** active

## W4-R17
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.5
- **Quote:** "Execute 5 common user flows: load the main page, view a document, list issues, load a sprint board, search for content" — "Count total queries executed per flow" — "Run EXPLAIN ANALYZE on the slowest queries" — "Check for missing indexes" — "Identify N+1 patterns"
- **Meaning in code:** The DB baseline table covers the 5 named flows with counts, slowest-query times, and N+1 flags.
- **Type:** process
- **Acceptance evidence:** filled Category 4 table (cross-check audit/db-query/baseline.json)
- **Status:** active

## W4-R18
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.5
- **Quote:** "20% reduction in total query count on at least one user flow, or 50% improvement on the slowest query. Provide before/after EXPLAIN ANALYZE output."
- **Meaning in code:** One flow's query count or the slowest query improves per threshold with EXPLAIN proof.
- **Type:** functional
- **Acceptance evidence:** audit/db-query compare artifact with before/after EXPLAIN ANALYZE
- **Status:** active

## W4-R19
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.5
- **Quote:** "Run the full test suite: pnpm test. Record pass/fail counts and total runtime" — "Identify flaky tests: run the suite 3 times and note any tests that pass sometimes and fail others" — "Map critical user flows (document CRUD, real-time sync, auth, sprint management) against existing test coverage"
- **Meaning in code:** The test baseline table (totals, pass/fail/flaky, runtime, uncovered critical flows) is complete.
- **Type:** process
- **Acceptance evidence:** filled Category 5 table (cross-check audit/test-quality/baseline.json)
- **Status:** active

## W4-R20
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.6
- **Quote:** "If code coverage tooling is not configured, configure it and report line/branch coverage per package"
- **Meaning in code:** Coverage tooling runs for api and web packages and per-package numbers are reported.
- **Type:** functional
- **Acceptance evidence:** coverage config in repo + coverage % in Category 5 table
- **Status:** active

## W4-R21
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.6
- **Quote:** "Add meaningful tests for 3 previously untested critical paths, or fix 3 flaky tests with documented root cause analysis." — "“Meaningful” means the test catches a real regression, not just asserting that a page loads. Each test must include a comment explaining what risk it mitigates."
- **Meaning in code:** Three new regression-catching tests (or 3 flaky-test RCAs) exist, each with a risk comment.
- **Type:** functional
- **Acceptance evidence:** the 3 tests identified by file:line with risk comments; verify.test / verify.e2e green
- **Status:** active

## W4-R22
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.6
- **Quote:** "Console errors during normal usage" — "Unhandled promise rejections (server)" — "Network disconnect recovery" — "Missing error boundaries" — "Silent failures identified"
- **Meaning in code:** The error-handling baseline table is complete with repro steps for silent failures.
- **Type:** process
- **Acceptance evidence:** filled Category 6 table (cross-check audit/error-handling/baseline.json)
- **Status:** active

## W4-R23
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.7
- **Quote:** "Fix 3 error handling gaps. At least one must involve a real user-facing data loss or confusion scenario (not just a missing loading spinner). Each fix requires reproduction steps, before/after behavior, and a screenshot or recording."
- **Meaning in code:** Three error-handling fixes landed, one covering a data-loss/confusion path, each documented with repro + before/after + capture.
- **Type:** functional
- **Acceptance evidence:** audit/error-handling compare artifact + fix documentation with captures
- **Status:** active

## W4-R24
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.7
- **Quote:** "Lighthouse accessibility score (per page)" — "Total Critical/Serious violations" — "Keyboard navigation completeness" — "Color contrast failures" — "Missing ARIA labels or roles"
- **Meaning in code:** The a11y baseline table is complete across the app's major pages.
- **Type:** process
- **Acceptance evidence:** filled Category 7 table (cross-check audit/a11y/baseline.json)
- **Status:** active

## W4-R25
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.7
- **Quote:** "Achieve a Lighthouse accessibility score improvement of 10+ points on the lowest-scoring page, or fix all Critical/Serious violations on the 3 most important pages. Provide before/after Lighthouse reports or axe scan output as evidence."
- **Meaning in code:** One of the two a11y thresholds is met with before/after scanner output.
- **Type:** functional
- **Acceptance evidence:** audit/a11y compare artifact with before/after reports
- **Status:** active

## W4-R26
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.7
- **Quote:** "Install Terraform locally. The local exercises use the Terraform local provider (hashicorp/local) — no cloud account needed. For deployment, configure the Render Terraform provider (registry.terraform.io/render-oss/render) with a Render API key. Navigate to terraform/ and run terraform init followed by terraform plan. Save the full plan output."
- **Meaning in code:** terraform/ inits and plans locally; the full plan output is saved as an artifact.
- **Type:** functional
- **Acceptance evidence:** saved plan output file + terraform init/plan reproducible from terraform/
- **Status:** active

## W4-R27
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Annotated terraform plan output explaining every resource and its blast radius"
- **Meaning in code:** Every resource in the saved plan carries a one-sentence annotation + risk/blast-radius note.
- **Type:** process
- **Acceptance evidence:** annotated plan document covering every resource in the plan output
- **Status:** active

## W4-R28
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Drift detection demonstration: before-and-after plan output showing a manual change being detected"
- **Meaning in code:** A documented drift demo exists (local provider file edit or Render dashboard change, re-plan diff captured).
- **Type:** process
- **Acceptance evidence:** before/after plan outputs showing the detected drift
- **Status:** active

## W4-R29
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Write a new Terraform config that uses the local provider to manage at least two local resources (e.g. configuration files, environment files)."
- **Meaning in code:** A local-provider .tf config managing ≥2 local resources exists and plans clean.
- **Type:** functional
- **Acceptance evidence:** the .tf file(s) + terraform plan output matching intent
- **Status:** active

## W4-R30
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Then write a second config using the Render provider that declares a Render web service and deploys your improved ShipShape fork."
- **Meaning in code:** A Render-provider .tf config declaring the fork's web service exists and plans clean.
- **Type:** functional
- **Acceptance evidence:** the .tf file(s) + plan output; deployment verifiable per W4-R32
- **Status:** active

## W4-R31
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Both configs must have pinned provider versions."
- **Meaning in code:** required_providers blocks pin exact versions in both configs.
- **Type:** functional
- **Acceptance evidence:** version pins visible at file:line in both .tf configs
- **Status:** active

## W4-R32
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "The Render deployment replaces any manual deploy steps — your fork should be deployable from a clean machine using only terraform apply."
- **Meaning in code:** terraform apply alone deploys the fork; no manual deploy scripts required for it.
- **Type:** functional
- **Acceptance evidence:** documented clean-machine apply run (or its captured output)
- **Status:** active

## W4-R33
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Improve all 8 categories. Your audit report guides your priorities, but you must deliver measurable improvement in every category. The passing threshold for each category is defined by its Improvement Target above."
- **Meaning in code:** Every category's improvement target (W4-R10/12/16/18/21/23/25 and Terraform R29-32) is met.
- **Type:** functional
- **Acceptance evidence:** compare artifacts per category meeting each target
- **Status:** active

## W4-R34
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Before/After proof is mandatory. Every improvement must include a reproducible benchmark or measurement showing the before state and the after state, run under identical conditions."
- **Meaning in code:** Each improvement has paired before/after measurements under identical conditions.
- **Type:** process
- **Acceptance evidence:** compare artifacts alongside baselines in audit/
- **Status:** active

## W4-R35
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Tests must still pass. If any existing test breaks because of your change, you must either fix the test (with justification) or revert the change. Any change that causes a regression in the CI pipeline must be rolled back immediately"
- **Meaning in code:** The suite is green at every improvement merge point.
- **Type:** functional
- **Acceptance evidence:** verify.test + verify.e2e green on the improvement branches/main
- **Status:** active

## W4-R36
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Regression tests are required. Every bug or vulnerability found during the audit must have a corresponding regression test that would have caught it. Tests that mock external services must use stable fakes (not live external calls)"
- **Meaning in code:** Each audit finding ID maps to a regression test; external-service mocks are deterministic fakes.
- **Type:** functional
- **Acceptance evidence:** finding-ID → test file:line mapping; no live external calls in those tests
- **Status:** active

## W4-R37
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "CI pipeline required. Add GitHub Actions workflows that run on every PR and commit: build, lint, type-check, test, coverage, dependency audit (pnpm audit), and security scan. All checks must pass before a PR can merge."
- **Meaning in code:** .github/workflows/ contains workflows running all seven checks on PR + push, enforced for merge.
- **Type:** functional
- **Acceptance evidence:** workflow file:line for each of the 7 checks; branch protection or equivalent gate
- **Status:** active

## W4-R38
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Dependency versions must be pinned in package.json and lockfiles committed."
- **Meaning in code:** package.json files use exact versions; pnpm-lock.yaml committed.
- **Type:** functional
- **Acceptance evidence:** no range specifiers in package.json deps; lockfile in git
- **Status:** active

## W4-R39
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Produce a source-code inventory as part of the CI run — a list of all packages, their versions, and their license."
- **Meaning in code:** A CI step emits a package/version/license inventory artifact.
- **Type:** functional
- **Acceptance evidence:** workflow step file:line + a produced inventory artifact
- **Status:** active

## W4-R40
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Any deviation from required checks must be documented with written justification."
- **Meaning in code:** Skipped/altered CI checks are documented with reasons.
- **Type:** process
- **Acceptance evidence:** justification section in CI docs or CHANGES.md
- **Status:** active

## W4-R41
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.8
- **Quote:** "Build/release/run separation. Build artifacts (compiled output, Docker images) must be produced once and promoted through environments — never rebuilt per environment. The artifact produced in CI must be the artifact that runs in production. Tag each artifact with the git commit SHA for provenance. Document the artifact lifecycle in your dev docs."
- **Meaning in code:** CI builds once, tags with SHA, deploys promote that artifact; lifecycle documented.
- **Type:** functional
- **Acceptance evidence:** workflow/deploy script file:line showing build-once + SHA tag; lifecycle doc
- **Status:** active

## W4-R42
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "One-command local start. Write a script (e.g. ./start.sh or a Makefile target) that starts the full composed system locally — app, database, and any mock external services — with a single command from a clean checkout. This script must be documented in the README cold-start guide and must work without any manual setup steps beyond installing dependencies."
- **Meaning in code:** A single script boots app + database from clean checkout; README documents it.
- **Type:** functional
- **Acceptance evidence:** script file:line (scripts/dev.sh or start.sh) + README cold-start section
- **Status:** active

## W4-R43
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "Retries, timeouts, and circuit breakers. Assess the existing codebase for missing retry logic, hardcoded timeouts, and missing circuit breaker patterns on outbound service calls (database, WebSocket, external APIs). Add or improve these where gaps are found. Document each change with the failure mode it protects against."
- **Meaning in code:** Outbound calls (pg pool, WebSocket, external) have assessed retry/timeout/breaker handling; gaps fixed + documented.
- **Type:** functional
- **Acceptance evidence:** assessment doc + fix file:line with failure-mode notes
- **Status:** active

## W4-R44
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "Dev documentation required. Every addition or improvement you make must be accompanied by developer documentation. This is separate from the audit report and improvement documentation — it is written for the next engineer who inherits this codebase. At minimum: what was added, how to run it, how to test it, and how to roll it back if it breaks. Store this in a CHANGES.md file at the repo root."
- **Meaning in code:** CHANGES.md at repo root covers every improvement with run/test/rollback notes.
- **Type:** functional
- **Acceptance evidence:** CHANGES.md present, entries per improvement
- **Status:** active

## W4-R45
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "Document your reasoning. For each improvement, write a short explanation of: what you changed, why the original code was suboptimal, why your approach is better, and what tradeoffs you made."
- **Meaning in code:** Per-improvement reasoning write-ups exist (CHANGES.md or improvement docs).
- **Type:** process
- **Acceptance evidence:** reasoning sections per improvement
- **Status:** active

## W4-R46
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "No cosmetic changes. Renaming variables, reformatting code, or updating comments do not count as improvements unless they directly support a measurable change in one of the 7 categories."
- **Meaning in code:** Improvement commits contain substantive changes tied to category targets.
- **Type:** process
- **Acceptance evidence:** commit review: no cosmetic-only improvement claims
- **Status:** active

## W4-R47
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.9
- **Quote:** "Commit discipline matters. Each improvement should be in its own branch or clearly separated commit(s) with descriptive messages. We will read your git history."
- **Meaning in code:** Git history shows per-improvement branches/commits with descriptive messages.
- **Type:** process
- **Acceptance evidence:** git log structure per improvement
- **Status:** active

## W4-R48
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.10
- **Quote:** "Find 3 things in this codebase that you did not know before." — "1. Name the thing you discovered 2. Where you found it in the codebase (file path and line range) 3. What it does and why it matters 4. How you would apply this knowledge in a future project"
- **Meaning in code:** A discovery write-up with 3 entries, each carrying the 4 elements incl. file:line ranges.
- **Type:** process
- **Acceptance evidence:** discovery doc with 3 complete entries
- **Status:** active

## W4-R49
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.10
- **Quote:** "GitLab Repository" — "Forked repo with all improvements on clearly labeled branches. Setup guide in README."
- **Meaning in code:** The fork hosts improvement branches with clear names; README has a setup guide.
- **Type:** process
- **Acceptance evidence:** branch list + README setup section
- **Status:** active

## W4-R50
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.11
- **Quote:** "Improvement Documentation" — "For each of the 7 categories: before measurement, explanation of root cause, description of fix, after measurement, proof of reproducibility."
- **Meaning in code:** Per-category improvement docs contain those 5 elements.
- **Type:** process
- **Acceptance evidence:** improvement docs per category (see 7-vs-8 note)
- **Status:** active

## W4-R51
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.11
- **Quote:** "Demo Video (3-5 min)" — "Walk through your audit findings and improvements. Show before/after measurements. Explain your reasoning."
- **Meaning in code:** Not code-traceable; an external video deliverable.
- **Type:** process
- **Acceptance evidence:** video link in submission materials
- **Status:** active

## W4-R52
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.11
- **Quote:** "AI Cost Analysis" — "Dev spend + reflection on AI tool effectiveness for codebase comprehension."
- **Meaning in code:** Not code-traceable; a written analysis deliverable.
- **Type:** process
- **Acceptance evidence:** cost-analysis doc in submission materials
- **Status:** active

## W4-R53
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.11
- **Quote:** "Deployed Application" — "Your improved fork running and publicly accessible."
- **Meaning in code:** The fork is deployed at a public URL.
- **Type:** functional
- **Acceptance evidence:** live URL responding (deploy config in repo: scripts/deploy*.sh, terraform/)
- **Status:** active

## W4-R54
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.11
- **Quote:** "Social Post" — "Share on X or LinkedIn: what you learned auditing a government codebase, key findings, tag @GauntletAI."
- **Meaning in code:** Not code-traceable; external post.
- **Type:** process
- **Acceptance evidence:** post link in submission materials
- **Status:** active
