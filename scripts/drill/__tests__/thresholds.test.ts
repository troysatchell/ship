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
import {
  evaluateDeliveryLatency,
  evaluateDrillStages,
  formatDrillEvaluation,
  percentile95,
  type DrillThresholdConfig,
} from '../thresholds.js';

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

// ── TRO-615: first-attempt delivery latency P95 gate (PLUGFORGE.MD §5
// "first-attempt webhook latency P95 < 2 s"). Each case is the specific
// regression that would make it fail: a version that ignores the P95 config,
// one that uses `<=` instead of strict `<`, one that computes an average or
// a wrong rank, one that passes on a too-small sample, one that returns NaN
// on an empty sample, and one whose format output lacks the row a grader
// would look for.
const P95_CONFIG: DrillThresholdConfig = {
  ...CONFIG,
  deliveryLatencyP95Ms: 2_000,
  deliveryLatencySampleSize: 20,
};

const FAST_STAGES = [
  { name: 'install_sdk', ms: 3000 },
  { name: 'wait_for_delivery', ms: 600 },
];

function samples(n: number, ms: number): number[] {
  return Array.from({ length: n }, () => ms);
}

describe('percentile95', () => {
  it('returns null on an empty sample (never NaN, which would compare false against any budget)', () => {
    expect(percentile95([])).toBeNull();
  });

  it('uses nearest-rank ceil(0.95*n)-1 on a sorted copy, without mutating its input', () => {
    // n=20 → ceil(19)-1 = index 18 → second-largest value.
    const input = [2500, 100, ...samples(18, 500)];
    const snapshot = [...input];
    expect(percentile95(input)).toBe(500);
    expect(input).toEqual(snapshot);
    // n=1 → index 0.
    expect(percentile95([777])).toBe(777);
    // n=10 → ceil(9.5)-1 = index 9 → the max.
    expect(percentile95([...samples(9, 100), 1999])).toBe(1999);
  });
});

describe('evaluateDeliveryLatency', () => {
  it('returns null when the config carries no deliveryLatencyP95Ms (gate not configured)', () => {
    expect(evaluateDeliveryLatency(samples(20, 5000), CONFIG)).toBeNull();
  });

  it('passes a 20-sample set whose P95 is under the 2000ms budget', () => {
    const evaluation = evaluateDeliveryLatency([...samples(19, 650), 5000], P95_CONFIG);
    expect(evaluation).toMatchObject({ sampleSize: 20, requiredSampleSize: 20, p95Ms: 650, budgetMs: 2000, pass: true });
  });

  it('fails when the P95 is over budget', () => {
    const evaluation = evaluateDeliveryLatency(samples(20, 2500), P95_CONFIG);
    expect(evaluation).toMatchObject({ p95Ms: 2500, overBudget: true, sampleTooSmall: false, pass: false });
  });

  it('is a strict "< budget" gate: a P95 of exactly the budget fails', () => {
    const evaluation = evaluateDeliveryLatency(samples(20, 2000), P95_CONFIG);
    expect(evaluation).toMatchObject({ p95Ms: 2000, overBudget: true, pass: false });
  });

  it('fails a too-small sample even when every latency is fast', () => {
    const evaluation = evaluateDeliveryLatency(samples(3, 100), P95_CONFIG);
    expect(evaluation).toMatchObject({ sampleSize: 3, sampleTooSmall: true, overBudget: false, pass: false });
  });

  it('fails an empty sample (p95 null → over budget) rather than passing vacuously', () => {
    const evaluation = evaluateDeliveryLatency([], P95_CONFIG);
    expect(evaluation).toMatchObject({ p95Ms: null, overBudget: true, sampleTooSmall: true, pass: false });
  });
});

describe('evaluateDrillStages with the TRO-615 P95 gate', () => {
  it('folds a failing P95 into the overall verdict even when every stage is within budget', () => {
    const evaluation = evaluateDrillStages(FAST_STAGES, P95_CONFIG, samples(20, 2500));
    expect(evaluation.totalOverBudget).toBe(false);
    expect(evaluation.overBudgetStages).toEqual([]);
    expect(evaluation.deliveryLatency).toMatchObject({ p95Ms: 2500, pass: false });
    expect(evaluation.pass).toBe(false);
  });

  it('passes when stages and P95 are both within budget', () => {
    const evaluation = evaluateDrillStages(FAST_STAGES, P95_CONFIG, samples(20, 650));
    expect(evaluation.deliveryLatency).toMatchObject({ p95Ms: 650, pass: true });
    expect(evaluation.pass).toBe(true);
  });

  it('leaves deliveryLatency null and ignores samples when the config has no P95 budget (pre-TRO-615 configs)', () => {
    const evaluation = evaluateDrillStages(FAST_STAGES, CONFIG, samples(20, 99_999));
    expect(evaluation.deliveryLatency).toBeNull();
    expect(evaluation.pass).toBe(true);
  });

  it('formatDrillEvaluation prints a delivery_p95_ms row with the sample size and an OVER BUDGET marker on failure', () => {
    const rendered = formatDrillEvaluation(FAST_STAGES, evaluateDrillStages(FAST_STAGES, P95_CONFIG, samples(20, 2500)));
    expect(rendered).toContain('delivery_p95_ms: 2500ms over 20 deliveries (target < 2000ms) OVER BUDGET (>= 2000ms)');
    expect(rendered).toContain('verdict: fail');
  });

  it('formatDrillEvaluation prints the delivery_p95_ms row without markers on pass, and omits it when unconfigured', () => {
    const passing = formatDrillEvaluation(FAST_STAGES, evaluateDrillStages(FAST_STAGES, P95_CONFIG, samples(20, 650)));
    expect(passing).toContain('delivery_p95_ms: 650ms over 20 deliveries (target < 2000ms)');
    expect(passing).not.toContain('OVER BUDGET');
    expect(passing).not.toContain('SAMPLE TOO SMALL');
    expect(passing).toContain('verdict: pass');

    const unconfigured = formatDrillEvaluation(FAST_STAGES, evaluateDrillStages(FAST_STAGES, CONFIG));
    expect(unconfigured).not.toContain('delivery_p95_ms');
  });
});
