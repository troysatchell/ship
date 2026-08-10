# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-10 (evening). **Week 6 (PlugForge) — plan phase DONE, build phase pending.**
The W6 Linear project exists and is fully ticketed: **"PlugForge — Week 6 Platform & Public API"**,
10 grouping epics (TRO-386–395) + 60 tickets (TRO-396–455), tiered + dependency-wired, one ticket →
one branch → one PR (no bundling — brief mandate). `audit/requirements.config.yaml`
`tickets.project` re-scoped to it. PM scope gate passed with 6 live spot-checks.

## Current focus

1. **🔔 PF-100 (TRO-403) AWAITING TROY'S ACK — blocks all E1/OAuth code, the critical path.**
   Study brief at `docs/submission/PF-100-OAUTH-STUDY-BRIEF.md` (uncommitted). Ack = session reply
   or "ack" comment on TRO-403.
2. **Test designs DONE (2026-08-10 evening):** all 60 tickets carry pre-implementation test-design
   comments (5 parallel designers); PM triage posted on 17 tickets — key decisions: /oauth speaks
   RFC 6749 errors not ApiError; `oauth_apps.client_type` added to 042; `replay_of_delivery_id`
   added to 045; **PF-603 drill is environment-dual (graded GitLab runner cannot run DinD —
   testcontainers locally, GitLab `services:` in graded CI)**; PF-802 Playwright proof = dedicated
   CI job; env-var names canonical on TRO-411. Next: `/ship-factory` build wave 1. Dispatchable now
   (no E1 dependency): PF-001/TRO-396 (scaffold, first), PF-900/TRO-411, PF-902/TRO-420,
   PF-903/TRO-424 — Day-1 defense material.
3. **Factory preflight blocker:** working tree on `main` is dirty with Troy's uncommitted W6 kickoff
   files (PLUGFORGE.MD, inventory-W6, deck, this bank, + session additions: study brief, ticket
   manifest in scratchpad). Needs Troy's word on the kickoff commit before worktree dispatch.
4. **Ticket map anchors:** PF-### ↔ TRO-### is 1:1; every ticket title starts with its PF ID, so
   Linear search "PF-" resolves. Epics: E0=386 E1=387 E2=388 E3=389 E4=390 E5=391 E6=392 E7=393
   E8=394 E9=395. Checkpoints: PF-100=TRO-403, PF-700=TRO-417, PF-904=TRO-429 (never agent-closed).
   PF-901/TRO-415 needs human go-ahead before `terraform destroy` on graded env.

## Open questions

- GitHub repo **public**? Brief mandates; still unchecked — PF-907/TRO-441 carries it as its first,
  one-command step.
- W6 deadline contradiction (Sun 11:59 AM vs PM CT) — planning for **AM 2026-08-16**, all work lands Saturday.
- Carry-over for Troy: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s on live.

## Standing watch-outs

- **TRO-361: Render `auto_deploy` broken** — manual Render API deploys + SHA verification, every time.
- **W6 PR discipline:** per-slice branches preserved; PR names its acceptance criterion + confirms
  fitness test. Overrides W4/W5 bundling habit.
- **Graded CI is GitLab** (`.gitlab-ci.yml`) — GH Actions is the mirror; check the right one (W4's
  invisible GitLab outage precedent). Coverage thresholds live in vitest configs + CI, not gate.sh.
- Dependency-audit baseline drift recurs on GitHub's schedule (pnpm.overrides pin + refresh pattern).
- Local dev on `ship_standup` DB; `ship_dev` (638 docs) intact.
