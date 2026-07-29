# Review pass for a new or edited skill

Run this before committing. Any "no" is a fix, not a note.

## Existence

- [ ] I can name the class of task that loads this skill **and** the class that doesn't.
- [ ] It is not one of the cheaper four homes in disguise (`lessons.md` line, `CLAUDE.md` rule,
      `docs/` page, memory-bank entry).
- [ ] It does not duplicate an existing skill, `e2e/AGENTS.md`, or a `docs/` page. Where it overlaps,
      it **points** rather than restates.
- [ ] It contains nothing the model already knows about the framework — only repo-specific truth.

## Claims

- [ ] Every factual claim was checked against the repo in this session.
- [ ] Anchors are `file:line`, not "the sidebar" or "the auth middleware".
- [ ] Commands include the flags that change the result (`--filter`, `--base`, env vars).
- [ ] Derived claims are marked derived, with what they were derived from and the date.
- [ ] Measured claims state the configuration they ran under.
- [ ] Counts (test totals, file counts, finding numbers) were read from a report or a command, not
      remembered.
- [ ] The skill says what it does **not** establish.

## Form

- [ ] Frontmatter has exactly `name` and `description`; `name` matches the directory.
- [ ] `description` is third person and contains the trigger words a user would actually type,
      plus the file paths / finding prefixes that identify the domain.
- [ ] Body is under ~200 lines; anything longer moved to `references/` with a stated read-trigger.
- [ ] Rules are bolded with the reason attached — the cost of breaking them is visible.
- [ ] Tables used wherever there are 3+ parallel cases.

## Wiring

- [ ] At least one path reaches it: orchestrator routing table, a named step in another skill, a
      `CLAUDE.md` pointer, or a description sharp enough for retrieval.
- [ ] The referring file names it correctly (typos fail silently).
- [ ] If it is a factory role brief, `/ship-orchestrator` §1's routing table lists it.

## Verification

- [ ] Trigger test: the intended phrasing loads this skill and not a neighbour.
- [ ] A/B: a representative task produces different output with the brief than without.
- [ ] Contradiction sweep: `grep` the other homes for the same rule; duplicates removed from the
      narrower file.

## Repo rules

- [ ] No `git commit --no-verify` — pre-commit runs the compliance scan.
- [ ] Committed with a conventional-commit message naming what the skill closes.
- [ ] `memory-bank/activeContext.md` / `progress.md` updated if this changed how the factory runs.
