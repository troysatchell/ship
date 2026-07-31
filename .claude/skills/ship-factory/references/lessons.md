# Standing rules for factory agents

Injected into every agent brief. **Keep this short.** A rule earns its place by having caught a
real failure; noise here degrades every future prompt. When a gate failure could have been
prevented by a better brief, add one line. When an agent simply hit a hard problem, add nothing.

Seeded 2026-07-29 from failures already documented in this project.

## Claims

1. **Mark derived claims as derived.** "axe reports X, which usually means Y" — never "it does Y."
   A11Y-1 was reported as *"announced incorrectly by screen readers"*, reasoned from an axe rule
   and never heard. A human running VoiceOver found the titles are **not announced at all** — a
   worse defect, and statically detectable the whole time.
2. **State the configuration a check ran under.** A container smoke test was reported "verified
   end-to-end" while running `NODE_ENV=development`, which returns early past `ssm.ts:39` — the
   exact code that was broken. It passed *because* it skipped the failure.
3. **Check the specific case, not the category.** DB-1 skips migrations in general; against a
   *fresh* database it does not matter, because `migrate.ts:38-41` applies `schema.sql` first. The
   claim "DB-1 blocks fresh deploys" was exactly backwards, and the audit report already said so.
4. **Read the artifact before asserting about it.** Twice the disconfirming evidence was already
   in the repo.

## Environment

5. **`pnpm test` TRUNCATEs 16 tables in whatever `DATABASE_URL` points at**, in the `beforeAll` of
   every api test file. Always `source .factory-env` first. Never run it with `DATABASE_URL` unset.
6. **Root `pnpm test` runs api only.** Web needs `pnpm --filter @ship/web test`, and it has 13
   known failures quarantined in `audit/factory/quarantine.json`.
7. **`pnpm db:migrate` exits 0 while under-applying** (finding DB-1 — it abandons at migration 010).
   The schema is still complete because `schema.sql` runs first. Do not read exit 0 as "all 42
   migrations applied", and confirm columns with `\d` before relying on them.
8. **There is no local postgres.** Everything runs against the Docker container `ship-audit-pg` on
   `:5433`. `psql` and `createdb` are not on PATH; `scripts/worktree-init.sh` assumes they are and
   silently degrades.
9. **Ports are not 3000/5173.** Read the repo-root `.ports` file, or `.factory-env` in a worktree.

## Tests

10. **A test with only comments passes silently.** 68 e2e tests do exactly this (TEST-2), including
    the only stored-XSS and audit-log-authz checks. Use `test.fixme()` for unimplemented tests.
11. **Confirm a regression test fails for the right reason.** An import error or a typo is not a
    red test — it proves nothing about the behaviour you claim to have fixed.
12. **Never widen the quarantine or skip a test to get green.** The gate greps your diff for it.
13. **Put the regression test where the gate runs it** — `api/src/**/*.test.ts` or
    `web/src/**/*.test.ts(x)`. The gate's regression-test check counts added cases in `*.spec.ts`
    too, but its test *execution* is only the two vitest projects and neither includes `e2e/`. An
    e2e-only regression test passes the check unexecuted.

## Measurement

13. **gzip shows no win on loopback** (API-3). Measure payload size or use a shaped link.
14. **a11y compare runs need a fresh login** — the runner scripts read `SESSION_ID` and
    `WIKI_DOC_ID` from the environment.
15. **Run `db-query-audit` after `api-perf-audit`, never concurrently.** The statement logging one
    enables skews the other's timings.

## Recurring review findings

*Derived from `node scripts/factory/review-ledger.mjs report`, not from memory. Each class below was
filed by a reviewer on **two or more separate tickets** after `gate.sh` had already passed. That is
the bar for appearing here: one finding is feedback, two is a missing rule.*

16. **Never add a non-null `!`, `as any`, or `as unknown as` — including in tests.**
    5 findings across 4 tickets (TRO-188, TRO-178, TRO-276, TRO-179). This is the single largest
    recurring class. TS-4 counts 236 non-null assertions as a **measured number we are graded on
    reducing**; TS-8 is specifically that test-side casts decouple tests from the shapes they claim to
    verify. Adding one while fixing an audit that counts them moves the metric backwards.
    `gate.sh` now checks this mechanically (G7b). To allow a specific line, write
    `// review-pattern-ok: <reason>` and justify it in the PR. Do not bypass silently.
    For mocks: return **real** `Response`/object instances, or define a small test-local type. For
    indexed access under `noUncheckedIndexedAccess`, destructure and assert explicitly.
17. **Never add a fixed sleep to a test. Await an observable event.**
    3 findings across 3 tickets (TRO-215, TRO-188, TRO-276). TEST-11 (TRO-233) is the open finding
    that 619 fixed sleeps cause this repo's flakes; adding more while that ticket is open is
    self-defeating. Also checked by G7b.
    Asserting an *absence* genuinely needs a window — for that, poll for the duration and assert the
    value never changes, and tie the window to a real constant (a debounce interval), not a round
    number. A sampled stability check is a **stronger** assertion than sleep-then-check, because it
    catches a value that appears and is then overwritten.
18. **Anything periodic or read-then-write needs a concurrency argument.**
    3 findings across 3 tickets (TRO-188, TRO-178, TRO-179), all Major, none machine-detectable —
    which is why this one is a rule and not a gate check. Before shipping:
    - A `setInterval` that starts async work needs an **in-flight guard**, or invocations stack
      exactly when the thing they call is already slow (TRO-188).
    - A decision made in application code and then applied as an unconditional write is a
      **lost update**. Push the predicate into the `WHERE` clause so the database decides (TRO-179).
    - A read-then-apply sequence over shared state needs a **lock** (TRO-178 → TRO-279).
    State the argument in the PR. "It is unlikely to happen" is not one.

    **Updated 2026-07-31 (TRO-300 / TEST-16) — a barrier that gates DISPATCH is not the same
    guarantee as one that gates EXECUTION.** TRO-288 made a flaky concurrency test's "the burst
    genuinely raced" precondition structural by holding every caller's query *send* until all
    arrived, then releasing them together — provably correct on the client side (traced into
    `pg-pool`'s source: all sends really do leave the process in the same tick). It still failed
    in CI three more times with the identical signature. Why: synchronizing when bytes leave your
    process says nothing about when the *receiving* system (Postgres's own per-connection backend,
    scheduled by the OS) actually executes the statement — under real contention one connection's
    whole read-decide-write-commit cycle can finish before another, already-sent, statement is even
    scheduled to run. The fix was to gate *result delivery* instead of dispatch: hold every caller's
    response until every barriered call has itself settled, so no caller can act on its read until
    every read has already happened, regardless of execution order anywhere downstream. If your
    "structural" fix for a race is a barrier, ask which side of the operation it actually
    synchronizes — the side you control leaving your process, or the side you don't, being acted on
    by something else.

    **Updated 2026-07-30 — now 6 findings across 4 tickets, worst severity CRITICAL.** This is the
    most *dangerous* recurring class in the project, and it has one dominant shape:
    **async work between making something reachable and making it able to respond.** Four instances,
    all in `api/src/collaboration/index.ts`: the `'error'` listener attached after an `await`
    (ERR-10); the `'message'` listener attached after an `await`, dropping sync step 1 (ERR-11); a
    `Y.Doc` published into the shared map before its content loaded (ERR-12); and a socket that
    closed *during* an `await` still being registered in `conns` with no `'close'` listener — a
    permanent leak that also replayed buffered frames into a live broadcast (found in review on
    ERR-11's own fix, i.e. the pattern recurred **inside the PR that was fixing it**).
    Before you `await` anything in a connection or cache path, ask: *between this line and the one
    that finishes setup, what can arrive, and where does it go?* If the answer is "nowhere" or "into
    a half-built object", that is this bug. The fixes that work are **buffer-then-drain**, **cache
    the load promise rather than the object**, and **re-check liveness after every await**.
    `memory-bank/systemPatterns.md` records the pattern; read it before touching that file.
19. **`CHANGES.md` claims get checked against the diff.**
    4 findings across 3 tickets (TRO-178, TRO-223, TRO-179): a count that contradicted itself, a
    test-harness fix filed as a source defect, an entry title that overstated the result, and a
    stated ordering guarantee the runner did not provide. Before committing an entry, re-read it
    against what you actually changed — the rollback paragraph especially, since that is what someone
    reads under pressure. Run `node scripts/factory/merge-changes.mjs --check CHANGES.md`.
20. **Tests must not share mutable resources or reuse a spent connection.**
    2 findings across 2 tickets, one **Critical**. Derive database names from `randomBytes`, never a
    deterministic string, and never use `DROP DATABASE ... FORCE` — it converts "something is still
    connected" into a silent disconnect (TRO-178). In socket tests, open a **fresh** connection per
    hostile case; reusing one that an earlier case closed asserts against a dead socket and proves
    nothing (TRO-276).

21. **Type the boundaries that hand you `any` without saying so. G7b cannot see these.**
    Every rule above about `as any` and `: any` greps for a token in your diff. These have no token,
    which is exactly why they keep landing after a green gate:
    - **`pool.query(...)` rows.** Untyped, the row is `any` and every field access after it is
      unchecked. Write `pool.query<MyRow>(...)` with a small local interface. (TRO-178, TRO-226.)
    - **`response.json()` / `res.json()`.** Returns `any`/`Promise<any>`. Define a response-body
      interface and narrow before touching fields — including in tests and e2e specs.
      (TRO-226 ×3 call sites, TRO-224.)
    Reviewers filed **8 type-safety findings across 6 tickets**, and that undercounts it: the same
    defect also got filed as `implicit-any`, `unsafe-cast`, `unsafe-type-cast` and `test-cast`.
    Normalized, it is roughly **14 findings** and by a wide margin the largest recurring class in
    this project — against an audit (TS-2) whose whole point is that 707 pg queries are untyped.
    **When you record a finding in the ledger, use the slug `type-safety`** for anything in this
    family; a fragmented taxonomy hides recurrence and is why this took six tickets to see.

22. **Never start a background poll or monitor and then wait for it. Nothing will wake you.**
    Six agents in one run stalled this way — on CI polls, on gate runs, on a "monitor" that was
    going to notify them. Each burned wall-clock doing nothing and had to be nudged by the
    orchestrator to produce a report it had already earned. Run what you need in the **foreground**
    and read the result, or make one synchronous check and move on.
    Concretely: `gh pr checks <n>` once, not a loop. `scripts/factory/gate.sh` in the foreground, or
    read `.factory/gate-result.json` after it returns.
    **CI is the orchestrator's gate, not yours.** "CI queued at time of report" is a complete and
    acceptable answer — an unsent report is not. Finish, write it up, stop.

23. **After `git merge main`, run `pnpm install` before you believe any failure.**
    `main` gains dependencies. When it does, your worktree's `node_modules` is stale and the import
    fails at module load — so **every** test file that imports the app fails at once. The cascade
    looks like a catastrophic regression from your merge; it is one missing package.
    Observed three times in one hour, on TRO-277, TRO-240 and TRO-181, all from PR #20 adding
    `compression`: ~19 api file-level failures, a web failure, and typecheck errors
    (`Cannot find module 'compression'`, then `TS7006` on the untyped params downstream). One
    `pnpm install` cleared all of it — the lockfile was already correct, so nothing else was wrong.
    Symptom to recognise: failures in files your diff never touched, all reporting import or
    module-resolution errors rather than assertion failures.
24. **The load-sensitive api/web flake is one shared mechanism, not isolated flaky tests — never
    widen the quarantine.** TEST-1 emptied `quarantine.json` entirely, so there is no longer any list
    absorbing a red test: one flake now fails a gate and a CI run outright. `gate.sh` re-runs each new
    failure standalone and reports the result automatically — you don't need to track identities by
    hand. It still records `fail`, deliberately: "fails in the suite, passes alone" is equally the
    signature of a real test-isolation bug (TEST-12 turned out to be exactly that), so auto-passing it
    would hide the class this project keeps finding.
    Read `.factory/<pkg>-standalone.txt` and judge. Concurrency across worktrees under a loaded
    `gate.sh` run (typecheck + build first) is the usual cause — check `ps` for sibling gates before
    concluding anything. Multiple identities across files unrelated to each other (TRO-277) is
    evidence of one shared load-sensitive mechanism, not many flaky tests — re-run standalone before
    believing any single failure, and never widen the quarantine.
25. **A commit message that claims a cleanup is not evidence the cleanup happened.**
    A commit on TRO-223 asserted it had removed two `as any` casts; only one was removed, and the
    survivor sat in a file the branch otherwise edited. `review-patterns.mjs` (G7b) could not catch
    it because it only inspects **added** lines — a pre-existing violation inside a file you touch is
    a structural blind spot. When you claim to have removed casts, `grep` the file afterwards and
    quote the result.

## Log

*Append dated entries as the factory learns. One line each, with the ticket that taught it.*

- 2026-07-29 — seeded from `.claude/CLAUDE.md` provenance rules and the memory-bank watch-outs.
- 2026-07-29 — **In a linked worktree `.git` is a FILE, not a directory.** `.git/info/exclude`
  fails with "Not a directory" and, under `set -e`, silently aborts the rest of a provisioning
  script. Cost: a worktree whose database was created but never migrated. Use `.gitignore`, or
  resolve via `git rev-parse --git-common-dir`.
- 2026-07-29 — **`grep -c ... || echo 0` emits `"0\n0"`.** `grep -c` already prints `0` and *then*
  exits 1, so the fallback appends a second line and every integer test breaks. Use
  `n=$(grep -c ...) || n=0`.
- 2026-07-29 — **Anything interpolated into a `psql` command must be validated first.** Database
  and other identifiers cannot be bound as parameters. Caught by CodeRabbit on the factory's own
  provisioner, where a ticket ID reached `CREATE DATABASE` unchecked.
- 2026-07-29 (TRO-215) — **NEVER `git stash` in a factory worktree.** `refs/stash` lives in the
  **common** `.git` directory, so every concurrent worktree shares ONE stash stack. An agent
  stashing its fix to take a "before" measurement had its entry popped by a sibling worktree within
  ~2 minutes and gone from `git stash list`. Recovered only via `git fsck --unreachable`. To measure
  before/after, **copy the files aside or `git worktree add` a second checkout** — never stash.
- 2026-07-29 (TRO-215) — **Some findings are data-dependent; reproduce before you conclude.**
  A11Y-1's bare-`<li>` violations only render when a sidebar section has **>10** root docs (the
  "N more…" link) or **zero** (empty state). Default seed data has 5, so axe reports **C0/S0** and a
  re-measurement on stock seed would wrongly conclude the finding never existed. Check the data
  precondition before reporting a finding as unreproducible.
- 2026-07-30 (TRO-174) — **The scratchpad is SHARED across concurrent agents. Never use a generic
  temp filename.** Two agents independently chose `ours-CHANGES.md`; one clobbered the other, and the
  first re-merge produced a `CHANGES.md` with the **wrong ticket at the top and the right one absent
  entirely**. Caught only by checking entry headings against git rather than trusting the tool's
  "1 ours-new + 1 theirs-new" summary. Prefix every scratch file with your ticket ID, and verify
  intermediate files came from where you think. Same class as the shared `refs/stash`: worktrees are
  isolated, everything around them is not.
- 2026-07-30 (TRO-174) — **git reads merge attributes from the PRE-MERGE working tree.** Removing
  `CHANGES.md merge=union` from `main` did **not** protect any open branch: each branch still carried
  the attribute in its own tree, so the union driver stayed live for that branch's next merge and
  damaged three more files *after* the removal landed. `git merge` reported *"Auto-merging CHANGES.md
  — Automatic merge went well."* It was not well.
- 2026-07-30 (TRO-224) — **`git check-attr` AFTER the merge does not detect this, and the earlier
  version of this rule told you to use it. That was wrong.** The merge itself replaces
  `.gitattributes` with `main`'s version, so `check-attr merge -- CHANGES.md` reads `unspecified`
  *even when the union driver just ran and corrupted the file*. A clean `unspecified` is therefore
  not evidence of anything. The only check that caught it was
  **`node scripts/factory/merge-changes.mjs --check CHANGES.md`**, which found 17 unbalanced fences
  and one entry's command block spliced into another. **Always run `--check` after merging `main`,
  whatever `check-attr` says.** To inspect the attribute meaningfully you must read it from the
  pre-merge tree (`git check-attr merge -- CHANGES.md` *before* `git merge`, or
  `git show HEAD:.gitattributes`). Recovery: redo the resolution from the pre-merge `--ours`/
  `--theirs` snapshots with `merge-changes.mjs --expect <TICKET>`.
- 2026-07-30 (TRO-197) — **`coderabbit review` has no internal deadline and hangs under concurrent
  factory load.** Observed 11+ minutes of wall time against 2.6s of CPU — blocked on I/O, not
  working — while sibling worktrees ran the same command. Since gate check G9 can only record
  pass/warn/skip, a hang can never change the verdict; it just stalls the gate until someone kills
  the subprocess, which an unattended run cannot absorb. `gate.sh` now wraps the call in
  `timeout` (`CR_TIMEOUT`, default 360s) and records `warn: review timed out`. **If your gate sits
  on a `coderabbit` subprocess, kill it and treat G9 as `warn`** — then triage the PR-level review,
  which `triage.md` already prefers because it sees the full branch diff.
- 2026-07-30 (TRO-226) — **Do not re-run the gate's CodeRabbit step once you have findings in hand.**
  G9 used to redirect the CLI straight over `.factory/coderabbit.json`, so a failed run replaced a
  completed review with its error stub: a 21-line file holding 10 findings became a 5-line
  `rate_limit` object. `gate.sh` now captures to a temp file and keeps the older findings when the
  new run produced none, reporting `KEPT n finding(s) from an earlier run`. Belt and braces though —
  **transcribe findings into your report as you triage them**, because the file is gitignored and has
  no history to recover from. Use `--skip-review` on re-runs.
- 2026-07-30 (TRO-226) — **`BASE_REF` is the local `main`, which lags `origin/main` at factory pace.**
  Local `main` is one shared ref across every worktree, and it sat three merges behind `origin/main`
  during a single session. Triple-dot diffs still resolve via merge-base, so a stale base is *quiet*
  rather than loud. `.factory-env` used to clobber a caller's override; it no longer does, so
  `FACTORY_BASE_REF=origin/main scripts/factory/gate.sh` now works when you need certainty.
- 2026-07-30 (TRO-224) — **A third load-sensitive api flake identity: `weeks.test.ts::should reject
  review approval without rating`** (joining `backlinks.test.ts` and `rate-limit.test.ts`). Same
  signature every time: fails inside a full gate run, then passes standalone — 41/41 for the file,
  472/472 for the suite. Three distinct identities is the evidence that this is one shared
  load-sensitive mechanism (TRO-277), not three flaky tests. Re-run standalone before believing it,
  and report the identity so the set keeps growing.
- 2026-07-30 (TRO-207, TRO-211) — **New load-flake identity, confirmed by two independent agents:**
  `web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx` — fails inside a loaded full run,
  passes standalone and on immediate re-run. Joins the rule-24 set (first *web* identity beyond the
  original five api ones plus the 2026-07-30 additions).
- 2026-07-30 (TRO-208, TRO-206) — **The stash rule keeps being violated at the same moment: A/B-testing a fix for red/green proof.** Two agents in one session ran `git stash` mid-task despite reading the rule; both caught themselves and recovered. The failure shape is always "I need the pre-fix code back for a minute." Do it with `git show HEAD:<path> > TRO-XXX-before.<ext>` or copy the files aside — decide HOW you'll do the before/after comparison *before* you start it, not at the moment you need the old code.
- 2026-07-30 (TRO-173) — **A tool improvement that is not committed protects nothing.** A G7b rule
  added to catch `: any` annotations sat uncommitted in the orchestrator's working tree, so every
  branch gating against `main` kept running the weaker checker. Found because an agent reconciled a
  contradiction — the orchestrator reported 2 violations, the agent's own run said `clean` — instead
  of assuming one side was wrong. **When two runs of the same check disagree, diff the checkers.**
