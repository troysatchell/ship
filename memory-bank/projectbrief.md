# Project Brief — ShipShape Sprint

*Foundation document. Rarely changes. Everything else in the memory bank builds on this.*

**Source of truth:** `/Users/troy/Documents/G.Assignments/GFA_Week_4_ShipShape_Updated.pdf` (13 pp).
Re-read it before final submission — this file is a summary, not a substitute.
Upstream target repo: `github.com/US-Department-of-the-Treasury/ship` (public).

## Mission

Audit and measurably improve the Ship codebase, with baseline → fix → before/after evidence for every claim. The deliverable is **proof of engineering judgment on an inherited production codebase**, not a new feature. *"Depth over breadth. Proof over promises."*

## Categories and improvement targets

Phase 1 audits **7** categories; Phase 2 says **improve all 8** (Terraform is Category 8 and has its own submission row).

| # | Category | Target (phase 2) |
|---|----------|------------------|
| 1 | Type safety | −25% of violations, with real types (no `any`→`unknown` swaps) |
| 2 | Bundle size | −15% total, or −20% initial-load via code splitting |
| 3 | API response time | −20% P95 on ≥2 endpoints, identical conditions |
| 4 | DB query efficiency | −20% query count on a flow, or −50% on slowest query |
| 5 | Test coverage/quality | 3 meaningful tests on untested paths, or 3 flakes root-caused |
| 6 | Error/edge handling | 3 fixes, ≥1 real data-loss/confusion scenario |
| 7 | Accessibility | +10 Lighthouse on worst page, or all Critical/Serious fixed on top 3 pages |
| 8 | Terraform / IaC | Local-provider config (≥2 local resources) **+ Render-provider config** declaring a web service that deploys the improved fork. Both with pinned provider versions; `terraform plan` confirming intent on each. |

## Deadlines (absolute)

- **Tue Jul 28, 2026 11:59 PM — audit report (HARD GATE).** ✅ met. Incomplete audits are an automatic fail regardless of implementation quality.
- **Fri Jul 31, 2026 11:59 PM — implementation.**
- **Sun Aug 2, 2026 11:59 AM — final submission.**

## Deployment is Render — settled by the brief

Category 8 states deployment is done **via Render**, which has an official first-party Terraform provider (`render-oss/render`). **No AWS account or cloud credentials are required.** The Render deployment *replaces* manual deploy steps: the fork must be **deployable from a clean machine using only `terraform apply`**.

Implication: do not hand-create the Render service in the dashboard — Terraform must own it.

## Implementation rules (all 11 are graded)

1. **Before/after proof mandatory** — reproducible benchmark, identical conditions.
2. **Tests must still pass** — fix with justification or revert; never merge a red build.
3. **Regression tests required** — every bug/vulnerability found in the audit needs a test that *would have caught it*. Stable fakes, not live external calls.
4. **CI pipeline required** — GitHub Actions on every PR and commit: build, lint, type-check, test, coverage, `pnpm audit`, security scan. All must pass before merge. Dependency versions pinned, lockfiles committed. **Produce a source-code inventory in CI** (packages, versions, licenses). Document any deviation.
5. **Build/release/run separation** — artifacts built **once** and promoted across environments, never rebuilt per environment. The CI artifact is what runs in prod. Tag each artifact with the git SHA. Document the lifecycle.
6. **One-command local start** — `./start.sh` or a Makefile target bringing up app + database + mocks from a clean checkout, no manual steps beyond installing deps. Documented in a README cold-start guide.
7. **Retries, timeouts, circuit breakers** — assess and fix missing retry logic, hardcoded timeouts, and missing circuit breakers on outbound calls (DB, WebSocket, external APIs). Document the failure mode each change protects against.
8. **Dev documentation required** — `CHANGES.md` at repo root: what was added, how to run it, **how to roll it back**. Separate from the audit report.
9. **Document your reasoning** — per improvement: what changed, why the original was suboptimal, why yours is better, what you traded off.
10. **No cosmetic changes** — renames/reformatting don't count unless they support a measurable change.
11. **Commit discipline** — each improvement on its own branch or clearly separated commits. *"We will read your git history."*

## Submission deliverables

| Deliverable | Requirement |
|---|---|
| **GitLab repository** | Forked repo, improvements on **clearly labeled branches**, setup guide in README |
| **Audit report** | Baselines for all 7 categories + methodology, tools, raw data ✅ |
| **Improvement documentation** | Per category: before, root cause, fix, after, proof of reproducibility |
| **Discovery write-up** | 3 things learned — name, file path + line range, what it does and why it matters, how you'd apply it |
| **Demo video (3–5 min)** | Walk through findings and improvements; show before/after; explain reasoning |
| **AI cost analysis** | Dev spend + reflection on AI tool effectiveness for codebase comprehension |
| **Deployed application** | Improved fork running and **publicly accessible** |
| **Social post** | X or LinkedIn — what you learned auditing a government codebase, key findings, tag **@GauntletAI** |
| **Terraform plan review** | Local + Render configs, annotated plan with blast radius, drift demo, versions pinned, `terraform apply` from a clean checkout |
| **Orientation notes** | The Appendix checklist output is part of the final submission |

## Grading

**Audit report is a pass/fail gate.** Implementation is scored:

| Criteria | Weight |
|---|---|
| Measurable improvement (hit target in all categories, reproducible) | 40% |
| Technical depth (root cause vs. surface patch) | 25% |
| TypeScript quality (generics, narrowing, utility types) | 15% |
| Documentation quality | 10% |
| Commit discipline | 10% |

## Non-negotiable audit rules

1. Diagnosis before treatment — nothing is fixed during the audit phase.
2. Every number comes from a reproducible command; methodology is part of the deliverable.
3. Before/after comparisons run under identical conditions (seed volume, concurrency, hardware).
4. Fixes must preserve behavior — full test suite green after every fix.
5. Seed to realistic volume before perf measurement: 500+ documents, 100+ issues, 20+ users, 10+ sprints.

## Tooling

Audit executed with the ShipShape skill set (`~/.claude/skills/`): `shipshape-audit` orchestrator + 7 category skills, each with `baseline` and `compare <label>` modes. Repo-specific facts in `audit/shipshape.config.yaml`. Artifacts in `audit/<category>/`.
