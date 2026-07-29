# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-29 (Wed), day 3 · **Next session: run the factory on Phase 2**

## Where we are

**The ticket factory is built and tested; no tickets have been worked yet.** Phase 2 remediation
is still at zero — what changed today is that the machinery to do it exists and has been proven
on itself.

Harness committed on **`feat/ticket-factory-harness`** (`ea2dcd3`, 15 files) and pushed. Phase 2
due **Fri Jul 31**.

## Start here tomorrow

**Harness is shipped and on `main` at `58714cb`** — PR #1 (`2dced06`, the harness + CI) and PR #2
(`58714cb`, role skills + the fixes from #1's review). CI green on both; CodeRabbit clean on #2.
Both remotes verified in parity. Nothing is pending.

1. **Run `/ship-factory`.** Agreed scope: the 4 Criticals + the assignment rules —
   `TRO-178` (DB-1), `TRO-188`+`TRO-189` (ERR-1/ERR-2, **one branch**, same file), `TRO-172`
   (API-1), `TRO-215` (A11Y-1), and `TRO-245`–`TRO-249`. `TRO-244` (CI) is **done**.

## Decisions made 2026-07-29

- **Non-ticket content skips the CodeRabbit gate** — tooling, skills, docs, CI merge on gate + CI
  green alone. Anything under `api/`/`web/`/`shared/` is ticket content and the full gate applies.
- **Merge policy: auto-merge once the CodeRabbit review is green** (gate-green + CI-green +
  triage-clean + no open escalation). Pushing factory branches and opening PRs is pre-authorized.
  CodeRabbit findings get fixed when in scope and non-trivial; trivial nits and findings that
  contradict a deliberate design decision are dismissed **with a written reason**.
- **Parallel by default.** Serialize only on true `blocks` relations, same-file collisions, or the
  api-perf→db-query measurement ordering.
- **Scope over throughput** — Criticals + assignment rules, not all 75 tickets.

## Open questions

- **CodeRabbit GitHub App is NOT installed.** Verified, not assumed — the CLI reported
  *"troysatchell/Ship is not connected to a CodeRabbit organization you can access."* Until it is
  installed at app.coderabbit.ai there are no automatic PR reviews, and the auto-merge policy has
  nothing to gate on. The CLI still works locally via `gate.sh`.
- **A11Y-1 (`TRO-215`) cannot be closed by machine.** A screen-reader claim needs a human running
  VoiceOver — that is what escalated it to Urgent in the first place.
- **GitHub/GitLab divergence.** CI and CodeRabbit run on GitHub; the graded remote is GitLab;
  `origin` *fetches* from GitLab but pushes to both. A merge performed on GitHub is not in local
  `main` until pulled — push again before pulling and the remotes diverge. Needs a deliberate sync
  habit, not just the note in the skill.
- Still open from Jul 28: uncaught boot crash (lib0 Yjs decode, inside `TRO-188`); Terraform
  ownership of Render; free-tier sleep before Sunday.

## Watch-outs (verified)

- **`pnpm test` TRUNCATEs whatever `DATABASE_URL` points at** — `api/src/test/setup.ts:9-21`, 16
  tables, in the `beforeAll` of *every* api test file. This is why each factory ticket gets its
  own database. `gate.sh` refuses to run unless `DATABASE_URL` names a factory-owned DB.
- **Green-on-arrival is not green:** web has 13 known failures (TEST-1/`TRO-223`), quarantined by
  identity in `audit/factory/quarantine.json`. api is 451/451.
- **In a linked worktree `.git` is a FILE**, so `.git/info/exclude` fails "Not a directory" and
  under `set -e` aborts silently. Cost a worktree whose DB was created but never migrated.
- **`grep -c … || echo 0` yields `"0\n0"`** — `grep -c` prints `0` *then* exits 1.
- `pnpm db:migrate` still exits 0 while abandoning at migration 010 (DB-1 — reproduced again today).
- Root `pnpm test` runs **api only**. No local postgres — Docker `ship-audit-pg` on `:5433`.
- `scripts/worktree-init.sh` assumes `psql`/`createdb` on `:5432`; both absent here, so it
  degrades silently. Use `scripts/factory/worktree.sh`.
- `gh` cannot resolve the repo (origin fetches GitLab) — needs `GH_REPO=troysatchell/ship`, now set
  in `.claude/settings.local.json`.
- Pre-commit warns `comply` is missing and proceeds. Never `--no-verify`.
