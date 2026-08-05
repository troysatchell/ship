/**
 * Prints the numbers TRO-339 / FG-21 was built to produce, from the real
 * recorded ledger — never estimated. Reads every row `FileCostTracker` has
 * ever appended (default: `agent/.cache/cost-ledger.jsonl`, override with
 * `--ledger <path>` or `AGENT_COST_LEDGER_PATH`) and prints:
 *
 *  - Development spend to date (input tokens, output tokens, invocation
 *    count, total $) — the number FLEETGRAPH.MD's Development and Testing
 *    Costs table cites.
 *  - Measured cost per graph run, per tier (node) — to compare against
 *    FLEETGRAPH.MD's projected $0.021/$0.015/$0.052/$0.065 figures.
 *  - Runs per day, observed.
 *  - Average documents pulled per `composeAnswer` run (cost cliff #2).
 *
 * Usage (from repo root):
 *   pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts
 *   pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger /path/to/other-ledger.jsonl
 */
import { FileCostTracker, aggregate, aggregateByNode, invocationsByDay, type PerNodeStats } from '../costTracking.js';

function parseLedgerArg(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf('--ledger');
  if (flagIndex === -1) return undefined;
  return argv[flagIndex + 1];
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return 'n/a (no priced invocations)';
  return `$${value.toFixed(6)}`;
}

/** The `cost/run` line for one tier (CodeRabbit, TRO-339 round 2). A tier's
 * `costPerRunUsd` (costTracking.ts's `aggregateByNode`) already divides
 * `totalCostUsd` by only the PRICED invocation count, not this tier's total
 * `invocationCount` — so the number itself is a correct average over the
 * priced subset. What was misleading is printing it next to `invocations: N`
 * (the TOTAL count, including unpriced ones) with nothing to say the two
 * numbers don't cover the same set — a reader computing "total spend" as
 * `invocations * cost/run` would overstate it. Whenever this tier has any
 * unpriced invocation, this reports `n/a` plus the unpriced count instead of
 * a number that looks precise but doesn't match the adjacent invocation
 * count, rather than showing a real (if partial) number silently. */
export function formatCostPerRun(tier: PerNodeStats): string {
  if (tier.unpricedInvocations > 0) {
    const noun = tier.unpricedInvocations === 1 ? 'invocation' : 'invocations';
    return `n/a (unpriced model invocation) — ${tier.unpricedInvocations} of ${tier.invocationCount} ${noun} unpriced`;
  }
  return formatUsd(tier.costPerRunUsd);
}

export function main(): void {
  const ledgerPath = parseLedgerArg(process.argv.slice(2)) ?? process.env.AGENT_COST_LEDGER_PATH;
  const tracker = new FileCostTracker(ledgerPath ? { ledgerPath } : {});
  const records = tracker.readAll();

  console.log(`--- FleetGraph cost report (TRO-339 / FG-21) ---`);
  console.log(`Ledger: ${tracker.ledgerPath}`);
  console.log('');

  if (records.length === 0) {
    console.log('No invocations recorded yet. Nothing to report.');
    return;
  }

  const overall = aggregate(records);
  console.log('Development spend to date (recorded, not estimated):');
  console.log(`  Invocations:        ${overall.invocationCount}`);
  console.log(`  Input tokens:       ${overall.inputTokens}`);
  console.log(`  Output tokens:      ${overall.outputTokens}`);
  console.log(`  Total spend:        ${formatUsd(overall.totalCostUsd)}`);
  if (overall.unpricedInvocations > 0) {
    console.log(
      `  NOTE: ${overall.unpricedInvocations} invocation(s) used a model with no price-table entry — ` +
        'total spend above is a floor, not the true total. Add the model to costTracking.ts\'s ' +
        'PRICE_PER_MILLION_TOKENS.'
    );
  }
  console.log('');

  console.log('Measured cost per graph run, per tier:');
  for (const tier of aggregateByNode(records)) {
    console.log(`  ${tier.node}:`);
    console.log(`    invocations: ${tier.invocationCount}`);
    console.log(`    cost/run:    ${formatCostPerRun(tier)}`);
    if (tier.avgDocumentsPulled !== undefined) {
      console.log(`    avg documents pulled: ${tier.avgDocumentsPulled.toFixed(2)}`);
    }
  }
  console.log('');

  console.log('Runs per day, observed:');
  for (const day of invocationsByDay(records)) {
    console.log(`  ${day.day}: ${day.count}`);
  }
}

// Only run when executed directly (`tsx src/scripts/cost-report.ts`), not
// when imported by a test — same guard `api/src/db/ensureDatabase.ts` and
// `api/src/db/verifyMigrations.ts` already use for their own CLI entry
// points, applied here (CodeRabbit, TRO-339 round 2) so
// `cost-report.test.ts` can import `formatCostPerRun`/`formatUsd`/`main`
// without the script's side effects (reading the real ledger, printing to
// stdout) firing on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
