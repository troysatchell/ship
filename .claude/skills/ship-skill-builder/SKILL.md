---
name: ship-skill-builder
description: >-
  Build, wire in, and maintain engineering skills for this repository — decide whether knowledge
  belongs in a skill at all (versus lessons.md, CLAUDE.md, docs/, or the memory bank), verify every
  claim against the code before writing it down, wire a role skill into the factory's agent brief so
  it actually changes behaviour, and retire skills that have gone stale. Use when the user asks for
  a new skill, when a factory gap needs codifying, or when an existing skill's claims no longer
  match the repo.
---

# Ship skill builder

Anthropic ships a general skill-creator. This one is narrower on purpose: it encodes where
knowledge goes **in this repo**, which has five competing homes for it, and it refuses to let a
skill assert anything that wasn't checked against the code.

A skill here is not documentation. It is **a brief that changes what an agent does** — most often a
factory sub-agent that will never read `docs/`. If a new skill would not change any agent's
behaviour, it should not exist.

## Step 1 — decide it should be a skill at all

Five places hold knowledge in this repo and they are not interchangeable. Most requests for "a new
skill" are actually one of the cheaper four.

| Put it here | When | Cost |
|---|---|---|
| **`lessons.md`** (`ship-factory/references/`) | A single rule that would have prevented one gate failure. Injected into **every** agent brief. | One line. Free to add, but every line taxes every future prompt — noise degrades all of them. |
| **`.claude/CLAUDE.md`** | A convention that applies to *every* session in this repo regardless of task. Loaded always. | Loaded always — the most expensive real estate. Reserve it. |
| **`docs/`** | Architecture, design rationale, "why we chose this". Read on demand by humans and agents making design decisions. | Free, but agents only read it when told to. |
| **`memory-bank/`** | Sprint state — what's in flight, what was verified when, dated. Changes weekly. | Free. Wrong place for anything durable. |
| **A skill** | A **role or workflow** with enough domain content that it needs its own document, invoked selectively for a class of task. | A whole file plus maintenance. Justify it. |

The test for a skill: **can you name the class of task that loads it, and the class that doesn't?**
`/ship-frontend` loads for `web/` work and not for a DB migration — that's a skill. "Always
parameterize SQL" loads for everything — that's a `lessons.md` line.

Three failure modes to refuse outright:

- **A skill that restates framework docs.** "How to use React hooks" helps nobody; the model knows.
  Only repo-specific truth earns space: `DocumentTreeItem.tsx:70` has a `role` with no `onKeyDown`.
- **A skill that duplicates an existing one.** `e2e/AGENTS.md` already covers e2e flake patterns;
  `/ship-qa` **points at it** rather than restating it. Two copies of a rule means one will be wrong
  after the next change.
- **A skill nothing invokes.** See step 4. An unwired skill is a file, not a capability.

## Step 2 — verify before you write

This repo has three documented failures with one shared cause: **a derived claim written down with
the confidence of an observed one** (`.claude/CLAUDE.md`, "Claim provenance"). A skill multiplies
that risk, because every future agent inherits the claim without the evidence.

Before a factual claim enters a skill:

1. **Open the file.** Not "Express apps usually…" — `api/src/middleware/auth.ts:169`. Cite
   `file:line`. Line numbers move; a wrong-but-close anchor still lands the reader in the right
   file, and a missing one lets a stale claim survive indefinitely.
2. **Run the command.** If the skill says `pnpm lint` does nothing, confirm no package defines a
   `lint` script. If it names a test count, run the suite or read the report.
3. **Mark derived claims as derived, and date them.** "Derived from reading the three vitest configs
   and the gate script on 2026-07-29 — not from a forged branch" is a usable claim. "The gate has a
   hole" is not.
4. **Check the specific case, not the category.** DB-1 skips migrations *in general*; against a
   fresh database it doesn't matter, because `migrate.ts:38-41` applies `schema.sql` first. The
   general mechanism and the specific case disagreed, and the general one got written down.
5. **Look for disconfirming evidence already in the repo.** Twice it was there — in the audit report
   and in a source file that could have been opened.

State the configuration for anything measured. A number without its conditions is not evidence.

## Step 3 — write it

**Frontmatter**, exactly two fields:

```yaml
---
name: ship-<role-or-workflow>          # kebab-case, matches the directory name
description: >-                        # third person, one or two sentences
  What it does — then the trigger conditions: "Use when …".
---
```

The `description` is the **only** part loaded before invocation. It is a retrieval key, not a
summary — write the words someone would actually use ("when a gate fails on tests", "when working
in `web/`", "TEST-* finding"), and name the file paths and finding prefixes that identify the
domain.

**Body budget: under ~200 lines.** Past that, split: keep the decisions and the rules in `SKILL.md`,
move long procedures, templates, and tables into `references/*.md` and say when to read each — the
factory skill's own structure is the model (`SKILL.md` + five references).

**Conventions in this repo:**

- Location `.claude/skills/<name>/SKILL.md`, prefix `ship-` for repo-specific skills.
- Rule-dense, not tutorial. Bold the rule, then one sentence of *why it exists* — a rule with a
  cost attached survives; a bare imperative gets rationalized away at 2am.
- **Every rule earns its place by having caught a real failure.** Say which. "Never widen the
  quarantine" is followed because the reader learns the gate greps for it.
- Give the command with the flags that matter (`pnpm --filter @ship/web test`, not "run the tests").
  Half the bugs in this repo's claims come from an omitted filter.
- Prefer a table for anything with 3+ parallel cases. Prose hides the case you didn't handle.
- Note what the skill does **not** establish. `/ship-frontend` says a jsdom pass is evidence about
  logic, not layout or focus order.

## Step 4 — wire it in, or it does nothing

A skill that no path reaches is dead weight. Pick at least one:

- **Factory role brief** — add it to the routing table in `/ship-orchestrator` §1 so the
  orchestrator injects it for that finding class. This is the wiring for anything a coding sub-agent
  needs.
- **Named in a step** of an existing skill, at the point of need ("read `references/evals.md` before
  your first dispatch").
- **Description sharp enough for autonomous retrieval** — the model picks it up from the trigger
  words alone. Necessary but weakest; don't rely on it for something load-bearing.
- **A `CLAUDE.md` pointer** — for a skill that must fire in every session. One line, and only if it
  genuinely must.

Then verify the wiring: does the routing table entry exist, and does the referring skill name the
file correctly? A typo'd reference fails silently.

## Step 5 — prove it changed behaviour

The honest test is behavioural, not editorial.

1. **Trigger test.** Give the phrasing a real user would use and check the skill is what loads. If
   two skills compete, the descriptions overlap — tighten the narrower one.
2. **A/B on a real task.** Run a representative task with and without the brief. If the output is
   the same, the skill is either redundant or too vague. This is the only test that distinguishes
   the two.
3. **Contradiction sweep.** Grep the other four homes for the same rule. If `CLAUDE.md` and the new
   skill both state it, delete one — and delete the copy in the *narrower* file, keeping the
   broadly-loaded one.
4. **Report what you didn't verify.** A skill shipped with three checked claims and one derived one
   is fine if the derived one says so.

## Step 6 — maintain, and retire

Skills rot faster than code because nothing type-checks them.

- **A skill contradicted by the repo is worse than no skill** — it drives confident wrong decisions.
  When a claim turns out stale, fix it in the same session you noticed and say what it changes
  downstream.
- **Promotion rule:** when the same `lessons.md` line has fired on 3+ tickets in one domain, it has
  outgrown the shared brief — move it into that domain's role skill, with the ticket that taught it,
  and delete the line. `lessons.md` stays short or it stops working.
- **Demotion rule:** a skill whose rules never fire is a candidate for deletion, not for expansion.
- **After a schema, config, or tooling change**, grep the skills for the thing you changed. Dropped
  columns, renamed scripts, and moved ports are exactly what skills assert about.
- Anchor claims to `file:line` and date the derived ones, so the next reader can tell a checked
  claim from an inherited one.

`references/checklist.md` has the pre-commit review pass for a new or edited skill.
