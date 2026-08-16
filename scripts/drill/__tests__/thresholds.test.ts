/**
 * Regression test for `evaluateDrillStages` (TRO-455 / PF-603) — the pure
 * decision logic behind the TTFE drill's "regression past threshold fails
 * the build" AC. Standalone `vitest.config.ts` scoped to `scripts/drill/`,
 * same precedent as `scripts/factory/defect-gates/vitest.config.ts`: nothing
 * under `scripts/` is covered by api's or web's vitest `include`
 * (`ship-qa`'s own documented trap — a `.test.ts` file there satisfies
 * `gate.sh`'s G6 "regression test added" grep while never being EXECUTED by
 * either vitest project). This file is executed for real by an explicit
 * step in `gate.sh` (a new one, added by this ticket) and by
 * `.gitlab-ci.yml`/`.github/workflows/ci.yml`'s new `drill-ttfe`
 * job — see that step's own comment for the cross-reference.
 *
 * Per this repo's "check the negative space" convention (lessons.md rule
 * 27), each case is picked to be the SPECIFIC regression that would make it
 * fail:
 *   - all-fast stages catch a version that always reports fail (or never
 *     sums correctly);
 *   - one stage over ITS OWN per-stage ceiling, but the total still under
 *     budget, catches a version that only checks the total and ignores
 *     `stageBudgetsMs` entirely;
 *   - every stage under its own ceiling but the SUM over `totalBudgetMs`
 *     catches a version that only checks per-stage ceilings and never sums;
 *   - a stage with no entry in `stageBudgetsMs` catches a version that
 *     throws or wrongly flags an unconfigured stage as over budget;
 *   - `formatDrillEvaluation` is asserted for the exact "OVER BUDGET" marker
 *     text a CI log reader/grader would actually see, not just that pass is
 *     false.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDrillStages, formatDrillEvaluation, type DrillThresholdConfig } from '../thresholds.js';

const CONFIG: DrillThresholdConfig = {
  totalBudgetMs: 60_000,
  stageBudgetsMs: {
    install_sdk: 30_000,
    device_login: 20_000,
    webhook_create: 5_000,
    document_create: 5_000,
    wait_for_delivery: 15_000,
    verify_webhook: 2_000,
  },
};

describe('evaluateDrillStages', () => {
  it('passes when every stage is fast and the total is well under budget', () => {
    const evaluation = evaluateDrillStages(
      [
        { name: 'install_sdk', ms: 3000 },
        { name: 'device_login', ms: 5200 },
        { name: 'webhook_create', ms: 120 },
        { name: 'document_create', ms: 90 },
        { name: 'wait_for_delivery', ms: 1500 },
        { name: 'verify_webhook', ms: 1 },
      ],
      CONFIG
    );

    expect(evaluation.pass).toBe(true);
    expect(evaluation.totalMs).toBe(3000 + 5200 + 120 + 90 + 1500 + 1);
    expect(evaluation.totalOverBudget).toBe(false);
    expect(evaluation.overBudgetStages).toEqual([]);
  });

  it('fails when a single stage exceeds ITS OWN ceiling, even though the total stays under totalBudgetMs', () => {
    // Sum here is 25_121ms — comfortably under the 60_000ms total budget —
    // so a version of the function that only checked the total would wrongly
    // report pass:true. device_login alone (21_000ms) is over its own
    // 20_000ms ceiling.
    const evaluation = evaluateDrillStages(
      [
        { name: 'install_sdk', ms: 3000 },
        { name: 'device_login', ms: 21_000 },
        { name: 'webhook_create', ms: 120 },
        { name: 'document_create', ms: 90 },
        { name: 'wait_for_delivery', ms: 900 },
        { name: 'verify_webhook', ms: 11 },
      ],
      CONFIG
    );

    expect(evaluation.pass).toBe(false);
    expect(evaluation.totalOverBudget).toBe(false);
    expect(evaluation.overBudgetStages).toEqual([{ name: 'device_login', ms: 21_000, budgetMs: 20_000 }]);
  });

  it('fails on total budget alone when every stage individually stays under its own ceiling', () => {
    // Six stages, each comfortably under its own per-stage ceiling, but
    // summing to 61_000ms — over the 60_000ms total. A version that only
    // checked per-stage ceilings (never summed) would wrongly report
    // pass:true here.
    const evaluation = evaluateDrillStages(
      [
        { name: 'install_sdk', ms: 29_000 },
        { name: 'device_login', ms: 19_000 },
        { name: 'webhook_create', ms: 4_500 },
        { name: 'document_create', ms: 4_500 },
        { name: 'wait_for_delivery', ms: 3_500 },
        { name: 'verify_webhook', ms: 500 },
      ],
      CONFIG
    );

    expect(evaluation.totalMs).toBe(61_000);
    expect(evaluation.overBudgetStages).toEqual([]);
    expect(evaluation.totalOverBudget).toBe(true);
    expect(evaluation.pass).toBe(false);
  });

  it('does not flag a stage that has no entry in stageBudgetsMs, however slow', () => {
    const evaluation = evaluateDrillStages(
      [{ name: 'an_unconfigured_informational_stage', ms: 999_999 }],
      CONFIG
    );

    // Still fails on the total (999_999 > 60_000) — but NOT because the
    // unconfigured stage was flagged individually.
    expect(evaluation.overBudgetStages).toEqual([]);
    expect(evaluation.totalOverBudget).toBe(true);
    expect(evaluation.pass).toBe(false);
  });

  it('passes on an empty stage list (0ms total, nothing to flag)', () => {
    const evaluation = evaluateDrillStages([], CONFIG);
    expect(evaluation).toMatchObject({ pass: true, totalMs: 0, totalOverBudget: false, overBudgetStages: [] });
  });

  it('formatDrillEvaluation prints an OVER BUDGET marker next to the specific regressed stage, and a fail verdict', () => {
    const stages = [
      { name: 'install_sdk', ms: 3000 },
      { name: 'device_login', ms: 21_000 },
    ];
    const evaluation = evaluateDrillStages(stages, CONFIG);

    const rendered = formatDrillEvaluation(stages, evaluation);

    expect(rendered).toContain('install_sdk: 3000ms');
    expect(rendered).toContain('device_login: 21000ms OVER BUDGET (> 20000ms)');
    expect(rendered).not.toContain('install_sdk: 3000ms OVER BUDGET');
    expect(rendered).toContain('verdict: fail');
  });

  it('formatDrillEvaluation prints a pass verdict with no OVER BUDGET markers when everything is within budget', () => {
    const stages = [{ name: 'install_sdk', ms: 100 }];
    const evaluation = evaluateDrillStages(stages, CONFIG);

    const rendered = formatDrillEvaluation(stages, evaluation);

    expect(rendered).not.toContain('OVER BUDGET');
    expect(rendered).toContain('verdict: pass');
  });
});
