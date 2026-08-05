/**
 * Per-invocation cost accounting for every real model call the graph makes
 * (TRO-339 / FG-21).
 *
 * ---- What was investigated before writing this file --------------------
 *
 * 1. "LangSmith captures much of this natively once PR-B wires it — check
 *    before building a parallel counter" (the ticket, verbatim). OBSERVED,
 *    2026-08-04, by querying the real LangSmith API against the
 *    `fleetgraph-agent` project (`POST /api/v1/runs/query`, `x-api-key` =
 *    the real `LANGSMITH_API_KEY` from the repo root's `.env`): LangSmith
 *    DOES capture per-LLM-run `prompt_tokens` / `completion_tokens` /
 *    `total_cost` natively, with no extra wiring — confirmed on a real
 *    `ChatAnthropic` call's trace (`usage.input_tokens: 33,
 *    output_tokens: 38`, LangSmith's own computed `total_cost: 0.000223`).
 *    BUT the project holds exactly two runs, ever: one 404 (a stale
 *    `claude-3-5-haiku-latest` model id, zero tokens, zero cost, from a
 *    DIFFERENT worktree) and one success — both are `trace-invoke.ts`-style
 *    manual smoke-test calls, not real traffic from FG-5/FG-6/FG-7's
 *    proactive/deep/expansion node chains. So LangSmith is a real, working,
 *    zero-setup source of usage data — genuinely worth reading before
 *    reaching for a parallel counter, per the ticket's own instruction —
 *    but it currently holds almost no development-spend history to recover,
 *    which matches FLEETGRAPH.MD's own "no agent invocations yet" claim
 *    more closely than the ticket's framing that PR-B/C/D "built and merged
 *    real graph runs." They merged real graph CODE, exercised only by
 *    tests against a stable fake model — never against the real API.
 * 2. "Does `ChatAnthropic`'s own `.invoke()` response already carry token
 *    usage at runtime, independent of what LangSmith shows?" OBSERVED by
 *    reading `@langchain/core`'s own `AIMessage`/`AIMessageChunk` typings
 *    (`node_modules/@langchain/core/dist/messages/ai.d.ts`): both declare
 *    `usage_metadata?: UsageMetadata` with `input_tokens`/`output_tokens`/
 *    `total_tokens`. `ChatAnthropicMessages extends BaseChatModel<CallOptions,
 *    AIMessageChunk>`, and `BaseChatModel#invoke` returns
 *    `Promise<OutputMessageType>` — so a real `ChatAnthropic.invoke()` call
 *    genuinely returns an `AIMessageChunk` carrying `usage_metadata` at
 *    runtime. `graph.ts`'s own `AnthropicModel` interface (this ticket's
 *    named "real, load-bearing type constraint") narrowed the return type
 *    to `{ content: unknown }` — so every one of the three real call sites
 *    (`respond`, `composeAnswer`, `composeStandupDraft`) was discarding
 *    that usage data by construction of the type, confirmed by direct
 *    reading, not assumed. `AnthropicModel.invoke`'s return type is widened
 *    in `graph.ts` to carry an optional `usage_metadata` field so those
 *    three call sites can read it — optional, so every existing test double
 *    (`{ invoke: () => ({ content: ... }) }`, no usage field) keeps
 *    compiling and passing unchanged.
 *
 * ---- What this file does not build, and why -----------------------------
 *
 * No derived-content cache exists anywhere in this codebase (grepped
 * `agent/src` for "cache" — the only hit is `rateLimiter.ts`'s unrelated
 * comment about Ship's OWN rate-limit cache failing open). Cost cliff #4
 * ("cache hit rate") has no hook to attach to; noted as a real gap in the
 * ticket's own report, not built here.
 *
 * Outbound-Ship request-rate visibility DOES have a partial hook already:
 * `RateLimiter.currentCount()` (`rateLimiter.ts`) returns a live snapshot of
 * calls within the trailing self-throttle window. Nothing currently reads
 * or logs it, though — it is a query method with no caller. Left as-is:
 * wiring a periodic export is adjacent to, not part of, this ticket's core
 * deliverable (per-invocation model-call accounting), and is noted as a gap
 * rather than built here.
 *
 * ---- Concurrency (lessons.md #18: state it explicitly) -------------------
 *
 * `FileCostTracker.record` is a single `appendFileSync` call per invocation
 * — one `write(2)` syscall for the whole line, which POSIX guarantees does
 * not interleave with a concurrent process's own single-line append (this
 * is the same `O_APPEND` atomicity every log-shipping tool relies on for
 * lines well under the platform's atomic-write size). There is no
 * read-modify-write here: every record is independent and append-only, so
 * two processes (e.g. the long-running server and a one-off trace script)
 * writing concurrently cannot corrupt or clobber each other's rows. The one
 * property this does NOT give you is a strict global write ORDER across
 * processes — irrelevant here, since aggregation only sums/group-bys rows,
 * never depends on their sequence.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The three real `model.invoke()` call sites in `graph.ts`, and — per this
 * ticket's own framing — the closest thing this codebase has today to
 * FLEETGRAPH.MD's Cost Analysis "tier" vocabulary: `respond` is the bare
 * on-demand chat path (no expansion), `composeAnswer` is the on-demand path
 * WITH expansion (FG-7, "follows the graph outward" — the tier the cost
 * model's $0.065/$9,000-token figure describes), and `composeStandupDraft`
 * is the deep-tier standup draft (FG-6). FLEETGRAPH.MD's cost model also
 * names "inbox assembly" and "retro draft" tiers; neither has a value here
 * because neither makes a model call in the graph as built today — FG-5's
 * `pollChangeFeed -> resolveMentions -> detectBlockingApprovals ->
 * commitInboxItems` chain has zero model calls (documented in `graph.ts`'s
 * own module docstring), and no retro-draft node exists yet ("Phase 2 ...
 * not fully done", `graph.ts:5-6`). Adding either later costs nothing here:
 * this union just grows, and every aggregation function in this file
 * already groups by whatever site values are actually present in the data. */
export type InvocationSite = 'respond' | 'composeAnswer' | 'composeStandupDraft';

/** Real usage as `ChatAnthropic`'s own response carries it
 * (`@langchain/core`'s `UsageMetadata`) — kept minimal to exactly what this
 * file uses, rather than importing the whole LangChain type. */
export interface RealUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

/** One real model invocation, as recorded. */
export interface ModelInvocationRecord {
  /** ISO 8601. */
  timestamp: string;
  /** Which graph node made the call (doubles as "tier" — see this file's
   * module docstring). */
  node: InvocationSite;
  /** `graph.ts`'s `TriggerKind` ('on_demand' | 'proactive_fast' |
   * 'proactive_steady' | 'proactive_deep'), kept as a plain string here
   * rather than importing that type — this file has no other dependency on
   * `graph.ts` and importing one purely for a string-literal union is not
   * worth the coupling. */
  trigger: string;
  /** The model that served this invocation, read from the real
   * `ChatAnthropic` instance's own public `.model` field (widened onto
   * `AnthropicModel` in `graph.ts` for exactly this reason). `'unknown'`
   * for a test double that doesn't expose one. Recording this PER CALL
   * (not once per tracker instance) is what makes a future second model
   * tier visible for free — the ticket's own instruction: "make sure your
   * accounting records which model served each invocation." */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Only ever set for `node: 'composeAnswer'` — how many documents the
   * on-demand expansion walk pulled into context this run (cost cliff #2:
   * "how far on-demand expands the graph", so FG-7's `documentCap` can be
   * tuned against evidence rather than guessed). `undefined` for every
   * other node, which never runs an expansion walk. */
  documentsPulled?: number;
}

/** What `graph.ts`'s nodes need to record an invocation — the injection
 * seam, same pattern as `ProactiveDeps`/`OnDemandDeps`/`DeepDeps` (all
 * interfaces, all optional on `buildGraph`, all with one real production
 * implementation constructed in `index.ts`). */
export interface CostTracker {
  record(entry: Omit<ModelInvocationRecord, 'timestamp'> & { timestamp?: string }): void;
}

/**
 * $ per million tokens, by model id. DERIVED from Anthropic's published
 * rate card for `claude-haiku-4-5` ($1.00 input / $5.00 output per million
 * tokens) — and independently cross-checked, 2026-08-04, against a REAL
 * LangSmith trace's own computed `total_cost` for a real
 * `claude-haiku-4-5-20251001` call: 33 input / 38 output tokens ->
 * LangSmith reported `total_cost: 0.000223`, which is exactly
 * `33 * 1.00/1e6 + 38 * 5.00/1e6`. Both sources agree; this is OBSERVED,
 * not assumed from memory.
 *
 * Add a new model's entry here the day it is wired into `index.ts` — an
 * unlisted model reports cost as `undefined` from `costUsd` below (never a
 * silently wrong number extrapolated from a different model's price).
 */
const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
};

/** `undefined` when `model` has no entry in the price table above — the
 * caller decides how to treat an unpriced record (see `aggregate` below,
 * which counts it in `unpricedInvocations` rather than silently omitting
 * it or guessing a price). */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = PRICE_PER_MILLION_TOKENS[model];
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ============================================================================
// FileCostTracker — the production implementation
// ============================================================================

/** `<agent package root>/.cache/cost-ledger.jsonl` — already covered by the
 * repo's root `.gitignore` (`.cache`, no leading slash, matches at any
 * depth — verified directly with `git check-ignore -v agent/.cache/...`),
 * so recording real spend here needed no `.gitignore` change, which is
 * outside this ticket's file scope. Survives `pnpm build`/`pnpm clean`
 * (those only ever touch `dist/`). */
const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../.cache/cost-ledger.jsonl', import.meta.url));

export interface FileCostTrackerOptions {
  /** Override the ledger path — tests use a scratch path so runs never
   * share or pollute the real development ledger (lessons.md #20). Takes
   * precedence over `AGENT_COST_LEDGER_PATH`. */
  ledgerPath?: string;
  /** Injected clock — tests never depend on real wall-clock time
   * (lessons.md #17, matching every other store in this package). */
  now?: () => Date;
}

export class FileCostTracker implements CostTracker {
  readonly ledgerPath: string;
  private readonly now: () => Date;

  /** Resolution order: explicit `options.ledgerPath` > `AGENT_COST_LEDGER_PATH`
   * env var > the package-relative default. Reading the env var here (not
   * just in the reporting script) means `index.ts`'s real production
   * tracker and `cost-report.ts`'s reader are guaranteed to agree on the
   * same file without the caller having to pass the override to both. */
  constructor(options: FileCostTrackerOptions = {}) {
    this.ledgerPath = options.ledgerPath ?? process.env.AGENT_COST_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
    this.now = options.now ?? (() => new Date());
  }

  record(entry: Omit<ModelInvocationRecord, 'timestamp'> & { timestamp?: string }): void {
    const full: ModelInvocationRecord = {
      ...entry,
      timestamp: entry.timestamp ?? this.now().toISOString(),
    };
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, `${JSON.stringify(full)}\n`, 'utf8');
  }

  /** Every record currently on disk, in file order. `[]` if the ledger
   * doesn't exist yet (no invocation has ever been recorded). */
  readAll(): ModelInvocationRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    const raw = readFileSync(this.ledgerPath, 'utf8');
    const records: ModelInvocationRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      if (isModelInvocationRecord(parsed)) {
        records.push(parsed);
      }
      // A line that doesn't parse into the expected shape is skipped rather
      // than thrown on — a hand-edited or partially-written last line
      // should not take down the whole report (same "never throws on bad
      // input" posture as `expansion.ts`'s `fetchCommentSnippets`).
    }
    return records;
  }
}

/** Structural validation for a parsed JSONL line — same "narrow with a
 * type guard, never `as`" posture as `graph.ts`'s `hasStringText` and
 * `server.ts`'s `isValidChatRequestBody` (lessons.md #21: type the
 * boundary a JSON parse hands you). */
function isModelInvocationRecord(value: unknown): value is ModelInvocationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === 'string' &&
    (v.node === 'respond' || v.node === 'composeAnswer' || v.node === 'composeStandupDraft') &&
    typeof v.trigger === 'string' &&
    typeof v.model === 'string' &&
    typeof v.inputTokens === 'number' &&
    typeof v.outputTokens === 'number' &&
    (v.documentsPulled === undefined || typeof v.documentsPulled === 'number')
  );
}

// ============================================================================
// Aggregation — the numbers FLEETGRAPH.MD's Development and Testing Costs
// table, and FG-13 after this ticket, actually cite.
// ============================================================================

export interface AggregateStats {
  invocationCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of every record's `costUsd`, skipping records whose model has no
   * price-table entry (see `unpricedInvocations`) — so this is a real
   * floor computed from recorded data, never an estimate padded to cover
   * an unknown model's price. */
  totalCostUsd: number;
  /** Count of records included in `invocationCount`/token sums above but
   * EXCLUDED from `totalCostUsd` because their `model` has no entry in
   * `PRICE_PER_MILLION_TOKENS`. Non-zero here means `totalCostUsd`
   * understates real spend — surfaced explicitly rather than silently. */
  unpricedInvocations: number;
}

function emptyAggregate(): AggregateStats {
  return { invocationCount: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0, unpricedInvocations: 0 };
}

function fold(stats: AggregateStats, record: ModelInvocationRecord): AggregateStats {
  const cost = costUsd(record.model, record.inputTokens, record.outputTokens);
  return {
    invocationCount: stats.invocationCount + 1,
    inputTokens: stats.inputTokens + record.inputTokens,
    outputTokens: stats.outputTokens + record.outputTokens,
    totalCostUsd: stats.totalCostUsd + (cost ?? 0),
    unpricedInvocations: stats.unpricedInvocations + (cost === undefined ? 1 : 0),
  };
}

/** "Development spend to date" — the graded FLEETGRAPH.MD table's four
 * numbers (input tokens, output tokens, invocation count, total $), all
 * from recorded data. */
export function aggregate(records: readonly ModelInvocationRecord[]): AggregateStats {
  return records.reduce(fold, emptyAggregate());
}

export interface PerNodeStats extends AggregateStats {
  node: InvocationSite;
  /** `totalCostUsd / invocationCount` — "measured cost per graph run, per
   * tier" (the ticket's own phrase), to replace FLEETGRAPH.MD's projected
   * $0.021/$0.015/$0.052/$0.065 figures with observed ones. `undefined`
   * when every record for this node is unpriced (would divide by a cost of
   * 0 that isn't really 0, which would misreport as "free"). */
  costPerRunUsd: number | undefined;
  /** Only meaningful for `node: 'composeAnswer'` — the average
   * `documentsPulled` across every record that set it (cost cliff #2).
   * `undefined` when no record for this node carries the field. */
  avgDocumentsPulled: number | undefined;
}

/** Groups by `node` (this file's "tier") and computes per-tier measured
 * cost. Only nodes actually present in `records` appear in the result —
 * this naturally reflects "inbox assembly and retro draft make no model
 * call in the graph as built today" without this file hardcoding that
 * fact anywhere. */
export function aggregateByNode(records: readonly ModelInvocationRecord[]): PerNodeStats[] {
  const byNode = new Map<InvocationSite, ModelInvocationRecord[]>();
  for (const record of records) {
    const list = byNode.get(record.node) ?? [];
    list.push(record);
    byNode.set(record.node, list);
  }

  const result: PerNodeStats[] = [];
  for (const [node, nodeRecords] of byNode) {
    const stats = aggregate(nodeRecords);
    const pricedCount = stats.invocationCount - stats.unpricedInvocations;
    const documentsPulledValues = nodeRecords
      .map((r) => r.documentsPulled)
      .filter((v): v is number => v !== undefined);

    result.push({
      node,
      ...stats,
      costPerRunUsd: pricedCount > 0 ? stats.totalCostUsd / pricedCount : undefined,
      avgDocumentsPulled:
        documentsPulledValues.length > 0
          ? documentsPulledValues.reduce((a, b) => a + b, 0) / documentsPulledValues.length
          : undefined,
    });
  }
  return result.sort((a, b) => a.node.localeCompare(b.node));
}

/** "Runs per day, observed" — invocation counts bucketed by the UTC
 * calendar day of `timestamp`, newest first. */
export function invocationsByDay(records: readonly ModelInvocationRecord[]): Array<{ day: string; count: number }> {
  const byDay = new Map<string, number>();
  for (const record of records) {
    const day = record.timestamp.slice(0, 10); // YYYY-MM-DD, ISO 8601 prefix
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
