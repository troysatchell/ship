# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-28 (Tue), end of day 2 · **Next session: Phase 2 begins**

## Where we are

**Phase 1 complete and submitted.** The audit gate was verified row-by-row against the assignment PDF, not assumed. Tagged **`audit-baseline`** at `149873a` — compare-mode runs diff against that tag.

**The application is live and seeded:** https://ship-rr6m.onrender.com — login `dev@ship.local` / `admin123`. Verified end to end: login 200, `/api/issues` returns 104 issues. 11 users, 257 documents.

Repo clean at `5b72a79`, both remotes in sync, 11 commits today.

## Start here tomorrow

Phase 2, due **Fri Jul 31**. Recommended order, unchanged from the report's improvement plan:

1. **DB-1** (`TRO-178`) — migration runner. Deploy safety; unblocks trusting any non-fresh database.
2. **ERR-1 + ERR-2** (`TRO-188`, `TRO-189`) — one collaboration-server change, clears both remaining Criticals.
3. **API-1** (`TRO-172`) — until the limiter moves, no latency win is observable, *and* the live demo will 429 under a reviewer clicking around.
4. **DB-2 / DB-4 + API-4** — the shared-root perf fixes.

Then **A11Y-1** (`TRO-215`), which was escalated to Urgent today — see below.

⚠️ **Every improvement on its own branch** (rule 11 — *"we will read your git history"*, 10% of the grade). Today's pattern worked well: branch → verify → `--no-ff` merge.

## What changed today, beyond the audit

- **A11Y-1 escalated High → Urgent** after Troy tested with VoiceOver. Observed: **the workspace sidebar document titles are not announced at all** ("Project Overview", "API Reference" are silent). Root cause is an ARIA contract never implemented — `role="tree"` with no `tabIndex`, no `onKeyDown`, no `aria-level`, plus bare `<li>` children. Recommended fix is **subtraction**: delete `role="tree"`/`role="treeitem"` and let native list semantics work. Full diagnosis in `TRO-215`.
- **Two deploy fixes shipped** — `TRO-242` (multi-stage Dockerfile + SPA served from the API) and `TRO-243` (SSM fallback). Both marked Done with before/after and tradeoffs recorded, which is rule 9's improvement documentation.
- **New epic `TRO-241`** — the six assignment implementation rules that the 68 findings don't cover: CI (`TRO-244`, Urgent), regression tests (`TRO-245`), build/release/run (`TRO-246`), one-command start (`TRO-247`), retries/timeouts/breakers (`TRO-248`), `CHANGES.md` (`TRO-249`).
- **DB-11 → `TRO-240`** — `client.ts` has no SSL config while `migrate.ts`/`seed.ts` do. Marked post-baseline; **not** one of the report's 68.

## Corrections worth remembering

- **DB-1 does not break a *fresh* database.** `migrate.ts:38-41` runs `schema.sql` first, which carries the end state, so a new Render Postgres comes out complete (verified: 18 tables, 83 indexes). The hazard is an *existing* database at an intermediate state. I had this backwards earlier.
- **A local smoke test with `NODE_ENV=development` does not exercise the production startup path.** That is how the SSM coupling was missed on the first pass — `ssm.ts:39` returns early below production.

## Open questions

- **Uncaught boot crash** (`Error: Unexpected end of array`, lib0 Yjs decode on `yjs_state`) — flagged inside `TRO-188`. A 5th Critical if it reproduces cleanly.
- **Terraform ownership of Render.** Category 8 requires `terraform apply` from a clean checkout, but the service and database were created by hand/API. Either `terraform import` them or let Terraform recreate them.
- Free tier: the service sleeps on inactivity and the database has a limited lifetime. Worth upgrading before Sunday, when the URL becomes a graded deliverable.

## Watch-outs (verified)

- **`pnpm test` TRUNCATEs whatever `DATABASE_URL` points at** — always override to an isolated database. The audit used `ship_unit_audit` on the Docker pg at `:5433`.
- Root `pnpm test` runs **api only**; web needs `pnpm --filter @ship/web test` and has 13 known failures.
- **Coverage:** `@vitest/coverage-v8` must match vitest's exact version (4.0.17 — `^4` resolves to 4.1.10 and fails to load), and `coverage.reportOnFailure=true` is required or failing tests suppress the report entirely.
- Migrations 011–042 must still be force-applied individually on an *existing* clean DB until DB-1 is fixed.
- App runs web :5173 / api :3001 locally — read repo-root `.ports`.
- **a11y compare runs need re-auth** — the runner scripts read `SESSION_ID`/`WIKI_DOC_ID` from env.
- **API-3 caveat:** gzip won't show on loopback — measure by payload size or a shaped link.
- Pre-commit warns the `comply` CLI is missing and proceeds. Never `--no-verify`.
