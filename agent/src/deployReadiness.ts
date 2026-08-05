/**
 * Corrective-rollback decision logic for a "boots but broken" deploy
 * (TRO-322 / FG-12).
 *
 * FLEETGRAPH.MD's "Rollback trigger and procedure" section documents two
 * layers that already exist: (1) CI gates merge — a failing build never
 * reaches `main`, so it never reaches Render's `auto_deploy` trigger either;
 * (2) Render's own health-check-gated promotion — a process that never
 * returns 200 on `/health` within its startup window never receives live
 * traffic, and the previous good deploy keeps serving. Both are real and
 * automatic. What neither catches: a deploy that boots cleanly (`/health`
 * always 200 by construction — `server.ts`'s handler makes no dependency
 * check) but is missing required config or cannot reach Ship. `/ready`
 * (`health.ts`'s `checkReady`) reports that case as 503 — but `/ready` is
 * deliberately NOT what Render's platform check watches
 * (`terraform/render/variables.tf`'s `agent_health_check_path` docstring
 * says so explicitly), so nothing currently acts on a sustained `/ready`
 * failure.
 *
 * This module is the decision function a corrective step needs: given a
 * series of `/ready` polls, was the failure SUSTAINED (real
 * misconfiguration — the case this ticket closes) or a single TRANSIENT
 * blip (Ship briefly unreachable during a healthy instance's normal
 * operation — FLEETGRAPH.MD's own explicit caveat: "`/ready` can also
 * legitimately be false on a healthy, freshly-promoted instance if Ship
 * itself is briefly down, and that specific case must not be read as 'the
 * deploy failed'"). Blindly rolling back on one 503 would violate that
 * caveat; blindly trusting `/health` alone is the gap this ticket exists to
 * close. Requiring EVERY sample in the window to fail is what tells the two
 * apart — see `evaluateReadinessSamples`'s own docstring.
 *
 * Kept as pure, injectable-clock-free logic (no timers, no fetch) so it is
 * testable without a real network call or a real elapsed wait — the
 * sampling loop that actually waits between polls (`pollReadiness`) is a
 * thin, separately-testable wrapper around it, matching this codebase's
 * existing `checkReady`/`ShipReadClient` split (`health.ts`).
 */

export interface ReadinessSample {
  /** Wall-clock instant this sample was taken (ISO 8601). */
  at: string;
  ready: boolean;
  /** `checkReady`'s own `reason` field, or a poll-level failure reason
   * (e.g. a network error reaching `/ready` itself) when the endpoint could
   * not be reached at all. */
  reason: string;
}

export interface ReadinessEvaluation {
  /** True only when EVERY sample in the window reports not-ready — see
   * module docstring for why a single failure is deliberately insufficient. */
  rollbackWarranted: boolean;
  reason: string;
  sampleCount: number;
  failureCount: number;
}

/**
 * Decides whether a window of `/ready` samples represents a sustained
 * failure (every sample failed) or not (at least one succeeded, including
 * possibly the last one — recovery mid-window counts as "not sustained,"
 * matching FLEETGRAPH.MD's transient-blip caveat: a Ship-down blip that
 * clears before the window ends is exactly the case that must not trigger a
 * rollback).
 *
 * An empty sample list is never "warranted" — there is nothing to conclude
 * from zero observations, and treating "no data" as "roll back" would make
 * a network hiccup in the CHECKER itself (as opposed to the service being
 * checked) fire a rollback for no real reason.
 */
export function evaluateReadinessSamples(samples: readonly ReadinessSample[]): ReadinessEvaluation {
  const sampleCount = samples.length;
  const failureCount = samples.filter((s) => !s.ready).length;

  if (sampleCount === 0) {
    return { rollbackWarranted: false, reason: 'no_samples', sampleCount, failureCount };
  }

  if (failureCount === sampleCount) {
    return {
      rollbackWarranted: true,
      reason: `sustained_not_ready: all ${sampleCount} sample(s) reported not-ready`,
      sampleCount,
      failureCount,
    };
  }

  return {
    rollbackWarranted: false,
    reason:
      failureCount === 0
        ? 'healthy: every sample reported ready'
        : `transient: ${failureCount}/${sampleCount} sample(s) reported not-ready, at least one recovered`,
    sampleCount,
    failureCount,
  };
}

export interface ReadinessFetcher {
  get(url: string): Promise<Response>;
}

export interface PollReadinessOptions {
  /** Full `/ready` URL to poll (e.g. `https://ship-agent.onrender.com/ready`). */
  url: string;
  /** How many samples to take. FLEETGRAPH.MD's caveat requires more than
   * one — a single sample can never distinguish "sustained" from
   * "transient," so this is deliberately NOT allowed to default to 1. */
  attempts: number;
  /** Wait between samples, in ms. */
  intervalMs: number;
  fetcher: ReadinessFetcher;
  /** Injected clock, same posture as `itemStore.ts`'s `InMemoryItemStore` —
   * tests never depend on real wall-clock time (lessons.md #17). */
  now?: () => Date;
  /** Injected sleep, so tests can run this loop with zero real wait time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Takes `attempts` samples of `options.url`, `intervalMs` apart, and
 * returns them in order. Never throws on a failed fetch or a non-2xx
 * response — either is recorded as `ready: false` with a reason, same
 * "a failure is data, not an exception" posture as `checkReady` itself.
 */
export async function pollReadiness(options: PollReadinessOptions): Promise<ReadinessSample[]> {
  const { url, attempts, intervalMs, fetcher } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (attempts < 1) {
    throw new Error(`pollReadiness: attempts must be >= 1, got ${attempts}`);
  }

  const samples: ReadinessSample[] = [];
  for (let i = 0; i < attempts; i++) {
    const at = now().toISOString();
    try {
      const response = await fetcher.get(url);
      samples.push({
        at,
        ready: response.ok,
        reason: response.ok ? 'ok' : `http_${response.status}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      samples.push({ at, ready: false, reason: `fetch_failed: ${message}` });
    }
    if (i < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return samples;
}
