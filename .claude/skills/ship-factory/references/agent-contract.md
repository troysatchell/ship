# The coding sub-agent contract

Fill this in and hand it to the agent verbatim. Substitute `{{...}}`. Append the current contents
of `lessons.md` under *Standing rules* — that is how eval feedback reaches the worker.

Then append the **role brief** for the finding's category — `/ship-frontend`, `/ship-backend`, or
`/ship-qa`, per the routing table in `/ship-orchestrator` §1. This contract is domain-blind by
design; the role brief is what carries the repo's actual frontend/backend/test facts. A brief
without one leaves the agent to rediscover them, usually by breaking something first.

---

## Brief

You are fixing one ticket in the Ship repository — or, where the orchestrator has grouped several,
the whole group on one branch. Nothing outside it.

**Tickets:** {{TICKET_IDS}} — {{TICKET_TITLES}}
**Findings:** {{FINDING_IDS}} (from `audit/AUDIT_REPORT.md` — read every listed section first)

**If more than one ticket is listed, read which kind of group this is — they are not the same job:**

- **A batch** — tickets that share a single root cause. They are **one change**: fix the shared
  cause once.
- **A bundle** (`{{BUNDLE_ID}}`, a `[PR-x] EPIC` parent) — tickets grouped so they ship as one PR
  because they share a *surface*, not a cause. They are **several distinct changes** on one branch,
  committed in the order the epic states. **Do not collapse them into one commit or one fix** — each
  has its own problem, its own change, and its own proof, and the PR body is structured per ticket.

Either way: **every** listed ticket must be covered by its own regression test, named in
`CHANGES.md`, closed by the PR, and accounted for in your final report. In a bundle the gate runs
on the branch, so one ticket's test can mask another's absence — check per ticket, not per branch.
**Worktree:** `{{WORKTREE_PATH}}` — already provisioned. Work only here.
**Branch:** `{{BRANCH}}` — already checked out. Do not switch branches.
**Database:** yours exclusively; `DATABASE_URL` is in `.factory-env`. `source .factory-env` first.

### Start by reading

1. The finding's section in `audit/AUDIT_REPORT.md` — it separates **Evidence** from **Hypothesis**
   from **Estimated impact**. The Evidence is what was measured; the Hypothesis may be wrong.
2. The Linear ticket body for the user-facing framing.
3. `.claude/CLAUDE.md` — repo conventions. Non-negotiable.

### What you must produce

1. **The fix.** Smallest change that addresses the finding's root cause. If the report's
   hypothesis turns out to be wrong, fix what is actually broken and say so — do not implement a
   wrong diagnosis because it was written down.
2. **A regression test that fails before your fix and passes after.** Assignment rule 3 requires
   one per audit bug. Confirm it fails for the *right reason* on the unfixed code — an import
   error is not a red test. State in your report that you saw it red first.
   It must live in a **vitest** file the gate actually runs — `api/src/**/*.test.ts` or
   `web/src/**/*.test.ts(x)`. A test added only as `e2e/*.spec.ts` satisfies the gate's
   regression-test check while never executing, because neither vitest config includes `e2e/`. Add
   an e2e spec as well if the flow deserves it; it is additive coverage, not the proof.
3. **A `CHANGES.md` entry** naming `{{TICKET_ID}}`: what changed, how to run it, how to roll it
   back. Assignment rule 8.
4. **Commits with real messages.** The git history is read directly and is 10% of the grade.
   Conventional-commit prefixes, one logical change per commit.

### Rules you may not break

- **Never `git commit --no-verify`.** Pre-commit runs a compliance scan. If it fails, fix the
  cause.
- **Never weaken a test to get green.** No `.skip`, no `.todo`, no deleted assertions, no widening
  `audit/factory/quarantine.json`. The gate greps your diff for all of these. If a test genuinely
  must change, stop and escalate.
- **Never touch files outside the finding's scope.** Drive-by fixes belong in their own ticket.
- **Schema changes go in numbered migrations** (`api/src/db/migrations/NNN_*.sql`), never by
  editing `schema.sql` for an existing table.
- **Do not reference dropped columns** — `documents.sprint_id`, `documents.project_id`,
  `documents.program_id` are all gone. (`sprint_iterations.sprint_id` is a different, live column.)
- **Do not run `pnpm test` with an unset `DATABASE_URL`.** It TRUNCATEs 16 tables in whatever it
  points at.

### Claim provenance — this repo enforces it

Three documented failures here came from stating a derived claim with the confidence of an
observed one. In your report and your PR body:

- Mark **observed** vs **derived**. "axe reports X, which usually means Y" — not "it does Y."
- State the **configuration** every check ran under. A pass under a config that skips the broken
  path proves nothing. (`NODE_ENV=development` returning early past `ssm.ts:39` is how a real
  production break got missed.)
- Check the **specific case**, not the general mechanism. A mechanism's usual behaviour is not its
  behaviour here.
- If disconfirming evidence exists in the repo, read it before asserting.

### Working style

**Keep going.** Do not stop to ask whether to continue, which equivalent approach to pick, or
whether to write the test — write it. Run `scripts/factory/gate.sh --fast` as your inner loop and
fix what it reports.

Stop and report **only** if: the finding does not reproduce; the fix requires credentials, a
browser login, or an irreversible action; the fix changes user-visible product behaviour; it
touches auth/session/security semantics; or the work has clearly outgrown one ticket.

### Definition of done for you

`scripts/factory/gate.sh` returns `verdict: pass`. Run it before reporting. The orchestrator will
run it again independently — your self-report is a claim, that run is the result.

### Your final message

Return, concisely:

- What was actually broken (root cause, `file:line`), and whether the report's hypothesis held.
- What you changed and why that addresses the cause.
- The regression test: its path, and confirmation you saw it fail before the fix.
- Gate result.
- Anything you could not verify, and what would be needed to verify it.
- Any *new* problem you noticed but did not fix — it becomes a ticket, so describe it precisely.

---

## PR body template

```markdown
## {{TICKET_IDS}} — {{TITLES}}

<!-- One `Closes` line PER ticket — GitHub only auto-closes what it sees named
     individually, and a batched branch that closes one of three leaves two
     tickets open with their work already merged. -->
Closes {{TICKET_ID_1}}. Audit finding `{{FINDING_ID_1}}`.
Closes {{TICKET_ID_2}}. Audit finding `{{FINDING_ID_2}}`.

### What was broken
{{root cause, file:line}}

### What changed
{{the fix, and why it addresses the cause rather than the symptom}}

### Evidence
| Check | Result | Ran under |
|---|---|---|
| Regression test | {{path}} — red before, green after | {{command}} |
| Gate | {{pass}} | `scripts/factory/gate.sh` |
| Measurement | {{before → after, or "n/a — correctness fix"}} | {{conditions}} |

**Observed:** {{what was actually run and seen}}
**Derived:** {{what is inferred, and from what}}
**Not verified:** {{what this PR does not establish}}

### Rollback
{{how to undo}}
```

### Bundle PRs

A bundle ships several distinct changes, so **repeat the *What was broken* → *What changed* →
*Evidence* block once per sub-issue**, under its ticket id as a heading. Keep the `Closes` lines
together at the top and the `Rollback` section at the bottom, covering the branch as a whole.

Then add, before Rollback:

```markdown
### Bundle
Bundle: {{BUNDLE_ID}} — {{BUNDLE_TITLE}}
Bundle definition of done: {{each item, with pass/fail}}
Dropped from this bundle: {{ticket + reason, or "none"}}
```

**A bundle PR written as one undifferentiated change has defeated its own purpose.** The point of
bundling was to spend one review well, not to make four changes harder to see. If the reviewer
cannot tell which diff belongs to which ticket, restructure the body before opening it.
