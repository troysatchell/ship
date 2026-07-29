---
name: ship-qa
description: >-
  QA and test-engineering brief for Ship — which suite runs where, where a regression test has to
  live for the factory gate to actually execute it, red-before-green discipline, the silent
  empty-test footgun, quarantine semantics, seed-data rules, and flake-versus-failure judgement.
  Use when writing or fixing tests, when a ticket is a TEST-* finding, when a gate fails on tests,
  or as the role brief injected into a factory agent whose deliverable is test coverage.
---

# Ship QA

The factory's definition of done requires a regression test that **fails before the fix and passes
after**. This skill is about making that claim true rather than merely satisfying the check that
looks for it.

## Three test tiers, and only two of them run in the gate

| Tier | Command | Files | Run by `gate.sh`? |
|---|---|---|---|
| api unit/integration | `pnpm --filter @ship/api test` | `api/src/**/*.test.ts` | **yes** |
| web unit/component | `pnpm --filter @ship/web test` | `web/src/**/*.test.ts?(x)` | **yes** |
| e2e | `playwright test` (via `/e2e-test-runner`) | `e2e/*.spec.ts` | **no** |

`pnpm test` at the repo root is `--filter @ship/api` only. "Tests pass" without naming the filter
is an unverified claim about web.

### The gap you must not fall into

`scripts/factory/gate.sh:171-181` counts **added test cases** in `*.test.ts`, `*.test.tsx`, and
`*.spec.ts`. That pathspec matches `e2e/*.spec.ts`. But the gate's actual test execution is only
the two vitest projects, and neither includes `e2e/` — `api/vitest.config.ts` pins
`include: ['src/**/*.test.ts']`, and `web`'s config resolves from `web/`.

So: **a regression test added only as an e2e spec passes the gate's regression-test check while
never being executed by the gate.**

Provenance, 2026-07-29. **Observed:** `git ls-files -- '*.spec.ts'` — the gate's exact pathspec —
matches all 71 files in `e2e/`; `api/vitest.config.ts:7` pins `include: ['src/**/*.test.ts']`;
`web/vitest.config.ts` declares no `include`, so it uses vitest defaults rooted at its own
directory and cannot reach `../e2e`. **Not verified:** an end-to-end demonstration — no branch was
built that adds only an e2e test and then passes a full gate run.

Rule: **the regression test for a fix goes in a vitest file the gate runs.** Add an e2e spec too
when the defect is a user flow — but it is additive coverage, never the proof.

## Red before green — for the right reason

A test you never saw fail proves nothing, and a test that fails for the wrong reason proves less
than nothing because it looks like proof.

1. Write the test. Run it **on the unfixed code**.
2. Read the failure. An `AssertionError` on the behaviour you're claiming is a red test. A
   `ReferenceError`, an import failure, a typo in a locator, a timeout because nothing rendered —
   those are broken tests, not red ones.
3. Apply the fix. Re-run. It must pass **and** the rest of the file must still pass.
4. In your report, state that you saw it red first and what the failure message was.

## Empty tests pass silently

A `test()` whose body is only a `// TODO` comment reports as passing. **68 e2e tests in this repo do
exactly that** (finding TEST-2) — including the only stored-XSS check and the only audit-log
authorization check. The suite advertised coverage it did not have.

- Use `test.fixme('...', async () => { ... })` for anything unimplemented. It reports as skipped,
  which is honest.
- `scripts/check-empty-tests.sh` runs pre-commit and fails on empty bodies, excluding
  `test.fixme`/`test.skip`/`test.todo`. It parses `e2e/*.spec.ts` with awk looking for bodies with
  no `expect()` or `page.` calls.
- The same failure mode exists in vitest files, where the hook does not check. A test with no
  `expect` is not a test.

## Assertion quality

The audit spot-checked 10 tests and found assertion quality to be the weak spot, not test count.
Two rules that came out of it:

- **Assert on the behaviour, not on the absence of a crash.** `expect(res.status).toBe(200)` after
  a mutation says nothing about whether the mutation happened. Read the row back.
- **Never widen an assertion to make a test pass.** Deleting an `expect`, loosening a matcher to
  `toBeDefined()`, or wrapping in `try/catch` is weakening the suite. `gate.sh:148-170` greps your
  diff for removed `it(`/`test(`/`expect(` lines and newly added `.skip(`/`.todo(`, and fails the
  branch.
- **`.fixme(` is deliberately *not* forbidden by that gate** — the repo *requires* `test.fixme()` for
  unimplemented tests, so banning it would make the rules unsatisfiable. `.skip`/`.todo` disable a
  test that was running; `.fixme` marks one that never ran. Different acts.

## Quarantine semantics

`audit/factory/quarantine.json` records known-failing tests **by identity** (`file::test name`),
not by count: api is 451/451 green, web has 13 failures (TEST-1 / TRO-223).

- The gate materializes the baseline from `BASE_REF`, **never from the branch under test**
  (`gate.sh:68-77`), so appending your own new failures to the file cannot buy a pass.
- Identity comparison is the point: an agent that fixes one test and breaks another leaves the
  totals at 13, and a count-based check would wave it through. Verified against a forged report on
  2026-07-29 — totals held, the gate still failed and named the new break.
- **Removing** an entry because you genuinely fixed the test is legitimate and the gate reports it
  as `fixed`. Adding an entry is gaming, and it is an escalation if you think you need to.

## e2e specifics

**Never run `pnpm test:e2e` in the foreground.** 600+ tests produce enough output to crash the
session. Use **`/e2e-test-runner`**, which has the full procedure. The short version:

- Run in the **background**, output redirected to a file — never streamed.
- Poll `test-results/summary.json`, written live by `e2e/progress-reporter.ts:35` (registered as a
  reporter in `playwright.config.ts` for both CI and local). `scripts/watch-tests.sh --once` renders
  it.
- Read failures from `test-results/errors/*.log`, one file per failing test — not from stdout.
- Iterate with `playwright test --last-failed` rather than re-running the suite.

**Flakiness patterns are already documented** in `e2e/AGENTS.md` — read it before writing a spec.
The short version: no `waitForTimeout()` as synchronization, no `isVisible().catch(() => false)`
silent skips, no point-in-time checks on async state. Use the helpers in
`e2e/fixtures/test-helpers.ts` rather than reinventing retry logic.

**Isolation:** each Playwright worker gets its own Postgres container, API server, and Vite
**preview** server (`playwright.config.ts`). Worker count is computed from free memory — history in
that file records that 8 workers against `vite dev` caused a 90GB memory explosion and a system
crash. Do not raise `PLAYWRIGHT_WORKERS` past the computed value on a loaded machine.

**Seed data — assert, never skip.** When a test needs data:

1. Add it to `e2e/fixtures/isolated-env.ts` (`seedMinimalTestData`). That is the only sanctioned
   place.
2. Never `test.skip()` because data is missing — that is a silent pass. Assert with an actionable
   message:
   ```typescript
   expect(rowCount, 'Seed data should provide at least 4 issues. Run: pnpm db:seed')
     .toBeGreaterThanOrEqual(4);
   ```
3. If a test needs N rows, seed N+2.

## Flake versus failure

`playwright.config.ts` sets `retries: process.env.CI ? 2 : 1`. A test that fails then passes on
retry is **a flake, not a pass** — the run is green and the defect is still there.

- Distinguish them before reporting: re-run the single spec 3× against unchanged code. Consistent
  failure is a defect; intermittent is a flake.
- A flake you fix by adding a retry is not fixed. Fix the synchronization.
- Flake detection is Tier 2 (`/test-quality-audit compare <label>`) and expensive by nature — it
  needs the suite run repeatedly. Batch it per category, don't run it per ticket.

## The api test-database hazard

`api/src/test/setup.ts` `TRUNCATE`s 16 tables in the `beforeAll` of **every** api test file. This is
the single most destructive footgun in the repo.

- `source .factory-env` before running anything in a worktree.
- Never run api tests against a database you care about. The gate refuses a `DATABASE_URL` that
  does not look factory-owned (`gate.sh:51-57`); apply the same caution by hand.
- `fileParallelism: false` in `api/vitest.config.ts` exists because of this truncation. Leave it.

## Reporting a test claim

- Name the **command with its filter**, not "the tests".
- Say **which tier** ran. "Green" after api-only is not green.
- If a test passed only on retry, say so.
- If you could not run something, say what and why — a skipped tier reported as silence reads as a
  pass.
