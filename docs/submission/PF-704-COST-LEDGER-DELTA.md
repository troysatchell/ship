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
workload, given the traced `content`-field data-flow difference above — that is what the
TRO-620 measurement below establishes directly.

## What this doc does not claim (revised)

This is not a live A/B comparison of two full agent sessions run under each mode, and — after the
correction above — it is also not a completed structural proof that the two modes are
token-equivalent. What is actually established:

1. **Transport-level:** the flag changes only which HTTP client makes Ship-API calls
   (`/api/*` vs. `/api/v1/*`) — confirmed by grep, not touching `graph.ts` directly.
2. **One real, traced exception:** the `on_demand`/expansion path's prompt text depends on
   `getDocument()`'s `content` field, which is not carried over in `sdk` mode — so token volume
   for that trigger specifically can differ between modes, and this doc does not know by how much.
3. **Measured (TRO-620, 2026-08-16) — see "Measured: matched workload, both modes" below:** a live,
   matched-workload run of the `on_demand` trigger through both modes, before and after the
   `getDocument` passthrough fix. Before the fix, `sdk` mode reached the model with **~85% fewer
   input tokens** (0 documents in context — every candidate failed the visibility check on the
   synthesized `visibility`); after it, input tokens are **identical** to `internal` mode.

**Recommended for PF-905:** run the same question-answering workload through both modes and diff
the resulting ledger entries for the `on_demand` trigger specifically — that is the one path this
session traced as genuinely exposed. The other four triggers' prompt builders were not individually
traced and may or may not need the same treatment.

## Measured: matched workload, both modes (TRO-620, 2026-08-16)

**What changed first:** TRO-605 widened `GET /api/v1/documents/:id` to return
`content`/`visibility`/`created_by`/`completed_at`, and TRO-620 made `agent/src/shipClient.ts`'s
`getDocumentViaSdk` pass all four through instead of returning `content: null` / a synthesized
`visibility` / `created_by: null` / `completed_at: undefined`. So the "traced exception" above is
closed at the source — and this section measures it rather than asserting it.

**Setup (OBSERVED, all from the TRO-620 worktree):** local Ship API (`api/src/index.ts` under
`tsx`) against the worktree's own freshly `db:seed`-ed database; one personal `api_tokens` row for
`dev@ship.local` (`documents:read`/`issues:read`/`sprints:read`); model
`claude-haiku-4-5-20251001`, `maxTokens: 512`, `temperature: 0`; seed document = the seeded project
`25c15212-31dd-462c-a96f-7e615b107d2b` ("API Platform - Core Features"); three fixed questions
(hard-coded in `agent/src/scripts/measure-token-volume.ts`, the script that produced these ledgers,
which mirrors `index.ts`'s on-demand `shipClientFactory` construction — `sdk` mode uses
`@ship/sdk` authenticated with the same personal token; `askingUserId` is passed so
`expansion.ts`'s `passesAskerVisibility` runs for real). Every row below is a real
`FileCostTracker` record (`usage_metadata` off the real `ChatAnthropic` response). Ledgers are
committed verbatim as `docs/submission/cost-ledger/tro-620-{internal,sdk,sdk-before-fix}.jsonl`.
The "before" run used `agent/src/shipClient.ts` as of `b68da413` (GitHub `main` at branch time),
everything else identical.

| Turn | Mode | Docs pulled | Input tokens | Output tokens | Input Δ vs internal |
|---|---|---:|---:|---:|---:|
| Q1 | internal | 12 | 424 | 237 | — |
| Q1 | sdk (after TRO-620) | 12 | 424 | 237 | 0.0% |
| Q1 | sdk (before TRO-620) | 0 | 65 | 93 | −84.7% |
| Q2 | internal | 12 | 425 | 279 | — |
| Q2 | sdk (after TRO-620) | 12 | 425 | 261 | 0.0% |
| Q2 | sdk (before TRO-620) | 0 | 66 | 153 | −84.5% |
| Q3 | internal | 12 | 425 | 121 | — |
| Q3 | sdk (after TRO-620) | 12 | 425 | 121 | 0.0% |
| Q3 | sdk (before TRO-620) | 0 | 66 | 77 | −84.5% |
| **Total** | internal | — | **1274** | **637** | — |
| **Total** | sdk (after) | — | **1274** | **619** | **0.0% input / −2.8% output** |
| **Total** | sdk (before) | — | **197** | **323** | **−84.5% input / −49.3% output** |

Reading it: **input tokens — the part of the turn the rewire could change — are identical per turn
between `internal` and post-fix `sdk` mode** (same 12 documents, same snippets, same prompt). The
single output-token difference (Q2: 279 vs 261) is model non-determinism on an identically-sized
prompt (both runs cited the same 12 sources; Q1/Q3 outputs matched exactly), not a mode effect. The
pre-fix `sdk` rows are the real cost of the old "fail closed" synthesis: `passesAskerVisibility`
rejected every fetched candidate, `documentsPulled: 0`, and the model answered from the question
alone — cheaper, and useless.

**One thing this run also OBSERVED that is not about tokens:** on the first `sdk`-mode attempt the
expansion walk died with `ShipSdkError: Too many requests` (HTTP 429, `kind: 'rate_limit'`) from
`/api/v1`'s per-token bucket (`RATE_LIMIT_TOKEN_RPM`, default 60 —
`api/src/platform/ratelimit/config.ts`). `sdk` mode's association reads page through the v1
sub-resources per document (`collectAllPages`), so a 12-document walk issues well over 60 v1
requests in a few seconds. The runs above were made with `RATE_LIMIT_TOKEN_RPM=10000` on the local
API. `internal` mode is not subject to that limiter. That is a real, separate `sdk`-mode operability
finding for the on-demand path, out of TRO-620's scope, and it is disclosed here rather than
absorbed.

**Cap on LLM spend for this measurement:** 9 real calls total (3 per configuration), all
`claude-haiku-4-5-20251001`, ≈ $0.0074 at the rate card in `costTracking.ts`.

**Not measured:** the other four triggers (`composeStandupDraft`, `composeBlockerEscalation`,
`composeRetroDraft`, `composePlanChangeDraft`) — same boundary as the section above; the traced
exposure was `on_demand` only, and only `on_demand` was run.

## Feeds PF-905 (TRO-434)

PF-905's own AC needs: (1) this delta — the honest version above, not the discarded "architecturally
inert" claim; (2) TTFE CI minutes; (3) Playwright OAuth compute; (4) spec-gen overhead; (5)
delivery-log storage growth; (6) production cost projections at 100/1k/10k/100k users. Items 2–6 are
out of this ticket's scope (PF-704 owns only item 1) and remain for PF-905 to produce — and per the
correction above, item 1 was "here's the exact real gap to measure" — and as of TRO-620 (section
above) it is measured: input token volume is identical between modes for the `on_demand` trigger
once `getDocument` passes `content`/`visibility`/`created_by`/`completed_at` through.
