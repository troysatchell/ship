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
}

export interface StageOverBudget {
  readonly name: string;
  readonly ms: number;
  readonly budgetMs: number;
}

export interface DrillEvaluation {
  readonly pass: boolean;
  readonly totalMs: number;
  readonly totalBudgetMs: number;
  readonly totalOverBudget: boolean;
  readonly overBudgetStages: readonly StageOverBudget[];
}

/**
 * Evaluates a completed (or partially-completed, for a fail-fast caller)
 * drill run's stage timings against `config`. `stages` order does not
 * matter to this function — `ttfe.ts` runs them in the PRD's own sequence,
 * but the sum and the per-stage lookups here are order-independent.
 */
export function evaluateDrillStages(
  stages: readonly StageTiming[],
  config: DrillThresholdConfig
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

  return {
    pass: !totalOverBudget && overBudgetStages.length === 0,
    totalMs,
    totalBudgetMs: config.totalBudgetMs,
    totalOverBudget,
    overBudgetStages,
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
  lines.push(`verdict: ${evaluation.pass ? 'pass' : 'fail'}`);
  return lines.join('\n');
}
