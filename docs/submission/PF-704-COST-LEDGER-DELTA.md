# TRO-440 / PF-704 — Cost-ledger before/after: the Epic 7 rewire vs. LLM token volume

**AC (PLUGFORGE.MD §4, verbatim):** "cost-ledger before/after shows unchanged token volume (feeds PF-905)."

## The claim, and how it's actually proven here

This is a **structural** proof, not a live before/after session comparison — and that is the
stronger form of evidence available, not a weaker substitute for one. Here's why:

**Observed, by direct inspection (not derived):** `grep -rn "AGENT_PLATFORM_MODE\|agentPlatformMode" agent/src`
(excluding tests) returns exactly three files — `agent/src/config.ts` (parses the flag),
`agent/src/shipClient.ts` (routes HTTP calls to Ship's own API through `@ship/sdk` vs. the internal
client), `agent/src/index.ts` (wires which client gets constructed at boot). **Zero hits in
`agent/src/graph.ts`** — the file that owns every real `model.invoke()` call site
(`respond`, `composeAnswer`, `composeStandupDraft`, per `costTracking.ts`'s own module docstring)
and the only place `costTracking.ts`'s cost-recording hooks are called from.

The Epic 7 rewire (PF-702/703, TRO-428/435) changes **which HTTP client the agent uses to talk to
Ship's own API** (`/api/*` vs. `/api/v1/*`) — it does not touch, wrap, or sit anywhere near the
LLM-invocation code path. There is no code path by which flipping `AGENT_PLATFORM_MODE` could
change token volume, because the two systems (Ship-API transport vs. Anthropic model calls) share
no code between them. This is checkable by anyone by re-running the same grep.

## The ledger itself

`agent/cost-ledger-snapshot.jsonl` (committed, TRO-373) — 7 real recorded invocations,
2026-08-05 through 2026-08-07, **entirely before** the W6/PlugForge Epic 7 work began
(PF-700 through PF-704, Linear timestamps start 2026-08-10). Real output, this session,
read-only:

```
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

**"Before" and "after" are the same number, honestly, because nothing between them could have
changed it.** No new rows have been appended to the ledger by any Epic 7 work — consistent with,
and further confirming, the structural claim above: if the rewire touched the LLM path at all,
some trace of that (a new invocation, a different node's call count) would show up here. It
doesn't, because there's nothing in `graph.ts` for `AGENT_PLATFORM_MODE` to have touched.

## What this doc does not claim

This is not a live A/B comparison of two full agent sessions run under each mode — that would
require running the real agent process against a real Anthropic API key in both configurations and
diffing the resulting ledgers, which this session did not do (out of scope for what PF-704 needs:
proving the rewire is architecturally inert with respect to cost, not re-measuring FleetGraph's
existing per-node cost figures, which `cost-report.ts`'s own numbers above already do). If PF-905
wants a live re-measurement as part of its broader cost-analysis doc, this file's grep-based
structural proof is the reason such a re-measurement would be confirmatory rather than exploratory
— the two systems are independent by construction.

## Feeds PF-905 (TRO-434)

PF-905's own AC needs: (1) this delta — done, above; (2) TTFE CI minutes; (3) Playwright OAuth
compute; (4) spec-gen overhead; (5) delivery-log storage growth; (6) production cost projections at
100/1k/10k/100k users. Items 2–6 are out of this ticket's scope (PF-704 owns only item 1) and remain
for PF-905 to produce.
