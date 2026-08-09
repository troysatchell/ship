import { describe, expect, it } from 'vitest';
import { anthropicWorstCaseCallMs, isConfigComplete, loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('applies documented defaults when env vars are absent', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3100);
    expect(config.shipApiBaseUrl).toBe('http://localhost:3000');
    expect(config.shipRequestTimeoutMs).toBe(5000);
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.langchainTracingV2).toBe(false);
    expect(config.shipBreakerFailureThreshold).toBe(5);
    expect(config.shipBreakerCooldownMs).toBe(30000);
    expect(config.shipRetryMaxAttempts).toBe(3);
    expect(config.shipSelfThrottleRpm).toBe(500);
    expect(config.proactivePollIntervalMs).toBe(60_000);
    expect(config.proactiveInitialLookbackMs).toBe(24 * 60 * 60 * 1000);
    // TRO-318 / FG-7: the on-demand expansion cap, grounded in
    // FLEETGRAPH.MD's cost model — see config.ts's own docstring.
    expect(config.onDemandDocumentCap).toBe(12);
    // TRO-320 / FG-9: no default — a missing secret must fail /chat closed.
    expect(config.agentInternalSecret).toBeUndefined();
    // CodeRabbit review, PR #120 — shorter than api/'s own
    // AGENT_REQUEST_TIMEOUT_MS (30s, api/src/routes/agent.ts).
    expect(config.chatHandlerTimeoutMs).toBe(25_000);
    // TRO-368 — explicit, chosen values for the LLM-provider call, never
    // silently left to @anthropic-ai/sdk's own 10-minute timeout /
    // AsyncCallerParams' own 6-retry default. Lowered from the original 20s/2
    // by CodeRabbit review, PR #156 (finding 1) — see the
    // `anthropicWorstCaseCallMs` describe block below for why.
    expect(config.anthropicRequestTimeoutMs).toBe(8_000);
    expect(config.anthropicMaxRetries).toBe(1);
  });

  it('reads every value from the provided env map, not process.env', () => {
    const config = loadConfig({
      PORT: '4100',
      ANTHROPIC_API_KEY: 'sk-test',
      SHIP_API_BASE_URL: 'https://ship.example.gov',
      SHIP_API_TOKEN: 'token-abc',
      LANGCHAIN_TRACING_V2: 'true',
      LANGCHAIN_PROJECT: 'fleetgraph-agent',
      SHIP_REQUEST_TIMEOUT_MS: '2500',
      SHIP_BREAKER_FAILURE_THRESHOLD: '7',
      SHIP_BREAKER_COOLDOWN_MS: '15000',
      SHIP_RETRY_MAX_ATTEMPTS: '4',
      SHIP_SELF_THROTTLE_RPM: '250',
      PROACTIVE_POLL_INTERVAL_MS: '30000',
      PROACTIVE_INITIAL_LOOKBACK_MS: '3600000',
      ON_DEMAND_DOCUMENT_CAP: '20',
      AGENT_INTERNAL_SECRET: 'shared-secret-abc',
      CHAT_HANDLER_TIMEOUT_MS: '12000',
      ANTHROPIC_REQUEST_TIMEOUT_MS: '15000',
      ANTHROPIC_MAX_RETRIES: '4',
    });

    expect(config).toEqual({
      port: 4100,
      anthropicApiKey: 'sk-test',
      shipApiBaseUrl: 'https://ship.example.gov',
      shipApiToken: 'token-abc',
      langchainTracingV2: true,
      langchainProject: 'fleetgraph-agent',
      shipRequestTimeoutMs: 2500,
      shipBreakerFailureThreshold: 7,
      shipBreakerCooldownMs: 15000,
      shipRetryMaxAttempts: 4,
      shipSelfThrottleRpm: 250,
      proactivePollIntervalMs: 30000,
      proactiveInitialLookbackMs: 3600000,
      onDemandDocumentCap: 20,
      agentInternalSecret: 'shared-secret-abc',
      chatHandlerTimeoutMs: 12000,
      anthropicRequestTimeoutMs: 15000,
      anthropicMaxRetries: 4,
    });
  });

  it('falls back to defaults on non-numeric PORT / timeout rather than NaN', () => {
    const config = loadConfig({ PORT: 'not-a-number', SHIP_REQUEST_TIMEOUT_MS: 'also-not' });
    expect(config.port).toBe(3100);
    expect(config.shipRequestTimeoutMs).toBe(5000);
  });

  it('never lets ON_DEMAND_DOCUMENT_CAP resolve to 0 or a negative number — the cap must stay a real limit', () => {
    expect(loadConfig({ ON_DEMAND_DOCUMENT_CAP: '0' }).onDemandDocumentCap).toBe(12);
    expect(loadConfig({ ON_DEMAND_DOCUMENT_CAP: '-5' }).onDemandDocumentCap).toBe(12);
    expect(loadConfig({ ON_DEMAND_DOCUMENT_CAP: 'not-a-number' }).onDemandDocumentCap).toBe(12);
  });

  // CodeRabbit review, PR #156 (finding 2): ANTHROPIC_MAX_RETRIES=0 is the
  // documented way to disable @langchain/core's AsyncCaller retries — it
  // must survive, not be treated as "unset" the way `positiveInt` would.
  describe('ANTHROPIC_MAX_RETRIES (nonNegativeInt parser)', () => {
    it('accepts 0 — the documented way to disable retries entirely', () => {
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '0' }).anthropicMaxRetries).toBe(0);
    });

    it('accepts a genuine positive value', () => {
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '3' }).anthropicMaxRetries).toBe(3);
    });

    it('falls back to the default (1) on a negative value', () => {
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '-1' }).anthropicMaxRetries).toBe(1);
    });

    it('falls back to the default (1) on malformed input, unlike positiveInt which would parse "2abc" as 2', () => {
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '2abc' }).anthropicMaxRetries).toBe(1);
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: 'not-a-number' }).anthropicMaxRetries).toBe(1);
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '3.5' }).anthropicMaxRetries).toBe(1);
      expect(loadConfig({ ANTHROPIC_MAX_RETRIES: '' }).anthropicMaxRetries).toBe(1);
    });
  });
});

// CodeRabbit review, PR #156 (finding 1): the timeout+retry budget for the
// Anthropic call must fit inside chatHandlerTimeoutMs, or a hung call can
// outlive the handler that started it — the exact hole TRO-368 exists to
// close, reopened in a narrower form by picking a per-attempt timeout that
// looked safe in isolation but wasn't once multiplied by the retry count.
describe('anthropicWorstCaseCallMs (CodeRabbit review, PR #156, finding 1)', () => {
  it('computes attempts * timeout plus worst-case backoff for a simple case', () => {
    // 1 retry (2 attempts): worst-case backoff before the only retry is
    // round(rand[1,2) * 1_000 * 2**0) -> worst case 2_000ms.
    expect(anthropicWorstCaseCallMs(5_000, 1)).toBe(2 * 5_000 + 2_000);
  });

  it('accounts for compounding backoff across multiple retries', () => {
    // 2 retries (3 attempts): backoff before retry 1 is up to 2_000ms,
    // before retry 2 is up to 4_000ms (factor 2 per the `retry` package's
    // own default) — worst case total backoff 6_000ms.
    expect(anthropicWorstCaseCallMs(1_000, 2)).toBe(3 * 1_000 + 2_000 + 4_000);
  });

  it('returns exactly the timeout with 0 retries — no backoff, one attempt', () => {
    expect(anthropicWorstCaseCallMs(9_000, 0)).toBe(9_000);
  });

  it('the production defaults fit inside the production chatHandlerTimeoutMs default, with margin', () => {
    const config = loadConfig({});
    const worstCase = anthropicWorstCaseCallMs(config.anthropicRequestTimeoutMs, config.anthropicMaxRetries);

    expect(worstCase).toBe(18_000);
    expect(worstCase).toBeLessThan(config.chatHandlerTimeoutMs);
    // Leaves real margin for the rest of /chat's own work (Ship reads before
    // the model is ever called), not just barely squeaking under the wire.
    expect(config.chatHandlerTimeoutMs - worstCase).toBeGreaterThanOrEqual(5_000);
  });

  it("TRO-368's ORIGINAL defaults (20s timeout, 2 retries) would NOT have fit — documents the regression this finding fixed", () => {
    const originalWorstCase = anthropicWorstCaseCallMs(20_000, 2);
    const chatHandlerTimeoutMsDefault = loadConfig({}).chatHandlerTimeoutMs;

    expect(originalWorstCase).toBeGreaterThan(chatHandlerTimeoutMsDefault);
  });
});

describe('isConfigComplete', () => {
  it('is false without an Anthropic API key', () => {
    const config = loadConfig({
      SHIP_API_BASE_URL: 'https://ship.example.gov',
      SHIP_API_TOKEN: 'token-abc',
    });
    expect(isConfigComplete(config)).toBe(false);
  });

  it('is false without a Ship API token', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      SHIP_API_BASE_URL: 'https://ship.example.gov',
    });
    expect(isConfigComplete(config)).toBe(false);
  });

  it('is true once the API key, Ship base URL, and Ship token are all set', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      SHIP_API_BASE_URL: 'https://ship.example.gov',
      SHIP_API_TOKEN: 'token-abc',
    });
    expect(isConfigComplete(config)).toBe(true);
  });
});
