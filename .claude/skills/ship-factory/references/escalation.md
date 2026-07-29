# Escalation: when the factory stops for a human

The operating instruction is **keep working; stop only when something needs verification**. That
only works if "needs verification" is defined in advance — otherwise it collapses into either
asking about everything or asking about nothing.

## Do NOT stop for these — decide and continue

- A gate failure inside the retry cap. Read the output, fix, re-run.
- Choosing between implementations that are equivalent in observable behaviour.
- Writing the regression test, the `CHANGES.md` entry, the PR body.
- CodeRabbit findings — triage them (`triage.md`). Filing a new ticket is not an escalation.
- Which ticket to take next, when the ordering rules in `SKILL.md` already decide it.
- Ordinary ambiguity a careful engineer would resolve by reading the code.
- "Should I keep going?" — yes. Between tickets, continue.

## STOP — human gate

### 1. Credentials, OAuth, or a browser session
Installing a GitHub App, Render/AWS/Linear auth, rotating a secret, anything with a login prompt.
The factory cannot complete these and should not try.

### 2. Irreversible or outward-facing actions
Dropping a column or table, deleting tracked files, force-push, rewriting history, `terraform
apply`, changing branch protection, publishing anything to a public remote that wasn't already
published, rotating credentials. Confirm first, every time, even if a similar action was approved
earlier — approval does not carry forward.

### 3. Merging — DELEGATED as of 2026-07-29, within limits
The maintainer has delegated merge authority: **once the CodeRabbit review is green, auto-merge.**
Pushing factory branches and opening their PRs is likewise pre-authorized.

That delegation covers **only** PRs that are gate-green, CI-green, triage-clean, and free of open
escalations. It does **not** cover: force-pushing, rewriting history, merging a PR whose gate
failed, merging something that trips any other item on this list, or pushing to any remote other
than the factory's own branches and `main`.

### 4. A fix that changes what users see or how the product behaves
Not "the code got faster" — "the product is different now". The standing example is **A11Y-1**:
the recommended fix is to *delete* `role="tree"`/`role="treeitem"` and let native list semantics
work. That is a deliberate subtraction with a UX consequence, and it is the user's call.
Same class: changing error copy, altering default views, changing what a keyboard shortcut does.

### 5. Any claim about screen-reader behaviour
Automated tooling cannot produce it. A11Y-1's escalation from High to Urgent happened only because
a human ran VoiceOver and heard silence where the tool predicted a mislabel. Any a11y ticket whose
acceptance depends on what is *announced* stops here for verification.

### 6. Auth, session, or security semantics
ERR-2 (revoked sessions retaining socket write access), anything touching `api/src/middleware/
auth.ts`, CSRF, cookie flags, or the collaboration server's authorization path. A passing test
still leaves room for a costly mistake. Get a human read before merge.

### 7. Three failed gates on one ticket
Mark it `blocked` in Linear with the gate output and your best read on the cause. Move on to the
next ticket — do not idle waiting for an answer, and do not raise the cap.

### 8. The ticket is wrong
The finding does not reproduce, is already fixed, or the report's diagnosis is mistaken. Do not
quietly close it and do not invent work to fill it. Report the disconfirming evidence — this has
happened before (DB-1 was described backwards in prose while the audit report had it right).

### 9. Scope explosion
A "one finding" ticket that needs more than ~40 files or a cross-cutting refactor. Either the
ticket boundary is wrong or the fix is a project. Stop and re-scope with the user.

### 10. Measurement that will not reproduce
A compare run that cannot match baseline conditions — missing seed volumes, a different pg
version, no way to re-auth for the a11y runner. Report what is missing rather than shipping a
number whose conditions differ from the baseline's.

## How to escalate without stalling the factory

Escalation blocks **that ticket**, not the run. Mark it, move to the next eligible ticket, and
keep going.

Batch the questions. The user should be able to answer a queue of decisions in one sitting and
have the factory resume, rather than being interrupted once per ticket. Hold escalations in a
running list and surface them together unless one is genuinely blocking everything.

When you do ask, give: what you were doing, the specific decision, what you would choose and why,
and what it costs if the choice is wrong. Not a menu with no recommendation.
