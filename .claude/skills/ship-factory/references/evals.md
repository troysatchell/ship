# Evals: what proves a ticket is actually fixed

Two tiers, because they cost radically different amounts and answer different questions.

| | Tier 1 — Gate | Tier 2 — Compare |
|---|---|---|
| Question | *Did this break anything?* | *Did this measurably improve anything?* |
| Runs | every ticket, every attempt | once per category, after its tickets land |
| Cost | seconds to ~3 min | 15–90 min, some need a live app |
| Tool | `scripts/factory/gate.sh` | `/<category>-audit compare <label>` |
| Blocking | yes — a red gate is never merged | yes for graded categories |

Tier 1 alone is not enough. A rate-limiter ticket can pass every test and still not have moved
P95 latency. Measurable improvement is **40% of the grade**; Tier 2 is where that evidence comes
from.

## Tier 1 — the gate

`scripts/factory/gate.sh` inside the ticket worktree. Nine checks, all mechanical:

typecheck · build · api tests · web tests · tests-not-weakened · regression-test-present ·
CHANGES.md entry · scope · CodeRabbit capture.

The load-bearing one is the test comparison. It compares failure **identities** against
`audit/factory/quarantine.json`, not pass/fail counts — an agent that breaks one test while
fixing another leaves the totals unchanged, and a count-based check would wave it through.
(Verified 2026-07-29 against a forged run: totals held at 13 failing, the gate still failed and
named the new break.)

Output lands in `.factory/gate-result.json` and becomes the PR evidence block.

## Tier 2 — compare mode

Each category audit skill has a compare mode that re-measures against the `audit-baseline` tag
(`149873a`) under identical conditions and emits a delta. Invoke as
`/<category>-audit compare <label>`.

**Cheap enough to run per ticket:**

- `type-safety-audit` — static counts (`any`, `as`, `!`, `@ts-ignore`). Seconds.
- `bundle-audit` — production build + analyzer. A few minutes. Run on any BUN-* ticket.

**Batch per category — do not run per ticket:**

- `api-perf-audit` — needs the app running against a seeded database plus concurrent load.
- `db-query-audit` — needs statement logging enabled and each flow driven in a browser.
  **Must run after `api-perf-audit`, never concurrently** — the query logging it enables skews
  api-perf's timings. This ordering is a hard constraint from the audit conventions.
- `error-handling-audit` — probe suite, needs a live app.
- `a11y-audit` — Lighthouse + axe against authenticated pages. The runner scripts read
  `SESSION_ID` and `WIKI_DOC_ID` from the environment, so **compare runs need a fresh login**.
- `test-quality-audit` — flake detection needs the suite run repeatedly; expensive by nature.
- `terraform` — `validate` plus the local drift demo; no cloud credentials required.

### Conditions that must match the baseline or the delta is meaningless

- Same seed volumes (500 documents / 100 issues / 20 users per `audit/shipshape.config.yaml`).
- Same database engine. The baseline used `postgres:15-alpine` on the Docker pg at `:5433`.
- Same logging configuration, reverted afterwards.
- Steady-state numbers, not cold-start; note the cold number separately.
- **API-3 caveat:** gzip will not show a win on loopback. Measure payload size or use a shaped
  link, or the compression fix will read as no improvement.

State the configuration every measurement ran under. A number without its conditions is not
evidence — that is the third documented failure in `.claude/CLAUDE.md`.

## What a screen reader eval cannot be

A11Y-1 is the standing example. axe reported an ARIA-contract violation; the derived claim was
"announced incorrectly". A human running VoiceOver found the titles are **not announced at all** —
a worse defect than the automated tool implied.

So: automated a11y checks are Tier 2 evidence for *contrast, landmarks, names, and roles*. They
are **not** evidence about what a screen reader says. Any ticket claiming a screen-reader outcome
escalates to a human verification gate. See `escalation.md`.

## Feeding evals back — the self-improvement loop

The point of measuring is to change how the next agent is briefed. Three channels, in order of
how much they matter:

**1. Gate failures → `lessons.md`.** After each ticket, ask: *would a better brief have prevented
this gate failure?* If yes, add one specific rule to `lessons.md`, which is injected into every
subsequent agent brief. If no — the agent hit genuine difficulty — do not add a rule; noise there
degrades every future prompt.

**2. The scorecard → what to fix next.** Append one row per ticket attempt to
`audit/factory/scorecard.jsonl`:

```json
{"ticket":"TRO-178","attempt":1,"verdict":"fail","failedGates":["regression-test"],
 "crFindings":3,"crFixNow":1,"crNewTickets":1,"crDismissed":1,"ts":"2026-07-29T18:00:00Z"}
```

Read it in aggregate, not row by row. The signal is *which gate fails first, repeatedly*. Three
tickets in a row failing `changes-md` is a prompt defect, not three careless agents — fix the
brief. Gate-pass-on-first-attempt is the headline number: if it is climbing, the loop is learning.

**3. Underdelivery → a new ticket.** When a Tier 2 compare shows a fix landed but missed its
improvement target, that is not a failure to hide. File a follow-up ticket with the measured
shortfall and link it to the original. The report's target for each category is in
`audit/AUDIT_REPORT.md`.

## Do not game the gate

Two moves are forbidden outright, and the gate detects both:

- **Widening the quarantine.** Adding entries to `quarantine.json` makes a red suite green without
  fixing anything. Only removal is legitimate.
- **Weakening tests.** `.skip`, `.todo`, deleted assertions. The gate greps the diff for these.

If a ticket genuinely cannot be done without one of them, that is an escalation, not a judgement
call to make quietly.
