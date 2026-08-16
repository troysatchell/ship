# Subagent brief — W6 requirements-audit compare sweep `w6-2026-08-16b`

You are a **tracer** for a requirements audit of the Ship repo (`/Users/troy/repos/GAUNTLET/Ship`, commit `08505d2d459ac00842110d6410c2aef82c349e06` == `origin/main`; only `memory-bank/activeContext.md` is dirty in the working tree — never cite that file). You are assigned a **cluster of requirement IDs** (W6-Rn). For each, produce a matrix row with file:line evidence, ticket mapping, and a plain-English status sentence.

## Inputs (read these first)
- Inventory (the requirements — Quote / Meaning in code / Acceptance evidence): `audit/requirements/inventory-W6.md`
- Prior matrix (2026-08-16 07:10Z sweep — your starting point, NOT your answer): `audit/requirements/matrix.after-w6-2026-08-16.json` — use `jq '.requirements[] | select(.id=="W6-Rn")'`
- Prior report narrative for context: `audit/requirements/REPORT-W6-2026-08-16.md`, `audit/requirements/REPORT-W6-2026-08-15.md` (has full-matrix evidence for rows unchanged on 08-16)
- Interpretations (permanent rulings — apply silently): `audit/requirements/interpretations.md` (I-04 governs W6-R25)
- Linear tickets for the project (113 issues, current status as of 13:45Z today): `audit/requirements/sweep-w6-2026-08-16b/tickets.md`
- The PRD that decomposed the brief into PF-### tickets: `PLUGFORGE.MD` (repo root; ticket titles carry the PF-### code)
- Since the prior sweep only 3 substantive PRs merged: #266 (TRO-609 e2e sprint-filter fix), #273 (TRO-488 terraform variable validation), #276 (TRO-501 IssuePriority 'none'). Open PRs: #268 TRO-493, #269 TRO-588, #272 TRO-589, #274 TRO-598, #275 TRO-552, #277 TRO-591, #278 TRO-614, #282 docs.
- Migration state (fresh scratch DB migrated this sweep, 56 migrations applied 001..051): `\d` dumps in `audit/requirements/sweep-w6-2026-08-16b/d-*.txt`, list in `schema_migrations.txt`.
- `pnpm type-check` passed (exit 0) this sweep: `audit/requirements/sweep-w6-2026-08-16b/typecheck.log`. `pnpm test` is RUNNING in the background into `.../test.log` — it may not be complete when you run; do not wait for it. Instead, name the vitest test files that bear on each row (field `test_files_bearing`) and the main session will reconcile them against the finished log.

## Hard rules
1. **Read-only.** Do not modify any file except your own output file `audit/requirements/sweep-w6-2026-08-16b/cluster-<LETTER>.json`. Never run `pnpm test`, `db:migrate`, seeders, or anything that writes to a database. Never touch Linear. `git stash` is forbidden (shared stash across worktrees).
2. **Every citation must open.** Before writing `{file, line, note}`, run `sed -n '<line>p' <file>` (or `grep -n`) and confirm the line contains what your note says. Line numbers are 1-indexed. For whole-file/directory artifacts cite line 1 and say so in the note ("line 1 = file title; whole-file artifact"). Never cite `audit/requirements/**` (the audit's own output). Never cite `memory-bank/activeContext.md` (dirty). Prior-matrix line numbers may have drifted — re-check every one; if it moved, find the new line.
3. **Observed vs derived.** If you did not run it, say what you read. "test file X asserts Y" is observed-from-source; "Y works" is a claim only a run supports. CI run IDs / PR numbers / URLs go in `notes` (checkable, not file:line).
4. **Verdict proposal tiers:** `VERIFIED` only if a behavioral check ran *this sweep* — for you that means: `typecheck.log` exit 0 bears on it, or `test.log` is complete AND shows the named test file passed (check `tail -50 test.log` for the final summary + `grep` the file name — if the log is incomplete, propose `IMPLEMENTED-UNVERIFIED` and name the file in `test_files_bearing`; the main session upgrades). `IMPLEMENTED-UNVERIFIED` = real file:line trace, no run. `PARTIAL` = some acceptance evidence present, some missing — name what's missing in `notes` and fill `suggested_scope`. `MISSING` = no implementing code found — fill `suggested_scope`. `N/A` = process requirement nothing in-repo can satisfy (still list proxy artifacts in notes if any). Never guess: if a requirement is readable two+ ways in code terms and no interpretation governs it, set `needs_ruling` to a single yes/no question and trace under a stated `assumption` — do NOT ask anyone.
5. **Ticket mapping:** list every TRO ticket from tickets.md whose content addresses the requirement (a ticket may map to several requirements). Include follow-up/hardening tickets that touch the same requirement (they show up in the report as related work) — but distinguish in `notes` which ticket *implements* vs *hardens*. Note ticket status (Done/Backlog/In Progress) since an open ticket that maps to a requirement is a live gap indicator.
6. **Plain English is mandatory:** `plain_english` = 1–3 sentences a non-engineer grader can read: what the requirement asks for, what exists in the repo (naming the file), what ticket delivered it, and what if anything is still missing. No jargon without a gloss.

## Output
Write **valid JSON** to `audit/requirements/sweep-w6-2026-08-16b/cluster-<LETTER>.json`:

```json
{
  "cluster": "<LETTER> — <label>",
  "rows": [
    {
      "id": "W6-Rn",
      "verdict": "VERIFIED|IMPLEMENTED-UNVERIFIED|PARTIAL|MISSING|N/A",
      "tickets": ["TRO-###"],
      "evidence": [ { "file": "path/from/repo/root", "line": 123, "note": "what that line shows" } ],
      "test_files_bearing": ["api/src/platform/oauth/__tests__/token.test.ts"],
      "e2e_specs_bearing": ["e2e/oauth-pkce-chain.spec.ts"],
      "verification": null,
      "plain_english": "…",
      "notes": "…",
      "suggested_scope": null,
      "assumption": null,
      "needs_ruling": null,
      "delta_vs_prior": "same | upgraded because … | downgraded because … | evidence re-pointed (line drift) …"
    }
  ],
  "commands_run": [ { "command": "…", "result": "…", "bears_on": ["W6-Rn"] } ]
}
```
Then reply with a ≤15-line summary: per row `ID verdict — one clause`, plus any `needs_ruling` items. Do not paste file contents back.
