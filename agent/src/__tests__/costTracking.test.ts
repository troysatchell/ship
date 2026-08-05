import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(respondStats?.invocationCount).toBe(2);
    expect(respondStats?.costPerRunUsd).toBeCloseTo(respondStats!.totalCostUsd / 2, 9);
    expect(respondStats?.avgDocumentsPulled).toBeUndefined();

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
});

describe('FileCostTracker', () => {
  it('round-trips a recorded invocation through the ledger file', () => {
    const ledgerPath = scratchLedgerPath();
    const tracker = new FileCostTracker({ ledgerPath, now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(existsSync(ledgerPath)).toBe(false);
    tracker.record({ node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 12, outputTokens: 34 });

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

  it('appends across multiple record() calls rather than overwriting', () => {
    const ledgerPath = scratchLedgerPath();
    const tracker = new FileCostTracker({ ledgerPath, now: () => new Date('2026-08-04T00:00:00.000Z') });
    tracker.record({ node: 'respond', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 1 });
    tracker.record({ node: 'composeAnswer', trigger: 'on_demand', model: 'claude-haiku-4-5-20251001', inputTokens: 2, outputTokens: 2 });
    expect(tracker.readAll()).toHaveLength(2);
  });

  it('readAll returns an empty array when the ledger has never been written', () => {
    const tracker = new FileCostTracker({ ledgerPath: scratchLedgerPath() });
    expect(tracker.readAll()).toEqual([]);
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
    const costTracker: CostTracker = { record: (entry) => records.push(entry) };

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
    const costTracker: CostTracker = { record: (entry) => records.push(entry) };

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
});
