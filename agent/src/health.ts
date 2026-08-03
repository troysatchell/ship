/**
 * Readiness check (TRO-313 / FG-2): "Ship API reachable + config loaded."
 *
 * Deliberately a bare, single fetch with a timeout — no retry, no backoff, no
 * circuit breaker. FG-4 (TRO-315) is the ticket that gives every outbound
 * call, this one included, the full resilient-client treatment; wiring that
 * in here now would be doing FG-4's work under FG-2's ticket. `fetchImpl` is
 * injectable so `/ready`'s 200/503 behavior is provable against a stable
 * fake, per FG-2's "how it will be proven" — never a live call in tests.
 */

export interface ReadinessCheckDeps {
  shipApiBaseUrl: string;
  configComplete: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface ReadinessResult {
  ready: boolean;
  reason: string;
}

export async function checkReady(deps: ReadinessCheckDeps): Promise<ReadinessResult> {
  if (!deps.configComplete) {
    return { ready: false, reason: 'config_incomplete' };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.shipApiBaseUrl.replace(/\/+$/, '');

  try {
    const response = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!response.ok) {
      return { ready: false, reason: `ship_unhealthy_${response.status}` };
    }
    return { ready: true, reason: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ready: false, reason: `ship_unreachable: ${message}` };
  }
}
