> **DRAFT** — for Troy to personalize before posting. Numbers cited are sourced from
> `audit/AUDIT_REPORT.md` (68 findings / 4 Critical), `memory-bank/progress.md` (bundle, DB-query,
> and ERR-1 collaboration-server figures), and `audit/type-safety/baseline.md` (707/767 untyped
> query figures — rounded to "700+" for a general audience). No internal hostnames, account IDs, or
> credentials are referenced. The repo being audited is a fork of the U.S. Treasury's already-public
> open-source Ship project (`github.com/US-Department-of-the-Treasury/ship`).

# Social Post Drafts

## X / Twitter (267 characters)

> Audited a real government codebase this week (US Treasury's open-source Ship project): 68
> findings across type safety, perf, a11y, infra. Fixed the worst ones — /login bundle -80.5%, a
> silent editor data-loss bug, 700+ untyped DB queries now type-checked. @GauntletAI

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

> — GIR: "Doom doom doom doom doom."
