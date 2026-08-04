# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-04. Focus is **Week 5 — FleetGraph**, MVP critical path. **PR-A, PR-B, PR-C all merged and closed today; PR-D is next.**

## Where we are

**Critical path A ∥ B → C → D → G-MVP: A/B/C done, D next.** PR-A (#110), PR-B (#108) merged 2026-08-03. PR-C (#117, TRO-317/318/319/321 — the graph: proactive detection, on-demand expansion, standup drafts, human-in-the-loop gate) merged 2026-08-04 — every ticket independently re-verified (gate re-run, tests run directly, FG-8's write-boundary code manually read) before merge, not just trusted from agent self-reports. `TRO-327` and all 4 sub-issues Done in Linear.

**FG-11 (TRO-316) and FG-23 (TRO-341) also closed today**, both required live infra actions the user explicitly signed off on:
- `terraform apply` created the real `ship-agent` Render service (0 changes to `ship`/`ship-db`); destroy-and-redeploy proof completed, scoped to the agent only (PR #112).
- `ship` (the graded/public Ship instance) had silently not redeployed since 2026-07-30 — PR-A/PR-B were on `main` but not live. Manually redeployed; root cause of why `auto_deploy` stopped firing is still **not diagnosed** (see watch-outs). Real per-user agent token minted (CSRF, not a WAF, was the earlier 403's cause) and wired in — hit a `render-oss/render` provider bug (`ignore_changes` doesn't stop `maintenance_mode` in the update payload for a free-tier service), worked around via the Render REST API directly. `ship-db` reseeded with FG-3 fixtures — Test Case 1's fixture (and part of Test Case 3's) didn't fire, a real data-timing gap now documented in FLEETGRAPH.MD rather than hidden (PR #113).

**Next: PR-D** (`TRO-328`, Ship UI surfaces — in-context chat, ranked inbox, blocks/blocked-by sidebar; sub-issues `TRO-320`/`TRO-323`/`TRO-334`) is now unblocked and is the next dispatch per the stacking order (`/ship-pm`'s 2026-08-03 review: D stacks on C, don't wait for a separate merge).

## Deadlines (from the brief)

**MVP Tue 2026-08-04 23:59** · Early Sub Thu 2026-08-06 23:59 · Final Sun 2026-08-09 12:00. **Today is the MVP deadline.**

## Open questions

- **Model provider** (Anthropic API vs Bedrock) — resolved: Anthropic API directly (TRO-313, confirmed 2026-08-03).
- `TRO-342` (new, 2026-08-04): the agent's read path uses one shared `SHIP_API_TOKEN` env var, not per-requesting-user tokens — contradicts FLEETGRAPH.MD's "no service account" design on the read side (the write side, FG-8, already does per-call token injection correctly). Not blocking MVP; worth fixing before the design principle is graded.
- Week 4 final submission outcome — still not recorded in the bank.

## Standing watch-outs

- **`auto_deploy` on the graded Render `ship`/`ship-agent` services is unreliable — root cause not found.** After any future merge to `main` that the graded demo depends on, manually verify (`GET /` last-modified, or probe a route the merge added) rather than assuming Render redeployed. Remediation command and the standing procedure are in FLEETGRAPH.MD's "Deployment model".
- **`terraform apply` cannot update `render_web_service.agent` at all, for any field, on the free tier** — a provider bug (`maintenance_mode` rejected by Render's API for free-tier services, sent unconditionally by the provider regardless of `ignore_changes`). Any future change to this resource needs the Render REST API directly, not `terraform apply`, until the provider is patched.
- Check GitLab CI as well as GitHub (`glab ci status --branch main -R troysatchell/ship`). Backlog still holds `TRO-309` (CodeQL alerts, unread) and `TRO-310` (TEST-11 batch 2).
