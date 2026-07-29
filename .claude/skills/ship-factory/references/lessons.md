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
- 2026-07-29 (TRO-178) — **The api suite has a pre-existing, load-sensitive intermittent failure, and
  `quarantine.json` records api as `knownFailing: 0`.** A flake therefore fails an otherwise-good
  branch. Demonstrated not to be any one ticket's fault: with the ticket's new test file removed
  entirely, 1 of 5 runs still failed. It appears right after `pnpm type-check` + `pnpm build`, i.e.
  under CPU load. **If a gate fails on an api test you did not touch, re-run it standalone before
  believing it** — and never "fix" it by widening the quarantine. Report the identities either way.
- 2026-07-29 (TRO-215) — **Some findings are data-dependent; reproduce before you conclude.**
  A11Y-1's bare-`<li>` violations only render when a sidebar section has **>10** root docs (the
  "N more…" link) or **zero** (empty state). Default seed data has 5, so axe reports **C0/S0** and a
  re-measurement on stock seed would wrongly conclude the finding never existed. Check the data
  precondition before reporting a finding as unreproducible.
