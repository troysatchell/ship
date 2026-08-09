# Requirements gaps — Ship / FleetGraph W5 (2026-08-09, commit 3e4a76dfbd7b)

Compare-mode sweep against `matrix.baseline-W5.json`. **No `MISSING` requirements remain.** The 3 rows below are all `PARTIAL`, each naming which part of its acceptance evidence is absent.

## Requirements with gaps

### W5-R36 — PARTIAL
- **Quote:** "If a CI run fails, the deployment must be rolled back automatically — do not allow a failing build to remain deployed."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** CI failure triggers an automatic rollback of the deployed agent.
- **Tickets:** TRO-367
- **Governing ruling:** I-03
- **What is missing:** Ruling I-03 applies: readiness polling does not satisfy the literal 'CI failure triggers rollback' wording. Substantial real progress from MISSING, but two gaps keep it PARTIAL.
- **Suggested scope:** Two independent gaps. (1) SEMANTIC: nothing rolls back because a CI job failed — CI failure only blocks merge. A literal fix adds a workflow_run/post-deploy step that fires rollback on a failed CI run against a deployed commit. (2) EVIDENTIARY: as of 2026-08-09 13:48 UTC the workflow has never executed its real step — its last scheduled run (12:56) predates the secrets (13:38) and logged configured=false. Gap 2 closes on the next tick; gap 1 needs new work.

### W5-R43 — PARTIAL
- **Quote:** "All outbound calls from the agent (to Ship APIs, LLM providers, and any external tools) must implement explicit timeouts and retry logic with exponential backoff."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** Every outbound call path sets a timeout and retries with exponential backoff.
- **Tickets:** TRO-368, TRO-379
- **What is missing:** Label unchanged but the REASON is entirely different — do not read as 'nothing happened'. Baseline's PARTIAL was 'the LLM call has no timeout/retry at all'; that is fully closed. It stays PARTIAL only because of a narrower, independently filed follow-up (TRO-379): the timeout exists per-call but is not composable with the handler's deadline or its cancellation signal.
- **Suggested scope:** Tracked as TRO-379: derive each attempt's timeout from the deadline remaining at call time; propagate the handler's AbortSignal into the ChatAnthropic call; validate at startup that worst-case model time plus a stated pre-model-work allowance fits inside chatHandlerTimeoutMs. Done when an integration test delays pre-model work and asserts no Anthropic request survives the handler timeout.

### W5-R45 — PARTIAL
- **Quote:** "Document the retry strategy and fallback behaviour in FLEETGRAPH.md, and demonstrate graceful degradation in your Architecture Defense."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** FLEETGRAPH.md documents retry/fallback; the Architecture Defense demonstrated degradation.
- **Tickets:** TRO-368
- **What is missing:** Half of baseline's two-part gap is closed. The other half is unchanged: no record anywhere that the Architecture Defense's graceful-degradation demonstration occurred (grep for defense/defend across FLEETGRAPH.MD returns zero; memory-bank has no entry past 2026-08-07).
- **Suggested scope:** Add one dated note (FLEETGRAPH.MD or memory-bank) recording when the Architecture Defense was held and that the degradation demo was shown, or attach a transcript/recording artifact. This is the only element still missing.

## Findings with no requirement of their own

- **FLEETGRAPH.MD:431 contradicts itself** — says Use Case 5's agent side is unbuilt; the chain has existed since `a600a12` (2026-08-05) and the Graph Diagram section of the same file documents it. An under-claim, so W5-R18's narrow bar still passes, but a grader reading end to end finds the file arguing with itself. **TRO-381.**
- **Stale source citations are compounding** — `graph.ts:617-628` cited for `routeTrigger`, which now lives at 1277 (~650 lines off, up from ~570 at baseline). **TRO-351.**
- **"Four paths" is still wrong** in Architecture Decisions (`FLEETGRAPH.MD:796`); seven distinct chains exist. **TRO-351.**
- **Three distinct load-flake identities appeared in one day** — `session-revocation`, `programWeeksNav`, `auth.test.ts::extend-session` — each failing a gate or CI run on a branch that changes no file it could reach. **TRO-380.**

## Orphan tickets

- **TRO-372** "W5 sweep's section detector miscounts CHANGES.md" — audit-tooling defect; maps to no W5 requirement
- **TRO-375** "W5 sweep artifacts carry W4 labels and stale verdicts" — audit-tooling defect; maps to no W5 requirement
- **TRO-376** "Preflight/role skills still claim 13 expected web failures" — factory tooling; maps to no W5 requirement
- **TRO-377** "gate.sh needs a vacuous-assertion check" — factory tooling; maps to no W5 requirement
- **TRO-378** "Block git stash in factory worktrees" — factory tooling; maps to no W5 requirement
- **TRO-380** "programWeeksNav flake fails CI on unrelated PRs" — test-infrastructure defect; bears on CI reliability generally, no specific W5 requirement
- **TRO-374** "resilientClient.ts docstring claims model-provider coverage it lacks" — code-comment accuracy; adjacent to W5-R43/R45 but not itself a requirement
