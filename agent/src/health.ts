/**
 * Readiness check (TRO-313 / FG-2; upgraded by TRO-315 / FG-4).
 *
 * "Ship API reachable + config loaded." The Ship-reachability half now goes
 * through the resilient client (timeout + retry/backoff + circuit breaker +
 * self-throttle) instead of a bare fetch, so `/ready` reflects the breaker's
 * real state: once Ship has failed enough consecutive times, `/ready` fails
 * FAST (the breaker short-circuits) rather than waiting out a full
 * timeout+retry cycle on every poll — exactly FG-4's degradation contract
 * ("in-flight ... requests return a plain 'I can't reach Ship right now'
 * rather than a stack trace or a hang").
 *
 * `client` is typed as the narrow `ShipReadClient` interface, not the
 * concrete `ResilientClient` class, so tests can inject a plain stable fake
 * without constructing a real breaker/rate-limiter — see
 * `__tests__/health.test.ts`.
 */

export interface ShipReadClient {
  get(url: string, init?: RequestInit): Promise<Response>;
}

export interface ReadinessCheckDeps {
  shipApiBaseUrl: string;
  configComplete: boolean;
  client: ShipReadClient;
}

export interface ReadinessResult {
  ready: boolean;
  reason: string;
}

export async function checkReady(deps: ReadinessCheckDeps): Promise<ReadinessResult> {
  if (!deps.configComplete) {
    return { ready: false, reason: 'config_incomplete' };
  }

  const base = deps.shipApiBaseUrl.replace(/\/+$/, '');

  try {
    const response = await deps.client.get(`${base}/health`);
    if (!response.ok) {
      // The `ShipReadClient` interface only promises a resolved `Response` —
      // it does not promise the resolved value is a success. A real
      // `ResilientClient` already throws for >=500 (`checkedFetch`), but a
      // fake or a future client implementation could resolve with any
      // status, so this check does not rely on that internal contract.
      return { ready: false, reason: `ship_unhealthy: ${response.status}` };
    }
    return { ready: true, reason: 'ok' };
  } catch (err) {
    // The client always normalizes failures to a plain, safe message
    // (ShipUnreachableError) — never a raw stack trace reaches this reason.
    const message = err instanceof Error ? err.message : String(err);
    return { ready: false, reason: `ship_unreachable: ${message}` };
  }
}
