# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-30, day 4 · **Phase 2: 26 audit tickets Done, 16 PRs merged this run, 1 PR open.** Phase 2 due **Fri Jul 31**.

## Where we are

`main` went `4d74602` → `319e1af` this run — 16 PRs merged (12 carrying 21 audit tickets, 4 tooling), both remotes (GitLab + GitHub) in sync. Audit tickets Done: 5 → **26**, verified directly against Linear this session (filtered to the ShipShape Audit Remediation range — the day-2 deploy/CI tickets aren't counted).

| | |
|---|---|
| Merged this run | #14 #8 #20 #19 #13 #12 #24 #17 #22 #23 #29 #30 (tickets) + #26 #27 #28 #31 (tooling) |
| **Open PRs** | **#11 only** (TRO-223 TEST-1) — gate-green, empties the quarantine, blocked solely by TRO-288 |
| Review ledger | **74** findings / 13 tickets (`node scripts/factory/review-ledger.mjs report`) |
| Type-safety family | **14** once `type-safety` + `implicit-any` + `unsafe-cast` + `unsafe-type-cast` + `test-cast` are summed — file everything there as `type-safety` going forward, the split taxonomy hid the size of the class |

Per-PR headline results, the four factory-tooling defects fixed, and the merge mechanics that actually drained the queue are in `progress.md`'s 2026-07-30 entry — not duplicated here.

## Needs a human before the next deploy

- **Read production SSM `DATABASE_URL`.** PR #17 (DB-11) merged: the API now refuses to start in production if the resolved connection string carries `sslmode=disable`. No `aws` CLI access from here to check it.
- **VoiceOver on TRO-215 and TRO-281.** Still nobody has *heard* either; both PRs claim only DOM semantics + axe.
- **#30 inverted an ordering and it's awaiting a decision.** Express `router.param` now fires before `authMiddleware`, so an unauthenticated request with a malformed id returns 400 where it used to return 401. Nothing sensitive is exposed, but it inverts the repo's auth-then-validate convention.

## Current focus (max 3)

1. **TRO-288 [TEST-15] determinism fix, in flight.** `session-activity-race.test.ts` asserts exactly-once under a concurrent burst and fails CI on branches that never touch auth — it hit #29 and blocks #11 now. Bar: 10 consecutive runs under deliberate load, still red against the pre-DB-2 unconditional write.
2. **Merge PR #11** the moment TRO-288 lands — it's the sole blocker. Takes the web quarantine from 13 entries to 0.
3. **TRO-284 (ERR-11) + TRO-285 (ERR-12)**, the collaboration load-window pair — same mechanism as the already-fixed ERR-10, now recorded as a pattern in `systemPatterns.md` so a fourth agent doesn't rediscover it. ERR-11's regression test is confirmed red for the documented reason (frame sequence `[3,0,1,1]`).

## Decisions made 2026-07-30

- Merge #17 (DB-11) now; read the SSM value before the next deploy rather than gating the merge on it.
- Merge #13 (DB-2/API-6) without a separate human auth read.
- Maintainer is installing CodeRabbit's GitHub App for the repo — removes the review rate-limit bottleneck that forced this run's local-merge workaround.

## Watch-outs verified this run (two supersede prior guidance)

- **`git check-attr merge -- CHANGES.md` after a merge is NOT a valid check — this reverses what was written here before.** The merge replaces `.gitattributes` with `main`'s version first, so it reads `unspecified` even over a genuinely corrupted file. Two agents independently saw clean `unspecified` beside spliced `CHANGES.md` (17 and 13 unbalanced fences). Only `merge-changes.mjs --check` catches it.
- **After `git merge main`, run `pnpm install`.** PR #20 added `compression`; a stale `node_modules` fails ~19 api test files at module load — three agents read this as a catastrophic regression from their own merge. Tell: failures in files the diff never touched, module-resolution errors not assertion errors.
- **Never start a background poll and then wait on it.** Six agents stalled this way this run (CI checks, gate runs, monitors) — nothing wakes them.
- **The load-sensitive api flake (TEST-12/TRO-277) now has five identities**, all failing only inside a full `gate.sh` run: `backlinks.test.ts`, `rate-limit.test.ts`, `weeks.test.ts::should reject review approval without rating`, `session-activity-race.test.ts::…exactly once…`, candidate `workspaces.test.ts::should archive person document`.
- **The merge method that actually drains the queue:** integrate locally with `git merge --no-ff` in sequence, resolve `CHANGES.md` with `merge-changes.mjs`, union the append-only `.jsonl`s, verify the *combined* result once, then a single push. Merging one PR at a time through GitHub re-conflicts every other open branch on `CHANGES.md` and the queue never drains. Two merges were deliberately aborted and hand-resolved instead (#17×#8 in `migrate.ts`, #23×#13 in `auth.test.ts`) because they were real code conflicts, not text ones.

> — GIR: "I'm gonna sing the doom song now."
