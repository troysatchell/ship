import { describe, expect, it } from 'vitest';
import { isConfigComplete, loadConfig } from '../config.js';

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
