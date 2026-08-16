# TRO-440 / PF-704 — Cost-ledger before/after: the Epic 7 rewire vs. LLM token volume

**AC (PLUGFORGE.MD §4, verbatim):** "cost-ledger before/after shows unchanged token volume (feeds PF-905)."

## The claim, corrected — CodeRabbit caught a real overstatement in an earlier draft

An earlier version of this doc claimed the rewire was "architecturally inert" with respect to
token volume, based on `AGENT_PLATFORM_MODE`/`agentPlatformMode` never appearing in
`agent/src/graph.ts`. That grep observation is real, but the conclusion drawn from it was too
strong — **traced further, this session, and it does not hold in general:**

**Observed, by direct inspection:** `grep -rl --exclude-dir='__tests__' --exclude='*.test.ts' --exclude='*.spec.ts' 'AGENT_PLATFORM_MODE\|agentPlatformMode' agent/src`
returns exactly three files — `agent/src/config.ts` (parses the flag), `agent/src/shipClient.ts`
(routes HTTP calls to Ship's own API through `@ship/sdk` vs. the internal client),
`agent/src/index.ts` (wires which client gets constructed at boot). Zero hits in `agent/src/graph.ts`
— true, and it is true that no code in `graph.ts` branches on the flag directly.

**But the flag doesn't need to appear in `graph.ts` to affect token volume — it only needs to change
the DATA `graph.ts` feeds into a prompt.** Traced one concrete path: `buildExpansionPrompt()`
(`agent/src/expansion.ts:444`) builds its prompt text from `ExpandedDocument.textSnippet`, and
`textSnippet: extractPlainText(doc.content)` (`expansion.ts:385`) derives directly from
`getDocument()`'s `content` field. `shipClientParity.liveServer.test.ts`'s own module docstring
documents that `content` is one of the fields that **cannot** carry over between `internal` and
`sdk` mode (absent from v1's response). So for the `on_demand` trigger (question-answering via
document expansion), the prompt text — and therefore token count — **can genuinely differ between
modes**, through a real, traced data-flow path, not a hypothetical one.

The other four prompt builders (`buildStandupPrompt`, `buildBlockerEscalationPrompt`,
`buildRetroPrompt`, `buildPlanChangePrompt`) build from aggregated summary objects
(`standupActivity`, `blockerFanoutImpact`, `weekDeliverySummary`, `planChangeSummary`) rather than
raw per-document content strings — plausibly less exposed to the same field-drift, but **this pass
did not trace each one's field usage individually**, so that is a plausible read, not a checked one.
Stating the boundary of what was actually verified rather than extending the one confirmed trace to
cover all five builders.

## The ledger itself

`agent/cost-ledger-snapshot.jsonl` (committed, TRO-373) — 7 real recorded invocations,
2026-08-05 through 2026-08-07, **entirely before** the W6/PlugForge Epic 7 work began
(PF-700 through PF-704, Linear timestamps start 2026-08-10). Real output, this session,
read-only:

```text
$ pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl

--- FleetGraph cost report (TRO-339 / FG-21) ---
Ledger: cost-ledger-snapshot.jsonl

Development spend to date (recorded, not estimated):
  Invocations:        7
  Input tokens:       1860
  Output tokens:      839
  Total spend:        $0.006055

Measured cost per graph run, per tier:
  composeAnswer:
    invocations: 6
    cost/run:    $0.000876
    avg documents pulled: 6.50
  composeStandupDraft:
    invocations: 1
    cost/run:    $0.000798

Runs per day, observed:
  2026-08-07: 1
  2026-08-05: 6
```

**"Before" and "after" are the same number** — no new rows have been appended to the ledger by any
Epic 7 work. What this *does* honestly establish: the rewire has not been exercised against the LLM
path with real traffic yet (consistent with `AGENT_PLATFORM_MODE` defaulting to `internal` in
production — see `agent/src/config.ts:343`). It does **not**, on its own, establish that a real
`sdk`-mode run would produce the identical token count as an `internal`-mode run of the same
workload, given the traced `content`-field data-flow difference above.

## What this doc does not claim (revised)

This is not a live A/B comparison of two full agent sessions run under each mode, and — after the
correction above — it is also not a completed structural proof that the two modes are
token-equivalent. What is actually established:

1. **Transport-level:** the flag changes only which HTTP client makes Ship-API calls
   (`/api/*` vs. `/api/v1/*`) — confirmed by grep, not touching `graph.ts` directly.
2. **One real, traced exception:** the `on_demand`/expansion path's prompt text depends on
   `getDocument()`'s `content` field, which is not carried over in `sdk` mode — so token volume
   for that trigger specifically can differ between modes, and this doc does not know by how much.
3. **Not yet measured:** a live, matched-workload run of both modes through the same trigger paths,
   which would give a real number instead of a structural argument either way.

**Recommended for PF-905:** run the same question-answering workload through both modes and diff
the resulting ledger entries for the `on_demand` trigger specifically — that is the one path this
session traced as genuinely exposed. The other four triggers' prompt builders were not individually
traced and may or may not need the same treatment.

## Feeds PF-905 (TRO-434)

PF-905's own AC needs: (1) this delta — the honest version above, not the discarded "architecturally
inert" claim; (2) TTFE CI minutes; (3) Playwright OAuth compute; (4) spec-gen overhead; (5)
delivery-log storage growth; (6) production cost projections at 100/1k/10k/100k users. Items 2–6 are
out of this ticket's scope (PF-704 owns only item 1) and remain for PF-905 to produce — and per the
correction above, item 1 itself is now "here's the exact real gap to measure," not "already closed."
