/**
 * Environment-only configuration for the agent service (TRO-313 / FG-2).
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
  /** Connect/read timeout, in ms, for outbound calls to Ship (FG-4 client). */
  shipRequestTimeoutMs: number;
}

const DEFAULT_PORT = 3100;
const DEFAULT_SHIP_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_SHIP_REQUEST_TIMEOUT_MS = 5_000;

/** Load config from an env map. Defaults to `process.env`; tests inject a fake map. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const port = Number.parseInt(env.PORT ?? '', 10);
  const timeout = Number.parseInt(env.SHIP_REQUEST_TIMEOUT_MS ?? '', 10);

  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    shipApiBaseUrl: env.SHIP_API_BASE_URL ?? DEFAULT_SHIP_API_BASE_URL,
    shipApiToken: env.SHIP_API_TOKEN,
    langchainTracingV2: env.LANGCHAIN_TRACING_V2 === 'true',
    langchainProject: env.LANGCHAIN_PROJECT,
    shipRequestTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_SHIP_REQUEST_TIMEOUT_MS,
  };
}

/**
 * "Config loaded" half of /ready (TRO-313's proof section). The other half —
 * Ship reachability — is a live check, not a static one; see `health.ts`.
 */
export function isConfigComplete(config: AgentConfig): boolean {
  return Boolean(config.anthropicApiKey) && config.shipApiBaseUrl.length > 0;
}
