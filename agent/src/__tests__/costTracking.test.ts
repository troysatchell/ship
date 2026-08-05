import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraph, type AnthropicModel } from '../graph.js';
import {
  FileCostTracker,
  aggregate,
  aggregateByNode,
  costUsd,
  invocationsByDay,
  type CostTracker,
  type ModelInvocationRecord,
} from '../costTracking.js';

// Scratch dir per test file run, cleaned up afterward — never shares a path
// with the real development ledger (lessons.md #20: tests must not share
// mutable resources).
let scratchDirs: string[] = [];
function scratchLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tro339-cost-ledger-'));
  scratchDirs.push(dir);
  return join(dir, 'nested', 'cost-ledger.jsonl');
}

afterEach(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  scratchDirs = [];
});

function record(overrides: Partial<ModelInvocationRecord> = {}): ModelInvocationRecord {
  return {
    timestamp: '2026-08-04T12:00:00.000Z',
    node: 'respond',
    trigger: 'on_demand',
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

describe('costUsd', () => {
  it('computes $/million-token pricing for a known model — matches the real LangSmith total_cost this ticket observed', () => {
    // 33 input / 38 output on claude-haiku-4-5-20251001 -> LangSmith's own
    // computed total_cost was $0.000223 for this exact call, queried
    // 2026-08-04 against the real fleetgraph-agent LangSmith project.
    expect(costUsd('claude-haiku-4-5-20251001', 33, 38)).toBeCloseTo(0.000223, 6);
  });

  it('returns undefined for a model with no price-table entry, rather than guessing', () => {
    expect(costUsd('some-future-model', 1000, 1000)).toBeUndefined();
  });
});

describe('aggregate', () => {
  it('sums tokens, invocation count, and cost across records', () => {
    const stats = aggregate([
      record({ inputTokens: 100, outputTokens: 50 }),
      record({ inputTokens: 200, outputTokens: 75 }),
    ]);
    expect(stats.invocationCount).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(125);
    expect(stats.totalCostUsd).toBeCloseTo(300 / 1_000_000 + (125 * 5) / 1_000_000, 9);
    expect(stats.unpricedInvocations).toBe(0);
  });

  it('counts but does not cost an unpriced model, and reports it separately', () => {
    const stats = aggregate([record({ model: 'unknown-model' })]);
    expect(stats.invocationCount).toBe(1);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.unpricedInvocations).toBe(1);
  });
});

describe('aggregateByNode', () => {
  it('groups by node/tier and computes cost-per-run and avg documentsPulled', () => {
    const byNode = aggregateByNode([
      record({ node: 'respond', inputTokens: 100, outputTokens: 10 }),
      record({ node: 'respond', inputTokens: 200, outputTokens: 20 }),
      record({ node: 'composeAnswer', inputTokens: 9000, outputTokens: 800, documentsPulled: 5 }),
      record({ node: 'composeAnswer', inputTokens: 9000, outputTokens: 800, documentsPulled: 9 }),
    ]);

    const respondStats = byNode.find((s) => s.node === 'respond');
    expect(respondStats).toBeDefined();
    if (!respondStats) throw new Error('unreachable — asserted defined above');
    expect(respondStats.invocationCount).toBe(2);
    expect(respondStats.costPerRunUsd).toBeCloseTo(respondStats.totalCostUsd / 2, 9);
    expect(respondStats.avgDocumentsPulled).toBeUndefined();

    const composeAnswerStats = byNode.find((s) => s.node === 'composeAnswer');
    expect(composeAnswerStats?.avgDocumentsPulled).toBe(7);
  });

  it('only includes nodes actually present in the data', () => {
    const byNode = aggregateByNode([record({ node: 'respond' })]);
    expect(byNode.map((s) => s.node)).toEqual(['respond']);
  });
});

describe('invocationsByDay', () => {
  it('buckets by UTC calendar day, newest first', () => {
    const days = invocationsByDay([
      record({ timestamp: '2026-08-01T09:00:00.000Z' }),
      record({ timestamp: '2026-08-01T10:00:00.000Z' }),
      record({ timestamp: '2026-08-03T09:00:00.000Z' }),
    ]);
    expect(days).toEqual([
      { day: '2026-08-03', count: 1 },
      { day: '2026-08-01', count: 2 },
    ]);
  });

  // Regression (CodeRabbit, GitHub PR #122 round): before the fix, the day
  // key was `record.timestamp.slice(0, 10)` — a naive string slice of
  // whatever offset the timestamp happened to carry, not its real UTC
  // calendar day. `FileCostTracker.record`'s own signature lets a caller
  // pass an explicit non-canonical `timestamp` (tests already do), so a
  // record whose local-offset timestamp crosses UTC midnight used to be
  // misbucketed under its own date portion instead of its real UTC day.
  // `2026-08-04T23:30:00-05:00` is `2026-08-05T04:30:00.000Z` once parsed —
  // a different calendar day than the `2026-08-04` the naive slice would
  // have produced. Before the fix this test failed with `day: '2026-08-04'`
  // (the un-parsed prefix), not an import/type error.
  it('parses a non-UTC-offset timestamp and buckets it under its real UTC calendar day', () => {
    const days = invocationsByDay([record({ timestamp: '2026-08-04T23:30:00-05:00' })]);
    expect(days).toEqual([{ day: '2026-08-05', count: 1 }]);
  });

  // Regression: an unparseable timestamp used to pass straight through
  // `.slice(0, 10)` and silently create a bogus bucket instead of being
  // skipped. Before the fix this test failed because the result included an
  // extra `{ day: 'not-a-real-t', count: 1 }`-shaped entry (sorted ahead of
  // the real day since it string-compares greater), not because of a thrown
  // error.
  it('skips a record whose timestamp does not parse to a valid date', () => {
    const days = invocationsByDay([
      record({ timestamp: 'not-a-real-timestamp' }),
      record({ timestamp: '2026-08-01T09:00:00.000Z' }),
    ]);
    expect(days).toEqual([{ day: '2026-08-01', count: 1 }]);
  });
});

describe('FileCostTracker', () => {
  it('round-trips a recorded invocation through the ledger file', async () => {
    const ledgerPath = scratchLedgerPath();
    const tracker = new FileCostTracker({ ledgerPath, now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(existsSync(ledgerPath)).toBe(false);
    await tracker.record({ node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 12, outputTokens: 34 });

    expect(existsSync(ledgerPath)).toBe(true);
    const rows = tracker.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      timestamp: '2026-08-04T00:00:00.000Z',
      node: 'respond',
      trigger: 'on_demand',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it('appends across multiple record() calls rather than overwriting', async () => {
    const ledgerPath = scratchLedgerPath();
    const tracker = new FileCostTracker({ ledgerPath, now: () => new Date('2026-08-04T00:00:00.000Z') });
    await tracker.record({ node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 1 });
    await tracker.record({ node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 2, outputTokens: 2 });
    expect(tracker.readAll()).toHaveLength(2);
  });

  it('readAll returns an empty array when the ledger has never been written', () => {
    const tracker = new FileCostTracker({ ledgerPath: scratchLedgerPath() });
    expect(tracker.readAll()).toEqual([]);
  });

  // Regression (CodeRabbit, TRO-339 round 2): readAll()'s own comment claims
  // a line that doesn't parse is "skipped rather than thrown on," but before
  // the fix `JSON.parse(line)` ran with no try/catch — a syntactically
  // invalid line (not just wrong-shape JSON) threw an uncaught SyntaxError
  // and aborted the whole report instead of being skipped. Before the fix
  // this test failed with that SyntaxError propagating out of readAll(),
  // not an import error.
  it('skips a syntactically malformed JSON line and still returns the valid record', () => {
    const ledgerPath = scratchLedgerPath();
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const validRecord: ModelInvocationRecord = {
      timestamp: '2026-08-04T00:00:00.000Z',
      node: 'respond',
      trigger: 'on_demand',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1,
      outputTokens: 1,
    };
    // A malformed (not just wrong-shape) line, as if a crash landed mid
    // `appendFileSync` of the second record.
    writeFileSync(ledgerPath, `${JSON.stringify(validRecord)}\n{ this is not valid json\n`, 'utf8');

    const tracker = new FileCostTracker({ ledgerPath });
    expect(tracker.readAll()).toEqual([validRecord]);
  });

  // Regression (CodeRabbit, TRO-339 round 2): `??` only falls through on
  // null/undefined, so `AGENT_COST_LEDGER_PATH=` (an explicitly-empty env
  // var — e.g. a blank line in a copied `.env.local`, matching
  // `agent/.env.example`'s own template) used to resolve `ledgerPath` to
  // `""` instead of falling through to the default. Before the fix this
  // test failed because `withEmptyEnv.ledgerPath` was `""`, not equal to
  // `withoutEnv.ledgerPath` (the real default) — not an import error.
  it('treats an explicitly-empty AGENT_COST_LEDGER_PATH env var as unset, not as ""', () => {
    const original = process.env.AGENT_COST_LEDGER_PATH;
    try {
      delete process.env.AGENT_COST_LEDGER_PATH;
      const withoutEnv = new FileCostTracker();

      process.env.AGENT_COST_LEDGER_PATH = '';
      const withEmptyEnv = new FileCostTracker();

      expect(withEmptyEnv.ledgerPath).toBe(withoutEnv.ledgerPath);
      expect(withEmptyEnv.ledgerPath).not.toBe('');
    } finally {
      if (original === undefined) delete process.env.AGENT_COST_LEDGER_PATH;
      else process.env.AGENT_COST_LEDGER_PATH = original;
    }
  });

  // Regression (CodeRabbit, GitHub PR #122 round): `isModelInvocationRecord`
  // only checked `typeof v.inputTokens === 'number'`, which admits `-5`,
  // `1.5`, `NaN`, and `Infinity` — a hand-edited or corrupted ledger line
  // with a negative or fractional token count used to pass the guard and be
  // included in every aggregation. Before the fix this test failed because
  // `readAll()` returned all three records (the two malformed ones included),
  // not just `validRecord` — a plain array-length/content mismatch, not a
  // thrown error.
  it('skips a record with a negative or fractional token count', () => {
    const ledgerPath = scratchLedgerPath();
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const validRecord: ModelInvocationRecord = {
      timestamp: '2026-08-04T00:00:00.000Z',
      node: 'respond',
      trigger: 'on_demand',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1,
      outputTokens: 1,
    };
    const negativeInputTokens = { ...validRecord, inputTokens: -5 };
    const fractionalOutputTokens = { ...validRecord, outputTokens: 1.5 };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(validRecord)}\n${JSON.stringify(negativeInputTokens)}\n${JSON.stringify(fractionalOutputTokens)}\n`,
      'utf8'
    );

    const tracker = new FileCostTracker({ ledgerPath });
    expect(tracker.readAll()).toEqual([validRecord]);
  });

  it('treats an explicitly-empty options.ledgerPath the same way, for consistency', () => {
    const original = process.env.AGENT_COST_LEDGER_PATH;
    try {
      delete process.env.AGENT_COST_LEDGER_PATH;
      const withoutOption = new FileCostTracker();
      const withEmptyOption = new FileCostTracker({ ledgerPath: '' });
      expect(withEmptyOption.ledgerPath).toBe(withoutOption.ledgerPath);
    } finally {
      if (original === undefined) delete process.env.AGENT_COST_LEDGER_PATH;
      else process.env.AGENT_COST_LEDGER_PATH = original;
    }
  });
});

// ============================================================================
// The regression: graph.ts's three real model.invoke() call sites must
// actually capture and forward usage_metadata to an injected CostTracker.
//
// Before TRO-339's fix: `AnthropicModel.invoke`'s return type was narrowed to
// `{ content: unknown }` (no usage field at all), `buildGraph` took no
// costTracker parameter, and none of `respond`/`composeAnswer`/
// `composeStandupDraft` referenced token usage anywhere — so this exact test
// failed with 0 recorded invocations instead of 1, a plain assertion failure
// (not an import error: costTracking.ts has no dependency on graph.ts, so it
// resolves and type-checks on its own regardless of graph.ts's state).
// ============================================================================
describe('graph.ts wiring: real model usage is captured per invocation (TRO-339)', () => {
  it('records input/output tokens, node, trigger and model for the bare on-demand chat path', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({
        content: 'hello',
        usage_metadata: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
      }),
      model: 'claude-haiku-4-5-20251001',
    };
    const records: Array<Parameters<CostTracker['record']>[0]> = [];
    const costTracker: CostTracker = { record: async (entry) => { records.push(entry); } };

    const graph = buildGraph(model, undefined, undefined, undefined, costTracker);
    await graph.invoke({ input: 'What is going on?' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      node: 'respond',
      trigger: 'on_demand',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 42,
      outputTokens: 7,
    });
  });

  it('does not record anything when the model response carries no usage_metadata (a bare test double)', async () => {
    const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'hello' }) };
    const records: Array<Parameters<CostTracker['record']>[0]> = [];
    const costTracker: CostTracker = { record: async (entry) => { records.push(entry); } };

    const graph = buildGraph(model, undefined, undefined, undefined, costTracker);
    await graph.invoke({ input: 'hi' });

    expect(records).toHaveLength(0);
  });

  it('is a no-op (never throws) when no costTracker is injected at all', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({ content: 'hello', usage_metadata: { input_tokens: 1, output_tokens: 1 } }),
    };
    const graph = buildGraph(model);
    await expect(graph.invoke({ input: 'hi' })).resolves.toMatchObject({ output: 'hello' });
  });

  // Regression (CodeRabbit, TRO-339 round 2): a CostTracker.record() failure
  // (e.g. FileCostTracker hitting a disk write error) must never fail the
  // real model response it's merely accounting for. Before the fix,
  // `recordInvocation` (graph.ts) called `tracker.record(...)` with no
  // try/catch, so this throw propagated straight out of the `respond` node
  // and `graph.invoke` rejected instead of resolving — this exact test
  // failed with the thrown Error surfacing from `graph.invoke`, not an
  // import error (graph.ts and costTracking.ts already resolve fine
  // independent of this behavior).
  it('does not let a throwing CostTracker.record() fail the graph response', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({
        content: 'hello',
        usage_metadata: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
      }),
      model: 'claude-haiku-4-5-20251001',
    };
    const throwingCostTracker: CostTracker = {
      record: () => {
        throw new Error('simulated disk write failure');
      },
    };

    const graph = buildGraph(model, undefined, undefined, undefined, throwingCostTracker);

    await expect(graph.invoke({ input: 'What is going on?' })).resolves.toMatchObject({ output: 'hello' });
  });

  // Regression (CodeRabbit, GitHub PR #122 round — raised 3 times total):
  // `CostTracker.record()` must be genuinely awaited by `recordInvocation`
  // (graph.ts), not fired-and-forgotten, so a caller can rely on the graph's
  // own response promise not resolving until the cost write has actually
  // settled (the same guarantee an `await fs.promises.appendFile(...)` gives
  // over a blocking `appendFileSync`). This test controls exactly when the
  // tracker's own promise resolves and asserts the graph's `invoke()`
  // promise stays pending until then.
  //
  // Before the fix: `CostTracker.record` returned `void`, and `graph.ts`'s
  // `recordInvocation` called `tracker.record(...)` without `await`-ing it
  // (there was nothing to await against a `void`-returning interface) — so
  // even a test double whose `record()` returned an unresolved Promise had
  // that promise silently ignored, and the `respond` node returned its
  // output immediately. This test failed with `invokeSettled` already
  // `true` before `resolveRecord()` was ever called — a real behavioral
  // assertion failure, not a type or import error.
  it('awaits CostTracker.record() before the real response resolves', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({
        content: 'hello',
        usage_metadata: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
      }),
      model: 'claude-haiku-4-5-20251001',
    };

    let resolveRecord: () => void = () => {
      throw new Error('unreachable — assigned by the Promise executor below');
    };
    const recordPromise = new Promise<void>((resolve) => {
      resolveRecord = resolve;
    });
    let recordCalled = false;
    const deferredCostTracker: CostTracker = {
      record: () => {
        recordCalled = true;
        return recordPromise;
      },
    };

    const graph = buildGraph(model, undefined, undefined, undefined, deferredCostTracker);
    const invokePromise = graph.invoke({ input: 'What is going on?' });
    let invokeSettled = false;
    void invokePromise.then(() => {
      invokeSettled = true;
    });

    // Give the microtask/macrotask queue several turns to drain without
    // ever resolving recordPromise — the graph's own promise must not have
    // settled yet if recordInvocation genuinely awaits tracker.record().
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(recordCalled).toBe(true);
    expect(invokeSettled).toBe(false);

    resolveRecord();
    await expect(invokePromise).resolves.toMatchObject({ output: 'hello' });
    expect(invokeSettled).toBe(true);
  });
});
