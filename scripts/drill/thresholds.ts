/**
 * `evaluateDrillStages` — the TTFE drill's threshold-assertion logic
 * (TRO-455 / PF-603, PLUGFORGE.MD §4: "Per-stage elapsed-ms instrumentation
 * logged and asserted; total < 60 s ... regression past threshold fails the
 * build").
 *
 * Deliberately a PURE function, no I/O, no process/child_process/network —
 * the same "pull the decision logic out where it can be unit-tested without
 * a real server" shape this repo already uses for
 * `scripts/check-integration-deps.mjs`'s `checkPackageDeps` and
 * `sdk/scripts/measure-size.mjs`'s size comparison. `scripts/drill/ttfe.ts`
 * (the actual drill — spins up Postgres, spawns the real api process, drives
 * a real device-login/webhook/document round trip) is the expensive,
 * environment-dependent half; this file is the cheap, deterministic half
 * that decides pass/fail from the timings the expensive half measured.
 *
 * Two independent checks, both "asserted" per the PRD's own wording:
 *   1. `totalBudgetMs` — the drill's own headline number (TTFE CI P95 < 60s,
 *      PLUGFORGE.MD §5's performance-targets table). The sum of every named
 *      stage against ONE shared ceiling.
 *   2. `stageBudgetsMs` — a per-stage ceiling, generous and independent of
 *      the total (see `ttfe.config.json`'s own header for why the stage
 *      ceilings sum to well more than `totalBudgetMs`). This exists to catch
 *      a single pathological stage (a hung poll, a stuck network call) with
 *      a clear, specific "resolvers device_login" wound rather than only
 *      "the run took too long" — same reasoning `gate.sh`'s own per-check
 *      reporting favors a named failure over one opaque verdict.
 *
 * A third, TRO-615, check: `deliveryLatencyP95Ms` — PLUGFORGE.MD §5's
 * "first-attempt webhook latency P95 < 2 s". `ttfe.ts` measures per-delivery
 * latency (listener `receivedAt` − the moment `documents.create()` resolved)
 * over `deliveryLatencySampleSize` documents and passes the samples as the
 * third argument; `evaluateDeliveryLatency` computes a nearest-rank P95 and
 * folds the verdict into `pass`. Absent from the config → not evaluated.
 *
 * A stage with no entry in `stageBudgetsMs` is not checked against a
 * per-stage ceiling at all (only the total) — deliberate, not an oversight:
 * a caller can time an informational sub-stage without inventing an
 * arbitrary ceiling for it.
 */

export interface StageTiming {
  readonly name: string;
  readonly ms: number;
}

export interface DrillThresholdConfig {
  readonly totalBudgetMs: number;
  readonly stageBudgetsMs: Readonly<Record<string, number>>;
  /** TRO-615: PLUGFORGE.MD §5 "first-attempt webhook latency P95 < 2 s".
   *  Optional so pre-TRO-615 configs/tests keep evaluating; when absent,
   *  no P95 gate is applied and `deliveryLatency` on the evaluation is
   *  `null`. */
  readonly deliveryLatencyP95Ms?: number;
  /** TRO-615: minimum number of first-attempt deliveries the P95 must be
   *  computed over (§5 grades a P95, not a single sample). A sample smaller
   *  than this fails the gate — a P95 over 3 points is not a P95. */
  readonly deliveryLatencySampleSize?: number;
}

export interface StageOverBudget {
  readonly name: string;
  readonly ms: number;
  readonly budgetMs: number;
}

/** TRO-615: the first-attempt delivery-latency P95 gate's result. */
export interface DeliveryLatencyEvaluation {
  /** Sample size the P95 was computed over. */
  readonly sampleSize: number;
  /** Required minimum sample size (`config.deliveryLatencySampleSize`, default 1). */
  readonly requiredSampleSize: number;
  /** P95 in ms (nearest-rank: sorted ascending, index `ceil(0.95 * n) - 1`), or
   *  `null` when the sample is empty. */
  readonly p95Ms: number | null;
  readonly budgetMs: number;
  /** True when `p95Ms` is missing or `>= budgetMs` (the target is strict `< 2 s`). */
  readonly overBudget: boolean;
  /** True when fewer than `requiredSampleSize` latencies were supplied. */
  readonly sampleTooSmall: boolean;
  readonly pass: boolean;
}

export interface DrillEvaluation {
  readonly pass: boolean;
  readonly totalMs: number;
  readonly totalBudgetMs: number;
  readonly totalOverBudget: boolean;
  readonly overBudgetStages: readonly StageOverBudget[];
  /** TRO-615: `null` when the config carries no `deliveryLatencyP95Ms`
   *  (gate not configured), else the P95 gate's own result — folded into
   *  `pass` above. */
  readonly deliveryLatency: DeliveryLatencyEvaluation | null;
}

/**
 * Nearest-rank P95 over `latenciesMs` — sort ascending, take index
 * `ceil(0.95 * n) - 1`. Returns `null` for an empty sample rather than NaN so
 * a caller cannot accidentally compare `NaN < budget` (always false) and
 * pass. Pure; does not mutate its input.
 */
export function percentile95(latenciesMs: readonly number[]): number | null {
  if (latenciesMs.length === 0) return null;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx] ?? null;
}

/**
 * TRO-615: evaluates first-attempt webhook delivery latencies against
 * `config.deliveryLatencyP95Ms` (PLUGFORGE.MD §5: "first-attempt webhook
 * latency P95 < 2 s" — strict less-than, so a P95 of exactly the budget
 * fails). Also enforces `config.deliveryLatencySampleSize` (default 1) so the
 * drill cannot pass a "P95" computed over too few points. Returns `null` when
 * the config carries no `deliveryLatencyP95Ms` at all (gate not configured).
 */
export function evaluateDeliveryLatency(
  latenciesMs: readonly number[],
  config: DrillThresholdConfig
): DeliveryLatencyEvaluation | null {
  if (config.deliveryLatencyP95Ms === undefined) return null;
  const budgetMs = config.deliveryLatencyP95Ms;
  const requiredSampleSize = config.deliveryLatencySampleSize ?? 1;
  const p95Ms = percentile95(latenciesMs);
  const overBudget = p95Ms === null || p95Ms >= budgetMs;
  const sampleTooSmall = latenciesMs.length < requiredSampleSize;
  return {
    sampleSize: latenciesMs.length,
    requiredSampleSize,
    p95Ms,
    budgetMs,
    overBudget,
    sampleTooSmall,
    pass: !overBudget && !sampleTooSmall,
  };
}

/**
 * Evaluates a completed (or partially-completed, for a fail-fast caller)
 * drill run's stage timings against `config`. `stages` order does not
 * matter to this function — `ttfe.ts` runs them in the PRD's own sequence,
 * but the sum and the per-stage lookups here are order-independent.
 */
export function evaluateDrillStages(
  stages: readonly StageTiming[],
  config: DrillThresholdConfig,
  deliveryLatenciesMs: readonly number[] = []
): DrillEvaluation {
  const totalMs = stages.reduce((sum, stage) => sum + stage.ms, 0);
  const totalOverBudget = totalMs > config.totalBudgetMs;

  const overBudgetStages: StageOverBudget[] = [];
  for (const stage of stages) {
    const budgetMs = config.stageBudgetsMs[stage.name];
    if (budgetMs !== undefined && stage.ms > budgetMs) {
      overBudgetStages.push({ name: stage.name, ms: stage.ms, budgetMs });
    }
  }

  const deliveryLatency = evaluateDeliveryLatency(deliveryLatenciesMs, config);

  return {
    pass: !totalOverBudget && overBudgetStages.length === 0 && (deliveryLatency === null || deliveryLatency.pass),
    totalMs,
    totalBudgetMs: config.totalBudgetMs,
    totalOverBudget,
    overBudgetStages,
    deliveryLatency,
  };
}

/** Renders a `DrillEvaluation` as the human-readable summary `ttfe.ts` logs
 *  and the drill's CI step output shows — one line per stage plus a verdict
 *  line, so a CI failure names exactly which stage(s) regressed rather than
 *  just "drill failed." */
export function formatDrillEvaluation(stages: readonly StageTiming[], evaluation: DrillEvaluation): string {
  const lines: string[] = [];
  for (const stage of stages) {
    const overBudget = evaluation.overBudgetStages.find((s) => s.name === stage.name);
    const flag = overBudget ? ` OVER BUDGET (> ${overBudget.budgetMs}ms)` : '';
    lines.push(`  ${stage.name}: ${stage.ms}ms${flag}`);
  }
  lines.push(
    `  total: ${evaluation.totalMs}ms / ${evaluation.totalBudgetMs}ms budget` +
      (evaluation.totalOverBudget ? ' — OVER BUDGET' : '')
  );
  if (evaluation.deliveryLatency) {
    const d = evaluation.deliveryLatency;
    const p95Text = d.p95Ms === null ? 'n/a' : `${d.p95Ms}ms`;
    let flag = '';
    if (d.overBudget) flag += ` OVER BUDGET (>= ${d.budgetMs}ms)`;
    if (d.sampleTooSmall) flag += ` SAMPLE TOO SMALL (< ${d.requiredSampleSize})`;
    lines.push(`  delivery_p95_ms: ${p95Text} over ${d.sampleSize} deliveries (target < ${d.budgetMs}ms)${flag}`);
  }
  lines.push(`verdict: ${evaluation.pass ? 'pass' : 'fail'}`);
  return lines.join('\n');
}
