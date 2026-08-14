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
      const [first, second] = shas;
      if (!first || !second) throw new Error("expected at least two shas");
      const result = spawnSync("git", ["merge-base", "--is-ancestor", first, second], {
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
    const [first] = picked;
    if (!first) throw new Error("expected one picked row");
    expect(first.summary).toBe("the first bug, about widgets");
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
    const [outcome] = outcomes;
    if (!outcome) throw new Error("expected one outcome");
    expect(outcome.resolved).toBe(true);
    expect(outcome.hit).toBe(true);
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
    const [outcome] = outcomes;
    if (!outcome) throw new Error("expected one outcome");
    expect(outcome.resolved).toBe(true);
    expect(outcome.hit).toBe(true);
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
    const [outcome] = outcomes;
    if (!outcome) throw new Error("expected one outcome");
    expect(outcome.resolved).toBe(false);
    expect(outcome.hit).toBe(false);
  });

  it("throws immediately, naming the rule, when checkSource is missing", () => {
    const bareRule = { ...rule, checkSource: undefined } as unknown as Rule;
    expect(() => replayRule(repoRoot, bareRule, [])).toThrow(/non-null-assertion/);
  });
});

// A real scratch repo, not this repo's history. This test is about an
// algorithmic robustness property of replayRule — does it correctly skip a
// candidate whose checkSource throws and keep trying the rest — not about
// calibration authenticity. The two "counts a hit" tests above already
// establish that against real history for TRO-230 and TRO-276. TRO-230's
// real history turns out to offer only ONE candidate whose pre-fix
// snapshot both exists and carries the violation (the commit before it
// predates the file's creation; the commit after it already has the fix),
// so a "throws on first call" wrapper against that real row unavoidably
// consumes the row's only real hit — an accident of this repo's commit
// granularity, not a property of replayRule worth asserting on. A
// deliberately-built scratch repo makes the "hit survives a discarded
// candidate" scenario possible and deterministic instead. Uses the real
// nonNullAssertion rule (imported above), not a stub, so this still
// exercises real AST-detection logic — only the git history is synthetic.
describe("replayRule checkSource resilience (scratch repo)", () => {
  // Three commits: root has the violation; commit B ("touch") edits the
  // file but deliberately leaves the violation in place, so B's PARENT
  // (root) still has it; commit C ("fix") removes it, so C's PARENT (B)
  // still has it too. resolveFixCandidates returns [B, C] oldest first —
  // both name TRO-9001 and touch a.ts. Trying B's pre-fix snapshot (root)
  // is where the flaky wrapper's first, discarded checkSource call lands;
  // trying C's pre-fix snapshot (B) still finds the same violation on the
  // second, real call.
  function scratchRepoWithRetriableViolation(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "dg-replay-retry-"));
    const file = "a.ts";
    const withViolation = "export function f(x: { y: number } | null) {\n  return x!.y;\n}\n";
    scratchGit(dir, ["init", "-q"]);

    writeFileSync(join(dir, file), withViolation);
    scratchGit(dir, ["add", file]);
    scratchGit(dir, ["commit", "-q", "-m", "add a.ts"]);

    writeFileSync(join(dir, file), `${withViolation}// touch\n`);
    scratchGit(dir, ["add", file]);
    scratchGit(dir, ["commit", "-q", "-m", "TRO-9001: touch a.ts"]);

    const fixed =
      "export function f(x: { y: number } | null) {\n" +
      "  if (!x) throw new Error('x is null');\n" +
      "  return x.y;\n" +
      "}\n";
    writeFileSync(join(dir, file), fixed);
    scratchGit(dir, ["add", file]);
    scratchGit(dir, ["commit", "-q", "-m", "TRO-9001: fix a.ts"]);

    return { dir, file };
  }

  it("treats a candidate whose checkSource throws as unusable, and keeps trying the rest", () => {
    const { dir, file } = scratchRepoWithRetriableViolation();
    try {
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
          ticket: "TRO-9001",
          file,
          disposition: "fixed",
          category: "type-safety",
          summary: "synthetic non-null assertion for replay retry test",
        },
      ];
      const { outcomes } = replayRule(dir, flaky, rows);
      const [outcome] = outcomes;
      if (!outcome) throw new Error("expected one outcome");
      expect(calls).toBeGreaterThan(1);
      expect(outcome.resolved).toBe(true);
      expect(outcome.hit).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
