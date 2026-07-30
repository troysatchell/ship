# Demo Video Script (3–5 min) — DRAFT for Troy to record

*Every number below is sourced from `docs/IMPROVEMENTS.md` / compare artifacts. "SHOW:" lines are
screen-share cues. Target 4:30; trim the deep-dive section to hit 3:30 if needed.*

## 0:00–0:30 — Framing

- "I audited ShipShape — a real government project-management codebase fork — across 8 categories:
  type safety, bundle size, API performance, database queries, tests, error handling,
  accessibility, and Terraform."
- "Phase 1 produced **68 baseline findings** (4 Critical). Phase 2 remediated them with a
  before/after measurement for every fix. Everything I'll show is reproducible from the repo."
- SHOW: `audit/AUDIT_REPORT.md` scrolled at the 68-row ranking table.

## 0:30–1:45 — Three hero numbers (before → after on screen)

1. **Bundle:** "/login went from **601 KB to 117 KB gzip — an 80% cut** — by adding route-level
   code splitting where there was none."
   SHOW: `docs/IMPROVEMENTS.md` §2 table.
2. **Data loss fixed:** "The worst finding: if the collaboration socket was unreachable, edits were
   **silently lost while the UI said 'Saved'**. That's fixed, plus ten more error-handling gaps —
   including a whole class where async setup windows dropped frames or leaked sockets."
   SHOW: IMPROVEMENTS.md §6; optionally the live app editing a doc.
3. **The API contract stopped being a guess:** "**707 untyped database queries** — every `.rows`
   access was `any`. Now the hot paths are typed, **236 auth-context non-null assertions are zero**,
   and an authenticated route is a compile-time distinction. Over **400 violations retired**, each
   PR carrying its own before/after count."
   SHOW: IMPROVEMENTS.md §1.

## 1:45–3:00 — One deep dive (pick ONE, both scripted)

**Option A — the visitor-IP bug (great story):**
- "While locking the load balancer to CloudFront I found the app had been mis-counting proxy hops:
  `trust proxy 1` behind a two-hop chain meant **every visitor's IP resolved to CloudFront's own
  edge server** — so IP-based rate limiting was bucketing the whole internet into a handful of
  CDN addresses. And the first fix would have created the opposite bug on Render, where there's
  one hop — so the hop count is now environment-configured, with tests proving which
  X-Forwarded-For entry wins in each topology."
- SHOW: `api/src/app.ts` `resolveTrustProxyHops`, then `api/src/app.test.ts`.

**Option B — tests that couldn't fail:**
- "**68 end-to-end tests could pass without executing a single assertion** — including the only
  stored-XSS check, which 'passed' because the app rendered nothing at all. All 68 are now real
  assertions or explicit `test.fixme()`, and a pre-commit hook plus the factory gate keep new
  vacuous tests out."
- SHOW: IMPROVEMENTS.md §5; `e2e/` diff in PR #40.

## 3:00–3:45 — Measurement honesty (differentiator — say it plainly)

- "The audit corrected itself where the data demanded it. Three examples:"
  - "The type-safety counter had a grep bug — it never counted the largest assertion class. I
    proved the target with controlled per-ticket diffs instead of a flattering live recount."
  - "The API benchmark appeared to show **regressions from my own rate limiter** — so instead of
    hiding them or blindly 'fixing' them, I profiled. The hash I suspected cost 650 *nanoseconds*
    — acquitted. Then I re-benchmarked unchanged code and got ±30% swings: the regressions were
    **measurement noise**, and the real improvements survive because they're backed by
    deterministic numbers — payload bytes and query counts — that noise can't fake."
  - "An accessibility fix made two broken routes render for the first time — which *exposed* a
    pre-existing contrast failure. It's in the report as a new finding."
- SHOW: IMPROVEMENTS.md §3's two-reading P95 table.

## 3:45–4:30 — Live deployment + infrastructure as code

- "The improved fork is live: **ship-rr6m.onrender.com** — deployed today from main."
  SHOW: the live site, log in, open a document.
- "And the deployment itself is now infrastructure-as-code: I wrote the Render Terraform config,
  **imported the live service into state, and `terraform plan` reports 'No changes — your
  infrastructure matches the configuration'** — the config provably describes production."
  SHOW: `terraform/render/plan/post-import-plan-no-changes.txt`.

## 4:30–5:00 — Close

- "Every improvement: own branch, regression test seen red first, before/after under identical
  conditions, documented in CHANGES.md — 49 entries. The git history is the evidence."
- SHOW: `git log --oneline --merges | head -20`.
