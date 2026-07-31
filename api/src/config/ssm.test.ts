/**
 * TRO-248 / RULE-7 — SSM secret loading had no per-call timeout and no
 * retry: `getSSMSecret` awaited `client.send(command)` directly, so a single
 * transient failure (a cold VPC endpoint, a brief throttle, a dropped
 * connection) either hung indefinitely or failed the whole boot on the
 * first attempt. On AWS, `loadProductionSecrets` has no env fallback for a
 * production deploy (no `DATABASE_URL`/`SESSION_SECRET` already set), so
 * that failure reached the `throw` at the bottom of its catch block and
 * crash-looped the container — over a delay that would very likely have
 * cleared on its own.
 *
 * These tests exercise `getSSMSecret` against a mocked `SSMClient`, using
 * fake timers to drive the timeout/backoff without real waiting (no fixed
 * sleeps — the "clock" here is virtual and advanced explicitly per rule 17).
 * `Math.random` is stubbed to `1` so the jittered backoff delay is the
 * deterministic upper bound of its schedule, not a random value the test
 * would otherwise have to tolerate a range for.
 *
 * Two things a code-review pass caught that the first version of this file
 * missed, both covered below:
 *  - The AWS SDK's own client has a default retry strategy (`maxAttempts: 3`)
 *    that would otherwise compound with this file's own retry loop. The
 *    client is now constructed with `maxAttempts: 1` so this file's loop is
 *    the sole retry layer — asserted directly below.
 *  - A genuinely missing parameter name doesn't resolve with an empty value;
 *    the real SSM API rejects with `ParameterNotFound`, which must not be
 *    retried (retrying a name that doesn't exist can never succeed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ssm', () => {
  // Regular `function` expressions, not arrows: `new GetParameterCommand(...)`
  // (and `new ParameterNotFound(...)`) require a constructible value, and
  // arrow functions have no `[[Construct]]`.
  class ParameterNotFound extends Error {
    readonly name = 'ParameterNotFound';
    constructor(opts?: { message?: string }) {
      super(opts?.message ?? 'Parameter not found');
    }
  }

  return {
    SSMClient: vi.fn().mockImplementation(function SSMClient() {
      return { send: sendMock };
    }),
    GetParameterCommand: vi.fn().mockImplementation(function GetParameterCommand(
      input: unknown
    ) {
      return { input };
    }),
    ParameterNotFound,
  };
});

import { SSMClient, ParameterNotFound } from '@aws-sdk/client-ssm';
import { getSSMSecret, loadProductionSecrets } from './ssm.js';

function abortableHang(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

function parameterResponse(value: string | undefined) {
  return { Parameter: value === undefined ? undefined : { Value: value } };
}

describe('getSSMSecret (TRO-248)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the value on a successful first attempt without retrying', async () => {
    sendMock.mockResolvedValueOnce(parameterResponse('secret-value'));

    const result = await getSSMSecret('/ship/prod/DATABASE_URL');

    expect(result).toBe('secret-value');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds within the attempt budget', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(parameterResponse('recovered-value'));

    const promise = getSSMSecret('/ship/prod/SESSION_SECRET');
    // Drive past the retry's backoff delay (jitter stubbed to its cap).
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe('recovered-value');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting attempts and throws the last transient error', async () => {
    sendMock.mockRejectedValue(new Error('ECONNRESET'));

    const promise = getSSMSecret('/ship/prod/CORS_ORIGIN');
    promise.catch(() => {}); // observed below; suppress unhandled-rejection noise from the race with fake timers
    await vi.advanceTimersByTimeAsync(20000);

    await expect(promise).rejects.toThrow('ECONNRESET');
    // 1 initial attempt + 2 retries = 3 total, never more.
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('bounds a hung call with the per-attempt timeout, then retries', async () => {
    sendMock
      .mockImplementationOnce((_cmd: unknown, opts: { abortSignal: AbortSignal }) =>
        abortableHang(opts.abortSignal)
      )
      .mockResolvedValueOnce(parameterResponse('after-timeout-value'));

    const promise = getSSMSecret('/ship/prod/CDN_DOMAIN');
    // Past the 5s per-attempt timeout, then past the retry backoff.
    await vi.advanceTimersByTimeAsync(10000);

    await expect(promise).resolves.toBe('after-timeout-value');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful call that reports the parameter missing', async () => {
    sendMock.mockResolvedValue(parameterResponse(undefined));

    const promise = getSSMSecret('/ship/prod/DOES_NOT_EXIST');

    await expect(promise).rejects.toThrow('SSM parameter /ship/prod/DOES_NOT_EXIST not found');
    // The call succeeded (no exception); "not found" is a permanent outcome
    // discovered only after a successful send, so it must not be retried.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry the real ParameterNotFound rejection SSM actually throws', async () => {
    // What the live AWS API does for a genuinely missing name: `send()`
    // rejects with `ParameterNotFound` rather than resolving with an empty
    // value. Retrying a name that will never exist just delays the same
    // failure, so this must propagate on the very first attempt.
    sendMock.mockRejectedValue(
      new ParameterNotFound({ message: '/ship/prod/DOES_NOT_EXIST', $metadata: {} })
    );

    const promise = getSSMSecret('/ship/prod/DOES_NOT_EXIST');

    await expect(promise).rejects.toThrow('/ship/prod/DOES_NOT_EXIST');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('constructs the SSM client with maxAttempts: 1 so this file is the only retry layer', async () => {
    sendMock.mockResolvedValueOnce(parameterResponse('secret-value'));
    await getSSMSecret('/ship/prod/DATABASE_URL');

    expect(vi.mocked(SSMClient).mock.calls[0]?.[0]).toMatchObject({ maxAttempts: 1 });
  });
});

/**
 * TRO-280 / API-7 — `loadProductionSecrets` fetches REDIS_URL as a SEPARATE,
 * best-effort step after the five required secrets above, because
 * `terraform/redis.tf`'s ElastiCache instance has not been applied anywhere
 * (this ticket only wrote and validated the Terraform) and because Redis is
 * an opt-in improvement for the rate limiter, not a hard dependency — see
 * `ssm.ts`'s comment at the REDIS_URL fetch and `middleware/rate-limit.ts`'s
 * `MemoryStore` fallback. A missing REDIS_URL must never fail boot the way a
 * missing DATABASE_URL does; these tests pin that.
 */
describe('loadProductionSecrets REDIS_URL (TRO-280)', () => {
  const basePath = '/ship/prod';
  const requiredValues: Record<string, string> = {
    [`${basePath}/DATABASE_URL`]: 'postgresql://required-value',
    [`${basePath}/SESSION_SECRET`]: 'required-session-secret',
    [`${basePath}/CORS_ORIGIN`]: 'https://example.gov',
    [`${basePath}/CDN_DOMAIN`]: 'cdn.example.gov',
    [`${basePath}/APP_BASE_URL`]: 'https://example.gov',
  };
  const savedEnv: Record<string, string | undefined> = {};
  const managedKeys = [
    'NODE_ENV',
    'ENVIRONMENT',
    'DATABASE_URL',
    'SESSION_SECRET',
    'CORS_ORIGIN',
    'CDN_DOMAIN',
    'APP_BASE_URL',
    'REDIS_URL',
  ] as const;

  beforeEach(() => {
    for (const key of managedKeys) savedEnv[key] = process.env[key];
    sendMock.mockReset();
    process.env.NODE_ENV = 'production';
    process.env.ENVIRONMENT = 'prod';
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    for (const key of managedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function mockRequiredSecrets(
    redisBehavior: (name: string) => Promise<{ Parameter: { Value: string } | undefined }>
  ): void {
    sendMock.mockImplementation(async (command: { input: { Name: string } }) => {
      const name = command.input.Name;
      if (name === `${basePath}/REDIS_URL`) return redisBehavior(name);
      if (name in requiredValues) return parameterResponse(requiredValues[name]);
      throw new Error(`unexpected SSM parameter requested in test: ${name}`);
    });
  }

  it('sets process.env.REDIS_URL when SSM has the parameter, alongside the required secrets', async () => {
    mockRequiredSecrets(async () => parameterResponse('redis://ship-redis.internal:6379'));

    await loadProductionSecrets();

    expect(process.env.REDIS_URL).toBe('redis://ship-redis.internal:6379');
    expect(process.env.DATABASE_URL).toBe(requiredValues[`${basePath}/DATABASE_URL`]);
  });

  it('leaves REDIS_URL unset and does not fail boot when SSM has no REDIS_URL parameter yet', async () => {
    mockRequiredSecrets(async (name) => {
      throw new ParameterNotFound({ message: name, $metadata: {} });
    });

    await expect(loadProductionSecrets()).resolves.toBeUndefined();

    expect(process.env.REDIS_URL).toBeUndefined();
    // The required secrets must still have loaded — REDIS_URL failing must
    // not be able to take the rest of the boot down with it.
    expect(process.env.DATABASE_URL).toBe(requiredValues[`${basePath}/DATABASE_URL`]);
    expect(process.env.SESSION_SECRET).toBe(requiredValues[`${basePath}/SESSION_SECRET`]);
  });
});
