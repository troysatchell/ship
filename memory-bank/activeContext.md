# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-30, day 4 · **Phase 2: 19 tickets worked, 5 merged, 12 in review, all triage rounds complete**

## Where we are

The factory ran three waves plus a full review-triage round. **`main` is at `4d74602`.** Phase 2 due **Fri Jul 31**.

| | Count |
|---|---|
| Merged audit tickets | **5** — TRO-172 (API-1), TRO-188+189 (ERR-1/2), TRO-215 (A11Y-1), TRO-217 (A11Y-3) |
| Merged non-ticket (tooling) | #10, #15, #16, #18, #25, plus the harness |
| **In Review — gate-green, PR open** | **14 PRs** — see table below |
| New findings filed this run | **TRO-276 … TRO-287** (12), all post-baseline; TRO-287 investigated and cancelled |
| Linear "Done" total | 8 (5 audit + TRO-242/243/244 from day 2) |
| Review findings recorded in the ledger | **47** — `node scripts/factory/review-ledger.mjs report` |

## ⚠️ Needs a human before the next deploy

**If the production `DATABASE_URL` in SSM contains `sslmode=disable`, PR #17 turns a currently-working
deploy into a startup failure.** DB-11's triage found the connection string **overrides** the resolved
`ssl` object — `?sslmode=disable` discards it and puts the socket on plaintext (pg
`connection-parameters.js:56`, `parse()` is the last source). The guard now refuses to start in
production rather than silently rewriting the URL. Nobody could read SSM to check. **Read that
parameter before rolling out.** If plaintext is intended there, that is an explicit call to make.

## Open PRs — all gate-green, awaiting review/merge

| PR | Tickets | Headline result |
|---|---|---|
| #8 | TRO-178 DB-1 | migrate applies all 42 or exits non-zero |
| #11 | TRO-223 TEST-1 | web 138/151 → **214/214**, quarantine empty |
| #12 | TRO-276 ERR-10 | malformed frame closes its socket, not the process |
| #13 | TRO-179+177 DB-2/API-6 | **20% fewer statements/read**; 10 row versions → 1 |
| #14 | TRO-197/198/199/200/202 BUN-1..6 | **`/login` 601 → 117 kB gzip (−80.5%)** |
| #17 | TRO-240 DB-11 | one SSL decision shared by 4 pools |
| #19 | TRO-173+182 API-2/DB-5 | payload 380 → 241 kB; p95 90.4 → 59.1 ms |
| #20 | TRO-174 API-3 | **`/api/issues` 379,907 → 25,050 B (15.17×)** |
| #22 | TRO-226 TEST-4 | Yjs merge coverage, proved by 3 sabotages |
| #23 | TRO-277 TEST-12 | flake: 6/20 → **1/20** failures under load |
| #24 | TRO-224+225 TEST-2/3 | the XSS test never tested sanitization |
| #26 | — tooling | G7b flags `: any` annotations, not only `as any` |
| #27 | — tooling | `merge-changes --expect`, plus 3 shared-state rules |

*#21 (A11Y-3) and #25 (memory bank) are merged.*

## Start here next session

1. **Merge the 14 open PRs.** All gate-green, all triage rounds complete. Bottleneck is CodeRabbit's fair-usage throttle, not the work. The **CLI** (`coderabbit review --agent --base main`) uses a *separate* allowance and is the way through — the gate runs it as G9.
2. **Then dispatch the held-back tickets**, deliberately serialized: TS-1 (TRO-206) and TS-2 (TRO-207) collide with everything in their package; A11Y-2 + ERR-3/ERR-4 all touch `Editor.tsx` and must wait for #14.
3. **The three collaboration-window findings should be fixed as a set** — TRO-284 (ERR-11) and TRO-285 (ERR-12) share one cause with the already-fixed ERR-10: *async work between making something reachable and making it able to respond*. Three agents found it independently. Worth a `systemPatterns.md` note or the next person makes it a fourth time.
4. **Terraform tickets need a human** — escalation gate 2. TRO-234/235/278/283 involve `terraform apply` against production.

## Owed to a human — cannot be closed by machine

- **VoiceOver pass on TRO-215** (merged) and TRO-281. The PR claims only DOM semantics + axe; nobody has *heard* it.
- **TRO-287 was investigated and cancelled** — `admin.ts:11` applies `superAdminMiddleware` router-wide; the 200 was a fixture artefact of TRO-277 mechanism 2. Not a defect.

## Decisions made 2026-07-29/30

- **Ticket agents run on Sonnet** (`model: "sonnet"`). The brief carries the knowledge, not the model. Orchestrator stays as-is. Recorded in `ship-orchestrator` §2a.
- **Concurrency is capped by gates, not agents.** Load hit **39.75 on 14 cores** and manufactured phantom failures. Dispatch broadly, stagger gates.
- Non-ticket content merges on gate + CI green, no review gate. Auto-merge once review is green.

## Watch-outs (verified this run)

**Worktrees are isolated; everything around them is not.** Four instances of that one class this run:

- **`refs/stash` is shared** — one stack for all worktrees. Two agents collided; one recovered via `git fsck --unreachable`. Never `git stash`; copy files aside.
- **The scratchpad is shared.** Two agents both used `ours-CHANGES.md`; one clobbered the other, so a merge was fed a *different branch's* file. Every entry came out byte-identical to that wrong source, so integrity **and** `--check` both passed with the wrong ticket on top. Prefix scratch files with the ticket ID. `merge-changes --expect <TICKET>` now guards it.
- **`git` reads merge attributes from the PRE-MERGE tree.** Removing `merge=union` from `main` protected nothing until each branch merged it — three more files were damaged *after* the removal landed, while git reported "went well". After merging main: `git check-attr merge -- CHANGES.md`, expect `unspecified`.
- **An uncommitted tool improvement protects nothing.** A G7b rule sat in the orchestrator's working tree while every branch ran the weaker checker. Found by an agent reconciling a contradiction instead of assuming a side. **When two runs of the same check disagree, diff the checkers.**

Other verified watch-outs:

- **`merge=union` on `CHANGES.md` was tried and REVERTED.** It drops shared context lines — five branches came out with 9 entry headings and 8 run blocks, and on one it spliced an entry *into* another's body. Use `scripts/factory/merge-changes.mjs`.
- **A rollback instruction pointed at a commit where the file did not exist.** `previousCapture.capturedAtCommit` is the *measurement* commit, not where `quarantine.json` lives. Two successive wrong versions before it was fixed by storing identities inline.
- **api flake (TRO-277) is load-sensitive and real.** Two mechanisms fixed: `clearAllMocks` leaving once-queues armed, and an unguarded shared test DB **across processes**. Still 1/20 under load. **When a `beforeAll` fails, vitest reports SKIPPED not failed** — that is the phantom-skip explanation. The `connectionTimeoutMillis` theory is **disconfirmed**: `auth.ts:230-238` returns 500 on a query error, so a timeout cannot produce the observed 401.
- **`CREATE TABLE IF NOT EXISTS` is check-then-create, not atomic.** 6 concurrent `schema.sql` applies → **5 fail** (`23505` on `pg_type_typname_nsp_index`). That is what makes DB-1's silent-success path reachable, and why TRO-279 is now High. Checking whether the file was idempotent answered the *category*, not the *case*.
- CodeRabbit's green status check can mean **"Review rate limited"** — a skip, not a pass. Read the check description.
- `gate.sh` has **G7b** (`review-patterns.mjs`) failing new `!`/`as any`/`: any`/`as unknown as`/fixed sleeps; **G5** compares removed *vs added* test lines; **G7** validates `CHANGES.md` structure.
