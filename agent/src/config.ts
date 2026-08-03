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
}

const DEFAULT_PORT = 3100;
const DEFAULT_SHIP_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_SHIP_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_SELF_THROTTLE_RPM = 500;

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
  };
}

/**
 * "Config loaded" half of /ready (TRO-313's proof section). The other half —
 * Ship reachability — is a live check, not a static one; see `health.ts`.
 */
export function isConfigComplete(config: AgentConfig): boolean {
  return Boolean(config.anthropicApiKey) && config.shipApiBaseUrl.length > 0;
}
