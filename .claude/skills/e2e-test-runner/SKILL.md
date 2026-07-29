---
name: e2e-test-runner
description: >-
  Run Ship's Playwright e2e suite without flooding the session — launch it in the background, poll
  `test-results/summary.json`, and read per-test failures from `test-results/errors/*.log` instead of
  from stdout. Use whenever running e2e tests, iterating on failures, or asked to "run the e2e
  tests". Never run `pnpm test:e2e` in the foreground: 600+ tests produce enough output to crash
  Claude Code.
---

# Running the e2e suite

**Never run `pnpm test:e2e` in the foreground.** The suite is 600+ tests across 71 spec files and
streaming its output has crashed the session. Everything below exists to keep the output out of your
context while still giving you the result.

The machinery is already in the repo: `e2e/progress-reporter.ts` is registered as a reporter in
`playwright.config.ts` for **both** CI and local runs, so it always writes progress files. You do
not need to add any flags to get them.

## The three output files

| File | Written by | Contains |
|---|---|---|
| `test-results/summary.json` | `progress-reporter.ts:35` | `{total, passed, failed, skipped, pending, ts}` — updated after every test |
| `test-results/progress.jsonl` | `progress-reporter.ts:31` | One JSON line per state change: `{test, title, status, ts, duration, error?}` |
| `test-results/errors/<file>__<title>.log` | `progress-reporter.ts` | Full message + stack for **one** failing test |

`summary.json` is initialized in `onBegin` with all tests `pending`, then read-modify-written per
test. `errors/` holds one file per failure, named `<spec>_<sanitized title>.log`, and the
`progress.jsonl` entry for a failure carries that filename in its `error` field.

## The loop

**1. Launch in the background.** Use the Bash tool with `run_in_background: true`, redirecting
output to a file you will not read in full:

```bash
pnpm test:e2e > test-results/run.log 2>&1
```

First run is slow before any test starts: `globalSetup` (`./e2e/global-setup.ts`) builds api and web
once for all workers.

**2. Poll the summary, not the log.**

```bash
scripts/watch-tests.sh --once     # renders passed/failed/pending + time since last update
```

That script reads `summary.json` with `jq`. Without `--once` it watches until completion — do not
use the watching form in an agent loop, it produces continuous output. Poll `--once` on an interval
instead.

A stalled `ts` with `pending > 0` means a worker died or a container is hanging, not that tests are
slow.

**3. Read only the failures.**

```bash
ls test-results/errors/                       # which tests failed
cat test-results/errors/<one-file>.log        # the actual error + stack
```

Never `cat` the whole directory. Read the specific failures you are working on.

**4. Iterate with `--last-failed`.**

```bash
pnpm exec playwright test --last-failed
```

Re-runs only what failed. Or scope to one spec while fixing it:

```bash
pnpm exec playwright test e2e/backlinks.spec.ts
```

`globalSetup` still runs for a single-spec invocation, so the fixed startup cost applies.

## Worker count — do not raise it

Each worker gets its own PostgreSQL **container**, API server, Vite **preview** server, and browser
(`e2e/fixtures/isolated-env.ts`). `playwright.config.ts` computes worker count from *free* memory at
startup, reserving 2GB, at ~500MB per worker, capped by CPU cores; CI is pinned to 4.

The file records why: **8 workers against `vite dev` caused a 90GB memory explosion and a system
crash.** That is why it uses `vite preview` now. `PLAYWRIGHT_WORKERS` overrides the calculation —
raising it on a loaded machine, or while several factory worktrees are running gates, re-creates the
conditions of that crash. Lowering it is always safe.

## Flake, not pass

`retries: process.env.CI ? 2 : 1`. **A test that fails then passes on retry is a flake, and the run
still reports green.** Check `progress.jsonl` for a test appearing with `failed` and later `passed`
before calling a run clean. Fix the synchronization, not the retry count.

## Writing or fixing specs

- **`e2e/AGENTS.md` is the authority on flakiness** — read it before writing a spec. No
  `waitForTimeout()` as synchronization, no `isVisible().catch(() => false)` silent skips, no
  point-in-time checks on async state. Use `e2e/fixtures/test-helpers.ts` rather than reinventing
  retry logic.
- **Empty tests pass silently.** A `test()` whose body is only a `// TODO` reports as passing — 68
  tests in this repo do exactly that (finding TEST-2), including the only stored-XSS and audit-log
  authorization checks. Use `test.fixme()`. `scripts/check-empty-tests.sh` runs pre-commit and
  catches them.
- **Seed data goes in `e2e/fixtures/isolated-env.ts`** (`seedMinimalTestData`). Never `test.skip()`
  because data is missing — assert with an actionable message. If a test needs N rows, seed N+2.
- **An e2e spec does not satisfy the factory gate's regression-test requirement.** Neither vitest
  config collects `e2e/`, so the gate counts it but never runs it. See `/ship-qa`.

## Reporting a result

Give the counts from `summary.json`, name any test that only passed on retry, and say if you scoped
the run (`--last-failed`, a single spec) rather than running the whole suite. "e2e passed" after a
one-spec run is a claim about one spec.
