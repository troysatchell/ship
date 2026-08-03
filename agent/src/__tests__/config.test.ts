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
    });

    expect(config).toEqual({
      port: 4100,
      anthropicApiKey: 'sk-test',
      shipApiBaseUrl: 'https://ship.example.gov',
      shipApiToken: 'token-abc',
      langchainTracingV2: true,
      langchainProject: 'fleetgraph-agent',
      shipRequestTimeoutMs: 2500,
    });
  });

  it('falls back to defaults on non-numeric PORT / timeout rather than NaN', () => {
    const config = loadConfig({ PORT: 'not-a-number', SHIP_REQUEST_TIMEOUT_MS: 'also-not' });
    expect(config.port).toBe(3100);
    expect(config.shipRequestTimeoutMs).toBe(5000);
  });
});

describe('isConfigComplete', () => {
  it('is false without an Anthropic API key', () => {
    const config = loadConfig({ SHIP_API_BASE_URL: 'https://ship.example.gov' });
    expect(isConfigComplete(config)).toBe(false);
  });

  it('is true once the API key and Ship base URL are both set', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      SHIP_API_BASE_URL: 'https://ship.example.gov',
    });
    expect(isConfigComplete(config)).toBe(true);
  });
});
