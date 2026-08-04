/**
 * Environment-only configuration for the agent service (TRO-313 / FG-2;
 * extended by TRO-315 / FG-4 with the resilient-client knobs below).
 *
 * No secrets have defaults. Everything is read from `process.env` (or an
 * injected env map, for tests) — see `.env.example` for the documented shape.
 */

export interface AgentConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Anthropic API key for the model provider. Required for /ready to pass. */
  anthropicApiKey: string | undefined;
  /** Base URL of the Ship API this agent reads from and acts on. */
  shipApiBaseUrl: string;
  /** Per-user Ship API token the agent runs under (FLEETGRAPH.MD: "no service account"). */
  shipApiToken: string | undefined;
  /** Whether LangSmith tracing is enabled (`LANGCHAIN_TRACING_V2=true`). */
  langchainTracingV2: boolean;
  /** LangSmith project name traces are grouped under. */
  langchainProject: string | undefined;
  /** Connect/read timeout, in ms, for outbound calls to Ship. */
  shipRequestTimeoutMs: number;
  /** Consecutive Ship failures before the circuit breaker trips open (FG-4). */
  shipBreakerFailureThreshold: number;
  /** How long the breaker stays open before a half-open trial, in ms (FG-4). */
  shipBreakerCooldownMs: number;
  /** Max attempts (including the first) for idempotent Ship GET reads (FG-4). */
  shipRetryMaxAttempts: number;
  /** Self-throttle ceiling, requests/minute, well under Ship's shared per-IP limit (FG-4). */
  shipSelfThrottleRpm: number;
  /** Steady-tier proactive poll cadence, in ms (TRO-317 / FG-5) — the
   * ticket's own trigger table names 60s; see FLEETGRAPH.MD's Trigger Model. */
  proactivePollIntervalMs: number;
  /** How far back the FIRST proactive poll (no cursor carried forward yet —
   * a fresh start/redeploy) looks, in ms (FG-5). */
  proactiveInitialLookbackMs: number;
  /** Hard cap on documents pulled into context per on-demand answer,
   * counting the seed itself (TRO-318 / FG-7) — "the single most important
   * implementation constraint in the whole design" (FLEETGRAPH.MD's Cost
   * Analysis: on-demand is already 64% of projected spend). `graph.ts`'s
   * `OnDemandDeps.documentCap` has no default of its own on purpose (see
   * that interface's docstring) — this is the one place a concrete number
   * is chosen, so it can be reasoned about and changed in one spot. DERIVED,
   * not measured: FLEETGRAPH.MD's cost model estimates ~9,000 input tokens
   * per on-demand answer with no cap stated; 12 documents at a few hundred
   * tokens of title/snippet/comment context each is consistent with that
   * figure without re-deriving it from scratch. There is no production
   * traffic yet to measure a better number against. */
  onDemandDocumentCap: number;
  /** Shared secret `POST /chat` requires on the `X-Internal-Secret` header
   * (TRO-320 / FG-9). This agent's HTTP surface is reachable from the public
   * internet (a Render service, no private networking configured) — without
   * this check, anyone could spend the configured Anthropic API budget and
   * query the graph as an arbitrary `askingUserId`. No default: `undefined`
   * means `/chat` fails closed (every request rejected), never open. Must
   * match the value `api/`'s `AGENT_API_BASE_URL`-calling route sends —
   * see `api/.env.example`. */
  agentInternalSecret: string | undefined;
}

const DEFAULT_PORT = 3100;
const DEFAULT_SHIP_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_SHIP_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_SELF_THROTTLE_RPM = 500;
const DEFAULT_PROACTIVE_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROACTIVE_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ON_DEMAND_DOCUMENT_CAP = 12;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Load config from an env map. Defaults to `process.env`; tests inject a fake map. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    port: positiveInt(env.PORT, DEFAULT_PORT),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    shipApiBaseUrl: env.SHIP_API_BASE_URL ?? DEFAULT_SHIP_API_BASE_URL,
    shipApiToken: env.SHIP_API_TOKEN,
    langchainTracingV2: env.LANGCHAIN_TRACING_V2 === 'true',
    langchainProject: env.LANGCHAIN_PROJECT,
    shipRequestTimeoutMs: positiveInt(env.SHIP_REQUEST_TIMEOUT_MS, DEFAULT_SHIP_REQUEST_TIMEOUT_MS),
    shipBreakerFailureThreshold: positiveInt(
      env.SHIP_BREAKER_FAILURE_THRESHOLD,
      DEFAULT_BREAKER_FAILURE_THRESHOLD
    ),
    shipBreakerCooldownMs: positiveInt(env.SHIP_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER_COOLDOWN_MS),
    shipRetryMaxAttempts: positiveInt(env.SHIP_RETRY_MAX_ATTEMPTS, DEFAULT_RETRY_MAX_ATTEMPTS),
    shipSelfThrottleRpm: positiveInt(env.SHIP_SELF_THROTTLE_RPM, DEFAULT_SELF_THROTTLE_RPM),
    proactivePollIntervalMs: positiveInt(
      env.PROACTIVE_POLL_INTERVAL_MS,
      DEFAULT_PROACTIVE_POLL_INTERVAL_MS
    ),
    proactiveInitialLookbackMs: positiveInt(
      env.PROACTIVE_INITIAL_LOOKBACK_MS,
      DEFAULT_PROACTIVE_INITIAL_LOOKBACK_MS
    ),
    // `positiveInt` also guarantees >= 1 here — a misconfigured "0" cannot
    // silently disable expansion (`OnDemandDeps.documentCap`'s own docstring:
    // "required, not a nice-to-have").
    onDemandDocumentCap: positiveInt(env.ON_DEMAND_DOCUMENT_CAP, DEFAULT_ON_DEMAND_DOCUMENT_CAP),
    agentInternalSecret: env.AGENT_INTERNAL_SECRET,
  };
}

/**
 * "Config loaded" half of /ready (TRO-313's proof section). The other half —
 * Ship reachability — is a live check, not a static one; see `health.ts`.
 *
 * Deliberately does NOT include `agentInternalSecret`: that field gates one
 * route (`POST /chat`, TRO-320 / FG-9) and is checked there directly — folding
 * it in here would make `/ready` (and the proactive poller's start condition,
 * `index.ts`) depend on a value that has nothing to do with either. A missing
 * secret makes `/chat` fail closed on its own; it does not make the process
 * "not ready."
 */
export function isConfigComplete(config: AgentConfig): boolean {
  return (
    Boolean(config.anthropicApiKey) &&
    config.shipApiBaseUrl.length > 0 &&
    Boolean(config.shipApiToken)
  );
}
