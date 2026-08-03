> **DRAFT** — for Troy to personalize before posting. Numbers cited are sourced from
> `audit/AUDIT_REPORT.md` (68 findings / 4 Critical), `memory-bank/progress.md` (bundle, DB-query,
> and ERR-1 collaboration-server figures), and `audit/type-safety/baseline.md` (707/767 untyped
> query figures — rounded to "700+" for a general audience). No internal hostnames, account IDs, or
> credentials are referenced. The repo being audited is a fork of the U.S. Treasury's already-public
> open-source Ship project (`github.com/US-Department-of-the-Treasury/ship`).

# Social Post Drafts

## X / Twitter (267 characters — non-premium limit is 280)

> Audited a real government codebase this week (US Treasury's open-source Ship project): 68
> findings across type safety, perf, a11y, infra. Fixed the worst ones — /login bundle -81.6%, a
> silent editor data-loss bug, 700+ untyped DB queries now type-checked. @GauntletAI

Attach up to 4 images from `docs/submission/social-assets/` (generated 2026-08-02, no internal
hostnames or real user data — dashboard renders + a Playwright capture of the seeded dev app).

## LinkedIn (~156 words)

> This week I audited a real government codebase end to end: a fork of the U.S. Treasury's
> open-source Ship project. Not a toy repo — a live application, in every category that matters:
> type safety, bundle size, API and database performance, test coverage, error handling,
> accessibility, and infrastructure-as-code.
>
> The result was 68 concrete findings, four of them critical — including a silent data-loss bug in
> the real-time collaboration server that told users a document had saved when it hadn't.
>
> Then came the remediation sprint. Some numbers I'm glad to report: the largest page's JavaScript
> bundle down 80.5%, 700+ previously-untyped database queries now checked by the compiler, and that
> data-loss bug (plus a dozen other error-handling gaps) fixed and tested.
>
> The harder, less flashy part was building a process that could audit, prioritize, and verify
> improvements to a codebase I'd never seen before — and prove each fix with a before/after
> measurement, not just a claim.
>
> @GauntletAI

## X thread version (recommended) — 4 tweets, all under the 280-char non-premium limit

Attach one image per tweet from `docs/submission/social-assets/`.

**1/4** (263 chars) — image: `1-hero-scorecard.png`

> Audited a real government codebase this week — the US Treasury's open-source Ship project. 68
> findings across type safety, perf, accessibility, error handling, infra. Then a remediation
> sprint with a measured before/after for every fix. Some numbers 🧵 @GauntletAI

**2/4** (269 chars) — image: `2-biggest-improvement.png`

> /login bundle: 601 → 110 kB gzip (−81.6%). One import graph was the whole story: the entry chunk
> statically pulled all 25 pages + the full editor stack into a login page that never renders an
> editor. React.lazy on 23 routes + a lazy editor wrapper. No features removed.

**3/4** (258 chars) — image: `4-datafix-live-capture.png`

> Scariest find: the editor said 'Saved' while a dead collaboration socket silently dropped every
> keystroke — permanent data loss. Fixed and screenshot-proven. Also: 700+ untyped DB queries now
> compiler-checked, and 236 non-null assertions on auth context → 0.

**4/4** (254 chars) — image: `3-category-metrics.png`

> Biggest lesson: never trust a claim that does not name its evidence. An XSS test had passed
> forever because the app rendered nothing to test. The audit's own race hypothesis was wrong.
> Measure before, measure after, and mark what is observed vs. derived.