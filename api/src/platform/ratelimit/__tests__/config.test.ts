import { describe, it, expect } from 'vitest';
import { resolveRateLimits, DEFAULT_APP_RPM, DEFAULT_TOKEN_RPM, RATE_LIMIT_WINDOW_MS } from '../config.js';

describe('resolveRateLimits', () => {
  it('defaults to PLUGFORGE.MD §2.7 (120 app / 60 token) when neither env var is set', () => {
    const resolved = resolveRateLimits({});
    expect(resolved.appRpm).toBe(DEFAULT_APP_RPM);
    expect(resolved.tokenRpm).toBe(DEFAULT_TOKEN_RPM);
    expect(resolved.windowMs).toBe(RATE_LIMIT_WINDOW_MS);
    expect(DEFAULT_APP_RPM).toBe(120);
    expect(DEFAULT_TOKEN_RPM).toBe(60);
  });

  it('honors RATE_LIMIT_APP_RPM / RATE_LIMIT_TOKEN_RPM when both are set', () => {
    const resolved = resolveRateLimits({ RATE_LIMIT_APP_RPM: '240', RATE_LIMIT_TOKEN_RPM: '30' });
    expect(resolved.appRpm).toBe(240);
    expect(resolved.tokenRpm).toBe(30);
  });

  it('falls back to the default for whichever var is unset, independently of the other', () => {
    const appOnly = resolveRateLimits({ RATE_LIMIT_APP_RPM: '500' });
    expect(appOnly.appRpm).toBe(500);
    expect(appOnly.tokenRpm).toBe(DEFAULT_TOKEN_RPM);

    const tokenOnly = resolveRateLimits({ RATE_LIMIT_TOKEN_RPM: '15' });
    expect(tokenOnly.appRpm).toBe(DEFAULT_APP_RPM);
    expect(tokenOnly.tokenRpm).toBe(15);
  });

  it('treats an empty string the same as unset', () => {
    const resolved = resolveRateLimits({ RATE_LIMIT_APP_RPM: '', RATE_LIMIT_TOKEN_RPM: '' });
    expect(resolved.appRpm).toBe(DEFAULT_APP_RPM);
    expect(resolved.tokenRpm).toBe(DEFAULT_TOKEN_RPM);
  });

  it('throws on a non-positive or non-numeric override rather than silently ignoring it', () => {
    expect(() => resolveRateLimits({ RATE_LIMIT_APP_RPM: '0' })).toThrow(/RATE_LIMIT_APP_RPM/);
    expect(() => resolveRateLimits({ RATE_LIMIT_APP_RPM: '-10' })).toThrow(/RATE_LIMIT_APP_RPM/);
    expect(() => resolveRateLimits({ RATE_LIMIT_TOKEN_RPM: 'not-a-number' })).toThrow(/RATE_LIMIT_TOKEN_RPM/);
  });
});
