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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ssm', () => {
  // Regular `function` expressions, not arrows: `new GetParameterCommand(...)`
  // requires a constructible value, and arrow functions have no `[[Construct]]`.
  return {
    SSMClient: vi.fn().mockImplementation(function SSMClient() {
      return { send: sendMock };
    }),
    GetParameterCommand: vi.fn().mockImplementation(function GetParameterCommand(
      input: unknown
    ) {
      return { input };
    }),
  };
});

import { getSSMSecret } from './ssm.js';

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
});
