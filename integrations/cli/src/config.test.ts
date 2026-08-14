import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID_ENV_VAR,
  CREDENTIALS_PATH_ENV_VAR,
  CliConfigError,
  resolveBaseUrl,
  resolveClientId,
  resolveCredentialsPath,
} from './config.js';

describe('resolveClientId', () => {
  it('prefers the --client-id argument over the env var', () => {
    expect(resolveClientId('ship_app_from_arg', { [CLIENT_ID_ENV_VAR]: 'ship_app_from_env' })).toBe(
      'ship_app_from_arg'
    );
  });

  it('falls back to SHIP_CLI_CLIENT_ID when no argument is given', () => {
    expect(resolveClientId(undefined, { [CLIENT_ID_ENV_VAR]: 'ship_app_from_env' })).toBe('ship_app_from_env');
  });

  it('throws CliConfigError when neither is set', () => {
    expect(() => resolveClientId(undefined, {})).toThrow(CliConfigError);
    expect(() => resolveClientId(undefined, {})).toThrow(/SHIP_CLI_CLIENT_ID/);
  });

  it('treats an empty-string argument as absent, not as a valid client id', () => {
    expect(resolveClientId('', { [CLIENT_ID_ENV_VAR]: 'ship_app_from_env' })).toBe('ship_app_from_env');
  });
});

describe('resolveBaseUrl', () => {
  it('prefers the --base-url argument', () => {
    expect(resolveBaseUrl('https://arg.example.com', { SHIP_API_BASE_URL: 'https://env.example.com' })).toBe(
      'https://arg.example.com'
    );
  });

  it('falls back to SHIP_API_BASE_URL', () => {
    expect(resolveBaseUrl(undefined, { SHIP_API_BASE_URL: 'https://env.example.com' })).toBe(
      'https://env.example.com'
    );
  });

  it('returns undefined when neither is set, leaving the SDK to apply its own default', () => {
    expect(resolveBaseUrl(undefined, {})).toBeUndefined();
  });
});

describe('resolveCredentialsPath', () => {
  it('honors SHIP_CLI_CREDENTIALS_PATH when set', () => {
    expect(resolveCredentialsPath({ [CREDENTIALS_PATH_ENV_VAR]: '/tmp/custom-credentials.json' })).toBe(
      '/tmp/custom-credentials.json'
    );
  });

  it('defaults to ~/.ship/credentials.json (this ticket\'s own AC path)', () => {
    const resolved = resolveCredentialsPath({});
    expect(resolved.endsWith('.ship/credentials.json')).toBe(true);
  });
});
