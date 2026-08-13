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
26. **A mock/spy your test installs must be restored even when an assertion fails, and by a
    mechanism that actually undoes what you did.** 2 findings across 2 tickets in one wave
    (TRO-230, TRO-210), both filed by CodeRabbit after `gate.sh` had already passed. Two distinct
    failure shapes, same root cause:
    - `vi.spyOn(...)` inside a test body, with `.mockRestore()` called as the **last line** of the
      test — if an assertion above it throws, restoration never runs and the spy leaks into later
      tests. Wrap the body in `try { ... } finally { spy.mockRestore(); }`, or move teardown to
      `afterEach` (which runs even when the test fails).
    - A **direct property assignment** (`global.fetch = ...`) "restored" via `vi.restoreAllMocks()`
      in `afterEach` — that call only reverts `vi.spyOn`/`vi.fn` mocks, never a raw assignment, so
      the replacement value survives into whatever runs next. Use `vi.stubGlobal(name, value)` to
      install it and `vi.unstubAllGlobals()` to remove it — the pairing that's actually reversible.

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
- 2026-08-03 (TRO-325/PR-A merge) — **`gh pr checks <n>` right after a push can report the PREVIOUS
  head commit's results, not the new one's.** Pushed an update, polled `gh pr checks 110` in a loop
  until every check showed non-pending, then ran `gh pr merge` — GitHub rejected it: "the base branch
  policy prohibits the merge." `gh pr view --json mergeStateStatus` said `BLOCKED`; direct check on
  the actual head SHA (`gh api .../commits/<headSha>/check-runs`) showed `typecheck · build · unit
  tests` still `in_progress` — a fresh run had started for the new push, but `gh pr checks` was still
  serving the prior commit's already-`success` result for that same check name, satisfying the
  polling loop's "no pending" condition on stale data. GitHub's own branch-protection check was what
  actually caught this, not the orchestrator. **After any push mid-PR, poll `gh api
  repos/.../commits/<exact-head-sha>/check-runs` (or at minimum confirm `headRefOid` in `gh pr view
  --json headRefOid` matches the SHA you just pushed) instead of trusting `gh pr checks` alone** —
  it's fine once the run has visibly re-triggered, but not to be trusted in the first few seconds
  after a push.
- 2026-08-04 (TRO-326/PR-B) — **After `git merge main` picks up a sibling bundle's new migrations,
  `pnpm install` is not enough — the worktree's OWN database needs `pnpm exec tsx
  src/db/migrate.ts` run against it too.** Merged PR-A's main (which added migrations 040/041) into
  PR-B's branch; `gate.sh` failed with `tests:api` — 0/2 passed standalone, confirmed real, not the
  load-flake class. Both failures were exactly PR-A's own new test files
  (`association-cycle-protection.test.ts`, `blocks-relationship.test.ts`), which the merge brought
  in as source but whose migrations had never touched *this* worktree's database — each worktree
  gets its own isolated database at provision time (`worktree.sh`), so a sibling bundle merging new
  migrations into `main` doesn't propagate to a database that already existed before that merge.
  Running `migrate.ts` (idempotent, only applies what's missing) fixed it immediately; `gate.sh` went
  from `fail` to `pass` with no code change. **Whenever a merge from `main` brings in files under
  `api/src/db/migrations/`, re-run migrate before re-trusting the gate** — `pnpm install` only
  refreshes `node_modules`, never touches a database.
- 2026-08-04 (TRO-319/FG-6) — **The `git stash` ban crossed this factory's own 3-recurrence bar
  (TRO-215, TRO-208/TRO-206, now TRO-319) without the mechanical check its own policy calls for ever
  getting built.** `review-patterns.mjs`'s header states the rule plainly — "once a rule has been
  stated and ignored three times, restating it louder is not the fix, a check is" — and it was
  followed for type-safety/sleep patterns (G7b) but not for this one, because a source-diff checker
  genuinely can't see a clean `stash push`+`pop`: the working tree, `git stash list`, and sometimes
  even `.git/logs/refs/stash` end up byte-identical to before. **Fixed with G7c**
  (`scripts/factory/gate.sh`): a `reference-transaction` git hook (`.husky/reference-transaction` —
  hooks in `.git/hooks/` are silently ignored in this repo, Husky owns `core.hooksPath`) logs every
  write to `refs/stash` to a file in the *common* git directory, which every worktree shares by
  construction — the same sharing that makes the underlying stash risk real in the first place.
  `gate.sh` compares that log's line count against a per-worktree baseline captured on its own first
  run and fails loudly if it grew. **Building the detector surfaced a live near-miss of the exact bug
  it exists to catch**: an early, careless test of it ran `git stash pop` unconditionally after a
  `push` that had silently failed (wrong pathspec for an untracked file), and it popped a real,
  unrelated stash entry sitting on the shared stack instead — producing a genuine merge conflict
  against unrelated files. Recovered cleanly (`git reset --hard`, verified the stray stash entry was
  undisturbed) before it touched anything committed. **Any future stash-adjacent tooling test must
  check `git stash list` count before AND immediately after `push`, and only pop by the exact ref it
  just created — never pop unconditionally.**
- 2026-08-04 (TRO-341/FG-23) — **`terraform apply` cannot update `render_web_service.agent` at all,
  for any field, on the free tier — a provider bug, not a config mistake.** Adding `maintenance_mode`
  to `agent_service.tf`'s `lifecycle.ignore_changes` (the fix that worked for the identical-looking
  `pull_request_previews_enabled` drift in `web_service.tf`) did not fix it: `ignore_changes` only
  suppresses what shows in the `terraform plan` *diff* — it does not stop the render-oss/render
  provider's `Update` call from unconditionally including `maintenance_mode` in its actual API
  request body, and Render's API rejects that field's mere presence for a free-tier service. Worked
  around by calling the Render REST API directly (`PUT /v1/services/{id}/env-vars/{key}`) instead of
  `terraform apply` for this resource. **Before attempting `terraform apply` against
  `render_web_service.agent` (or any other free-tier Render service), expect this failure and go
  straight to the REST API for a single-field change** — retrying `terraform apply` after tweaking
  `ignore_changes` just burns time re-discovering the same dead end.
- 2026-08-04 (TRO-341/FG-23) — **A merged PR is not a live deploy — the graded `ship` instance had
  not actually redeployed in 6 days despite `auto_deploy` being configured correctly, and no wave
  this sprint had ever checked.** PR-A (merged 2026-08-03 20:07) and PR-B (merged 2026-08-03 21:54)
  were both on `main`, CI green, `gh pr list --state open` clean — every signal this factory normally
  trusts said "shipped." The graded public instance was still serving a 2026-07-30 build the whole
  time; confirmed three independent ways (Render's own `/deploys` API, a stale `last-modified`
  header, `GET /api/change-feed` 404ing on a route that had been merged 3 days earlier). Root cause of
  why `auto_deploy` stopped firing is still not found — a manual `POST /v1/services/{id}/deploys` is
  the only remediation known to work. **Whenever a live graded/demo deployment exists and depends on
  a merge, verify the deploy actually happened (a route probe or a `last-modified` check) as a
  standard step after merging — "CI green and PR merged" proves the code is on `main`, not that
  anyone's environment is running it.** Same class of failure as the GitLab-CI-never-ran incident
  (2026-08-01): a trusted signal (CI, or a merged PR) covered less scope than it was read as
  covering.
- 2026-08-04 (TRO-341/FG-23) — **A seed fixture that depends on "the current sprint" decays as real
  time passes, even though the seed script itself is unchanged and re-running it is a no-op by
  design.** FG-3's Test Case 1 fixture (`seed.ts`) requires an engineer with ≥3 non-done issues in
  whatever sprint resolves as current *at the moment `pnpm db:seed` runs* — true against a freshly
  seeded database, and no longer true 6 days later against the same database re-seeded today, because
  "current sprint" moved but the underlying issue-to-sprint assignments (frozen since the original
  seed, since seeding is idempotent and skips existing rows) did not. Failed silently: no error, no
  log line, just an absent `✅ Test Case 1 fixture:` line a human has to notice is missing. **When
  re-running an idempotent seed against a database seeded on an earlier date, check the console output
  for every expected per-fixture success line by name — "seed complete" alone does not mean every
  fixture actually fired**, and a fixture whose precondition is date-relative needs that precondition
  re-verified, not assumed, on every re-seed.
- 2026-08-04 (orchestrator, this session) — **Opening a separate small PR per scorecard/bookkeeping
  entry taxes every real ticket PR landing at the same time.** This session opened 5 tiny
  bookkeeping-only PRs (#111, #114, #115, #116, #118) interleaved with 3 ticket PRs (#112, #113,
  #117); every one of those 3 hit `mergeStateStatus: BEHIND` and needed a `merge main` (twice, for
  two of them) purely because a bookkeeping PR had landed on `main` between pushes — the same
  `CHANGES.md`-cascade tax already documented for concurrent ticket branches, self-inflicted here by
  the orchestrator's own dispatch pattern rather than by parallel agents. **Batch scorecard/ledger
  rows and land them once per wave (or fold into the next real ticket PR already in flight) instead
  of opening a bookkeeping PR after every single ticket** — the entries are non-urgent, gitignored
  from CodeRabbit's attention either way, and batching removes rebase churn from the tickets that
  actually matter.
- 2026-08-04 (TRO-323/FG-10) — **The `git stash` ban was violated a 5th time (TRO-215,
  TRO-208/TRO-206, TRO-319, now TRO-323) — this time with the FULL rule, reasoning, and G7c's own
  existence stated verbatim in the dispatched agent's brief.** Restating the rule, even maximally,
  has now empirically failed as a deterrent for this category of agent behavior — the actual fix was
  always going to be mechanical (G7c), and it worked exactly as designed: caught 2 real `refs/stash`
  writes (`push tmp/823f...`-style before/after comparisons on `agent/src/{server,index}.ts`, then
  `api/src/routes/agent.ts` tests) via `.git/factory-stash-activity.log`, and G7c's baseline
  mechanism means `stash-guard` now reports `fail` **permanently** for worktree `Ship-wt-tro_328`
  — re-running `gate.sh` does not clear it, because the baseline is captured once, at that
  worktree's first-ever gate run, and the log only grows.
  **What was verified before treating this as non-blocking:** `git worktree list` showed no sibling
  worktree existed concurrently (this run was solo — the actual data-loss risk the ban exists to
  prevent could not have materialized this time); `git stash list` showed only a pre-existing,
  untouched, days-old entry (`tro215-fix-temp`) — nothing from this incident is currently stashed,
  both push/pop pairs cleanly resolved. The agent disclosed this itself in `CHANGES.md`, unprompted,
  including naming the sanctioned alternative it should have used instead (`git show HEAD:<path>`
  or copy-aside) — a real example of this repo's own provenance culture working even when the
  underlying action was banned.
  **Decision, orchestrator-made:** do NOT reset the per-worktree `.factory/stash-baseline-lines`
  file to force a fresh "pass" — that would quietly erase the only durable evidence (gitignored,
  worktree-local) that this happened, which is the opposite of "surface, don't hide." Instead:
  `stash-guard: fail` stays in every future `gate.sh` run for this worktree's remaining life,
  treated the same as this factory's other documented gate-check overrides (TRO-233's
  `tests:not-weakened`, terraform tickets' `regression-test`) — an explicit, reasoned exception
  recorded at the merge decision, not a silently green gate. Any future PR/merge for bundle TRO-328
  must restate this reasoning rather than reporting `gate.sh: pass` unqualified.
  **Not yet tried: blocking the command itself.** Every fix so far (repeated warnings, then G7c's
  after-the-fact detection) has been reactive. A `git` alias or wrapper script that refuses `stash
  push`/`pop` inside a path matching `Ship-wt-*` would prevent the write instead of merely detecting
  it — worth proposing as a follow-up ticket rather than another lessons.md restatement, since this
  file has now tried restatement five times.
- 2026-08-05 (TRO-329/PR-E, orchestrator) — **`gate.sh` itself is a snapshot taken at worktree
  provisioning time — a sibling bundle's own edits to `gate.sh` (not just to application code) do
  not reach a worktree provisioned before that edit landed on `main`.** TRO-322 (bundle TRO-330,
  provisioned first) added a `tests:agent` check running `pnpm --filter @ship/agent test`. TRO-329
  (this bundle) was provisioned earlier and never picked it up, because that change was a commit on
  TRO-330's own branch, not yet on `main`. The orchestrator ran `gate.sh` on TRO-329's worktree after
  TRO-335/TRO-336 added `agent/src/__tests__/{retroDraft,planChangeDraft}.test.ts` and the gate
  reported `verdict: pass` — genuinely, on every check it ran — but **the new agent tests were never
  executed**, only counted by the static `regression-test` grep. Caught only because the orchestrator
  independently ran `pnpm --filter @ship/agent test` by hand rather than trusting the gate's own
  green verdict at face value; it happened to also pass (381/381), but the gate could not have told
  either way. Same failure shape as the documented e2e-spec-vs-vitest-config gap (`ship-qa` SKILL,
  "gate's regression-test check can be satisfied by a test the gate never runs") — this is that same
  class one layer up: **the gate's own coverage of packages, not just of file patterns, can silently
  fall behind a sibling branch's own gate.sh edits.** When a package's test suite is new to `gate.sh`
  (agent tests were, this run), independently run that package's test command by hand in every
  sibling worktree provisioned before the `gate.sh` change reached `main` — do not trust "pass" to
  mean a check that didn't exist yet in that worktree's copy of the script.
- 2026-08-05 (TRO-329/PR-E, orchestrator) — **Two more load-flake identities, joining the rule-24
  set, both surfacing while 3 sibling worktrees ran gate.sh/tests concurrently:**
  `api/src/routes/search.test.ts` (whole-file failure, one run) and
  `api/src/routes/documents.test.ts`'s two "moves plan_approval/review_approval back to
  changed_since_approved" cases (a different run). Both passed standalone per `gate.sh`'s own
  re-run; the `documents.test.ts` pair's actual error — `TypeError: Invalid value "undefined" for
  header "x-csrf-token"` — is a test-setup race (a CSRF-token fetch not settled before the next
  request fired), not a `changed_since_approved` assertion failure, despite that being the exact
  transition TRO-336 was reading in the same PR — worth naming explicitly because content-adjacency
  to your own branch's change is a real reason to look closer, not a reason to assume it's real
  without checking. Confirmed non-blocking by reading the actual stack trace, not just trusting
  "passed standalone."

- 2026-08-08 (TRO-366/W5-DOC, orchestrator) — **`git stash` violated a 6th time (TRO-215,
  TRO-208/TRO-206, TRO-319, TRO-323, now TRO-366), and this one had no mitigating circumstance.**
  TRO-323's write was verified as a solo run, so the cross-worktree risk could not have materialized.
  This time **two sibling agents were working concurrently** (`Ship-wt-tro_367`, `Ship-wt-tro_371`)
  when the push landed at `00:30:10Z`, with an unrelated pre-existing entry (`tro215-fix-temp`)
  sitting on the shared stack. The window was live; it just wasn't hit. Same trigger as always —
  wanting the pre-change tree back to compare timings — and the agent self-disclosed, popped by exact
  ref, and verified. Confirmed afterwards: tro_366's tree clean, all 4 review commits intact, the
  sibling's stash untouched. **Per TRO-323's precedent, `.factory/stash-baseline-lines` was NOT reset**
  — `stash-guard: fail` stays permanent for that worktree as the durable evidence, and the merge
  decision restates the reasoning rather than reporting an unqualified pass. Prevention is now filed
  as **TRO-378** (a `git` wrapper refusing `stash` under `Ship-wt-*`); restatement has failed six
  times and is not going to start working on the seventh.
27. **An automation that acts on a signal must distinguish "the thing failed" from "I could not
    observe the thing." 3 findings across 2 tickets in one wave, all Major, all on the
    automatic-rollback path (TRO-367, TRO-368).** The dominant shape: a monitoring result and an
    application result share one representation, so the actuator cannot tell them apart.
    - `pollReadiness` recorded a *thrown fetch* as `ready: false`, so three network failures between
      the runner and the service read as a sustained application failure — meaning a DNS blip would
      have **rolled back a healthy production service.** The automation would have caused the outage
      it exists to prevent. Give observation failures their own non-actionable outcome.
    - The same script's production fetcher had **no timeout**, so a stalled readiness probe never
      returned — on the very branch whose sibling ticket (TRO-368) existed because an outbound call
      had no explicit timeout. A rule fixed in one file is not fixed in the codebase.
    - A per-attempt timeout is not a budget. 20s × (1 + 2 retries) + backoff silently exceeded the
      caller's own handler deadline, so the "explicit timeout" still let work outlive its requester.
      **State the arithmetic next to the constants**, against the deadline it must fit inside.
    Before shipping anything that acts automatically, ask: *what does this do when it cannot see?*
    "It assumes the worst and takes the corrective action" is the wrong answer whenever the
    corrective action is itself disruptive.
- 2026-08-08 (TRO-367/W5-CI, orchestrator) — **New load-flake identity, and this one appeared with NO
  sibling gate running:** `api/src/collaboration/__tests__/session-revocation.test.ts::does not persist
  document writes attempted after the session is revoked`. Failed inside a full `gate.sh` run, passed
  standalone, then passed again on a full re-run with no code change. What makes it worth recording
  separately from the rest of the rule-24 set: the branch it failed on **changes zero `api/` files**
  (it touches only `agent/`, `.github/`, `.gitlab-ci.yml`, `CHANGES.md`, `FLEETGRAPH.MD`), so the diff
  could not causally reach that test — and gates were being run strictly serially, so the documented
  "sibling worktree under load" explanation did not apply either. A websocket/session-revocation timing
  test is inherently the most load-sensitive shape in this suite; single-gate load appears to be
  sufficient on its own. **Check `git diff --name-only main...HEAD` for the failing test's package
  before spending time on a suspected regression** — a failure in a package the branch never touched is
  strong evidence of the flake class, and it is a much faster discriminator than re-running.
- 2026-08-08 (TRO-371/W5-CHG, orchestrator) — **A ticket's measured counts can be wrong by an order of
  magnitude when they came from a warning-only detector.** TRO-371 asserted "13 CHANGES.md entries have
  no rollback instructions" and named 14 tickets; the real count was **1**, and the one real gap was not
  on the list. All 14 named entries already had rollback sections under `**Roll back.**` /
  `**Rollback.**` — phrasings `merge-changes.mjs`'s `RUN_RE` does not match. That tool's own header says
  it warns rather than fails *because* its regex false-positives; the defect was a sweep treating its
  output as a count. An agent following the ticket faithfully would have churned 12 healthy entries.
  **When a ticket states a count, have the agent re-derive it from the file before acting on it, and
  treat a large discrepancy as information rather than an obstacle** — here it made the work smaller,
  not larger, which is why it was completed rather than escalated. Filed as TRO-372.
- 2026-08-08 (wave preflight, orchestrator) — **`ship-audit-pg` is gone; the live container is
  `ship-postgres-1`.** `ship-audit-pg` is `Exited (255)` and `ship-postgres-1` now holds
  `0.0.0.0:5433->5432`. `worktree.sh` still defaults `FACTORY_PG_CONTAINER=ship-audit-pg` and will fail
  provisioning until that default is fixed — pass `FACTORY_PG_CONTAINER=ship-postgres-1` explicitly.
  Credentials, port, and `DATABASE_URL` shape are unchanged, so `gate.sh` and the test suites are
  unaffected once the worktree exists; only provisioning breaks.

- 2026-08-11 (TRO-430/PR #179, orchestrator) — **A duplicate implementation of a hardened rule
  escapes the hardening.** `e2e/fixtures/isolated-env.ts` carried its own fake migration runner
  (marked migrations applied, never executed them) — DB-1's exact failure mode, reintroduced in a
  copy after the original was fixed. Every fixture DB silently lacked `api_tokens.scopes` until CI
  caught it. When fixing any rule-class bug, `grep` for other implementations of the same mechanism
  before declaring it fixed — the second copy is where the bug survives.
- 2026-08-12 (TRO-412/PR #183, orchestrator) — **An e2e spec that has never actually run proves
  nothing, and its first real run finds the environment as often as the code.** The oauth-authorize
  spec's first-ever execution surfaced 4 stacked defects, none in the API: missing
  `response_type=code` in the spec's own URLs; a callback assertion built on `page.route`
  interception that never fires for server-redirect navigations (use a same-site redirect_uri and
  assert on `page.url()` instead); the fixture spawning the API with `CORS_ORIGIN='*'`, which the
  oauth router uses as a URL base (`new URL(path,'*')` throws); and the vite preview proxy missing
  `/oauth` — where the fix had to be `/oauth/` with a trailing slash, because Vite proxy keys are
  bare `startsWith` prefixes and `/oauth` would hijack the SPA's own `/oauth-consent` route. When a
  PR ships a spec that CI does not execute, run it once locally before merge — "compiles and is
  well-shaped" is not evidence.
- 2026-08-12 (TRO-495 verification, orchestrator) — **`pnpm --filter @ship/api test -- <path>` does
  NOT scope to the path — it runs the FULL api suite.** pnpm forwards the script as
  `vitest run -- <path>` and the literal `--` defeats vitest's path-filter parsing. A verifier
  following a brief that suggested this exact form ran 92 files / 975 tests when it meant to run
  one file — contained only because the worktree DB was exclusive; against a shared DATABASE_URL
  this is the TRUNCATE hazard with extra steps. Targeted runs: `cd api && npx vitest run <path>`
  or `pnpm --filter @ship/api exec vitest run <path>`. Never put the `test -- <path>` form in a
  brief.

## Concurrency

24. **Never run two `gate.sh` invocations concurrently against the same Postgres container.**
    Observed 2026-08-08 during the W4-sweep run: with three worktrees active, one gate's api suite
    failed broadly (75, then 68 of ~77 files) on Postgres connection errors while a sibling gate
    ran — root-caused via `ps aux` to the shared `ship-postgres-1` container being interrupted, not
    to any code change. Per-ticket *databases* isolate data; they do not isolate the container
    itself. Serialize gate runs, or accept that a broad connection-error failure under concurrency
    is an environment artifact and must be re-run alone before it is believed. The same run also
    produced `coderabbit rc=1` on two branches, matching the documented concurrent-load pattern.

25. **A test whose outcome depends on the host environment is not a test of the code.**
    Two instances landed within three commits of each other on 2026-08-08. (a)
    `migrationRunner.test.ts` compared a Postgres-ordered query against a JS `.sort()` — it failed
    on any database whose collation disagrees with JS, and passed on others, while the migrations
    were fine either way. (b) The fix's own new `postgresReachable.test.ts` asserted a probe of
    `127.0.0.1:5432` returns `false` "because nothing is expected to be listening" — true locally
    (Postgres mapped to 5433), false in CI (Actions runs Postgres on 5432). **`gate.sh` cannot
    catch this class**: it passed both times, because it ran in the environment the assumption held
    in. Only CI, running somewhere different, caught the second one. When a test's comment has to
    state an environmental assumption to justify the assertion, that is the signal — assert on the
    pure logic (the resolved port, the parsed value) or use a resource you can guarantee (loopback
    port 1), never on what happens to be listening or on how a server happens to collate.

26. **Write docs and comments in the tense of what your tests exercised — never state a future
    ticket's behavior as present fact.** The single largest finding class of W6 wave 1: 17 findings
    across four tickets in one review round (TRO-396 ×4, TRO-420 ×6, TRO-433 ×5, TRO-424 ×2), every
    one the same shape — confident prose the code or facts contradicted. "The legacy limiters are
    exempted" (PF-004 hadn't landed); "the public API is bearer-authenticated" (PF-107 didn't
    exist); a code comment asserting "no double-CORS collision to reason about" while unmatched
    paths reproducibly collided; "verify() never throws" (a throwing injected clock propagates); a
    memo lede guaranteeing every claim was provenance-marked while §3-4 weren't. This is
    CLAUDE.md's A11Y-1 unmarked-inference failure wearing prose clothes, and it recurred on both
    docs tickets AND code tickets' READMEs/CHANGES.md. Rules: (a) future behavior is written as
    "will X, once PF-### lands"; (b) absolutes ("never", "every", "all") require either a test that
    proves them or an explicit derived-mark; (c) after any fix pass, re-read the surrounding prose
    you did NOT edit — three of four locally-fixed findings on TRO-420 left or introduced a
    neighboring overclaim the second review caught. NOTE: this class crossed the 3-ticket
    mechanical-check threshold, but a grep for overclaiming prose is not reliably mechanizable —
    recorded here at maximum strength instead, and reviewers/triage agents are told to hunt for it
    specifically.

27. **A test proves exactly what would fail if the code regressed — check the negative space
    before claiming an AC.** Three tickets in W6 wave 2 shipped tests that proved less than their
    AC sentence claimed: a 601-request run "proving both limiters exempt /v1" that structurally
    cannot trip the 6,000-cap source-IP limiter (TRO-401); a boundary-lint test covering
    `**/routes/**` but not the bare `**/routes` import form (TRO-399); a constructor suite
    asserting the error body shape but never `httpStatus`, so four wrong status mappings would
    pass silently (TRO-397). None were dishonest — each was the obvious test written forward from
    the happy path. The check that catches this class: for each AC clause, name the specific
    regression that would make THIS test fail; a clause with no such regression is unproven, and
    either the test grows or the PR's "Not verified" line says so explicitly. Builders: run this
    check before writing the CHANGES entry. Reviewers/triage agents: hunt for it specifically —
    it was CodeRabbit's highest-value finding class this wave.
