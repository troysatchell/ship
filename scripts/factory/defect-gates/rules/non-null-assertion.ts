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
  activatedAt: "63d54e49b1eab2becab923eb823129eb4b829e8a",
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
