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
    const [finding] = findings;
    if (!finding) throw new Error("expected a finding");
    expect(finding.message).toContain("non-null assertion");
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
    const [finding] = findings;
    if (!finding) throw new Error("expected a finding");
    expect(finding.line).toBe(2);
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
    const [first, second] = findings;
    if (!first || !second) throw new Error("expected two findings");
    expect(first.identity).not.toBe(second.identity);
  });

  it("reports the correct 1-based line number", () => {
    const findings = nonNullAssertion.checkSource(
      "a.ts",
      `function f(foo: { bar: number } | null) {\n  return foo!.bar;\n}`,
      ctx,
    );
    const [finding] = findings;
    if (!finding) throw new Error("expected a finding");
    expect(finding.line).toBe(2);
  });
});
