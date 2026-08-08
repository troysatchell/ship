# Requirements-Audit Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. When authoring skill files (Tasks 1–5), also load superpowers:writing-skills for skill-authoring discipline.

**Goal:** Build the portable `requirements-audit` skill that extracts guideline PDFs into a requirements inventory and sweeps a repo into a three-way traceability matrix (requirement ↔ Linear ticket ↔ code file:line), then shake it down against the Ship repo's Week 4 PDF.

**Architecture:** One phased skill at `~/.claude/skills/requirements-audit/` (SKILL.md + 3 reference files), config-driven per repo, following ShipShape audit conventions (modes, artifact contract, determinism). Spec: `docs/superpowers/specs/2026-08-08-requirements-audit-skill-design.md` (Ship repo).

**Tech Stack:** Claude Code skill (markdown), YAML config, JSON artifacts. No application code.

## Global Constraints

Copied from the spec — every task implicitly includes these:

- The skill is portable: NO repo-specific commands, paths, ticket prefixes, or skill names hardcoded in any skill file. All repo facts live in `<repo>/audit/requirements.config.yaml`.
- Requirement IDs are `<docID>-R<n>`, assigned once, never renumbered. Removed requirements are marked `Status: retired`, never deleted.
- Inventory quotes are verbatim PDF text — interpretation lives only in the "Meaning in code" field.
- `VERIFIED` requires green behavioral evidence (command run, output captured). Static file:line tracing alone is `IMPLEMENTED-UNVERIFIED`.
- Never silently downgrade missing evidence into a confident verdict. A failed environment is never a failed requirement.
- This skill never creates or edits anything in Linear, and never modifies application source code.
- `~/.claude/skills` is NOT git-tracked: skill-file tasks verify by existence/parse checks, no commits. Ship-repo artifacts (config, audit outputs) ARE committed.
- Artifact/verdict/mode conventions mirror `~/.claude/skills/shipshape-audit/references/conventions.md` where applicable.

---

### Task 1: Skill scaffold + config template

**Files:**
- Create: `~/.claude/skills/requirements-audit/references/config-template.yaml`

**Interfaces:**
- Produces: the config schema every later task reads. Field names are load-bearing: `docs[].id`, `docs[].path`, `docs[].sha256`, `tickets.provider`, `tickets.team`, `tickets.project`, `code_roots`, `exclude`, `pm_skill`, `verify` (map of label → command), `verify_urls.app`.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p ~/.claude/skills/requirements-audit/references
```

- [ ] **Step 2: Write `references/config-template.yaml`**

```yaml
# requirements-audit per-repo config
# Written by `/requirements-audit init` — hand-edit freely; the skill re-reads it every run.
# The skill hardcodes nothing repo-specific: if a fact about this repo matters, it lives here.

docs:
  # One entry per guideline document. `id` prefixes requirement IDs (e.g. W4 -> W4-R12).
  # `sha256` is filled at extraction; a mismatch on a later run stops the sweep and
  # offers re-extraction.
  - id: W4
    path: "project guideliens/GFA_Week_4_ShipShape_Updated.pdf"
    sha256: null

tickets:
  provider: linear        # only supported value today; field exists as the seam
  team: TRO               # Linear team key / ticket prefix
  project: null           # optional: narrow to one Linear project

code_roots:               # directories searched during the trace phase
  - api/src
  - web/src
  - shared/src
exclude:                  # never searched, never cited as evidence
  - node_modules
  - dist
  - audit

# Repo's PM skill to hand gaps to after the sweep (invoked via the Skill tool).
# null = passive handoff: gaps.md + memory-bank pointer only.
pm_skill: null

# Commands available for behavioral verification. Keys are labels the inventory's
# "Acceptance evidence" field references; values run from the repo root.
verify:
  test: "pnpm test"
  e2e: "pnpm run test:e2e"
verify_urls:
  app: "http://localhost:5173"   # requires the seeded app running; probes only, never mutates
```

- [ ] **Step 3: Verify the YAML parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('$HOME/.claude/skills/requirements-audit/references/config-template.yaml')); print('OK')"
```

Expected: `OK`

### Task 2: Inventory format reference

**Files:**
- Create: `~/.claude/skills/requirements-audit/references/inventory-format.md`

**Interfaces:**
- Consumes: config schema from Task 1 (`docs[].id` prefixes requirement IDs).
- Produces: the inventory entry schema and `interpretations.md` entry schema that SKILL.md (Task 4) instructs phases to follow, and that report-format (Task 3) references. Exact field labels: `Source`, `Quote`, `Meaning in code`, `Type`, `Acceptance evidence`, `Interpretation`, `Status`.

- [ ] **Step 1: Write `references/inventory-format.md`**

````markdown
# Requirements Inventory Format

Governs `<repo>/audit/requirements/inventory.md` and `interpretations.md`.
The inventory is the single source of truth for WHAT is required; the user's
edits to it are authoritative over the skill's extraction.

## What counts as a requirement

Extract an entry for each independently checkable obligation in the document:

- Imperatives and deliverables ("must", "required", "submit", "implement", "your app should").
- Rubric / grading-criteria lines — each scored line is a requirement.
- Numeric floors and ceilings ("at least 500 documents", "under 3 seconds").
- Stated process obligations (demo video, README section, deployed URL). These
  become `Type: process` and usually verdict `N/A` for the code sweep — extract
  them anyway; the matrix reports them so nothing in the brief is invisible.

Split compound sentences into separate entries when the parts are separately
satisfiable ("export to CSV and PDF" = two entries if one could ship without the
other). Do NOT extract background prose, motivation, or examples — if failing it
couldn't be pointed to on a rubric, it is not a requirement.

## Entry schema

```markdown
## W4-R12
- **Source:** GFA_Week_4_ShipShape_Updated.pdf, p.6
- **Quote:** "<exact text from the PDF — never paraphrased, never trimmed mid-clause>"
- **Meaning in code:** <one testable sentence: what existing in this repo satisfies this>
- **Type:** functional | non-functional | process
- **Acceptance evidence:** <what green looks like, naming a verify label from config
  when one applies, e.g. "verify.test — api/tests/documents.test.ts covers the
  500-doc seed floor" or "file:line of the route registration">
- **Interpretation:** I-03   <!-- only when a ruling governs this entry -->
- **Status:** active | retired
```

## ID rules

- `<docID>-R<n>`, `n` sequential per document in extraction order. Assigned once,
  never renumbered, never reused — even after retirement.
- Re-extraction after a PDF change: entries whose Quote still appears in the new
  PDF keep their ID (page number may update). New text gets new IDs continuing
  the sequence. Entries whose Quote is gone become `Status: retired` with a
  `Retired: <date> — <reason>` line appended. Old reports stay readable forever.

## interpretations.md entry schema

```markdown
## I-03
- **Date:** 2026-08-08
- **Governs:** W4-R12, W4-R14
- **Question:** "Does 'real-time updates' require WebSocket push, or does
  polling satisfy it?" (asked as yes/no: "Is polling acceptable?")
- **Ruling:** Yes — polling acceptable at <=5s interval.
- **Consequence:** trace accepts `web/src/hooks/usePolling.ts` as implementing
  W4-R12; WebSocket absence is not a gap.
```

Rulings are permanent: before asking any ambiguity question, search this file —
if a ruling governs the requirement, apply it silently. Never re-ask.

## Extraction procedure

1. Compare the PDF's current sha256 against `docs[].sha256` in config. Match →
   inventory is current, skip extraction. Null (never extracted) → proceed.
   Mismatch while an inventory already exists → STOP and ask the user whether
   to re-extract; on yes, apply the ID rules above (stable IDs, retirement).
2. Read the PDF page-by-page (Read tool `pages` parameter, <=20 pages per call).
3. Write entries in document order. Quotes copied exactly, page numbers recorded.
4. Update `docs[].sha256` in the config (`shasum -a 256 <pdf>`).
5. First extraction for a document: STOP and ask the user to skim the inventory
   before any sweep uses it. Their edits are authoritative from then on — a
   later run never overwrites a user-edited field except via the re-extraction
   ID rules above.
````

- [ ] **Step 2: Verify the file exists and is non-trivial**

```bash
wc -l ~/.claude/skills/requirements-audit/references/inventory-format.md
```

Expected: 80+ lines.

### Task 3: Report format reference

**Files:**
- Create: `~/.claude/skills/requirements-audit/references/report-format.md`

**Interfaces:**
- Consumes: inventory entry schema (Task 2), config schema (Task 1).
- Produces: `matrix.json` schema, verdict definitions, `REPORT.md` / `gaps.md` templates, and the PM handoff framing text that SKILL.md (Task 4) instructs Phase 4 to follow. Exact verdict strings: `VERIFIED`, `IMPLEMENTED-UNVERIFIED`, `PARTIAL`, `MISSING`, `N/A`, `BLOCKED`, `ASSUMED`.

- [ ] **Step 1: Write `references/report-format.md`**

````markdown
# Report, Matrix, and Gaps Formats

Governs `<repo>/audit/requirements/matrix.baseline.json` (compare mode:
`matrix.after-<label>.json`), `REPORT.md`, `gaps.md`.

## Verdict tiers

| Verdict | Bar |
|---|---|
| `VERIFIED` | Behavioral evidence green: a `verify` command ran, output captured in the matrix |
| `IMPLEMENTED-UNVERIFIED` | file:line trace exists; no behavioral check ran (or it could not run — reason recorded) |
| `PARTIAL` | Some acceptance evidence present, some missing — the matrix entry names which part is missing |
| `MISSING` | No implementing code found in `code_roots` |
| `N/A` | Process/non-code requirement; nothing in the repo can satisfy it |
| `BLOCKED` | Could not check (e.g. Linear unauthorized); never silently downgraded to MISSING |
| `ASSUMED` | Traced under a stated assumption pending a user ruling (question-flood cap) |

## matrix.json schema

```json
{
  "mode": "baseline",
  "commit": "<git SHA of the swept tree>",
  "dirty": false,
  "date": "<ISO 8601>",
  "config_hash": "<sha256 of requirements.config.yaml>",
  "requirements": [
    {
      "id": "W4-R12",
      "verdict": "VERIFIED",
      "tickets": ["TRO-356"],
      "evidence": [
        { "file": "api/src/routes/documents.ts", "line": 142, "note": "route registration incl. OpenAPI" }
      ],
      "verification": {
        "command": "pnpm test -- documents",
        "result_excerpt": "<last ~5 lines of green output, verbatim>"
      },
      "interpretation": "I-03",
      "assumption": null,
      "notes": null
    }
  ],
  "orphan_tickets": [
    { "ticket": "TRO-399", "title": "<ticket title>", "note": "maps to no inventory requirement" }
  ],
  "baselineRef": "matrix.baseline.json   (compare mode only)"
}
```

Field rules: `verification` is null unless verdict is `VERIFIED`. `assumption`
is non-null exactly when verdict is `ASSUMED` (one sentence stating the
assumption). Every inventory entry with `Status: active` MUST appear in
`requirements` — no silent drops. `BLOCKED` entries carry a `notes` string
saying what was blocked and how to unblock.

In compare mode, write `matrix.after-<label>.json`; baseline stays untouched as
`matrix.baseline.json`.

## REPORT.md structure

```markdown
# Requirements Audit — <repo name>
**Commit:** <sha> · **Date:** <ISO> · **Docs:** W4 (p.1–12) · **Mode:** baseline

## Summary
<counts per verdict tier, one line each; then 3 lines max of prose: the overall
state and the most important gap.>

## Matrix
| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
<one row per active inventory entry, in inventory order. Evidence column:
file:line list or "—". Short label, not the full quote.>

## Gaps
<subset: MISSING + PARTIAL rows with their missing part named.>

## Orphan tickets
<tickets mapping to no requirement, with titles.>

## Blocked / assumed
<every BLOCKED row with its unblock instruction; every ASSUMED row with its
assumption, flagged for a later ruling.>

## Delta (compare mode only)
| ID | baseline verdict | now | evidence change |
<only rows whose verdict changed.>
```

## gaps.md structure (the PM handoff file)

```markdown
# Requirements gaps — <repo name> (<ISO date>, commit <sha>)

## Unticketed requirements
### W4-R17 — MISSING
- **Quote:** "<verbatim quote from inventory>"
- **Source:** <doc>, p.<n>
- **Meaning in code:** <from inventory>
- **Suggested scope:** <1–2 sentences: smallest change that would satisfy it>

## Orphan tickets
- TRO-399 "<title>" — no requirement maps to it. <one line: why it appears unrelated>
```

## PM handoff

If config `pm_skill` is non-null and that skill exists in the target repo's
`.claude/skills/` (or user-level skills): invoke it via the Skill tool with
args: `"Requirements sweep found <N> unticketed requirements and <M> orphan
tickets; apply your scope gate. Gaps file: <repo>/audit/requirements/gaps.md"`.
The PM skill owns everything downstream (whether gaps become tickets, orphan
triage). If the skill is configured but not found: warn in REPORT.md's Summary
and fall back to passive handoff. Passive handoff (also when `pm_skill` is
null): if the repo has a memory bank (`memory-bank/activeContext.md`), append
one line: `- Requirements sweep <date>: <N> gaps, <M> orphans — see
audit/requirements/gaps.md`. Never a run failure either way.
````

- [ ] **Step 2: Verify the embedded JSON schema example parses**

```bash
python3 - <<'EOF'
import json, re
text = open(f"{__import__('os').environ['HOME']}/.claude/skills/requirements-audit/references/report-format.md").read()
block = re.search(r'```json\n(.*?)```', text, re.S).group(1)
json.loads(block)
print("OK")
EOF
```

Expected: `OK`

### Task 4: SKILL.md — entry point and phase protocol

**Files:**
- Create: `~/.claude/skills/requirements-audit/SKILL.md`

**Interfaces:**
- Consumes: all three reference files by exact relative path (`references/config-template.yaml`, `references/inventory-format.md`, `references/report-format.md`); config field names from Task 1; verdict strings from Task 3.
- Produces: the user-facing skill invoked as `/requirements-audit [mode] [repo]`.

- [ ] **Step 1: Write `SKILL.md`**

````markdown
---
name: requirements-audit
description: >-
  Turn project guideline PDFs into a versioned requirements inventory, then
  sweep a repo into a three-way traceability matrix — requirement ↔ ticket ↔
  code (file:line) — with behavioral verification gating VERIFIED. Use to check
  work against a sprint brief or guideline document, find unimplemented or
  unticketed requirements, interpret what a requirement means in code, or
  re-verify after fixes. Flags requirements no ticket covers and tickets that
  map to no requirement, and hands gaps to the repo's PM skill when one is
  configured.
argument-hint: "[init | baseline | compare <label> | extract] [path/to/repo]"
---

# Requirements Audit

You verify work against the source-of-truth guideline documents. Evidence over
assertion: every verdict cites file:line or captured command output; anything
you could not check is labeled, never guessed. You never modify application
code, and you never create or edit tickets.

Read `references/inventory-format.md` and `references/report-format.md` in full
before any phase. They define the entry schemas, verdict bars, and artifact
formats that bind everything below.

## Input

`/requirements-audit [init | baseline | compare <label> | extract] [path/to/repo]`

- `init` — write `<repo>/audit/requirements.config.yaml` and stop.
- `baseline` (default) — full sweep, phases 0–4.
- `compare <label>` — re-sweep against an existing baseline; report verdict deltas.
- `extract` — refresh the inventory only (use after a guideline PDF changes).

Repo path omitted → current directory. If it has no `.git` and no obvious app
layout, confirm with the user before proceeding.

## Task tracking

Before `baseline` or `compare`, create ALL phase tasks upfront with TaskCreate,
then work them in order. Do not start a phase before the prior one completes.

## Phase 0 — Config

Look for `<repo>/audit/requirements.config.yaml`. Present and mode ≠ `init` →
read it and continue. Missing (or mode `init`):

1. Read `references/config-template.yaml`.
2. Auto-detect candidates:
   - **docs:** PDFs in folders matching guideline/brief patterns —
     `*uideline*`, `*rief*`, `docs/requirements/` (Ship's folder is literally
     `project guideliens/` — match loosely on purpose).
   - **verify commands:** if `<repo>/audit/shipshape.config.yaml` exists, reuse
     its verified commands and app URL.
   - **code_roots:** workspace source dirs from the root package manifest.
   - **pm_skill:** scan `<repo>/.claude/skills/*/SKILL.md` frontmatter for a
     description matching PM-role patterns (product manager, scope gate,
     triage). Take the best match; never guess between two — ask.
3. Show the filled config to the user for confirmation before writing. Every
   auto-detected value is a proposal, not a fact.
4. Mode `init` → stop here.

## Phase 1 — Extract (inventory)

Follow `references/inventory-format.md` exactly. Summary of the contract:

- Per config doc: sha256 match → skip; mismatch on an existing inventory →
  STOP and ask before re-extracting (ID stability rules apply); null → extract.
- Image-only/unreadable PDF → fail this phase with the config path in the
  message; offer to proceed from a user-provided text export.
- First extraction of a document ends with the user-skim gate: do not sweep
  until the user has confirmed the inventory once.

## Phase 2 — Ticket mapping

1. Pull open+recent tickets for `tickets.team` (narrowed by `tickets.project`
   when set) via the Linear MCP tools (ToolSearch for them if not loaded).
2. Map tickets ↔ requirement IDs by content match against Quote + Meaning in
   code. A ticket may map to several requirements and vice versa. Record
   unticketed active requirements and orphan tickets.
3. Linear unreachable/unauthorized → every ticket cell becomes `BLOCKED` with
   the unblock instruction ("authorize the Linear connector in claude.ai
   connector settings or /mcp"), and the run CONTINUES. Requirement → code
   tracing is unaffected.

## Phase 3 — Trace + verify

Per active inventory entry:

1. Search `code_roots` (respect `exclude`) for implementing code. Cite exact
   file:line; multiple citations allowed. Nothing found → `MISSING`.
   `Type: process` with nothing traceable in-repo → `N/A`.
2. **Ambiguity protocol:** requirement readable two+ ways in code terms →
   check `interpretations.md` first; a governing ruling applies silently.
   Otherwise ask the user ONE yes/no question, log the ruling per the
   interpretations schema, then proceed. **Flood cap:** if more than ~5
   unruled ambiguities surface in one sweep, ask only those that block a
   verdict entirely; trace the rest under a stated assumption with verdict
   `ASSUMED`.
3. **Behavioral verification:** when the entry's Acceptance evidence names a
   `verify` label, run that command (or probe `verify_urls.app` — GET only,
   never mutating). Green → `VERIFIED`, capture the command and last ~5 output
   lines. Command cannot run (env down, seed missing) → verdict stays
   `IMPLEMENTED-UNVERIFIED` with the environment reason in `notes`. A failed
   environment is never a failed requirement, and never a fake `VERIFIED`.
4. **Fan-out:** more than ~25 active requirements → dispatch parallel
   general-purpose subagents per requirement cluster (group by feature area),
   each returning matrix entries with evidence. Ambiguity questions are NEVER
   delegated — subagents return `NEEDS-RULING` items to the main session,
   which asks the user, then re-traces those items with the ruling applied.

## Phase 4 — Report + handoff

Follow `references/report-format.md` exactly: write `matrix.baseline.json`
(or `matrix.after-<label>.json`), `REPORT.md`, `gaps.md`, then run the PM
handoff (active via `pm_skill`, else passive). Verify before finishing:
every active inventory ID appears in the matrix; every `VERIFIED` entry has a
non-null `verification`; every `MISSING` entry appears in `gaps.md`.

## Compare mode

Reuse `inventory.md` and `interpretations.md` untouched (a PDF hash mismatch
in compare mode is a hard stop — re-baseline instead). Re-run phases 2–4.
REPORT.md gains the Delta section: only rows whose verdict changed. The
matrix's `baselineRef` names the baseline file. Run verify commands under the
same conditions as baseline (same seed, same app-up state) — if conditions
can't match, say so and stop; a delta under different conditions is not
evidence.

## Hard rules

- Never modify application source, configs, or dependencies. Only artifacts
  under `<repo>/audit/requirements/` and the config file are writable.
- Never create/edit anything in Linear.
- Never silently downgrade: blocked is `BLOCKED`, assumed is `ASSUMED`,
  unverified is `IMPLEMENTED-UNVERIFIED` — with reasons recorded.
- Quotes stay verbatim; requirement IDs stay stable; retired entries are
  never deleted.
````

- [ ] **Step 2: Verify frontmatter parses and references resolve**

```bash
python3 - <<'EOF'
import os, yaml
p = os.path.expanduser("~/.claude/skills/requirements-audit/SKILL.md")
text = open(p).read()
fm = yaml.safe_load(text.split("---")[1])
assert fm["name"] == "requirements-audit", fm
for ref in ["references/config-template.yaml", "references/inventory-format.md", "references/report-format.md"]:
    assert ref in text, f"SKILL.md never references {ref}"
    assert os.path.exists(os.path.expanduser(f"~/.claude/skills/requirements-audit/{ref}")), f"{ref} missing on disk"
print("OK")
EOF
```

Expected: `OK`

### Task 5: Skill discoverability check

**Files:**
- None created — verification only (fold-in gate before shakedown).

**Interfaces:**
- Consumes: SKILL.md from Task 4.

- [ ] **Step 1: Confirm the skill loads in a fresh session**

Run (from any directory):

```bash
claude -p "Invoke the Skill tool with skill name requirements-audit and args 'init /Users/troy/repos/GAUNTLET/Ship' — but STOP immediately after the skill content loads and report only: (1) did the skill load, (2) list the modes it defines. Do not run init." --max-turns 4
```

Expected: reply confirms the skill loaded and names modes init/baseline/compare/extract. If the Skill tool reports the skill unknown, the frontmatter `name` is wrong or the directory is misplaced — fix and re-run.

### Task 6: Shakedown — init on Ship

**Files:**
- Create: `/Users/troy/repos/GAUNTLET/Ship/audit/requirements.config.yaml` (written BY the skill, not by hand)

**Interfaces:**
- Consumes: the complete skill (Tasks 1–5).
- Produces: Ship's config — later shakedown tasks depend on it naming the W4 PDF, `pm_skill: ship-pm`, and Ship's real verify commands.

- [ ] **Step 1: Run init**

In a Ship-repo session: `/requirements-audit init /Users/troy/repos/GAUNTLET/Ship`

- [ ] **Step 2: Check the written config against ground truth**

Expected in the confirmed config:
- `docs[0].path` = `project guideliens/GFA_Week_4_ShipShape_Updated.pdf` (id `W4`; Week 5 PDF may be offered — user decides whether to include it now)
- `pm_skill: ship-pm` (auto-detected from `.claude/skills/ship-pm/SKILL.md`)
- `verify` commands reused from `audit/shipshape.config.yaml`
- `code_roots` matching Ship's real workspaces

Any wrong value → fix the DETECTION LOGIC in SKILL.md Phase 0 (not just the config file), re-run init, re-check.

- [ ] **Step 3: Commit Ship's config**

```bash
cd /Users/troy/repos/GAUNTLET/Ship && git add audit/requirements.config.yaml && git commit -m "chore: requirements-audit per-repo config (init shakedown)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Shakedown — extract the Week 4 inventory

**Files:**
- Create: `/Users/troy/repos/GAUNTLET/Ship/audit/requirements/inventory.md` (written BY the skill)
- Modify: `/Users/troy/repos/GAUNTLET/Ship/audit/requirements.config.yaml` (sha256 filled)

**Interfaces:**
- Consumes: Ship config (Task 6).
- Produces: the reviewed inventory all sweep tasks trace against.

- [ ] **Step 1: Run extract**

`/requirements-audit extract /Users/troy/repos/GAUNTLET/Ship`

- [ ] **Step 2: Verify inventory mechanics**

```bash
cd /Users/troy/repos/GAUNTLET/Ship
grep -c '^## W4-R' audit/requirements/inventory.md
grep -c '\*\*Quote:\*\*' audit/requirements/inventory.md
shasum -a 256 "project guideliens/GFA_Week_4_ShipShape_Updated.pdf"
grep sha256 audit/requirements.config.yaml
```

Expected: entry count and Quote count equal; sha256 in config matches the computed hash. Spot-check 3 random Quotes against the PDF pages they cite — verbatim or the extraction logic gets fixed before proceeding.

- [ ] **Step 3: User skim gate**

Troy skims the inventory (the skill must have stopped and asked). His edits, if any, land before Task 8 starts.

- [ ] **Step 4: Commit**

```bash
cd /Users/troy/repos/GAUNTLET/Ship && git add audit/requirements/inventory.md audit/requirements.config.yaml && git commit -m "chore: W4 requirements inventory (extract shakedown)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Shakedown — baseline sweep

**Files:**
- Create (all written BY the skill): `audit/requirements/matrix.baseline.json`, `audit/requirements/REPORT.md`, `audit/requirements/gaps.md`; possibly `audit/requirements/interpretations.md`; possibly a one-line append to `memory-bank/activeContext.md`

**Interfaces:**
- Consumes: reviewed inventory (Task 7), Ship config (Task 6). Linear connector state: if Troy has authorized it, ticket mapping runs live; if not, this task ALSO validates the BLOCKED degradation path — both are acceptance-relevant.
- Produces: the baseline artifacts Task 9 diffs against.

- [ ] **Step 1: Preconditions**

Ship's app seeded and running per `verify_urls.app` (so behavioral checks can produce `VERIFIED` rather than everything capping at `IMPLEMENTED-UNVERIFIED`).

- [ ] **Step 2: Run baseline**

`/requirements-audit baseline /Users/troy/repos/GAUNTLET/Ship`

During the run, confirm live behavior matches spec: ambiguity questions arrive one at a time as yes/no; rulings land in `interpretations.md`; if >5 unruled ambiguities, the flood cap engages.

- [ ] **Step 3: Acceptance checks (spec's testing section, verbatim)**

```bash
cd /Users/troy/repos/GAUNTLET/Ship && python3 - <<'EOF'
import json
m = json.load(open("audit/requirements/matrix.baseline.json"))
inv = open("audit/requirements/inventory.md").read()
gaps = open("audit/requirements/gaps.md").read()
active = [l.split()[1] for l in inv.splitlines() if l.startswith("## W4-R")]
retired = inv.count("Status: retired")
matrix_ids = {r["id"] for r in m["requirements"]}
missing_rows = [i for i in active if i not in matrix_ids]
assert not missing_rows or len(missing_rows) == retired, f"dropped rows: {missing_rows}"
for r in m["requirements"]:
    if r["verdict"] == "VERIFIED":
        assert r["verification"] and r["verification"]["result_excerpt"], f"{r['id']}: VERIFIED without evidence"
    if r["verdict"] == "MISSING":
        assert r["id"] in gaps, f"{r['id']}: MISSING but absent from gaps.md"
    if r["verdict"] == "ASSUMED":
        assert r.get("assumption"), f"{r['id']}: ASSUMED without stated assumption"
print(f"OK — {len(m['requirements'])} rows, verdicts sound")
EOF
```

Expected: `OK`. Also confirm by reading REPORT.md: verdict counts in Summary match the matrix; if Linear was unauthorized, ticket cells say `BLOCKED` with the authorization instruction (not MISSING, not blank).

- [ ] **Step 4: PM handoff check**

Expected: the skill invoked `ship-pm` with the framing line and the gaps.md path (visible in the session transcript), OR — if `pm_skill` lookup failed — REPORT.md carries the warning and `memory-bank/activeContext.md` got the pointer line. Silent skip = bug; fix Phase 4 in SKILL.md.

- [ ] **Step 5: Commit baseline artifacts**

```bash
cd /Users/troy/repos/GAUNTLET/Ship && git add audit/requirements/ memory-bank/activeContext.md && git commit -m "chore: W4 requirements baseline sweep (shakedown)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If `activeContext.md` had unrelated dirty edits before this run, stage only the pointer line via `git add -p`.)

### Task 9: Shakedown — determinism check

**Files:**
- Create: `matrix.run1.json`, `matrix.run2.json` in the executing session's scratchpad directory (scratch copies — never committed)

**Interfaces:**
- Consumes: baseline artifacts (Task 8).

- [ ] **Step 1: Re-run baseline with no code changes**

Copy `audit/requirements/matrix.baseline.json` into the scratchpad as `matrix.run1.json`, run `/requirements-audit baseline` again under identical conditions (same seed, app up), copy the new `matrix.baseline.json` to the scratchpad as `matrix.run2.json`, then `cd` to the scratchpad for Step 2.

- [ ] **Step 2: Diff verdicts**

```bash
python3 - <<'EOF'
import json
a = {r["id"]: r["verdict"] for r in json.load(open("matrix.run1.json"))["requirements"]}
b = {r["id"]: r["verdict"] for r in json.load(open("matrix.run2.json"))["requirements"]}
diff = {k: (a.get(k), b.get(k)) for k in set(a) | set(b) if a.get(k) != b.get(k)}
print("IDENTICAL" if not diff else f"DRIFT: {diff}")
EOF
```

Expected: `IDENTICAL`. Drift means a phase is eyeballing instead of following the formats — find which verdicts moved and tighten that phase's instructions in SKILL.md, then repeat this task. (Evidence file:line may legitimately vary in note wording; verdicts may not.)

- [ ] **Step 3: Restore the committed baseline**

```bash
cd /Users/troy/repos/GAUNTLET/Ship && git checkout -- audit/requirements/
```

### Task 10: Formal pass + memory

**Files:**
- Create: `/Users/troy/.claude/projects/-Users-troy-repos/memory/requirements-audit-skill.md`
- Modify: `/Users/troy/.claude/projects/-Users-troy-repos/memory/MEMORY.md`

**Interfaces:**
- Consumes: the shaken-down skill.

- [ ] **Step 1: Run skill-audit over the new skill**

Invoke the `skill-audit` skill against `~/.claude/skills/requirements-audit/`. Apply its findings that are cheap and clearly right; log anything structural as a follow-up rather than churning the just-validated skill.

- [ ] **Step 2: Write the memory file**

```markdown
---
name: requirements-audit-skill
description: Troy's portable requirements-audit skill — PDF guidelines to traceability matrix; conventions and Ship shakedown facts
metadata:
  type: project
---

Built 2026-08-08 (spec + plan in Ship repo `docs/superpowers/`). Portable skill
at `~/.claude/skills/requirements-audit/`: guideline PDFs → `inventory.md`
(stable `<doc>-R<n>` IDs, verbatim quotes) → three-way matrix (requirement ↔
Linear ticket ↔ code file:line) under `<repo>/audit/requirements/`. VERIFIED
needs green behavioral evidence; ambiguity rulings persist in
`interpretations.md`; gaps hand off to the repo's PM skill (Ship:
[[shipshape-audit-skills]]' factory `ship-pm`) or passively to the memory bank.
Modes: init / baseline / compare <label> / extract. Ship's config:
`audit/requirements.config.yaml`.
```

- [ ] **Step 3: Add the MEMORY.md index line**

```markdown
- [Requirements-audit skill](requirements-audit-skill.md) — PDF guidelines → traceability matrix; Ship shakedown done; gaps hand off to ship-pm
```
