# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-30, day 4 evening · **Phase 2 factory resumed after recovery; wave-based dispatch running.** Phase 2 due **Fri Jul 31**.

## Where we are

`main` at `9a15f43`, all three remotes identical. This session: recovered the interrupted run (19 stale worktrees + DBs cleaned), then **3 PRs merged** — #40 (TEST-14/TRO-286), #42 (RULE-5/TRO-246, CI now builds → GHCR by SHA), #43 (A11Y-2/TRO-216, axe Critical 1→0). Audit-68 Done: 26 → **27** (TRO-216; the other two are post-baseline/rule tickets — derived from the prior verified 26, not re-counted).

## Held for the maintainer (decision queue — batch-answer these)

- **PR (TF-10/TRO-299)** — new `terraform/render/` config (Render provider, pinned 1.9.1), plan-only
  (no apply/import). Decision needed: `terraform import` the existing hand-built `ship`/`ship-db`
  vs. a clean-machine `apply` that creates a parallel service — memo + recommendation (import) in
  `terraform/render/README.md`.
- **PR #41 (TF-2)** — deletes tracked infra config (gate 2). Agent corrected the ticket: only `environments/prod` was an unused duplicate (deleted); `dev`/`shadow` are the live TF path (kept). Ports include a real IAM fix (`PutSecretValue` missing from flat-root policy).
- **PR #47 (TF-7)** — gate 2+6. Pair that must land together: ALB SG → CloudFront prefix list + `trust proxy` 1→2. **Discovery: under `trust proxy 1`, `req.ip` was CloudFront's edge IP for ALL traffic** — the API-1 flood floor has been keying on edge IPs. Before apply: TRO-295 (SG rule quota, High), TRO-294 (doc health-check URL breaks).
- **Render image-deploy switch** — runbook in `docs/deployment-artifact-lifecycle.md` (RULE-5), not executed.
- Carried from before: prod SSM `DATABASE_URL` read; VoiceOver on TRO-215/281; PR #30 ordering decision.

## In flight (8 Sonnet agents)

TS-2 (TRO-207 typed pg boundary) · DB planner batch (183/184/185/187, one branch) · ERR-13/14 batch (289/290) · A11Y landmark batch (219/220/221) · TS-6 ESLint (211) · BUN-7/8 dep hygiene (203/204) · PR #45 fix round (TS-3 recursive-guard finding + main merge) · PR #46 fix round (TS-1: 2 findings + failed CI run diagnosis + main merge).

## Sequencing holds

- **DB-3 (TRO-180) waits for TS-2** — both would rewrite the same query call sites.
- **TS-4/TS-5 wait for TS-2**; ERR-6+TEST-5 (193/227) wait for PR #46 (editor files).
- **TF-1 (234) blocked on PR #41 human decision.** RULE-3 (245) deferred until today's merges settle.

## Session discoveries worth carrying

- TS-1's audit count had drifted: 156 latent errors (not 102) after 30 merges; all fixed, zero new casts.
- TRO-296 filed: converter marks round-trip asymmetry (`format()` written, never read back) — pre-existing, persistence path.
- New tickets this session: TRO-291..296.
- zsh does not word-split unquoted vars — two orchestrator scripts failed on it; use functions/explicit args in Bash-tool loops.

> — GIR: "I'm gonna sing the doom song now."
