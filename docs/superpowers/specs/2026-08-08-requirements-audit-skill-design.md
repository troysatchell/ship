# Requirements-Audit Skill — Design Spec

**Date:** 2026-08-08
**Status:** Approved design, pre-implementation
**First consumer:** Ship repo (GFA Week 4 ShipShape PDF; Week 5 FleetGraph PDF when active)

## Purpose

A portable Claude Code skill (`requirements-audit`) that turns project guideline
PDFs into a verifiable requirements inventory, then sweeps a repo to produce a
three-way traceability matrix — requirement ↔ Linear ticket ↔ code (file:line) —
with behavioral verification gating the top verdict. Primary use now: checking
Troy's work against the sprint brief. Designed so a later "help the PM draft
tickets" mode can build on the same artifacts without rework.

## Decisions (from design Q&A)

1. **Portable, generic-first.** Nothing repo-specific in the skill; a per-repo
   config carries specifics. Ship is the first consumer, not the design target.
2. **Tickets live in Linear** (TRO-### prefix in Ship). The Linear MCP
   connector must be authorized once by the user; the skill degrades gracefully
   without it.
3. **Default run = whole-repo sweep** producing a requirement-by-requirement
   coverage matrix. Not per-ticket by default.
4. **Persistent requirements inventory.** PDFs are extracted once into a
   human-editable markdown inventory with stable IDs; re-extraction only when
   the PDF's hash changes.
5. **Three-way traceability.** The matrix flags requirements with no covering
   ticket (PM gap) and tickets mapping to no requirement (scope creep), in
   addition to requirement → code evidence.
6. **Ambiguity = ask + log.** Ambiguous requirements trigger one yes/no
   question in the main session; the ruling is recorded permanently and never
   re-asked.
7. **Gaps are persisted and handed to the repo's PM skill.** Written to
   `gaps.md`, then the configured PM skill (Ship: `ship-pm`, the factory's
   scope-gate owner) is invoked with that file so PM judgment — should these
   exist as tickets? — happens in the same run. Repos without a PM skill fall
   back to passive handoff: `gaps.md` plus a pointer appended to the repo
   memory bank when one exists. Nothing is ever auto-created in Linear by this
   skill; ticket creation stays behind the PM's own process.
8. **Behavioral evidence gates VERIFIED.** Static file:line tracing alone earns
   a lower tier.
9. **Structure: one phased skill** (Approach A) following ShipShape audit
   conventions — not a skill family, not a factory pipeline. Internal subagent
   fan-out is permitted for large inventories.

## Architecture

### Skill layout (portable, at `~/.claude/skills/requirements-audit/`)

```
requirements-audit/
├── SKILL.md              # entry point: modes, phase protocol
└── references/
    ├── config-template.yaml
    ├── inventory-format.md   # requirement entry schema + extraction rules
    └── report-format.md      # matrix/report/gaps templates, verdict definitions
```

### Per-repo config: `<repo>/audit/requirements.config.yaml`

```yaml
docs:
  - id: W4                          # short doc ID, prefixes requirement IDs
    path: "project guideliens/GFA_Week_4_ShipShape_Updated.pdf"
    sha256: <filled at extraction>
tickets:
  provider: linear
  team: TRO                          # ticket prefix
  project: null                      # optional narrowing
code_roots: [api/src, web/src, shared/src]
exclude: [node_modules, dist, audit]
pm_skill: ship-pm                    # repo's PM skill to hand gaps to; null = passive handoff
verify:                              # commands available for behavioral checks
  test: "npm test --workspace api"
  e2e: "npm run test:e2e"
  app_url: "http://localhost:5173"   # requires seeded app running
```

`init` mode writes this by auto-detection (finds PDFs in folders whose names
match guideline/brief patterns — e.g. `project guideliens/`, `ProjectGuidelines/`,
`docs/requirements/` — reuses verified commands from `audit/shipshape.config.yaml`
when present, and scans `.claude/skills/` for a PM-role skill by name/description
match, e.g. `ship-pm`) and asks brief yes/no questions only for what it cannot
detect. Detected candidates are confirmed with the user before being written to
config.

### Artifacts: `<repo>/audit/requirements/`

| File | Contents |
|---|---|
| `inventory.md` | One entry per requirement (see format below). Human-editable; user edits are authoritative. |
| `interpretations.md` | Ambiguity rulings: `I-##`, question asked, ruling, date, governed requirement IDs. |
| `matrix.baseline.json` / `matrix.after-<label>.json` | Machine-readable trace per requirement: tickets, evidence `{file, line, note}`, verdict, verification `{command, result_excerpt}`. |
| `REPORT.md` | Human report: verdict counts up top, full matrix table, gaps, orphan tickets, deltas in compare mode. |
| `gaps.md` | Handoff for another agent: unticketed requirements (with source quotes) and orphan tickets. |

### Inventory entry format

```markdown
## W4-R12
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.6
- **Quote:** "<exact text from the PDF — never paraphrased>"
- **Meaning in code:** <normalized, testable statement of what satisfies this>
- **Type:** functional | non-functional | process
- **Acceptance evidence:** <what a green check looks like: test, endpoint probe, artifact>
- **Interpretation:** I-03 (only when a ruling governs this requirement)
- **Status:** active | retired
```

IDs are stable: `<docID>-R<n>`, assigned once, never renumbered. Retired
requirements keep their entry with `Status: retired` so old reports stay
readable.

### Verdict tiers

| Verdict | Bar |
|---|---|
| `VERIFIED` | Behavioral evidence green (command run, output captured) |
| `IMPLEMENTED-UNVERIFIED` | file:line trace exists; no behavioral check ran |
| `PARTIAL` | Some acceptance evidence present, some missing (report says which) |
| `MISSING` | No implementing code found |
| `N/A` | Process/non-code requirement (e.g., "record a demo video") |
| `BLOCKED` | Could not check (e.g., Linear unauthorized) — never silently downgraded |
| `ASSUMED` | Traced under a stated assumption pending a user ruling (see ambiguity cap) |

### Modes

- `init` — write per-repo config (auto-detect + minimal questions).
- `baseline` — full sweep (phases below).
- `compare <label>` — reuse inventory + interpretations untouched; re-trace,
  re-verify, report verdict deltas against baseline.
- `extract` — refresh inventory only (used when a PDF changes).

## Run flow (baseline)

1. **Init** (first run only) — as above.
2. **Extract** — read the PDF page-by-page; build `inventory.md`. Exact quotes
   are mandatory; interpretation lives only in the "Meaning in code" field.
   Record the PDF sha256 in config. Ask the user to skim the inventory once
   before the first sweep; their edits are authoritative thereafter.
3. **Ticket mapping** — pull the configured Linear team's tickets, match to
   requirement IDs by content, record both directions (unticketed requirements,
   orphan tickets). Linear unreachable → ticket cells `BLOCKED`, run continues.
4. **Code trace + verify** — per requirement: locate implementing code, cite
   `file:line`. Ambiguity triggers one yes/no question in the main session,
   logged to `interpretations.md`. Where config maps a behavioral check, run
   it; `VERIFIED` only on green captured output. Inventories over ~25
   requirements may fan out tracing to parallel subagents by requirement
   cluster; ambiguity questions always return to the main session.
5. **Report + handoff** — write `matrix.baseline.json` (compare:
   `matrix.after-<label>.json`), `REPORT.md`, `gaps.md`. If
   `pm_skill` is configured, invoke it with the `gaps.md` path and a one-line
   framing ("requirements sweep found N unticketed requirements and M orphan
   tickets; apply your scope gate") so PM judgment runs immediately; the PM
   skill owns everything downstream (whether gaps become tickets, triage of
   orphans). Otherwise: passive handoff — `gaps.md` plus a one-line pointer
   appended to the repo memory bank if one exists.

## Error handling

Rule: never silently downgrade missing evidence into a confident verdict.

- **PDF missing/unreadable (image-only):** fail extract with a message naming
  the config path; offer to proceed from a user-provided text export.
- **Linear unauthorized:** continue; ticket-dependent cells `BLOCKED` with
  authorization instructions in the report.
- **Verify command cannot run** (app down, seed missing): verdict stays
  `IMPLEMENTED-UNVERIFIED` with the environment reason recorded. A failed
  environment is never a failed requirement, and never a fake `VERIFIED`.
- **PDF hash mismatch:** stop, ask whether to re-extract. Unchanged quotes keep
  their IDs; new requirements get new IDs; removed ones are retired.
- **Question-flood cap:** a first sweep asks only blocking ambiguity questions;
  the rest proceed as `ASSUMED` with the assumption stated in the report, so a
  sweep always finishes. `ASSUMED` items are listed for later rulings.
- **Configured `pm_skill` not found in the repo:** warn in the report and fall
  back to passive handoff (`gaps.md` + memory-bank pointer). Never a run
  failure — the audit's own artifacts are already complete by this phase.

## Testing & acceptance

Shakedown: run `baseline` on Ship against the Week 4 ShipShape PDF.

- Every inventory row appears in `matrix.baseline.json` and `REPORT.md` (no silent drops).
- Every `VERIFIED` verdict carries the command and a captured output excerpt.
- Every `MISSING` requirement appears in `gaps.md`.
- Determinism: a second baseline with no code changes yields identical verdicts.
- Follow-up: run the `skill-audit` skill over the finished skill for a formal pass.

## Future (explicitly deferred)

- **Deeper PM integration:** the `pm_skill` handoff already routes gaps into
  the factory's scope gate. Deferred: this skill drafting ticket text itself,
  or running as a formal pre-spec step in the factory pipeline. Stable
  requirement IDs + `gaps.md` remain the seam.
- **Ticket providers beyond Linear** (config `provider` field is the seam).

## Out of scope (YAGNI)

- Auto-creating or editing anything in Linear.
- Scoring/weighting requirements, burndown charts, dashboards.
- Non-PDF guideline sources (markdown briefs can be added to `docs:` later
  without design changes — extraction simply skips the PDF-specific steps).
