# Factory Defect-Gate Engine + Config Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port LabelHunter's AST-based defect-gate framework (identity-hashed baseline diffing, activation pinning, replay calibration) into Ship's factory, prove it on one migrated rule (`non-null-assertion`, replacing the regex version in `review-patterns.mjs`), and consolidate two duplicated, self-flagged-stale facts (active project, recurrence ladder) into `audit/factory/config.yaml`.

**Architecture:** New `scripts/factory/defect-gates/` TypeScript module (types/engine/identity/baseline/activation/ast/replay + one rule), executed via `tsx` and wired into `gate.sh` as a new `G10` step. `review-patterns.mjs` loses its now-redundant regex rule. `audit/factory/config.yaml` becomes the canonical source for two facts currently duplicated in `ship-factory/SKILL.md` and `ship-orchestrator/SKILL.md`.

**Tech Stack:** TypeScript (`typescript` compiler API for AST parsing), `tsx` (root devDependency as of commit `3de0f10` — see the correction in Global Constraints below) for execution, `vitest` (root devDependency) for tests, bash (`gate.sh`).

**Spec:** `docs/superpowers/specs/2026-08-14-factory-defect-gate-design.md`

## Global Constraints

- **No `registries`/layer-2 field.** LabelHunter's `RuleMeta.registries` and `RuleContext.registries` are dropped from every ported type/interface — Ship has no per-repo-detected-config lookup analogous to LabelHunter's layer-2 registries.
- **Path scope for the engine:** `changedTsFiles` in `run.ts` restricts to files under `api/`, `web/`, `shared/`, `agent/`, `sdk/`, `e2e/` (matching `review-patterns.mjs`'s existing scope, plus `sdk/` which that script is missing — `sdk/` is a real TS workspace package per `gate.sh`'s TRO-405 comment). `scripts/` itself is excluded (factory tooling, not product code).
- **Test runner: vitest, not `node:test`.** Ship's one precedent for testing `scripts/` code (`scripts/factory/lib/dependency-audit-diff.test.mjs`, TRO-244) deliberately used `node:test`, reasoning that no `scripts/*.test.ts` pattern existed and the file needed zero new dependencies. This plan diverges deliberately: the ported test suites are vitest-native, cover safety-critical edge cases (git-failure-vs-missing-path, multiset-vs-set baseline comparison, pin-resolution-failure-must-surface), and transcribing ~40 assertions into `node:test` risks introducing bugs in exactly the logic this feature exists to get right. `vitest` is already a root devDependency (`4.0.17`); a scoped local config keeps it isolated from `pnpm test`'s api/web/agent/sdk chain, matching TRO-244's own boundary that `scripts/` tests are not part of that suite.
- **Execution:** `pnpm exec tsx scripts/factory/defect-gates/run.ts` from repo root (matches `gate.sh`'s own working directory, `$WT_ROOT`).
- **Correction to the spec's tsx claim:** the spec verified `tsx` resolves at `node_modules/.bin/tsx` against the main checkout's long-lived `node_modules` — that checkout has stale/manual state a fresh `pnpm install` does not reproduce. A fresh install (confirmed in this worktree) hoists `vitest` (an actual root devDependency) to root `.bin` but not `tsx` (previously only a nested dependency of `api`/`web`/`agent`). Fixed by adding `tsx: "4.21.0"` to root `package.json`'s `devDependencies` (commit `3de0f10`, already on this branch) — `pnpm exec tsx` now resolves reliably from a fresh install, matching how every other factory worktree gets provisioned.
- **`FACTORY_BASE_REF`** is already resolved and exported by `gate.sh` before any gate step runs; `run.ts` reads it the same way (`process.env.FACTORY_BASE_REF`, default `"main"`).
- **Identity discipline carried over unmodified:** a rule that throws reports `status: "error"`, never `"pass"`; an unresolved activation pin forces `"error"`, never silent permanent report-only; `fileAtRef` throws on any git failure that isn't "path missing at that ref."

---

### Task 1: `types.ts` + `engine.ts`

**Files:**
- Create: `scripts/factory/defect-gates/types.ts`
- Create: `scripts/factory/defect-gates/engine.ts`
- Test: `scripts/factory/defect-gates/engine.test.ts`
- Create: `scripts/factory/defect-gates/vitest.config.ts`

**Interfaces:**
- Produces: `Repairability`, `RuleScope`, `Severity`, `RuleStatus`, `ReplayCorpusEntry {ticket, file, summaryIncludes}`, `RuleMeta {id, version, scope, severity, repairability, activatedAt, pinExpiresAfterMainCommits, replayCorpus}` (no `registries`), `Finding {ruleId, ruleVersion, file, line, identity, message, repairability, exemptedBy}`, `RuleContext {files, repoRoot}` (no `registries`), `Rule {meta, check(ctx), checkSource(filePath, text, ctx)}`, `RuleResult {id, version, status, findings, error}` — all from `types.ts`.
- Produces: `runRules(rules: Rule[], ctx: RuleContext): RuleResult[]` from `engine.ts`.

- [ ] **Step 1: Create the vitest config for this directory**

```ts
// scripts/factory/defect-gates/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Write `types.ts`**

```ts
// scripts/factory/defect-gates/types.ts
// Generic rule contract for the factory's defect gate.
// Layer 1: nothing here names a target repository's domain.

export type Repairability = "auto" | "assisted" | "manual";
export type RuleScope = "changeset" | "repo";
export type Severity = "fail" | "advisory";
export type RuleStatus = "pass" | "fail" | "advisory" | "error" | "skipped";

/**
 * One historical ledger row a rule declares itself calibrated against.
 *
 * The review ledger (audit/factory/review-findings.jsonl) has no stable row
 * id. A corpus entry names a row by ticket, file, and a distinctive
 * substring of its summary instead.
 */
export interface ReplayCorpusEntry {
  ticket: string;
  file: string;
  summaryIncludes: string;
}

export interface RuleMeta {
  id: string;
  version: number;
  scope: RuleScope;
  severity: Severity;
  repairability: Repairability;
  /** Commit at which the rule became blocking. Null before activation. */
  activatedAt: string | null;
  pinExpiresAfterMainCommits: number;
  /** Ledger rows this rule is calibrated against. Select by row, not category. */
  replayCorpus: ReplayCorpusEntry[];
}

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  file: string;
  line: number;
  identity: string;
  message: string;
  repairability: Repairability;
  exemptedBy: string | null;
}

export interface RuleContext {
  /** Absolute paths the rule must analyse. */
  files: string[];
  repoRoot: string;
}

export interface Rule {
  meta: RuleMeta;
  check(ctx: RuleContext): Finding[];
  /**
   * Checks one file's source text directly, without reading the working
   * tree. The baseline pass and the replay harness both call this against
   * historical text read from a git ref — `check` alone cannot serve
   * either, since it reads files from disk by path. Required, not
   * optional: an optional method here would let a rule silently
   * contribute an empty baseline and an empty replay result instead of a
   * visible error.
   */
  checkSource(filePath: string, text: string, ctx: RuleContext): Finding[];
}

export interface RuleResult {
  id: string;
  version: number;
  status: RuleStatus;
  findings: Finding[];
  error: string | null;
}
```

- [ ] **Step 3: Write `engine.ts`**

```ts
// scripts/factory/defect-gates/engine.ts
import type { Rule, RuleContext, RuleResult } from "./types";

/**
 * Converts a thrown value to a message string, without itself throwing.
 *
 * `String(x)` throws when `x` has no usable conversion — an object made
 * with `Object.create(null)`, or one whose own `toString` throws. That
 * throw would escape `runRules`'s own `catch` block below and abort the
 * whole `.map()`, so one rule's crash would silently discard every other
 * rule's result too. This function must never let that happen.
 */
function safeErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "non-Error thrown value could not be converted to a string";
  }
}

/**
 * Runs every rule and returns one result each.
 *
 * A rule that throws produces status "error", never "pass". A crashed rule
 * that read as clean would repeat the exact defect this subsystem exists to
 * answer: absence must never look like cleanliness.
 */
export function runRules(rules: Rule[], ctx: RuleContext): RuleResult[] {
  return rules.map((rule) => {
    try {
      const findings = rule.check(ctx);
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: findings.length > 0 ? "fail" : "pass",
        findings,
        error: null,
      } as RuleResult;
    } catch (cause) {
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: "error",
        findings: [],
        error: safeErrorMessage(cause),
      } as RuleResult;
    }
  });
}
```

- [ ] **Step 4: Write `engine.test.ts`** (dropping `registries` from the stub rule and context vs. the source)

```ts
// scripts/factory/defect-gates/engine.test.ts
import { describe, expect, it } from "vitest";
import { runRules } from "./engine";
import type { Finding, Rule, RuleContext } from "./types";

function stubRule(id: string, findings: Finding[]): Rule {
  return {
    meta: {
      id,
      version: 1,
      scope: "changeset",
      severity: "fail",
      repairability: "manual",
      activatedAt: null,
      pinExpiresAfterMainCommits: 25,
      replayCorpus: [],
    },
    check: () => findings,
    checkSource: () => findings,
  };
}

const ctx: RuleContext = { files: [], repoRoot: "/repo" };

describe("runRules", () => {
  it("reports pass for a rule that finds nothing", () => {
    const [result] = runRules([stubRule("quiet", [])], ctx);
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("reports fail for a rule that finds something", () => {
    const finding: Finding = {
      ruleId: "noisy",
      ruleVersion: 1,
      file: "a.ts",
      line: 1,
      identity: "abc",
      message: "boom",
      repairability: "manual",
      exemptedBy: null,
    };
    const [result] = runRules([stubRule("noisy", [finding])], ctx);
    expect(result.status).toBe("fail");
    expect(result.findings).toHaveLength(1);
  });

  it("reports error, never pass, when a rule throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("rule crashed");
      },
    };
    const [result] = runRules([broken], ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("rule crashed");
  });

  it("runs every rule even when one throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("nope");
      },
    };
    const results = runRules([broken, stubRule("quiet", [])], ctx);
    expect(results.map((r) => r.status)).toEqual(["error", "pass"]);
  });

  it("reports error, and still runs later rules, when the thrown value has no usable toString", () => {
    // Object.create(null) has no prototype, so String() on it throws
    // TypeError: Cannot convert object to primitive value. That throw
    // must not escape runRules and abort the remaining rules.
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw Object.create(null);
      },
    };
    const results = runRules([broken, stubRule("quiet", [])], ctx);
    expect(results[0].status).toBe("error");
    expect(typeof results[0].error).toBe("string");
    expect(results[1].status).toBe("pass");
  });
});
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts`
Expected: PASS, 5 tests in `engine.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/factory/defect-gates/types.ts scripts/factory/defect-gates/engine.ts \
  scripts/factory/defect-gates/engine.test.ts scripts/factory/defect-gates/vitest.config.ts
git commit -m "feat(factory): add defect-gate engine core types and rule runner"
```

---

### Task 2: `identity.ts`

**Files:**
- Create: `scripts/factory/defect-gates/identity.ts`
- Test: `scripts/factory/defect-gates/identity.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (pure function on strings).
- Produces: `violationIdentity(ruleId: string, repoRelativePath: string, enclosingFunctionName: string, nodeText: string): string` — used by `baseline.ts` (Task 4) and every rule.

- [ ] **Step 1: Write `identity.ts`**

```ts
// scripts/factory/defect-gates/identity.ts
import { createHash } from "node:crypto";

/**
 * A stable identifier for one violation.
 *
 * Line numbers shift under unrelated edits, so a position-based identifier
 * would make the introduced-vs-baseline comparison report false failures.
 * This mirrors testdiff.mjs, which compares test failures by identity
 * rather than by position — the property that lets the gate catch a forged
 * break-one fix-one swap.
 */
export function violationIdentity(
  ruleId: string,
  repoRelativePath: string,
  enclosingFunctionName: string,
  nodeText: string,
): string {
  const normalised = nodeText
    .replace(/\s+/g, " ")
    .replace(/\s*([^\w\s])\s*/g, "$1")
    .trim();
  return createHash("sha256")
    .update([ruleId, repoRelativePath, enclosingFunctionName, normalised].join("|"))
    .digest("hex");
}
```

- [ ] **Step 2: Write `identity.test.ts`**

```ts
// scripts/factory/defect-gates/identity.test.ts
import { describe, expect, it } from "vitest";
import { violationIdentity } from "./identity";

describe("violationIdentity", () => {
  it("is stable when only whitespace differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every( p )");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(   p )");
    expect(a).toBe(b);
  });

  it("is stable across newlines in the node text", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(\n  p\n)");
    expect(a).toBe(b);
  });

  it("differs when the enclosing function differs", () => {
    const a = violationIdentity("r", "src/a.ts", "one", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "two", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when the file differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/b.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when the rule differs", () => {
    const a = violationIdentity("one", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("two", "src/a.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when keyword and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "new Date()");
    const b = violationIdentity("r", "src/a.ts", "fn", "newDate()");
    expect(a).not.toBe(b);
  });

  it("differs when typeof and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "typeof x");
    const b = violationIdentity("r", "src/a.ts", "fn", "typeofx");
    expect(a).not.toBe(b);
  });

  it("differs when return and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "return x");
    const b = violationIdentity("r", "src/a.ts", "fn", "returnx");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts identity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/factory/defect-gates/identity.ts scripts/factory/defect-gates/identity.test.ts
git commit -m "feat(factory): add defect-gate violation identity hashing"
```

---

### Task 3: `ast.ts`

**Files:**
- Create: `scripts/factory/defect-gates/ast.ts`
- Test: `scripts/factory/defect-gates/ast.test.ts`

**Interfaces:**
- Consumes: `typescript` package (already a devDependency in `api`/`web`/`agent`; resolvable from workspace root the same way `tsx` is).
- Produces: `parse(filePath: string, text: string): ts.SourceFile`, `walk(node: ts.Node, visit: (n: ts.Node) => void): void`, `enclosingFunctionName(node: ts.Node): string`, `lineOf(sourceFile: ts.SourceFile, node: ts.Node): number` — used by `rules/non-null-assertion.ts` (Task 6).

- [ ] **Step 1: Write `ast.ts`**

```ts
// scripts/factory/defect-gates/ast.ts
import ts from "typescript";

/** Parses one source file with parent pointers, which the walkers need. */
export function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}

/** Visits every node depth-first. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Names the function a node sits inside.
 *
 * Used by the identity hash, so two identical call sites in different
 * functions get different identities. A method name alone is not unique:
 * `A.validate()` and `B.validate()` both name only "validate", so a
 * violation in one class silently reuses the other's identity. A method
 * name is qualified with its enclosing class or object scope for this
 * reason; a plain function or arrow keeps its own name unqualified.
 */
export function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return `${enclosingScopeName(current)}.${current.name.text}`;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return "<module>";
}

/**
 * Reads the name of the variable or property a value is directly assigned
 * to, if there is one — `const A = <value>` or `{ A: <value> }`. Null when
 * the value sits somewhere else (an array element, a call argument), which
 * is not itself a name.
 */
function declarationOwnerName(value: ts.Expression): string | null {
  const owner = value.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  if (ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  return null;
}

/**
 * Names the class or object literal a method belongs to.
 *
 * Checked shapes: a named class (`class A { validate() {} }`); an unnamed
 * class expression, named instead from its own declaration owner (`const A
 * = class { validate() {} }`); and an object literal assigned to a name —
 * directly (`const A = { validate() {} }`) or as a property value (`{ A: {
 * validate() {} } }`). Falls back to `<anonymous>` when nothing above names
 * the scope, so the identity still separates same-named methods without
 * crashing on a truly unnamed, unassigned class expression.
 */
function enclosingScopeName(method: ts.MethodDeclaration): string {
  const parent = method.parent;
  if (ts.isClassDeclaration(parent) && parent.name) return parent.name.text;
  if (ts.isClassExpression(parent)) {
    if (parent.name) return parent.name.text;
    return declarationOwnerName(parent) ?? "<anonymous>";
  }
  if (ts.isObjectLiteralExpression(parent)) {
    return declarationOwnerName(parent) ?? "<anonymous>";
  }
  return "<anonymous>";
}

/** The 1-based line of a node. */
export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
```

- [ ] **Step 2: Write `ast.test.ts`**

```ts
// scripts/factory/defect-gates/ast.test.ts
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { enclosingFunctionName, parse, walk } from "./ast";

/** Finds the first call expression in the fixture and names its enclosing scope. */
function nameOfFirstCall(source: string): string {
  const sourceFile = parse("src/sample.ts", source);
  let found: string | null = null;
  walk(sourceFile, (node) => {
    if (found !== null) return;
    if (ts.isCallExpression(node)) found = enclosingFunctionName(node);
  });
  if (found === null) throw new Error("fixture has no call expression");
  return found;
}

describe("enclosingFunctionName", () => {
  it("names a top-level function declaration", () => {
    expect(nameOfFirstCall(`function one() { call(); }`)).toBe("one");
  });

  it("names an arrow function assigned to a const", () => {
    expect(nameOfFirstCall(`const one = () => { call(); };`)).toBe("one");
  });

  it("falls back to <module> for a call outside any function", () => {
    expect(nameOfFirstCall(`call();`)).toBe("<module>");
  });

  it("qualifies a class method with its class name", () => {
    expect(nameOfFirstCall(`class A { validate() { call(); } }`)).toBe("A.validate");
  });

  it("gives two same-named methods on different classes different identities", () => {
    const a = nameOfFirstCall(`class A { validate() { call(); } }`);
    const b = nameOfFirstCall(`class B { validate() { call(); } }`);
    expect(a).not.toBe(b);
  });

  it("qualifies an object-literal method with the object's own const name", () => {
    expect(nameOfFirstCall(`const A = { validate() { call(); } };`)).toBe("A.validate");
  });

  it("qualifies a nested object-literal method with its property key", () => {
    expect(
      nameOfFirstCall(`const registry = { A: { validate() { call(); } } };`),
    ).toBe("A.validate");
  });

  it("derives an anonymous class expression's name from its own variable declaration", () => {
    expect(nameOfFirstCall(`const x = class { validate() { call(); } };`)).toBe("x.validate");
  });

  it("qualifies an anonymous class expression assigned as a property value", () => {
    expect(
      nameOfFirstCall(`const registry = { X: class { validate() { call(); } } };`),
    ).toBe("X.validate");
  });

  it("falls back to <anonymous> when an unnamed class expression has no declaration owner", () => {
    expect(nameOfFirstCall(`const arr = [class { validate() { call(); } }];`)).toBe(
      "<anonymous>.validate",
    );
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts ast.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/factory/defect-gates/ast.ts scripts/factory/defect-gates/ast.test.ts
git commit -m "feat(factory): add defect-gate TypeScript AST helpers"
```

---

### Task 4: `baseline.ts`

**Files:**
- Create: `scripts/factory/defect-gates/baseline.ts`
- Test: `scripts/factory/defect-gates/baseline.test.ts`

**Interfaces:**
- Consumes: `Finding` from `types.ts` (Task 1).
- Produces: `isMissingPathFailure(stderr: string): boolean`, `fileAtRef(repoRoot: string, ref: string, repoRelativePath: string): string | null`, `introducedFindings(head: Finding[], base: Finding[]): Finding[]`, `preExistingFindings(head: Finding[], base: Finding[]): Finding[]` — used by `run.ts` (Task 7) and `replay.ts` (Task 8).

- [ ] **Step 1: Write `baseline.ts`**

```ts
// scripts/factory/defect-gates/baseline.ts
import { spawnSync } from "node:child_process";
import type { Finding } from "./types";

/**
 * True when a `git show REF:PATH` failure's stderr means "the path does not
 * exist at that ref" — the expected, common case: a file the branch added.
 * False for every other failure (a corrupt object, a bad tree, a
 * permissions error). Those are real git failures, not an absent baseline,
 * and must surface as one, not read as zero pre-existing findings.
 */
export function isMissingPathFailure(stderr: string): boolean {
  return /does not exist in|exists on disk, but not in/.test(stderr);
}

/**
 * Reads one file's content at a git ref, without touching the working tree.
 *
 * This is the discipline gate.sh already uses for the quarantine baseline:
 * `git show BASE_REF:` and never the branch copy, so an agent cannot
 * whitelist its own breakage. It also avoids `git stash`, which is banned in
 * factory worktrees because refs/stash is shared across them.
 *
 * The ref is validated first, separately from the path. A bad BASE_REF
 * (typo, a deleted branch, a force-pushed-away sha) must throw here, not
 * read as "no baseline" — silently returning null for every changed file
 * would look exactly like a branch that only ever added new files.
 *
 * Returns null when the file does not exist at that (valid) ref — a file
 * the branch added. Its baseline contribution is then correctly empty. Any
 * other `git show` failure (isMissingPathFailure false) throws instead.
 */
export function fileAtRef(
  repoRoot: string,
  ref: string,
  repoRelativePath: string,
): string | null {
  const refCheck = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (refCheck.status !== 0) {
    throw new Error(`fileAtRef: ref '${ref}' does not resolve to a commit in ${repoRoot}`);
  }

  const result = spawnSync("git", ["show", `${ref}:${repoRelativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;

  const stderr = result.stderr ?? "";
  if (isMissingPathFailure(stderr)) return null;
  const detail = stderr || result.error?.message || `exit code ${result.status}`;
  throw new Error(`git show ${ref}:${repoRelativePath} failed: ${detail}`);
}

/** Counts how many times each identity appears. */
function countByIdentity(findings: Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.identity, (counts.get(f.identity) ?? 0) + 1);
  return counts;
}

/**
 * H \ B, compared as a multiset — these fail the gate.
 *
 * A plain Set comparison treats identity as either present or absent. A
 * function with one existing violation that grows a second, structurally
 * identical one then reports zero introduced findings — the second copy
 * matches the same Set entry as the first. This decrements one baseline
 * occurrence per matched head finding instead, so a surplus occurrence is
 * correctly counted as introduced.
 */
export function introducedFindings(head: Finding[], base: Finding[]): Finding[] {
  const remaining = countByIdentity(base);
  const introduced: Finding[] = [];
  for (const f of head) {
    const n = remaining.get(f.identity) ?? 0;
    if (n > 0) {
      remaining.set(f.identity, n - 1);
    } else {
      introduced.push(f);
    }
  }
  return introduced;
}

/** H ∩ B, compared as a multiset — matched occurrences only, reported never failed. */
export function preExistingFindings(head: Finding[], base: Finding[]): Finding[] {
  const remaining = countByIdentity(base);
  const preExisting: Finding[] = [];
  for (const f of head) {
    const n = remaining.get(f.identity) ?? 0;
    if (n > 0) {
      remaining.set(f.identity, n - 1);
      preExisting.push(f);
    }
  }
  return preExisting;
}
```

- [ ] **Step 2: Write `baseline.test.ts`**

```ts
// scripts/factory/defect-gates/baseline.test.ts
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileAtRef, introducedFindings, isMissingPathFailure, preExistingFindings } from "./baseline";
import type { Finding } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r",
    ruleVersion: 1,
    file: "src/a.ts",
    line: 1,
    identity,
    message: "m",
    repairability: "manual",
    exemptedBy: null,
  };
}

describe("introducedFindings", () => {
  it("returns findings absent from the baseline", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base).map((f) => f.identity)).toEqual(["new"]);
  });

  it("returns nothing when every finding pre-exists", () => {
    const head = [finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base)).toEqual([]);
  });

  it("returns every finding when the baseline is empty", () => {
    const head = [finding("a"), finding("b")];
    expect(introducedFindings(head, []).map((f) => f.identity)).toEqual(["a", "b"]);
  });

  it("ignores a baseline finding that HEAD has fixed", () => {
    const head: Finding[] = [];
    const base = [finding("gone")];
    expect(introducedFindings(head, base)).toEqual([]);
  });

  it("counts a surplus occurrence as introduced, not a Set membership check", () => {
    // The function already had one "dup" violation (in base). The branch
    // adds a second, structurally identical one (head has two). A Set
    // comparison would report zero introduced — both match the same entry.
    const head = [finding("dup"), finding("dup")];
    const base = [finding("dup")];
    expect(introducedFindings(head, base)).toHaveLength(1);
    expect(preExistingFindings(head, base)).toHaveLength(1);
  });
});

describe("preExistingFindings", () => {
  it("returns findings present in both", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(preExistingFindings(head, base).map((f) => f.identity)).toEqual(["old"]);
  });
});

describe("fileAtRef", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

  it("reads a tracked file at HEAD", () => {
    const content = fileAtRef(repoRoot, "HEAD", "package.json");
    expect(content).toContain('"name"');
  });

  it("returns null for a path that does not exist at the ref", () => {
    expect(fileAtRef(repoRoot, "HEAD", "no/such/file.ts")).toBeNull();
  });

  it("throws when the ref itself does not resolve to a commit, instead of reading it as no baseline", () => {
    // A bad BASE_REF (typo, deleted branch, force-pushed-away sha) must
    // surface loudly. Silently returning null here would read exactly like
    // "this file is new on the branch" for every file in the diff.
    expect(() => fileAtRef(repoRoot, "not-a-real-ref-tro-defect-gate", "package.json")).toThrow(
      /not-a-real-ref-tro-defect-gate/,
    );
  });
});

describe("isMissingPathFailure", () => {
  it("recognizes git's does-not-exist-at-ref message as a missing path", () => {
    expect(isMissingPathFailure("fatal: path 'no/such/file.ts' does not exist in 'HEAD'")).toBe(
      true,
    );
  });

  it("recognizes the exists-on-disk-but-not-in-ref variant", () => {
    expect(
      isMissingPathFailure("fatal: path 'package.json' exists on disk, but not in '0000000'"),
    ).toBe(true);
  });

  it("does not classify an unrelated git failure as a missing path", () => {
    // A corrupt object, a permissions error, a bad tree — none of these
    // mean "the branch added this file." They must not read as one.
    expect(isMissingPathFailure("fatal: unable to read tree object deadbeef")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts baseline.test.ts`
Expected: PASS, 11 tests. (Runs real `git` commands against this repo's own checkout — no scratch repo needed for these cases.)

- [ ] **Step 4: Commit**

```bash
git add scripts/factory/defect-gates/baseline.ts scripts/factory/defect-gates/baseline.test.ts
git commit -m "feat(factory): add defect-gate baseline diffing (identity multiset)"
```

---

### Task 5: `activation.ts`

**Files:**
- Create: `scripts/factory/defect-gates/activation.ts`
- Test: `scripts/factory/defect-gates/activation.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (self-contained; uses `node:child_process` directly).
- Produces: `PinInput {activatedAt, mergeBaseIsAfterActivation, mainCommitsElapsed, expiresAfter}`, `PinDecision extends PinInput {mode: "blocking" | "report-only"}`, `decidePin(input: PinInput): PinDecision`, `PinFacts {mergeBaseIsAfterActivation, mainCommitsElapsed}`, `PinFactsResult`, `resolvePinFacts(repoRoot: string, baseRef: string, activatedAt: string): PinFactsResult` — used by `run.ts` (Task 7).

- [ ] **Step 1: Write `activation.ts`**

```ts
// scripts/factory/defect-gates/activation.ts
import { spawnSync } from "node:child_process";

export interface PinInput {
  activatedAt: string | null;
  mergeBaseIsAfterActivation: boolean;
  mainCommitsElapsed: number | null;
  expiresAfter: number;
}

export interface PinDecision extends PinInput {
  mode: "blocking" | "report-only";
}

/**
 * Decides whether a newly blocking rule applies to this branch.
 *
 * A branch cut before the rule existed runs report-only, so the rule does not
 * retroactively fail work written before it. The exemption dissolves by
 * itself: merge-base only moves forward, and the factory already requires
 * every branch to merge origin/main before landing. The expiry bounds the
 * case where a branch never syncs.
 */
export function decidePin(input: PinInput): PinDecision {
  const { activatedAt, mergeBaseIsAfterActivation, mainCommitsElapsed, expiresAfter } = input;
  if (activatedAt === null) return { ...input, mode: "blocking" };
  if (mergeBaseIsAfterActivation) return { ...input, mode: "blocking" };
  if (mainCommitsElapsed !== null && mainCommitsElapsed > expiresAfter) {
    return { ...input, mode: "blocking" };
  }
  return { ...input, mode: "report-only" };
}

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export type PinFacts = { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number };

export type PinFactsResult = { ok: true; facts: PinFacts } | { ok: false; error: string };

/**
 * Resolves the two git facts `decidePin` needs.
 *
 * Returns `ok: false` on a real git failure, instead of silently defaulting
 * to "not activated yet." A swallowed failure here reads exactly like a
 * branch cut before the rule existed — `mergeBaseIsAfterActivation: false`
 * — so the rule would run report-only forever, with no signal that
 * anything went wrong. An unknown or rewritten `activatedAt` must surface,
 * not disappear.
 *
 * `git merge-base --is-ancestor` exits 0 for "yes" and 1 for "no" — both
 * are real answers. Any other exit code (128 for an invalid ref, for
 * example) is a git failure, not a "no," and is reported as `ok: false`.
 */
export function resolvePinFacts(
  repoRoot: string,
  baseRef: string,
  activatedAt: string,
): PinFactsResult {
  const mergeBaseResult = git(repoRoot, ["merge-base", "HEAD", baseRef]);
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout) {
    return {
      ok: false,
      error: `git merge-base HEAD ${baseRef} failed: ${mergeBaseResult.stderr || "no output"}`,
    };
  }
  const mergeBase = mergeBaseResult.stdout;

  const ancestorResult = git(repoRoot, ["merge-base", "--is-ancestor", activatedAt, mergeBase]);
  if (ancestorResult.status !== 0 && ancestorResult.status !== 1) {
    return {
      ok: false,
      error:
        `git merge-base --is-ancestor ${activatedAt} ${mergeBase} failed: ` +
        `${ancestorResult.stderr || "no output"}`,
    };
  }
  const mergeBaseIsAfterActivation = ancestorResult.status === 0;

  const countResult = git(repoRoot, ["rev-list", "--count", `${activatedAt}..${baseRef}`]);
  if (countResult.status !== 0) {
    return {
      ok: false,
      error:
        `git rev-list --count ${activatedAt}..${baseRef} failed: ${countResult.stderr || "no output"}`,
    };
  }
  const mainCommitsElapsed = Number.parseInt(countResult.stdout, 10);
  if (!Number.isFinite(mainCommitsElapsed)) {
    return {
      ok: false,
      error: `git rev-list --count returned a non-numeric result: "${countResult.stdout}"`,
    };
  }

  return { ok: true, facts: { mergeBaseIsAfterActivation, mainCommitsElapsed } };
}
```

- [ ] **Step 2: Write `activation.test.ts`**

```ts
// scripts/factory/defect-gates/activation.test.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decidePin, resolvePinFacts } from "./activation";

describe("decidePin", () => {
  it("is blocking when the rule has no activation commit yet", () => {
    // A rule before activation cannot retroactively block anything, so the
    // pin is irrelevant and the caller's own severity governs.
    const d = decidePin({
      activatedAt: null,
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: null,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is blocking when the merge-base already contains the activation commit", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: true,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only when the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("is blocking once main has advanced past the expiry, even if the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 26,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only exactly at the expiry boundary", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 25,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("carries the diagnostics needed to report the pin", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
    expect(d).toMatchObject({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
  });
});

/** Runs a git command in a scratch repo, using an explicit test identity. */
function scratchGit(cwd: string, args: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, encoding: "utf8" }).trim();
}

describe("resolvePinFacts", () => {
  it("resolves real facts on the success path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const activatedAt = scratchGit(dir, "rev-parse HEAD");

      writeFileSync(join(dir, "a.ts"), "2\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "second"');
      writeFileSync(join(dir, "a.ts"), "3\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "third"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, baseSha, activatedAt);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.facts.mergeBaseIsAfterActivation).toBe(true);
      expect(result.facts.mainCommitsElapsed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ok:false, not a silent report-only default, when activatedAt is unresolvable", () => {
    // The failure this guards against: an unknown or rewritten activatedAt
    // must surface as an error, never quietly collapse to
    // mergeBaseIsAfterActivation: false (permanent report-only, no signal).
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, baseSha, "0000000000000000000000000000000000000000");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.error).toContain("is-ancestor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ok:false when baseRef itself does not resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const activatedAt = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, "no-such-ref", activatedAt);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.error).toContain("merge-base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts activation.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/factory/defect-gates/activation.ts scripts/factory/defect-gates/activation.test.ts
git commit -m "feat(factory): add defect-gate activation pinning"
```

---

### Task 6: `rules/non-null-assertion.ts` (the migrated rule)

**Files:**
- Create: `scripts/factory/defect-gates/rules/non-null-assertion.ts`
- Test: `scripts/factory/defect-gates/rules/non-null-assertion.test.ts`

**Interfaces:**
- Consumes: `parse`, `walk`, `enclosingFunctionName`, `lineOf` from `ast.ts` (Task 3); `violationIdentity` from `identity.ts` (Task 2); `Finding`, `Rule`, `RuleContext`, `RuleMeta` from `types.ts` (Task 1).
- Produces: default export `nonNullAssertion: Rule` — consumed by `run.ts` (Task 7) and `replay.ts`'s calibration test (Task 8).

**Calibration data** (real, verified against this repo's history — see the "Verify the calibration rows" step below):
- `TRO-230` / `web/src/pages/OrgChartPage.test.tsx` — commit `78e7ed0a1d63ba734f700524adfc5880cebd30c0` removed `let resolveFetch!: (res: Response) => void;` (a definite-assignment assertion). Its parent, `1d623118d878d594606694de1d6a4f9ce00fce46`, has the file with the assertion present.
- `TRO-276` / `api/src/__tests__/process-safety.test.ts` — commit `c6070d1a857b4d5e82ad47cf0a8ce7c6b78c9f9d` removed three postfix assertions (`calls[0]!.message`, `calls[0]!.meta`, `calls[1]!.message`). Its parent, `f846c3f1014ef8872f2f9aa1583b5ae21b260553`, has the file with all three present.

Both cases are covered because TypeScript's compiler API represents them as two different node shapes: `ts.NonNullExpression` (postfix `!` on an expression, e.g. `calls[0]!`) and a `ts.VariableDeclaration` with a non-undefined `exclamationToken` (a definite-assignment assertion, e.g. `let x!: T`). `review-patterns.mjs`'s own regex needed a dedicated follow-up fix for exactly the second shape (see its comment on TRO-230) — the AST rule handles both uniformly from the start.

- [ ] **Step 1: Write `rules/non-null-assertion.ts`**

```ts
// scripts/factory/defect-gates/rules/non-null-assertion.ts
import { readFileSync } from "node:fs";
import ts from "typescript";
import { enclosingFunctionName, lineOf, parse, walk } from "../ast";
import { violationIdentity } from "../identity";
import type { Finding, RuleContext, RuleMeta } from "../types";

const MESSAGE =
  "`!` non-null assertion — asserts a value is non-null without proving it. TS-4 tracks " +
  "these as a measured number this factory is graded on reducing. Prove non-null some " +
  "other way (a guard, type narrowing, or restructuring) instead of asserting past the " +
  "type checker.";

const meta: RuleMeta = {
  id: "non-null-assertion",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  // Set to null until the commit wiring this rule into gate.sh (G10) lands —
  // see Task 9's activation-pinning step, which pins this to that commit's
  // real sha so branches cut before it run report-only instead of failing
  // retroactively.
  activatedAt: null,
  pinExpiresAfterMainCommits: 25,
  replayCorpus: [
    { ticket: "TRO-230", file: "web/src/pages/OrgChartPage.test.tsx", summaryIncludes: "non-null assertion on resolveFetch" },
    { ticket: "TRO-276", file: "api/src/__tests__/process-safety.test.ts", summaryIncludes: "non null assertions and any cast" },
  ],
};

function checkSource(filePath: string, text: string, _ctx: RuleContext): Finding[] {
  const sourceFile = parse(filePath, text);
  const findings: Finding[] = [];

  walk(sourceFile, (node) => {
    // Postfix `!` on an expression: `foo!.bar`, `arr[0]!`, `foo!()`.
    if (ts.isNonNullExpression(node)) {
      pushFinding(node);
      return;
    }
    // Definite-assignment assertion on a variable declaration: `let x!: T;`.
    // A different AST shape than NonNullExpression — TypeScript attaches
    // this as an `exclamationToken` on the declaration itself, not as a
    // wrapper around an expression.
    if (ts.isVariableDeclaration(node) && node.exclamationToken) {
      pushFinding(node);
    }
  });

  function pushFinding(node: ts.Node): void {
    const fnName = enclosingFunctionName(node);
    const nodeText = node.getText(sourceFile);
    findings.push({
      ruleId: meta.id,
      ruleVersion: meta.version,
      file: filePath,
      line: lineOf(sourceFile, node),
      identity: violationIdentity(meta.id, filePath, fnName, nodeText),
      message: MESSAGE,
      repairability: meta.repairability,
      exemptedBy: null,
    });
  }

  return findings;
}

// Named before export: an anonymous default export cannot be re-imported
// under a stable name by tooling that inspects the module graph.
const nonNullAssertion = {
  meta,
  checkSource,
  check(ctx: RuleContext): Finding[] {
    return ctx.files.flatMap((absolute) => {
      const relative = absolute.startsWith(ctx.repoRoot)
        ? absolute.slice(ctx.repoRoot.length + 1)
        : absolute;
      return checkSource(relative, readFileSync(absolute, "utf8"), ctx);
    });
  },
};

export default nonNullAssertion;
```

- [ ] **Step 2: Write `rules/non-null-assertion.test.ts`**

```ts
// scripts/factory/defect-gates/rules/non-null-assertion.test.ts
import { describe, expect, it } from "vitest";
import nonNullAssertion from "./non-null-assertion";

const ctx = { files: [], repoRoot: "/repo" };

describe("non-null-assertion checkSource", () => {
  it("flags a postfix ! on a property access", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f(foo: { bar: number } | null) { return foo!.bar; }`,
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("non-null assertion");
  });

  it("flags a postfix ! on an element access", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f(calls: { message: string }[]) { return calls[0]!.message; }`,
      ctx,
    );
    expect(findings).toHaveLength(1);
  });

  it("flags a definite-assignment assertion on a variable declaration", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f() {
        let resolveFetch!: (res: Response) => void;
        return resolveFetch;
      }`,
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it("does not flag logical negation, which is syntactically unrelated", () => {
    // `!foo` is a PrefixUnaryExpression with an ExclamationToken operator —
    // a different AST node than NonNullExpression, which wraps a postfix `!`.
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f(foo: boolean) { return !foo; }`,
      ctx,
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a plain variable declaration with no exclamation token", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f() { let x: number = 1; return x; }`,
      ctx,
    );
    expect(findings).toEqual([]);
  });

  it("gives two structurally identical assertions in different functions different identities", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function one(foo: { bar: number } | null) { return foo!.bar; }
       function two(foo: { bar: number } | null) { return foo!.bar; }`,
      ctx,
    );
    expect(findings).toHaveLength(2);
    expect(findings[0].identity).not.toBe(findings[1].identity);
  });

  it("reports the correct 1-based line number", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f(foo: { bar: number } | null) {\n  return foo!.bar;\n}`,
      ctx,
    );
    expect(findings[0].line).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts rules/non-null-assertion.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 4: Verify the calibration rows against real history**

Confirm the two commits referenced in `replayCorpus` actually introduce and remove the assertions they claim to (this was already verified during planning; re-verify here since it is load-bearing for Task 8's replay proof):

```bash
git show 78e7ed0a1d63ba734f700524adfc5880cebd30c0 -- web/src/pages/OrgChartPage.test.tsx | grep -n "resolveFetch"
# Expected: a line "-    let resolveFetch!: (res: Response) => void;" and a
# replacement "+    let resolveFetch: ((res: Response) => void) | undefined;"

git show c6070d1a857b4d5e82ad47cf0a8ce7c6b78c9f9d -- api/src/__tests__/process-safety.test.ts | grep -nE '^-.*!\.'
# Expected: three removed lines containing "calls[0]!.message", "calls[0]!.meta", "calls[1]!.message"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/factory/defect-gates/rules/non-null-assertion.ts \
  scripts/factory/defect-gates/rules/non-null-assertion.test.ts
git commit -m "feat(factory): add AST-based non-null-assertion defect-gate rule"
```

---

### Task 7: `run.ts`

**Files:**
- Create: `scripts/factory/defect-gates/run.ts`
- Test: `scripts/factory/defect-gates/run.test.ts`

**Interfaces:**
- Consumes: `decidePin`, `resolvePinFacts`, `PinDecision` from `activation.ts` (Task 5); `fileAtRef`, `introducedFindings`, `preExistingFindings` from `baseline.ts` (Task 4); `runRules` from `engine.ts` (Task 1); `nonNullAssertion` from `rules/non-null-assertion.ts` (Task 6); `Finding`, `Rule`, `RuleResult` from `types.ts` (Task 1).
- Produces: `buildDocument(input: BuildInput)`, `formatReportLines(doc)`, `changedTsFiles(repoRoot: string, baseRef: string): string[]` — `changedTsFiles` and the `main()` CLI entrypoint are consumed by `gate.sh`'s G10 step (Task 9).

- [ ] **Step 1: Write `run.ts`**

```ts
// scripts/factory/defect-gates/run.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PinDecision } from "./activation";
import { decidePin, resolvePinFacts } from "./activation";
import { fileAtRef, introducedFindings, preExistingFindings } from "./baseline";
import { runRules } from "./engine";
import nonNullAssertion from "./rules/non-null-assertion";
import type { Finding, Rule, RuleResult } from "./types";

const RULES: Rule[] = [nonNullAssertion];

// Matches review-patterns.mjs's own path scope (api/web/shared/e2e/agent),
// plus sdk/ — a real TS workspace package review-patterns.mjs predates
// (gate.sh's TRO-405 comment). scripts/ itself is excluded: factory
// tooling, not product code.
const TRACKED_PATH_PREFIXES = ["api/", "web/", "shared/", "agent/", "sdk/", "e2e/"];

export interface BuildInput {
  results: RuleResult[];
  baselines: Record<string, Finding[]>;
  pins: Record<string, PinDecision>;
  baseRef: string;
  baseSha: string;
  mergeBase: string;
}

export function buildDocument(input: BuildInput) {
  const rules = input.results.map((result) => {
    const baseline = input.baselines[result.id] ?? [];
    const pin = input.pins[result.id];
    if (!pin) {
      throw new Error(
        `buildDocument: no pin decision for rule '${result.id}' — every RuleResult needs a matching pins entry.`,
      );
    }
    const introduced = introducedFindings(result.findings, baseline);
    const preExisting = preExistingFindings(result.findings, baseline).length;
    let status = result.status;
    if (result.status !== "error") {
      status = introduced.length > 0 ? "fail" : "pass";
    }
    return {
      id: result.id,
      version: result.version,
      status,
      mode: pin.mode,
      pin,
      introduced,
      preExisting,
      advisory: 0,
      exempted: 0,
      error: result.error,
    };
  });

  const failing = rules.filter(
    (r) => r.status === "error" || (r.status === "fail" && r.mode === "blocking"),
  );

  return {
    version: 1,
    ranAt: new Date().toISOString(),
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    mergeBase: input.mergeBase,
    rules,
    notRun: [] as string[],
    exitCode: failing.length > 0 ? 1 : 0,
  };
}

/**
 * Formats the console lines for one report: every introduced finding, plus
 * one line naming the failure detail for any rule with status "error".
 *
 * A rule can error with zero introduced findings — a pin-resolution
 * failure (see `main`) never touches `findings` at all. Printing only per-
 * finding lines then produced a blank report next to an exit code 1, with
 * no clue why the gate failed. The error line is printed even when the
 * same rule also has introduced findings, so neither detail hides the
 * other.
 */
export function formatReportLines(doc: ReturnType<typeof buildDocument>): string[] {
  const lines: string[] = [];
  for (const rule of doc.rules) {
    if (rule.status === "error") {
      lines.push(`  ERROR   ${rule.id}  ${rule.error ?? "unknown error"}`);
    }
    for (const f of rule.introduced) {
      lines.push(`  ${rule.mode === "blocking" ? "FAIL" : "report"}  ${f.file}:${f.line}  ${f.message}`);
    }
  }
  return lines;
}

/**
 * Runs `git` with an argument array, never a shell string.
 *
 * `execSync` hands its whole command string to `/bin/sh -c`, so a `baseRef`
 * value (from `FACTORY_BASE_REF`, or any future caller) interpolated into
 * that string is parsed by the shell — metacharacters in it change what
 * actually runs. `spawnSync` with an argument array passes each value to
 * `git` literally; no shell ever sees it.
 */
function sh(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Lists this branch's changed `.ts`/`.tsx` files under the tracked package
 * roots, excluding `.d.ts`.
 *
 * `--diff-filter=ACMR` keeps only Added, Copied, Modified, and Renamed
 * paths. Without it, a deleted or renamed-away path reaches `readFileSync`
 * downstream and throws `ENOENT` — `engine.ts` then reports `status:
 * "error"`, which fails the gate on a branch that only deleted a file. A
 * renamed path still analyses correctly: its new name is Added or
 * Renamed, so it stays in the list under its current content.
 */
export function changedTsFiles(repoRoot: string, baseRef: string): string[] {
  return sh(["diff", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--name-only"], repoRoot)
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => TRACKED_PATH_PREFIXES.some((p) => f.startsWith(p)));
}

function main(): void {
  const repoRoot = sh(["rev-parse", "--show-toplevel"], process.cwd());
  const baseRef = process.env.FACTORY_BASE_REF ?? "main";
  const outDir = join(repoRoot, ".factory");
  mkdirSync(outDir, { recursive: true });

  const changed = changedTsFiles(repoRoot, baseRef);

  const ctx = {
    files: changed.map((f) => join(repoRoot, f)),
    repoRoot,
  };

  const results = runRules(RULES, ctx);

  const baselines: Record<string, Finding[]> = {};
  const pins: Record<string, PinDecision> = {};
  for (const rule of RULES) {
    // Use fileAtRef, never a raw `git show`. A file this branch ADDED does not
    // exist at BASE_REF, and that is the common case, not the edge case.
    // fileAtRef returns null there; a raw git show would throw and take the
    // whole gate down.
    baselines[rule.meta.id] = changed.flatMap((f) => {
      const before = fileAtRef(repoRoot, baseRef, f);
      if (before === null) return [];
      return rule.checkSource(f, before, ctx);
    });
    let facts: { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number | null } = {
      mergeBaseIsAfterActivation: true,
      mainCommitsElapsed: null,
    };
    if (rule.meta.activatedAt) {
      const resolved = resolvePinFacts(repoRoot, baseRef, rule.meta.activatedAt);
      if (resolved.ok) {
        facts = resolved.facts;
      } else {
        // An unresolved pin must never default to a silently non-blocking
        // rule. Treat it the same as a crashed check: force status
        // "error", so the gate fails loudly with the real reason, never a
        // quiet, permanent report-only mode.
        const idx = results.findIndex((r) => r.id === rule.meta.id);
        if (idx !== -1) {
          results[idx] = { ...results[idx], status: "error", error: resolved.error };
        }
      }
    }
    pins[rule.meta.id] = decidePin({
      activatedAt: rule.meta.activatedAt,
      mergeBaseIsAfterActivation: facts.mergeBaseIsAfterActivation,
      mainCommitsElapsed: facts.mainCommitsElapsed,
      expiresAfter: rule.meta.pinExpiresAfterMainCommits,
    });
  }

  const doc = buildDocument({
    results,
    baselines,
    pins,
    baseRef,
    baseSha: sh(["rev-parse", baseRef], repoRoot),
    mergeBase: sh(["merge-base", "HEAD", baseRef], repoRoot),
  });

  writeFileSync(join(outDir, "defect-gate.json"), JSON.stringify(doc, null, 2) + "\n");
  for (const line of formatReportLines(doc)) console.log(line);
  process.exit(doc.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("run.ts")) main();
```

- [ ] **Step 2: Write `run.test.ts`** (path fixtures adapted to `api/a.ts`/`api/b.ts` so they survive the new `TRACKED_PATH_PREFIXES` filter)

```ts
// scripts/factory/defect-gates/run.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocument, changedTsFiles, formatReportLines } from "./run";
import type { Finding, RuleResult } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r", ruleVersion: 1, file: "src/a.ts", line: 1, identity,
    message: "m", repairability: "assisted", exemptedBy: null,
  };
}

const pin = {
  activatedAt: null, mergeBaseIsAfterActivation: true,
  mainCommitsElapsed: null, expiresAfter: 25, mode: "blocking" as const,
};

describe("buildDocument", () => {
  it("marks a rule failed when the branch introduced a finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("fail");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(1);
  });

  it("does not fail on a pre-existing finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("old")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [finding("old")] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("pass");
    expect(doc.rules[0].preExisting).toBe(1);
    expect(doc.exitCode).toBe(0);
  });

  it("does not fail a report-only rule, and records why", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] },
      pins: { r: { ...pin, mode: "report-only", activatedAt: "abc", mergeBaseIsAfterActivation: false } },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].mode).toBe("report-only");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(0);
  });

  it("fails the gate when a rule errored", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "error", findings: [], error: "boom" },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("error");
    expect(doc.exitCode).toBe(1);
  });

  it("throws a named error when a result's rule id has no matching pin decision", () => {
    // A missing pins entry previously threw a bare "Cannot read properties
    // of undefined (reading 'mode')" with no rule id attached — this names
    // the rule so the real cause (a caller bug, not a git failure) is
    // obvious immediately.
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "pass", findings: [], error: null },
    ];
    expect(() =>
      buildDocument({
        results, baselines: { r: [] }, pins: {},
        baseRef: "main", baseSha: "s", mergeBase: "m",
      }),
    ).toThrow(/no pin decision for rule 'r'/);
  });
});

describe("formatReportLines", () => {
  it("prints nothing for a clean pass with no findings", () => {
    const doc = buildDocument({
      results: [{ id: "r", version: 1, status: "pass", findings: [], error: null }],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(formatReportLines(doc)).toEqual([]);
  });

  it("prints the rule's own error detail for a rule with status error", () => {
    // Previously, a rule that errored with no introduced findings (the pin
    // resolution failure path, not a findings-based failure) printed
    // nothing at all — exit code 1 with a blank report, and no clue why.
    const doc = buildDocument({
      results: [{ id: "r", version: 1, status: "error", findings: [], error: "boom: pin unresolved" }],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    const lines = formatReportLines(doc);
    expect(lines.some((l) => l.includes("boom: pin unresolved"))).toBe(true);
    expect(lines.some((l) => l.includes("r"))).toBe(true);
  });

  it("still prints each introduced finding alongside an error rule's own detail", () => {
    const doc = buildDocument({
      results: [
        { id: "r", version: 1, status: "error", findings: [finding("new")], error: "boom" },
      ],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    const lines = formatReportLines(doc);
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    expect(lines.some((l) => l.includes("src/a.ts:1"))).toBe(true);
  });
});

/**
 * Runs a git command in a scratch repo, using an explicit test identity.
 *
 * Argv, not a shell string — the same discipline `run.ts`'s own `sh` helper
 * documents: a shell string hands metacharacters in any argument to
 * `/bin/sh -c`, where a commit message containing a quote or `$(...)` would
 * be parsed, not passed through literally.
 */
function scratchGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

describe("changedTsFiles", () => {
  it("excludes a deleted path and does not crash on one, but keeps an added path under a tracked prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, ["init", "-q"]);
      mkdirSync(join(dir, "api"));
      writeFileSync(join(dir, "api", "a.ts"), "export const a = 1;\n");
      scratchGit(dir, ["add", "api/a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "add a"]);
      const baseSha = scratchGit(dir, ["rev-parse", "HEAD"]);

      // Branch: delete api/a.ts (the ENOENT trigger), add api/b.ts.
      rmSync(join(dir, "api", "a.ts"));
      writeFileSync(join(dir, "api", "b.ts"), "export const b = 1;\n");
      scratchGit(dir, ["add", "-A"]);
      scratchGit(dir, ["commit", "-q", "-m", "delete a, add b"]);

      const changed = changedTsFiles(dir, baseSha);
      expect(changed).not.toContain("api/a.ts");
      expect(changed).toContain("api/b.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a modified path under a tracked prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, ["init", "-q"]);
      mkdirSync(join(dir, "web"));
      writeFileSync(join(dir, "web", "a.ts"), "export const a = 1;\n");
      scratchGit(dir, ["add", "web/a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "add a"]);
      const baseSha = scratchGit(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "web", "a.ts"), "export const a = 2;\n");
      scratchGit(dir, ["add", "web/a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "modify a"]);

      expect(changedTsFiles(dir, baseSha)).toEqual(["web/a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes a changed file outside every tracked package prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, ["init", "-q"]);
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "tool.ts"), "export const x = 1;\n");
      scratchGit(dir, ["add", "-A"]);
      scratchGit(dir, ["commit", "-q", "-m", "add scripts/tool.ts"]);
      const baseSha = scratchGit(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "scripts", "tool.ts"), "export const x = 2;\n");
      scratchGit(dir, ["add", "-A"]);
      scratchGit(dir, ["commit", "-q", "-m", "modify"]);

      expect(changedTsFiles(dir, baseSha)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts run.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 4: Run the CLI against this repo's own working state as a smoke test**

```bash
FACTORY_BASE_REF=main pnpm exec tsx scripts/factory/defect-gates/run.ts
```

Expected: exits 0 (no uncommitted changes yet touch tracked TS files beyond what's already committed), writes `.factory/defect-gate.json`. If it exits non-zero, read `.factory/defect-gate.json` before proceeding — a real finding here means either a genuine pre-existing non-null assertion on `main` in a file you've touched, or a bug in the port.

- [ ] **Step 5: Commit**

```bash
git add scripts/factory/defect-gates/run.ts scripts/factory/defect-gates/run.test.ts
git commit -m "feat(factory): add defect-gate run orchestrator (changed-file scan, .factory/defect-gate.json)"
```

---

### Task 8: `replay.ts`

**Files:**
- Create: `scripts/factory/defect-gates/replay.ts`
- Test: `scripts/factory/defect-gates/replay.test.ts`

**Interfaces:**
- Consumes: `fileAtRef` from `baseline.ts` (Task 4); `Finding`, `ReplayCorpusEntry`, `Rule` from `types.ts` (Task 1); `nonNullAssertion` from `rules/non-null-assertion.ts` (Task 6, for the test only).
- Produces: `LedgerRow {ticket, pr?, file, disposition, category, summary}`, `ReplayOutcome {ticket, file, resolved, hit}`, `ReplayReport {total, resolvable, unresolvable, hits, recall}`, `resolveFixCandidates(repoRoot, row): string[]`, `selectCorpusRows(rows, corpus): LedgerRow[]`, `summariseReplay(outcomes): ReplayReport`, `replayRule(repoRoot, rule, rows): {outcomes, report}`, `loadLedger(path): LedgerRow[]` — consumed by Task 12's verification step.

- [ ] **Step 1: Write `replay.ts`**

```ts
// scripts/factory/defect-gates/replay.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileAtRef } from "./baseline";
import type { Finding, ReplayCorpusEntry, Rule } from "./types";

export interface LedgerRow {
  ticket: string;
  pr?: string;
  file: string;
  disposition: string;
  category: string;
  summary: string;
}

export interface ReplayOutcome {
  ticket: string;
  /**
   * The ledger row's own file. A ticket alone does not name a row — one
   * ticket can carry several calibration rows, one per file, and without
   * this field their outcomes are indistinguishable in the written
   * artifact.
   */
  file: string;
  resolved: boolean;
  hit: boolean;
}

export interface ReplayReport {
  total: number;
  resolvable: number;
  unresolvable: number;
  hits: number;
  recall: number;
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/** Escapes text for safe use as a literal inside git's basic regex grammar. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lists every commit that touched this row's file and names its ticket in
 * its own message, oldest first.
 *
 * A single "most recent match" guess often lands on the wrong commit. It
 * might be a merge commit whose parent predates the whole PR. It might be
 * a later bookkeeping commit dated after the real fix. This lists every
 * candidate instead. `replayRule` can then test the rule against each
 * pre-fix snapshot in turn. It does not need to know which one was the
 * real fix.
 *
 * The `--grep` pattern is word-boundary anchored. An unanchored ticket id
 * is a prefix-match risk: "TRO-464" is itself a leading substring of
 * "TRO-4640", so a commit naming the wrong, longer ticket number would
 * read as a match for the shorter one. `\b` is a GNU extension git
 * supports in its default basic-regex grammar — deliberately NOT paired
 * with `--extended-regexp`, which compiles `\b` as a literal backspace
 * instead of a word boundary and silently matches nothing at all.
 */
export function resolveFixCandidates(repoRoot: string, row: LedgerRow): string[] {
  const pattern = `\\b${escapeForRegExp(row.ticket)}\\b`;
  const result = git(repoRoot, [
    "log",
    "--format=%H",
    "--reverse",
    "--grep",
    pattern,
    "--",
    row.file,
  ]);
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Selects the ledger rows a rule declares itself calibrated against.
 *
 * A corpus entry names one row by ticket, file, and a distinctive summary
 * substring — the ledger has no stable row id. Throws when an entry
 * matches no row, so a stale entry cannot silently shrink the corpus.
 */
export function selectCorpusRows(rows: LedgerRow[], corpus: ReplayCorpusEntry[]): LedgerRow[] {
  return corpus.map((entry) => {
    const match = rows.find(
      (row) =>
        row.ticket === entry.ticket &&
        row.file === entry.file &&
        row.summary.includes(entry.summaryIncludes),
    );
    if (!match) {
      throw new Error(
        `replayCorpus entry not found in ledger: ${entry.ticket} ${entry.file} "${entry.summaryIncludes}"`,
      );
    }
    return match;
  });
}

export function summariseReplay(outcomes: ReplayOutcome[]): ReplayReport {
  const resolvable = outcomes.filter((o) => o.resolved).length;
  const hits = outcomes.filter((o) => o.resolved && o.hit).length;
  return {
    total: outcomes.length,
    resolvable,
    unresolvable: outcomes.length - resolvable,
    hits,
    recall: resolvable === 0 ? 0 : hits / resolvable,
  };
}

/**
 * Runs a rule against the tree as it stood BEFORE each fix, and records
 * whether the rule would have caught it.
 *
 * A row may have several candidate fixing commits (see
 * `resolveFixCandidates`). The row counts as a hit when the rule fires at
 * any candidate's pre-fix snapshot. The real question is whether the rule
 * would have caught the defect while it was present. It does not matter
 * which commit history later assigned as "the" fix. A row is unresolvable
 * only when no candidate's parent contains the file.
 */
export function replayRule(
  repoRoot: string,
  rule: Rule,
  rows: LedgerRow[],
): {
  outcomes: ReplayOutcome[];
  report: ReplayReport;
} {
  // Rule is typed with a required checkSource, but a rule module loaded
  // through a dynamic import in a future CLI wrapper could still reach here
  // via an `as unknown as Rule` cast the type system cannot verify at
  // runtime. Fail loudly and by name here, rather than let a missing
  // method surface later as a generic "not a function" error with no rule
  // id attached.
  if (typeof rule.checkSource !== "function") {
    throw new Error(`rule ${rule.meta.id} has no checkSource; replay cannot measure recall`);
  }
  const outcomes: ReplayOutcome[] = rows.map((row) => {
    const candidates = resolveFixCandidates(repoRoot, row);
    let resolved = false;
    let hit = false;
    for (const fix of candidates) {
      const before = `${fix}^1`;
      const text = fileAtRef(repoRoot, before, row.file);
      if (text === null) continue;
      resolved = true;
      let found: Finding[];
      try {
        found = rule.checkSource(row.file, text, { files: [], repoRoot });
      } catch {
        // One historical snapshot failing to parse (a syntax the current
        // TypeScript version rejects, a shape the rule does not expect)
        // makes only that candidate unusable. It must not abort replay
        // for the remaining candidates or the remaining rows.
        continue;
      }
      if (found.length > 0) {
        hit = true;
        break;
      }
    }
    return { ticket: row.ticket, file: row.file, resolved, hit };
  });
  return { outcomes, report: summariseReplay(outcomes) };
}

export function loadLedger(path: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  // Split first, filter never — a blank line must keep its own position so
  // the line number reported below is the file's real line, not a count
  // over the SURVIVING lines. Filtering out blanks before numbering was
  // exactly this bug: a blank line before a bad row shifted every
  // following report short by however many blanks came before it.
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      // 1-based line number: the file's own first line, not the array's
      // zero-based index. A bare JSON.parse error names neither the file
      // nor which of its (often hundreds of) lines is malformed.
      throw new Error(`loadLedger: invalid JSON at ${path}:${i + 1}: ${reason}`);
    }
  }
  return rows;
}
```

- [ ] **Step 2: Write `replay.test.ts`** (adapted: the real-history assertions use `TRO-230`/`TRO-276` and their verified commits from this repo, instead of LabelHunter's `TRO-511`/`TRO-464`)

```ts
// scripts/factory/defect-gates/replay.test.ts
import { describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerRow } from "./replay";
import {
  loadLedger,
  replayRule,
  resolveFixCandidates,
  selectCorpusRows,
  summariseReplay,
} from "./replay";
import rule from "./rules/non-null-assertion";
import type { Rule } from "./types";

/**
 * Runs a git command in a scratch repo, using an explicit test identity and
 * an argument array — never a shell string (`run.ts`'s own `sh` documents
 * why: a shell string hands any metacharacter in an argument to `/bin/sh
 * -c`, where it gets parsed instead of passed through literally).
 */
function scratchGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

// resolveFixCandidates and replayRule below replay REAL commit history for
// two specific tickets (TRO-230, TRO-276) in this repo, not a synthetic
// scratch repo — that is the point: they prove the harness against actual
// git archaeology. A shallow checkout truncates that history, which would
// fail every assertion below for an environment reason, not a code bug.
// Skip with a named reason instead of a confusing failure; a full clone
// (this repo's normal state, and CI's `fetch-depth: 0`) always runs them.
const isShallowRepo =
  execSync("git rev-parse --is-shallow-repository", { cwd: repoRoot, encoding: "utf8" }).trim() ===
  "true";

describe("summariseReplay", () => {
  it("computes recall over resolvable rows only", () => {
    const report = summariseReplay([
      { ticket: "A", file: "a.ts", resolved: true, hit: true },
      { ticket: "B", file: "b.ts", resolved: true, hit: false },
      { ticket: "C", file: "c.ts", resolved: false, hit: false },
    ]);
    expect(report.resolvable).toBe(2);
    expect(report.hits).toBe(1);
    expect(report.recall).toBeCloseTo(0.5);
    expect(report.unresolvable).toBe(1);
  });

  it("reports zero recall rather than dividing by zero", () => {
    const report = summariseReplay([{ ticket: "A", file: "a.ts", resolved: false, hit: false }]);
    expect(report.recall).toBe(0);
    expect(report.resolvable).toBe(0);
  });
});

describe.skipIf(isShallowRepo)("resolveFixCandidates", () => {
  it("lists every commit touching the file that names the ticket, oldest first", () => {
    const shas = resolveFixCandidates(repoRoot, {
      ticket: "TRO-230",
      file: "web/src/pages/OrgChartPage.test.tsx",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    // Measured on this repo: three commits touch OrgChartPage.test.tsx and
    // name TRO-230 in their own message (create, address CodeRabbit
    // findings, strengthen assertion round 2).
    expect(shas.length).toBeGreaterThanOrEqual(2);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // git log --reverse lists the oldest commit first. Confirm ordering by
    // asking git which of the first two commits is the ancestor.
    if (shas.length >= 2) {
      const result = spawnSync("git", ["merge-base", "--is-ancestor", shas[0], shas[1]], {
        cwd: repoRoot,
      });
      expect(result.status).toBe(0);
    }
  });

  it("returns an empty list when no commit touches the file and names the ticket", () => {
    const shas = resolveFixCandidates(repoRoot, {
      ticket: "TRO-000000",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(shas).toEqual([]);
  });
});

describe("resolveFixCandidates word-boundary anchoring", () => {
  // A real scratch repo, not this repo's history — the point is a
  // deterministic, minimal reproduction of the prefix-match risk: a commit
  // naming a LONGER ticket number ("TRO-2300") must not read as a match for
  // a SHORTER one ("TRO-230") just because it starts with the same digits.
  function scratchRepoWithCommitMessage(message: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "dg-replay-boundary-"));
    scratchGit(dir, ["init", "-q"]);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    scratchGit(dir, ["add", "a.ts"]);
    scratchGit(dir, ["commit", "-q", "-m", message]);
    return { dir, file: "a.ts" };
  }

  it("does not match a longer ticket number that merely starts with the target ticket's digits", () => {
    const { dir, file } = scratchRepoWithCommitMessage("TRO-2300: unrelated change");
    try {
      const shas = resolveFixCandidates(dir, {
        ticket: "TRO-230",
        file,
        disposition: "fixed",
        category: "c",
        summary: "s",
      });
      expect(shas).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still matches the ticket when it appears with a non-word character on both sides", () => {
    const { dir, file } = scratchRepoWithCommitMessage("fix(TRO-230): the real fix");
    try {
      const shas = resolveFixCandidates(dir, {
        ticket: "TRO-230",
        file,
        disposition: "fixed",
        category: "c",
        summary: "s",
      });
      expect(shas).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadLedger", () => {
  it("names the file and line number when a row fails to parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-ledger-"));
    const ledgerPath = join(dir, "bad-ledger.jsonl");
    try {
      writeFileSync(ledgerPath, '{"ticket":"TRO-1"}\nnot json at all\n{"ticket":"TRO-2"}\n');
      let thrown: unknown;
      try {
        loadLedger(ledgerPath);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(ledgerPath);
      expect(message).toContain(":2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the true source line number even when a blank line precedes the bad row", () => {
    // A blank row is skipped, not counted as a ledger entry — but skipping
    // it must not shift the line numbers reported for anything after it.
    // Line 1 is the good row, line 2 is blank, line 3 is the bad JSON: the
    // error must name line 3, not line 2 (the position it would land at
    // if blank lines were filtered out before numbering).
    const dir = mkdtempSync(join(tmpdir(), "dg-ledger-"));
    const ledgerPath = join(dir, "bad-ledger-blank.jsonl");
    try {
      writeFileSync(
        ledgerPath,
        '{"ticket":"TRO-1"}\n\nnot json at all\n{"ticket":"TRO-2"}\n',
      );
      let thrown: unknown;
      try {
        loadLedger(ledgerPath);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(":3:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("selectCorpusRows", () => {
  const rows: LedgerRow[] = [
    { ticket: "TRO-1", file: "a.ts", disposition: "fixed", category: "c", summary: "the first bug, about widgets" },
    { ticket: "TRO-1", file: "b.ts", disposition: "fixed", category: "c", summary: "a second, unrelated bug" },
    { ticket: "TRO-2", file: "a.ts", disposition: "fixed", category: "c", summary: "a different ticket, same file" },
  ];

  it("picks the row matching ticket, file, and a summary substring", () => {
    const picked = selectCorpusRows(rows, [
      { ticket: "TRO-1", file: "a.ts", summaryIncludes: "widgets" },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].summary).toBe("the first bug, about widgets");
  });

  it("throws when a corpus entry matches no ledger row", () => {
    expect(() =>
      selectCorpusRows(rows, [{ ticket: "TRO-9", file: "z.ts", summaryIncludes: "nothing" }]),
    ).toThrow(/TRO-9/);
  });
});

describe.skipIf(isShallowRepo)("replayRule", () => {
  it("counts a hit for the TRO-230 definite-assignment-assertion calibration row", () => {
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-230",
        file: "web/src/pages/OrgChartPage.test.tsx",
        disposition: "fixed",
        category: "type-safety",
        summary: "non-null assertion on resolveFetch in test setup",
      },
    ];
    const { outcomes } = replayRule(repoRoot, rule, rows);
    expect(outcomes[0].resolved).toBe(true);
    expect(outcomes[0].hit).toBe(true);
  });

  it("counts a hit for the TRO-276 postfix-non-null-assertion calibration row", () => {
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-276",
        file: "api/src/__tests__/process-safety.test.ts",
        disposition: "fixed",
        category: "type-safety",
        summary: "non null assertions and any cast",
      },
    ];
    const { outcomes } = replayRule(repoRoot, rule, rows);
    expect(outcomes[0].resolved).toBe(true);
    expect(outcomes[0].hit).toBe(true);
  });

  it("marks a row unresolvable only when no candidate's parent contains the file", () => {
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-000000",
        file: "src/x.ts",
        disposition: "fixed",
        category: "c",
        summary: "s",
      },
    ];
    const { outcomes } = replayRule(repoRoot, rule, rows);
    expect(outcomes[0].resolved).toBe(false);
    expect(outcomes[0].hit).toBe(false);
  });

  it("throws immediately, naming the rule, when checkSource is missing", () => {
    const bareRule = { ...rule, checkSource: undefined } as unknown as Rule;
    expect(() => replayRule(repoRoot, bareRule, [])).toThrow(/non-null-assertion/);
  });

  it("treats a candidate whose checkSource throws as unusable, and keeps trying the rest", () => {
    let calls = 0;
    const flaky: Rule = {
      ...rule,
      checkSource: (f, t, c) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated parse failure on this snapshot");
        return rule.checkSource(f, t, c);
      },
    };
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-230",
        file: "web/src/pages/OrgChartPage.test.tsx",
        disposition: "fixed",
        category: "type-safety",
        summary: "non-null assertion on resolveFetch in test setup",
      },
    ];
    const { outcomes } = replayRule(repoRoot, flaky, rows);
    expect(calls).toBeGreaterThan(1);
    expect(outcomes[0].resolved).toBe(true);
    expect(outcomes[0].hit).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts replay.test.ts`
Expected: PASS, 12 tests (the `TRO-230`/`TRO-276` real-history hit tests are the load-bearing proof that this rule's `replayCorpus` calibration is real, not aspirational — this is the spec's "replay recall" acceptance-evidence bullet, satisfied here).

- [ ] **Step 4: Commit**

```bash
git add scripts/factory/defect-gates/replay.ts scripts/factory/defect-gates/replay.test.ts
git commit -m "feat(factory): add defect-gate replay calibration harness"
```

---

### Task 9: Wire into `gate.sh` as G10, then pin activation

**Files:**
- Modify: `scripts/factory/gate.sh` (insert new step after G9, before the verdict block — currently lines 471-472)
- Modify: `scripts/factory/defect-gates/rules/non-null-assertion.ts` (second commit only, once the wiring commit's SHA is known)

**Interfaces:**
- Consumes: `scripts/factory/defect-gates/run.ts`'s `main()` CLI entrypoint (Task 7) via `pnpm exec tsx`.

- [ ] **Step 1: Insert the G10 step into `gate.sh`**

Find this exact block near the end of `gate.sh` (currently lines 471-472):

```bash
# --- verdict ----------------------------------------------------------------
echo
```

Replace it with:

```bash
# --- G10: defect-gate (AST-based, identity-baselined, activation-pinned) ---
# Ported from LabelHunter's scripts/factory/defect-gates/ — see
# docs/superpowers/specs/2026-08-14-factory-defect-gate-design.md.
# scopeLimitFiles above (G8) also lives in audit/factory/config.yaml; this
# comment is the same cross-reference LabelHunter's own gate.sh uses rather
# than parsing the YAML at runtime.
if pnpm exec tsx scripts/factory/defect-gates/run.ts > "$OUT_DIR/defect-gate.log" 2>&1; then
  record defect-gate pass "no introduced findings"
else
  DG_N="$(grep -cE '^\s{2}(FAIL|report)' "$OUT_DIR/defect-gate.log" 2>/dev/null)" || DG_N=0
  record defect-gate fail "${DG_N} introduced finding(s) — see .factory/defect-gate.json / defect-gate.log"
fi

# --- verdict ----------------------------------------------------------------
echo
```

- [ ] **Step 2: Add the `config.yaml` cross-reference comment to G8**

Find the existing G8 block:

```bash
# --- G8: scope discipline ---------------------------------------------------
CHANGED_FILES="$(git diff "${BASE_REF}"...HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')"
```

Replace with:

```bash
# --- G8: scope discipline ---------------------------------------------------
# The 40-file threshold below is also recorded in audit/factory/config.yaml's
# gate.scopeLimitFiles — kept in sync by hand; not parsed from there at
# runtime (see the design spec's non-goals).
CHANGED_FILES="$(git diff "${BASE_REF}"...HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')"
```

- [ ] **Step 3: Smoke-test the wired gate step directly**

```bash
FACTORY_BASE_REF=main pnpm exec tsx scripts/factory/defect-gates/run.ts && echo "exit 0 confirmed"
```

Expected: `exit 0 confirmed` (no findings against `main`'s current committed state for whatever is in the working tree at this point in the plan).

- [ ] **Step 4: Commit the wiring**

```bash
git add scripts/factory/gate.sh
git commit -m "feat(factory): wire defect-gate engine into gate.sh as G10"
```

- [ ] **Step 5: Pin the rule's activation to this commit**

```bash
git rev-parse HEAD
```

Copy the printed SHA. Edit `scripts/factory/defect-gates/rules/non-null-assertion.ts`, changing:

```ts
  activatedAt: null,
```

to (using the SHA just printed):

```ts
  activatedAt: "<the-sha-from-git-rev-parse-HEAD-above>",
```

- [ ] **Step 6: Run the rule's unit tests once more to confirm the meta change doesn't break anything**

Run: `pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts rules/non-null-assertion.test.ts`
Expected: PASS, 7 tests (unaffected — none of them assert on `activatedAt`).

- [ ] **Step 7: Commit the activation pin**

```bash
git add scripts/factory/defect-gates/rules/non-null-assertion.ts
git commit -m "chore(factory): pin non-null-assertion rule's activation to the G10 landing commit"
```

---

### Task 10: Remove the redundant check from `review-patterns.mjs`

**Files:**
- Modify: `scripts/factory/review-patterns.mjs:48-63`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this is a deletion.

- [ ] **Step 1: Remove the `non-null-assertion` rule entry**

In `scripts/factory/review-patterns.mjs`, find:

```js
const RULES = [
  {
    id: 'non-null-assertion',
    // Postfix `!` on an identifier or index, e.g. `foo!.bar`, `arr[0]!`, `x!)`.
    // Also catches `!` immediately before a colon — TRO-230's CodeRabbit review
    // caught this checker missing `let resolveFetch!: (res: Response) => void;`
    // (a definite-assignment assertion) entirely, since `:` wasn't in the
    // followed-by set. The same `!(?=\s*:)` shape also catches a non-null
    // assertion in a ternary's consequent (`cond ? x! : y`), which is a second,
    // independently valid case this addition covers.
    // Deliberately not trying to catch every form: false positives here would
    // make the check untrustworthy, and TS-4 counts the common shapes.
    re: /(?:\w|\]|\))!(?=\s*[.,;)\]}:]|\s*$)/,
    why: 'new non-null assertion — TS-4 tracks 236 of these as a measured number we are graded on reducing',
    files: /\.(ts|tsx)$/,
  },
  {
    id: 'as-any',
```

Replace with:

```js
const RULES = [
  // non-null-assertion migrated to scripts/factory/defect-gates/rules/non-null-assertion.ts
  // (gate.sh's G10) — an AST-based check, identity-baselined and activation-pinned. See
  // docs/superpowers/specs/2026-08-14-factory-defect-gate-design.md.
  {
    id: 'as-any',
```

- [ ] **Step 2: Confirm `review-patterns.mjs` still runs cleanly**

```bash
node scripts/factory/review-patterns.mjs main
```

Expected: `review-patterns: clean` (or a report of genuinely pre-existing violations under the remaining five rules — not a syntax error from the edit).

- [ ] **Step 3: Commit**

```bash
git add scripts/factory/review-patterns.mjs
git commit -m "refactor(factory): drop non-null-assertion from review-patterns.mjs, now covered by G10"
```

---

### Task 11: `audit/factory/config.yaml` + doc consolidation

**Files:**
- Create: `audit/factory/config.yaml`
- Modify: `.claude/skills/ship-factory/SKILL.md:15-20`
- Modify: `.claude/skills/ship-factory/SKILL.md` (recurrence ladder table, currently around line 415-419)
- Modify: `.claude/skills/ship-orchestrator/SKILL.md:171-174`

**Interfaces:** none (documentation/config only).

- [ ] **Step 1: Create `audit/factory/config.yaml`**

```yaml
# audit/factory/config.yaml — single source for facts that were previously
# duplicated across .claude/skills/ship-factory/SKILL.md and
# .claude/skills/ship-orchestrator/SKILL.md, both of which flagged the
# duplication as "the thing most likely to go stale." Update this file when
# any of these facts change; the skill docs point here instead of repeating
# the value inline.
#
# Not parsed by any script at runtime — see
# docs/superpowers/specs/2026-08-14-factory-defect-gate-design.md's
# non-goals for why (verified against LabelHunter's own factory/config.yaml,
# which has the same property: gate.sh there also hardcodes its scope-limit
# number, referencing config.yaml only in a comment).

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
  briefRule: 2     # distinct tickets -> add a rule to references/lessons.md
  gateCheck: 3      # distinct tickets -> add a mechanical gate check

gate:
  scopeLimitFiles: 40    # gate.sh G8 hardcodes this; kept in sync by hand, see gate.sh's own comment
```

- [ ] **Step 2: Replace `ship-factory/SKILL.md`'s active-project paragraph**

Find (lines 15-20):

```
You are the **orchestrator**. You hold the board and the gates; sub-agents do the building.
**Current work (2026-08-08): Week 5, `FleetGraph — Week 5 Project Intelligence Agent`.** That is the
default project for selection, briefs, and measurement. Week 4's `ShipShape Audit Remediation` is
**past** — 121 of its 123 tickets are Done and it is worked only to close a specific residual
(`TRO-354`, or a W4 requirement gap named by `audit/requirements/`). Do not pull W4 tickets as
general queue-filler; a wave spent on last week's grade is a wave not spent on this week's.
Re-read this paragraph at the start of every run: it is the one thing in this file that goes stale.
```

Replace with:

```
You are the **orchestrator**. You hold the board and the gates; sub-agents do the building.
**Read `audit/factory/config.yaml`'s `meta.activeProject` at the start of every run — do not
hardcode it here.** As of the config's `updatedAt`, Week 4's `ShipShape Audit Remediation` is
**past** — 121 of its 123 tickets are Done and it is worked only to close a specific residual
(`TRO-354`, or a requirement gap named by `audit/requirements/`). Do not pull past-project tickets
as general queue-filler; a wave spent on last week's grade is a wave not spent on this week's.
```

- [ ] **Step 3: Replace `ship-factory/SKILL.md`'s recurrence-ladder table**

Find:

```
The thresholds are the point:

| Recurrence | Meaning | Action |
|---|---|---|
| 1 ticket | feedback | fix it, move on |
| **2 tickets** | a rule is missing from the brief | add it to `references/lessons.md` |
| **3+ tickets** | the prompt is not holding | add a **mechanical check** to `gate.sh` |
```

Replace with:

```
The thresholds (`audit/factory/config.yaml`'s `recurrenceLadder`) are the point:

| Recurrence | Meaning | Action |
|---|---|---|
| 1 ticket | feedback | fix it, move on |
| **`briefRule` tickets** | a rule is missing from the brief | add it to `references/lessons.md` |
| **`gateCheck` tickets** | the prompt is not holding | add a **mechanical check** to `gate.sh` |
```

- [ ] **Step 4: Replace `ship-orchestrator/SKILL.md`'s active-project paragraph**

Find:

```
- **Never dispatch outside the run's active project** in team `Troysatchell`. As of 2026-08-08 that
  is `FleetGraph — Week 5 Project Intelligence Agent`; `ShipShape Audit Remediation` is Week 4 and
  closed at 121/123. **Confirm the active project at the start of every run rather than trusting
  this line** — it is the sentence in this file most likely to be stale.
```

Replace with:

```
- **Never dispatch outside the run's active project.** Read `audit/factory/config.yaml`'s
  `meta.activeProject` and `meta.team` at the start of every run — do not hardcode either here.
```

- [ ] **Step 5: Verify the doc edits render correctly**

```bash
grep -n "audit/factory/config.yaml" .claude/skills/ship-factory/SKILL.md .claude/skills/ship-orchestrator/SKILL.md
```

Expected: at least 3 matches total (two in `ship-factory/SKILL.md`, one in `ship-orchestrator/SKILL.md`).

- [ ] **Step 6: Commit**

```bash
git add audit/factory/config.yaml .claude/skills/ship-factory/SKILL.md .claude/skills/ship-orchestrator/SKILL.md
git commit -m "docs(factory): consolidate active-project and recurrence-ladder facts into audit/factory/config.yaml"
```

---

### Task 12: End-to-end verification (this ticket's acceptance evidence)

**Files:** none created — this task produces evidence, referenced from the PR description / `CHANGES.md`.

- [ ] **Step 1: Replay recall, printed explicitly**

```bash
pnpm exec tsx -e '
import { loadLedger, selectCorpusRows, replayRule } from "./scripts/factory/defect-gates/replay";
import rule from "./scripts/factory/defect-gates/rules/non-null-assertion";
const rows = selectCorpusRows(loadLedger("audit/factory/review-findings.jsonl"), rule.meta.replayCorpus);
const { outcomes, report } = replayRule(process.cwd(), rule, rows);
console.log(JSON.stringify({ outcomes, report }, null, 2));
'
```

Expected: `report.recall` is `1` (both `TRO-230` and `TRO-276` rows resolve and hit — verified during Task 6's Step 4 and re-proven by Task 8's `replayRule` tests).

- [ ] **Step 2: Forged break-one/fix-one, in a scratch worktree**

**Caveat found during execution:** the commands below use `FACTORY_BASE_REF=main` literally. Before
this branch merges to `main`, that will NOT reproduce the exit-1 result this step expects —
`main` doesn't yet contain the commit that activates the rule (only this branch does), so
activation-pinning correctly runs the gate in report-only mode (exit 0) against real `main`, per its
own design. This is expected, not a bug — see `CHANGES.md`'s entry for this feature, which documents
running the forged test both ways (against real `main`, and against a commit on this branch past
activation) and explains why. Once this branch merges, `FACTORY_BASE_REF=main` will behave as written
below.

```bash
scripts/factory/worktree.sh TRO-DEFECT-GATE-VERIFY fix/defect-gate-verify
# worktree.sh names the worktree deterministically: TICKET_SLUG lowercases
# the ticket and turns "-" into "_", so this ticket lands at:
cd ../Ship-wt-tro_defect_gate_verify

# Introduce ONE new non-null assertion.
cat >> api/src/__tests__/scratch-verify.ts <<'EOF'
export function scratchProbe(x: { y: number } | null): number {
  return x!.y;
}
EOF
git add api/src/__tests__/scratch-verify.ts
git commit -m "test: forged new violation for defect-gate verification"

FACTORY_BASE_REF=main pnpm exec tsx scripts/factory/defect-gates/run.ts
echo "exit code: $?"
```

Expected: exit code `1`, and `.factory/defect-gate.json`'s `rules[0].introduced` has exactly one entry pointing at `scratchProbe`'s `x!.y` — proving `introducedFindings` catches a genuinely new violation, not just a raw count.

Then clean up:

```bash
git worktree remove --force "$(git worktree list | grep TRO-DEFECT-GATE-VERIFY | awk '{print $1}')" 2>/dev/null || true
git branch -D fix/defect-gate-verify 2>/dev/null || true
```

- [ ] **Step 3: Confirm activation pinning report-only behavior**

```bash
pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts activation.test.ts
```

Expected: PASS (this is the existing unit-test proof for `decidePin`'s report-only branch — Task 5's Step 3 already covers this; re-running here as part of this ticket's consolidated evidence, not a new test).

- [ ] **Step 4: Record the verification results in `CHANGES.md`**

Append an entry (matching the repo's existing `CHANGES.md` format — check a recent entry for the exact heading style before writing this one) summarizing: replay recall = 1.0 on 2 real calibration rows (TRO-230, TRO-276), forged break-one/fix-one caught (exit 1, correct single introduced finding), activation-pinning unit tests pass. This is the ticket's own claim-provenance evidence per CLAUDE.md.

- [ ] **Step 5: Run the full test suite once more before opening the PR**

```bash
pnpm exec vitest run --config scripts/factory/defect-gates/vitest.config.ts
pnpm exec tsc --noEmit -p scripts/factory/defect-gates
pnpm type-check
```

Expected: all three pass. Note the correction discovered during Task 7's review: `pnpm type-check` (`pnpm --recursive run type-check`) only runs each `pnpm-workspace.yaml` package's own check (`api`/`web`/`shared`/`agent`/`sdk`) — it never reaches `scripts/`, so it does NOT verify the new defect-gate files despite the original plan text's claim that it would. The scoped `pnpm exec tsc --noEmit -p scripts/factory/defect-gates` (the directory's own `tsconfig.json`, added during Task 7's fix loop) is what actually confirms the new TS files — including the compiler-API-heavy `ast.ts` and `rules/non-null-assertion.ts` — type-check cleanly. `pnpm type-check` is still run here to confirm this port didn't regress the rest of the workspace, not to verify the new directory.

- [ ] **Step 6: Commit the CHANGES.md entry**

```bash
git add CHANGES.md
git commit -m "docs(changes): record defect-gate engine verification evidence"
```

## Self-Review Notes

- **Spec coverage:** all three spec sections (engine port, migrated rule, config consolidation) map to tasks 1-8 (engine), 6+9+10 (rule + gate.sh wiring + review-patterns.mjs removal), and 11 (config.yaml). The spec's five-point verification plan maps to Task 12 (points 2, 3 explicitly; points 1, 4, 5 are covered by each task's own unit tests as they're built, cross-referenced in Task 12).
- **Placeholder scan:** the only two "fill in later" values in the source design (the rule's `activatedAt` commit and the replay corpus rows) are both resolved to concrete values in this plan — `activatedAt` via Task 9's two-commit pin sequence (the SHA cannot exist before the commit does, same constraint LabelHunter's own rule had), and the replay corpus via Task 6's verified `TRO-230`/`TRO-276` rows with real commit SHAs.
- **Type consistency:** `RuleContext` is `{files, repoRoot}` (no `registries`) everywhere it appears — Task 1's `types.ts`, Task 6's rule, Task 7's `run.ts`, Task 8's `replay.ts`'s inline context literal. `Rule`/`RuleMeta`/`Finding`/`RuleResult` field names match Task 1's definitions in every later task that constructs or destructures them.
