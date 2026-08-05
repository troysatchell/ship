import { describe, expect, it } from 'vitest';
import { aggregateByNode } from '../costTracking.js';
import { formatCostPerRun, formatUsd } from '../scripts/cost-report.js';

// Regression (CodeRabbit, TRO-339 round 2): a tier that mixes a priced-model
// invocation with an unpriced-model one used to print a real-looking dollar
// figure for `cost/run` (formatUsd(tier.costPerRunUsd)) sitting right next to
// `invocations: N` (the TOTAL count, including the unpriced one) — nothing on
// the line said the two numbers don't cover the same set, so a reader
// computing "total spend" as `invocations * cost/run` would overstate it.
// Before the fix, this test failed because `formatCostPerRun` returned
// `formatUsd(tier.costPerRunUsd)` (a real `$...` string, since
// `costPerRunUsd` is defined whenever at least one invocation in the tier is
// priced) instead of the expected `n/a (...)` string — a plain string
// mismatch, not an import error (the function already existed by the time
// this test was written; only its behavior changed).
describe('formatCostPerRun', () => {
  it('reports n/a, not a number, when a tier mixes a priced and an unpriced invocation', () => {
    const [tier] = aggregateByNode([
      { timestamp: '2026-08-04T00:00:00.000Z', node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 50 },
      { timestamp: '2026-08-04T00:00:01.000Z', node: 'respond', trigger: 'on_demand', model: 'some-future-unpriced-model', inputTokens: 100, outputTokens: 50 },
    ]);
    // Defensive runtime narrowing (CodeRabbit, GitHub PR #122 round):
    // array-destructuring the first element of aggregateByNode(...)'s return
    // types as `PerNodeStats | undefined` at the language level. Checked
    // this file's actual `agent/tsconfig.json`: `noUncheckedIndexedAccess`
    // is `true` at the repo root, but `agent/tsconfig.json` itself excludes
    // `src/__tests__/**/*` (predates this PR — `agent/tsconfig.json:8`,
    // unchanged since TRO-313/FG-2), so `pnpm --filter @ship/agent
    // type-check` (`tsc --noEmit`, which resolves `agent/tsconfig.json` from
    // its own directory) never actually type-checks this file at all —
    // confirmed directly with `tsc --noEmit --listFiles`, which lists no
    // `__tests__` file. So this was never a live type error to "fix"; the
    // guard below is added anyway (lessons.md #16's posture: explicit
    // narrowing over assumption, cheap insurance either way).
    if (!tier) throw new Error('unreachable — aggregateByNode([...single node...]) always returns exactly one tier');

    expect(tier.invocationCount).toBe(2);
    expect(tier.unpricedInvocations).toBe(1);
    // The underlying number itself is still a real, defined average over the
    // priced subset (costTracking.ts's own contract) — formatCostPerRun's
    // job is to not print it next to a mismatched invocation count.
    expect(tier.costPerRunUsd).toBeDefined();

    const line = formatCostPerRun(tier);
    expect(line).toContain('n/a');
    expect(line).toContain('1');
    expect(line).not.toMatch(/\$\d/);
  });

  it('reports the real cost/run when every invocation in the tier is priced', () => {
    const [tier] = aggregateByNode([
      { timestamp: '2026-08-04T00:00:00.000Z', node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 50 },
    ]);
    if (!tier) throw new Error('unreachable — aggregateByNode([...single node...]) always returns exactly one tier');

    expect(tier.unpricedInvocations).toBe(0);
    expect(formatCostPerRun(tier)).toBe(formatUsd(tier.costPerRunUsd));
    expect(formatCostPerRun(tier)).toMatch(/^\$\d/);
  });
});
