# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-16 ~16:57Z, by a fresh session that ran the merge-only endgame of the W6 factory wave. **Troy said at ~15:20Z "I have an hour left of work... disregard my deliverables" and to prioritize closing out in-flight work over anything new — that puts a real deadline around ~16:20Z, which has now passed as of this write.** Next session: confirm with Troy whether to keep working the backlog or the sprint is done: don't assume either way.

## Merge queue — essentially clear

This session's batch (11 PRs: 268/269/272/274/277/278/283/284/285/286/301) and ship-61's (287/288/300/302/303) all merged. Docs PRs #304/#305 also landed. **Only ship-16's #298 (TRO-453, PF-804 GitHub App) and #299 (TRO-496, boundary-lint hardening) remain open** as of this write — they were mid merge-forward-convoy, gate-clean, waiting on final CI. Check `gh pr list --state open` fresh; don't trust this as current.

**Branch protection `strict=true` was restored** (~16:56Z) after being relaxed 13:50Z–16:55Z to survive a 5-session merge convoy. Both remotes verified identical at `e6e4bbaf` via direct `git ls-remote`.

## Real bug found and fixed this session: `ship-agent` Render service was broken for ~2 days, undetected

Troy asked why `ship-agent` builds were failing. Checked Render's own deploy history directly
(`render deploys list srv-d9otunmgekts73eqs0h0`) rather than guessing: **every deploy back to
2026-08-16 05:36Z was `build_failed`** — predates this session, unrelated to the merge convoy.
Root cause: `agent/src/shipClient.ts` started importing `@ship/sdk` at PF-702/PF-703
(2026-08-14, `d50d5d66`/`2f1284f8`), but `agent/Dockerfile` was never updated to copy/build the
`sdk` workspace package — `tsc` failed with `TS2307: Cannot find module '@ship/sdk'` on every
build since. Fixed in PR #301, **verified with a real `docker build` + `docker run`** (not just
CI): container boots, logs `[agent] listening on :3100`, no `MODULE_NOT_FOUND`. Post-merge,
Render shows the deploy **`live`** and `https://ship-agent-t0zy.onrender.com/health` returns
`200 {"status":"ok"}` — confirmed directly, not assumed from a green check-run.

**Lesson for the next session:** nobody had checked the `ship-agent` Render deploy history in ~2
days of active factory work on `agent/`. GitHub CI (which only builds the root `Dockerfile`/tests,
not the agent-specific one) stayed green the whole time, so this was fully invisible to the normal
gate/CI signals. If agent work resumes, spot-check `render deploys list srv-d9otunmgekts73eqs0h0`
occasionally — it is not covered by anything in `gate.sh` or `ci.yml`.

## CodeRabbit rate-limit exception — still worth re-checking

The fleet-wide CodeRabbit rate limit confirmed ~13:25Z (see SKILL.md's standing exception) was
used to merge the entire queue on gate-pass + CI-green throughout this session, per Troy's
existing standing policy — this was **not** a new authorization, it's documented in
`.claude/skills/ship-factory/SKILL.md`. Nobody has re-checked whether the window has cleared since
~14:30Z. Whoever picks up ship-16's #298/#299 (or any new PR) should open it and read the actual
CodeRabbit comment body before assuming rate-limited — it may have cleared hours ago.

## Still needs Troy directly

- **TRO-429** (pre-search answers + saved AI-conversation artifact)
- **TRO-444** (demo video/social post) — docs re-grounding done (PRs #304/#305) but the actual
  recording/checkpoint itself still needs Troy.

## Standing facts (still true)

- `GH_REPO=troysatchell/ship` for all `gh` calls. `origin` fetches from GitLab, pushes to GitLab —
  GitHub main is a **separate remote** (`https://github.com/troysatchell/ship.git`), PR-only
  (branch-protected). To sync GitLab after a GitHub merge without disturbing a checked-out worktree:
  `git fetch https://github.com/troysatchell/ship.git main:refs/remotes/github-verify/main && git push origin refs/remotes/github-verify/main:main`.
- CHANGES.md is append-only and conflicts on nearly every merge under concurrent sessions — always
  resolve with `scripts/factory/merge-changes.mjs --ours <ours> --theirs <theirs> --out CHANGES.md`,
  never by hand (whole-entry merge, not line-based — hand/default-merge silently welds two entries
  together).
- CI (`typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)`) takes
  9-13 min per run; a merge convoy under N concurrent sessions costs N re-runs per PR as `main`
  advances. Push all independent branches' merge-forwards together, then poll once, rather than
  serializing round-trips.
- Multiple sessions share this machine's `Ship` main worktree and its `memory-bank/` files — check
  `git status`/re-read before overwriting.
