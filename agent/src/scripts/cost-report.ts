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
import { FileCostTracker, aggregate, aggregateByNode, invocationsByDay } from '../costTracking.js';

function parseLedgerArg(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf('--ledger');
  if (flagIndex === -1) return undefined;
  return argv[flagIndex + 1];
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return 'n/a (no priced invocations)';
  return `$${value.toFixed(6)}`;
}

function main(): void {
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
    console.log(`    cost/run:    ${formatUsd(tier.costPerRunUsd)}`);
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

main();
