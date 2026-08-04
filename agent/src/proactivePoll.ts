/**
 * Production poll loop for the proactive fast tier (TRO-317 / FG-5).
 *
 * `createProactivePoller` returns a `tick()` that invokes the compiled
 * graph once with `trigger: 'proactive_steady'`, carrying the change-feed
 * cursor forward between calls — separated from `start()`'s `setInterval`
 * so `tick()` itself is unit-testable without depending on real timers.
 *
 * A tick failure never crashes the process (matches FG-4's degradation
 * contract — `ResilientClient` already retries/breaks/self-throttles
 * underneath this; whatever reaches `onError` here is a failure that
 * survived all of that, e.g. a bug in resolution logic). The next tick
 * still runs on schedule with the SAME cursor it had before the failed
 * attempt, since the cursor is only advanced on success — a failed poll
 * costs a delay, not a gap (FLEETGRAPH.MD's "self-correcting" polling
 * property, applied to a mid-run failure the same way it applies to a
 * dropped delivery).
 */
import type { CompiledGraph } from './graph.js';

export interface ProactivePollerOptions {
  graph: Pick<CompiledGraph, 'invoke'>;
  intervalMs: number;
  initialLookbackMs: number;
  now?: () => Date;
  onError?: (err: unknown) => void;
}

export interface ProactivePoller {
  /** Runs one poll cycle now. Exposed for tests and for an initial
   * immediate run at startup rather than waiting a full interval. */
  tick(): Promise<void>;
  /** Starts the recurring interval and returns its handle (pass to
   * `clearInterval` to stop). */
  start(): NodeJS.Timeout;
  /** The cursor the next `tick()` will poll from — `undefined` before the
   * first successful tick. */
  getCursor(): string | undefined;
}

export function createProactivePoller(options: ProactivePollerOptions): ProactivePoller {
  const now = options.now ?? (() => new Date());
  let cursor: string | undefined;

  async function tick(): Promise<void> {
    const since = cursor ?? new Date(now().getTime() - options.initialLookbackMs).toISOString();
    try {
      const result = await options.graph.invoke({ trigger: 'proactive_steady', cursor: since });
      cursor = (result as { cursor?: string }).cursor ?? since;
    } catch (err) {
      options.onError?.(err);
    }
  }

  function start(): NodeJS.Timeout {
    return setInterval(() => {
      void tick();
    }, options.intervalMs);
  }

  return { tick, start, getCursor: () => cursor };
}
