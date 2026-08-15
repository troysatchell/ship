import { describe, expect, it } from 'vitest';
import { ShipSdkError } from '@ship/sdk';
import { CliConfigError } from './config.js';
import { formatError } from './errors.js';

describe('formatError', () => {
  it('renders a CliConfigError as "Error: <message>"', () => {
    expect(formatError(new CliConfigError('no client id'))).toBe('Error: no client id');
  });

  it('renders a ShipSdkError with its kind and, when present, the HTTP status', () => {
    const err = new ShipSdkError('auth', 'invalid_grant', { httpStatus: 400 });
    expect(formatError(err)).toBe('Error [auth]: invalid_grant (HTTP 400)');
  });

  it('renders a ShipSdkError with no httpStatus (e.g. a network failure) without an "(HTTP ...)" suffix', () => {
    const err = ShipSdkError.fromNetworkError(new TypeError('fetch failed'));
    expect(formatError(err)).toBe('Error [network]: fetch failed');
  });

  it('renders a plain Error', () => {
    expect(formatError(new Error('boom'))).toBe('Error: boom');
  });

  it('renders a non-Error throw without crashing', () => {
    expect(formatError('a string throw')).toBe('Error: a string throw');
  });
});
