# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-29 (Wed) late / 2026-07-30 early, day 3 → 4 · **Phase 2 is underway: 19 tickets worked, 4 merged, 12 in review**

## Where we are

The factory ran three waves. **`main` is at `84f05ff`.** Phase 2 due **Fri Jul 31**.

| | Count |
|---|---|
| Merged audit tickets | **4** — TRO-172 (API-1), TRO-188+189 (ERR-1/2), TRO-215 (A11Y-1) |
| Merged non-ticket (tooling) | 5 PRs — #10, #15, #16, #18, plus the harness |
| **In Review — gate-green, PR open** | **12 tickets across 8 PRs** — see table below |
| New findings filed this run | **TRO-276 … TRO-287** (12), all marked post-baseline |
| Linear "Done" total | 7 (4 audit + TRO-242/243/244 from day 2) |

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
| #21 | TRO-217 A11Y-3 | Lighthouse **95 → 100**, axe 18 Serious → 0 |
| #22 | TRO-226 TEST-4 | Yjs merge coverage, proved by 3 sabotages |
| #23 | TRO-277 TEST-12 | flake: 6/20 → **1/20** failures under load |
| #24 | TRO-224+225 TEST-2/3 | the XSS test never tested sanitization |

## Start here next session

1. **Merge the 12 open PRs.** All gate-green. Bottleneck is CodeRabbit's fair-usage throttle, not the work. The **CLI** (`coderabbit review --agent --base main`) uses a *separate* allowance and is the way through — the gate now runs it as G9.
2. **Then dispatch the held-back tickets**, deliberately serialized: TS-1 (TRO-206) and TS-2 (TRO-207) collide with everything in their package; A11Y-2 + ERR-3/ERR-4 all touch `Editor.tsx` and must wait for #14.
3. **Terraform tickets need a human** — escalation gate 2. TRO-234/235/278/283 involve `terraform apply` against production.

## Owed to a human — cannot be closed by machine

- **VoiceOver pass on TRO-215** (merged) and TRO-281. The PR claims only DOM semantics + axe; nobody has *heard* it.
- **TRO-287 was investigated and cancelled** — `admin.ts:11` applies `superAdminMiddleware` router-wide; the 200 was a fixture artefact of TRO-277 mechanism 2. Not a defect.

## Decisions made 2026-07-29/30

- **Ticket agents run on Sonnet** (`model: "sonnet"`). The brief carries the knowledge, not the model. Orchestrator stays as-is. Recorded in `ship-orchestrator` §2a.
- **Concurrency is capped by gates, not agents.** Load hit **39.75 on 14 cores** and manufactured phantom failures. Dispatch broadly, stagger gates.
- Non-ticket content merges on gate + CI green, no review gate. Auto-merge once review is green.

## Watch-outs (verified this run)

- **`refs/stash` is shared across worktrees** — one stack for all. Two agents collided; one recovered via `git fsck --unreachable`. Never `git stash`; copy files aside.
- **`merge=union` on `CHANGES.md` was tried and REVERTED.** It drops shared context lines — five branches came out with 9 entry headings and 8 run blocks. Use `scripts/factory/merge-changes.mjs`, which merges whole entries and asserts byte-identity.
- **A rollback instruction pointed at a commit where the file did not exist.** `previousCapture.capturedAtCommit` is the *measurement* commit, not where `quarantine.json` lives. Two successive wrong versions before it was fixed by storing identities inline.
- **api flake (TRO-277) is load-sensitive and real.** Two mechanisms fixed: `clearAllMocks` leaving once-queues armed, and an unguarded shared test DB across processes. Still 1/20 under load. **When a `beforeAll` fails, vitest reports SKIPPED not failed** — that is the phantom-skip explanation.
- CodeRabbit's green status check can mean **"Review rate limited"** — a skip, not a pass. Read the check description.
- `gate.sh` now has **G7b** (`review-patterns.mjs`) failing new `!`/`as any`/`as unknown as`/fixed sleeps, and G5 compares removed *vs added* test lines.
