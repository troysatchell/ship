# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-04. Focus is **Week 5 — FleetGraph**, MVP critical path. **PR-A through PR-D all merged and closed today; PR-G (MVP) is next.**

## Where we are

**Critical path A ∥ B → C → D → G-MVP: A/B/C/D done, G-MVP next.** PR-A (#110), PR-B (#108) merged 2026-08-03. PR-C (#117, TRO-317/318/319/321 — the graph: proactive detection, on-demand expansion, standup drafts, human-in-the-loop gate) merged 2026-08-04 — every ticket independently re-verified before merge. `TRO-327` and all 4 sub-issues Done in Linear.

**FG-11 (TRO-316) and FG-23 (TRO-341) also closed 2026-08-04**, both required live infra actions the user explicitly signed off on:
- `terraform apply` created the real `ship-agent` Render service (0 changes to `ship`/`ship-db`); destroy-and-redeploy proof completed, scoped to the agent only (PR #112).
- `ship` (the graded/public Ship instance) had silently not redeployed since 2026-07-30 — PR-A/PR-B were on `main` but not live. Manually redeployed; root cause of why `auto_deploy` stopped firing is still **not diagnosed** (see watch-outs). Real per-user agent token minted and wired in — hit a `render-oss/render` provider bug, worked around via the Render REST API directly. `ship-db` reseeded with FG-3 fixtures — Test Case 1's fixture didn't fire, documented in FLEETGRAPH.MD rather than hidden (PR #113).

**PR-D (`TRO-328`, Ship UI surfaces) merged 2026-08-04** — TRO-320 (chat panel), TRO-323 (ranked inbox), TRO-334 (blocks/blocked-by sidebar), PR #120. **A real scope gap was found and closed before dispatch, not after:** the epic's own text said "all three are `web/` changes" — false for two of the three. `agent/src/server.ts` exposed only `/health`/`/ready`; FG-9/FG-10 needed new agent-side HTTP routes plus an `api/` proxy (browser session → `api/` via existing `authMiddleware`, `api/` → agent via a new `AGENT_INTERNAL_SECRET` shared-secret header — no new browser-facing trust boundary invented). Caught by reading the code before writing agent briefs, not discovered mid-build.

Three review rounds on PR #120 (17 CodeRabbit findings total) were triaged to completion: 12 fixed on-branch (a `/chat` deadline + cancellation, CWE-319/522/524 hardening on the new agent proxy, a state-leak bug, an a11y gap, three mock-fidelity fixes), 2 correctly filed as separate tickets rather than patched in-branch — **`TRO-343`** (React Query cache never cleared on login/logout — verified as a *pre-existing, repo-wide* pattern across every hook in `web/src/hooks/`, not something PR-D introduced) and **`TRO-344`** (circular-blocks error message inferred from a bare 500 rather than a dedicated code — needs a backend change, correctly out of a UI-only ticket's scope).

**One process incident, handled and documented, not hidden:** the `git stash` ban (already violated 4 times before this) was violated a 5th time on PR-D's branch, this time by an agent whose brief stated the ban verbatim with full reasoning — restating the rule has now empirically failed as a deterrent. `gate.sh`'s G7c stash-guard caught it mechanically and correctly; verified independently no harm occurred (no concurrent sibling worktree, both stash entries cleanly popped). Per orchestrator decision, the gate's `stash-guard: fail` was **not** papered over (would have erased the only durable evidence) — it shipped as a disclosed, permanent exception on that one PR, with the merge decision explicitly kicked back to the user rather than auto-merged under the standing CodeRabbit-green delegation (which requires gate-green too). Full writeup: `lessons.md`, dated entries under TRO-323/FG-10. **Worth a real fix, not another warning:** a `git` wrapper/alias that refuses `stash push`/`pop` inside `Ship-wt-*` paths, proposed but not yet built.

**Next: PR-G (MVP)**, per `/ship-pm`'s 2026-08-03 review — runs right after PR-C/D, was split into three slices across the MVP/Early-Sub/Final deadlines as a declared exception to one-bundle-one-PR.

## Deadlines (from the brief)

**MVP Tue 2026-08-04 23:59** · Early Sub Thu 2026-08-06 23:59 · Final Sun 2026-08-09 12:00. **Today is the MVP deadline.**

## Open questions

- **Model provider** (Anthropic API vs Bedrock) — resolved: Anthropic API directly (TRO-313, confirmed 2026-08-03).
- `TRO-342` (new, 2026-08-04): the agent's read path uses one shared `SHIP_API_TOKEN` env var, not per-requesting-user tokens — contradicts FLEETGRAPH.MD's "no service account" design on the read side (the write side, FG-8, already does per-call token injection correctly). Not blocking MVP; worth fixing before the design principle is graded.
- `TRO-343`/`TRO-344` (new, 2026-08-04, from PR-D's CodeRabbit review): cross-user React Query cache leakage (repo-wide, not PR-D-specific) and the circular-blocks error-message precision gap. Neither blocking MVP.
- Week 4 final submission outcome — still not recorded in the bank.

## Standing watch-outs

- **`auto_deploy` on the graded Render `ship`/`ship-agent` services is unreliable — root cause not found.** After any future merge to `main` that the graded demo depends on, manually verify (`GET /` last-modified, or probe a route the merge added) rather than assuming Render redeployed. Remediation command and the standing procedure are in FLEETGRAPH.MD's "Deployment model".
- **`terraform apply` cannot update `render_web_service.agent` at all, for any field, on the free tier** — a provider bug (`maintenance_mode` rejected by Render's API for free-tier services, sent unconditionally by the provider regardless of `ignore_changes`). Any future change to this resource needs the Render REST API directly, not `terraform apply`, until the provider is patched.
- Check GitLab CI as well as GitHub (`glab ci status --branch main -R troysatchell/ship`). Backlog still holds `TRO-309` (CodeQL alerts, unread) and `TRO-310` (TEST-11 batch 2).
