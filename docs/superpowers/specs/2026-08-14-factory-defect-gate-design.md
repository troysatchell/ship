# Factory Defect-Gate Engine + Config Consolidation — Design Spec

**Date:** 2026-08-14
**Status:** Approved design, pre-implementation
**Source:** ported from `/Users/troy/repos/labelhunter` (`scripts/factory/defect-gates/`,
`factory/config.yaml`), a factory built off Ship's own factory pattern. This spec pulls back the
two pieces of that fork's design that are generalizable factory mechanics, not LabelHunter's
product domain (food/label compliance).

## Purpose

Ship's `scripts/factory/gate.sh` catches recurring defect classes with hand-written regex checks
(`review-patterns.mjs`) once they've hit the 3-occurrence recurrence bar (G7b/G7c). That works, but
it has three structural weaknesses LabelHunter's factory already solved:

1. **No baseline-exemption identity for arbitrary static findings.** Ship's only identity-based
   baseline mechanism (`quarantine.json` + `testdiff.mjs`) is for test pass/fail, not static-analysis
   violations. `review-patterns.mjs` instead compares *exact trimmed line text, counted* between
   base and head — fragile to reordering, and blind to two structurally-identical violations in
   different functions.
2. **No activation pinning.** A newly added regex rule blocks every in-flight branch immediately,
   with no grandfathering for branches cut before the rule existed.
3. **No calibration proof.** Each `review-patterns.mjs` rule is hand-justified with a `why` comment
   pointing at a finding ID (TS-4, TEST-11, ...), but nothing mechanically replays the rule against
   the real historical commit to prove it would have fired.

This spec ports LabelHunter's `defect-gates/` framework (AST-based rules, identity-hashed baseline
diffing, activation pinning, a replay harness) to close those three gaps, proves it on one migrated
rule, and separately consolidates two facts that are today duplicated and self-flagged as
stale-prone (`ship-factory/SKILL.md`, `ship-orchestrator/SKILL.md`) into one YAML file.

## Non-goals (explicitly out of scope for this spec)

- **`gate-exceptions.ts`/`gate-exceptions.json`** (LabelHunter's human-approved gate-exception
  ledger). Not requested; cleanly separable — nothing in `defect-gates/` depends on it.
- **Migrating all five TS-eligible `review-patterns.mjs` rules.** Only `non-null-assertion` moves in
  this pass; `as-any`, `any-annotation`, `as-unknown-as`, `fixed-sleep`, and `tls-bypass` stay in
  `review-patterns.mjs` unchanged.
- **`tls-bypass`.** Scans Dockerfiles/`.npmrc`/sh/py in addition to TS — outside what a
  TypeScript-AST engine can cover. Stays in `review-patterns.mjs` permanently, or gets a
  text-scanning rule variant in a later pass; not designed here.
- **Consolidating `model-tiering.md` into config.yaml.** It's a per-task judgment procedure (the
  apply/investigate/direct discriminator), not a fixed default — doesn't fit a YAML fact.
- **Live YAML-parsing in `gate.sh`.** Verified against the source: LabelHunter's own `gate.sh` does
  **not** parse `config.yaml` at runtime either — it hardcodes `40` for scope-limit-files exactly as
  Ship's does, with `config.yaml` referenced only in a comment. "Single source of truth" here means
  one canonical authored file that prose points at, not code reading YAML at runtime. Not building
  something the source repo itself doesn't have.
- **Adopting LabelHunter's Wave-0 bootstrap ritual as a standing process.** This spec's own
  verification plan (below) proves *this* gate works; it does not stand up a permanent
  pre-auto-merge checklist. That's a separate, larger adoption (flagged in the original comparison
  as item 3) Troy didn't ask for here.

## Architecture

### 1. Defect-gate engine

New directory, mirroring LabelHunter's layout with one structural simplification: no
`registries`/layer-2 concept (that's LabelHunter's per-repo-detected-config lookup; Ship has nothing
analogous, so `RuleContext.registries` is dropped from the port, not carried over unused).

```
scripts/factory/defect-gates/
├── types.ts       # Rule, RuleMeta, Finding, RuleContext, RuleResult, ReplayCorpusEntry
├── engine.ts       # runRules() — crash-safe: a throwing rule reports status "error", never "pass"
├── identity.ts     # violationIdentity(ruleId, path, enclosingFn, normalizedText) — sha256
├── baseline.ts     # fileAtRef() (git show BASE_REF:, never the branch copy),
│                   # introducedFindings()/preExistingFindings() — multiset H\B / H∩B
├── activation.ts   # decidePin()/resolvePinFacts() — report-only for branches cut pre-activation
├── ast.ts           # TypeScript compiler API helpers: parse, walk, enclosingFunctionName, lineOf
├── run.ts           # orchestrator: changed .ts/.tsx files, runs rules vs HEAD and BASE_REF,
│                   # writes .factory/defect-gate.json, exit 0/1
├── replay.ts        # loadLedger(), selectCorpusRows(), replayRule(), summariseReplay()
└── rules/
    └── non-null-assertion.ts
```

Each `*.ts` file gets a co-located `*.test.ts` (matching LabelHunter's own convention and Ship's
existing `dependency-audit-diff.test.mjs` pattern), run via the package's existing vitest setup.

**Ported near-verbatim** (generic, no LabelHunter domain coupling): `types.ts`, `engine.ts`,
`identity.ts`, `baseline.ts`, `activation.ts`, `ast.ts`, `replay.ts`. `run.ts` is adapted for Ship's
repo layout (multi-package workspace: `api/`, `web/`, `shared/`, `agent/`, `sdk/` — changed-file
globbing must span all of them, not a single Next.js app tree) and drops the `registries` context
field.

**Execution:** `pnpm exec tsx scripts/factory/defect-gates/run.ts` — `tsx` is already a workspace
devDependency (confirmed present in `api/`, `web/`, `agent/` `package.json`, hoisted to
`node_modules/.bin/tsx` at the workspace root). No new tooling.

**Wired into `gate.sh`** as a new step:

```bash
# --- G10: defect-gate (AST-based, identity-baselined, activation-pinned) ---
if pnpm exec tsx scripts/factory/defect-gates/run.ts > "$OUT_DIR/defect-gate.log" 2>&1; then
  record defect-gate pass "no introduced findings"
else
  record defect-gate fail "see .factory/defect-gate.json / defect-gate.log"
fi
```

Placed after G9 (CodeRabbit), before the verdict block. `FACTORY_BASE_REF` is already resolved by
the time this runs (gate.sh sets it near the top) — `run.ts` reads it from the environment the same
way, defaulting to `main`.

### 2. Migrated rule: `non-null-assertion`

AST-based replacement for `review-patterns.mjs`'s regex rule (`(?:\w|\]|\))!(?=\s*[.,;)\]}:]|\s*$)`).
Detects a postfix `!` TypeScript non-null assertion (`ts.NonNullExpression` node) via the compiler
API instead of pattern-matching diff text — catches every syntactic position uniformly (the current
regex needed three separate follow-up fixes for `:`, ternaries, and index expressions; an AST check
has no such enumeration problem) and is immune to reformatting-only diffs.

```ts
const meta: RuleMeta = {
  id: "non-null-assertion",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  activatedAt: "<commit landing G10>",   // filled in once the commit exists
  pinExpiresAfterMainCommits: 25,        // matches LabelHunter's own choice; no Ship-specific reason to diverge
  replayCorpus: [
    // 2-3 real rows selected from audit/factory/review-findings.jsonl,
    // category: "type-safety", disposition: "fixed" — filled in during implementation
    // once the actual rows and their fixing commits are identified.
  ],
};
```

**Calibration:** `audit/factory/review-findings.jsonl`'s row shape
(`{ticket, pr, source, severity, category, file, disposition, summary, ts}`) is a superset of
LabelHunter's `LedgerRow` (`{ticket, pr?, file, disposition, category, summary}`) — `loadLedger`,
`selectCorpusRows`, and `replayRule` need no schema changes, only extra ignored fields. Implementation
picks concrete rows by grepping `review-findings.jsonl` for `"category":"type-safety"` entries whose
`summary` mentions a non-null assertion, resolves their fixing commit via `git log --grep`, and
verifies (via `replayRule`) that `checkSource` fires on the pre-fix snapshot.

**`review-patterns.mjs` change:** remove the `non-null-assertion` entry from `RULES`, with a comment:
`// migrated to scripts/factory/defect-gates/rules/non-null-assertion.ts (G10) — see TRO-<ticket>`.
The other four TS rules and `tls-bypass` are untouched.

### 3. `config.yaml` consolidation

New file: `audit/factory/config.yaml` — joins the existing `quarantine.json`,
`review-findings.jsonl`, `scorecard.jsonl` already at that path.

```yaml
meta:
  activeProject: "FleetGraph — Week 5 Project Intelligence Agent"
  team: Troysatchell
  updatedAt: 2026-08-14
  scopeGuard: >
    Never dispatch outside the active project above. The team holds six projects
    with interleaving issue numbers (ShipShape Audit Remediation, an iOS app,
    a healthcare copilot, a separate security audit at TRO-250-275, ...).
    Filter by project via the API, never by number range.

recurrenceLadder:
  briefRule: 2        # distinct tickets -> add a rule to lessons.md
  gateCheck: 3         # distinct tickets -> add a mechanical gate check

gate:
  scopeLimitFiles: 40    # gate.sh G8 hardcodes this; kept in sync by hand — see gate.sh's own comment
```

**Doc changes** (facts replaced with pointers, reasoning stays in place):
- `ship-factory/SKILL.md:15-20` — the "Current work..." paragraph and its own
  "re-read this paragraph, it goes stale" note replaced with: "Read `audit/factory/config.yaml`'s
  `meta.activeProject` at the start of every run — do not hardcode it here."
- `ship-factory/SKILL.md:415-419` — the recurrence-ladder table's numbers (`2`, `3+`) become a
  reference to `audit/factory/config.yaml`'s `recurrenceLadder`; the surrounding explanation (why
  the threshold exists, the G7b precedent) stays as prose.
- `ship-orchestrator/SKILL.md:171-174` — same active-project fact, same replacement.
- `gate.sh`'s `G8` scope-check comment gets one line added pointing at
  `audit/factory/config.yaml`'s `gate.scopeLimitFiles`, matching LabelHunter's own practice of a
  comment cross-reference rather than a runtime parse.

## Testing / verification plan (this ticket's acceptance evidence)

Per CLAUDE.md's claim-provenance rule — this gate is not reported as working without evidence:

1. **Unit tests** for each ported module (`identity.test.ts`, `baseline.test.ts`,
   `activation.test.ts`, `engine.test.ts`, `run.test.ts`, `replay.test.ts`,
   `non-null-assertion.test.ts`) — ported/adapted from LabelHunter's own test files, which already
   cover the edge cases (missing-path vs. real git failure in `fileAtRef`, multiset vs. set
   comparison in `introducedFindings`, pin-resolution failure surfacing as `error` not silent
   report-only, etc.).
2. **Replay recall** — run the replay harness against the 2-3 calibration rows; the rule must fire
   (`hit: true`) on the real pre-fix snapshot for each resolvable row.
3. **Forged break-one/fix-one** — in a scratch worktree: introduce one real new non-null assertion
   AND fix a pre-existing one in the same branch. `introducedFindings` must report exactly the new
   one, not net-zero (proves multiset identity comparison, not a count check).
4. **Baseline not widenable from a branch** — attempt to add a findings-suppressing change to the
   baseline read path from the ticket branch itself; confirm `gate.sh`'s existing
   `git show BASE_REF:` discipline (already proven for `quarantine.json`) applies identically here
   since `fileAtRef` uses the same mechanism.
5. **Activation pinning** — construct a branch whose merge-base predates `activatedAt`; confirm the
   rule reports `mode: "report-only"` and does not fail the gate, per `decidePin`.

## Error handling notes carried over from the source (not weakened in the port)

- A rule that throws must report `status: "error"`, never `"pass"` — absence of a result must never
  read as cleanliness (`engine.ts`'s `safeErrorMessage`).
- An unresolved pin (a `git` failure in `resolvePinFacts`) must force `status: "error"`, never
  silently default to permanent report-only mode.
- A `fileAtRef` failure that isn't "path missing at that ref" must throw, not read as "no baseline."
- `checkSource` is a required method on `Rule`, not optional — an optional method previously let a
  rule silently contribute an empty baseline and an empty replay result instead of a visible error.

## File-by-file change list

**New:**
- `scripts/factory/defect-gates/{types,engine,identity,baseline,activation,ast,run,replay}.ts` + `.test.ts` each
- `scripts/factory/defect-gates/rules/non-null-assertion.ts` + `.test.ts`
- `audit/factory/config.yaml`
- `audit/factory/replay/non-null-assertion.v1.json` (calibration corpus, if kept as a separate file
  rather than inline in the rule — decide during implementation based on corpus size)

**Modified:**
- `scripts/factory/gate.sh` — new G10 step; comment pointing at `config.yaml`'s `scopeLimitFiles`
- `scripts/factory/review-patterns.mjs` — remove `non-null-assertion` rule entry
- `.claude/skills/ship-factory/SKILL.md` — lines 15-20, 415-419 replaced with config.yaml pointers
- `.claude/skills/ship-orchestrator/SKILL.md` — lines 171-174 replaced with config.yaml pointer
