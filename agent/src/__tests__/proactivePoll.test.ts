import { describe, expect, it, vi, afterEach } from 'vitest';
import { createProactivePoller } from '../proactivePoll.js';

describe('createProactivePoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bootstraps the first tick from initialLookbackMs when no cursor exists yet', async () => {
    const invoke = vi.fn().mockResolvedValue({ cursor: '2026-01-01T00:01:00.000Z' });
    const now = () => new Date('2026-01-02T00:00:00.000Z');
    const poller = createProactivePoller({
      graph: { invoke },
      intervalMs: 60_000,
      initialLookbackMs: 60 * 60 * 1000,
      now,
    });

    await poller.tick();

    expect(invoke).toHaveBeenCalledWith({ trigger: 'proactive_steady', cursor: '2026-01-01T23:00:00.000Z' });
    expect(poller.getCursor()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('carries the returned cursor forward into the next tick', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 'cursor-1' })
      .mockResolvedValueOnce({ cursor: 'cursor-2' });
    const poller = createProactivePoller({
      graph: { invoke },
      intervalMs: 60_000,
      initialLookbackMs: 1000,
    });

    await poller.tick();
    await poller.tick();

    expect(invoke).toHaveBeenNthCalledWith(2, { trigger: 'proactive_steady', cursor: 'cursor-1' });
    expect(poller.getCursor()).toBe('cursor-2');
  });

  it('a failed tick calls onError, keeps the process alive, and does not advance the cursor', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('ship unreachable'));
    const onError = vi.fn();
    const poller = createProactivePoller({
      graph: { invoke },
      intervalMs: 60_000,
      initialLookbackMs: 1000,
      onError,
    });

    await expect(poller.tick()).resolves.toBeUndefined(); // never throws out of tick()
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(poller.getCursor()).toBeUndefined();
  });

  it('the next tick after a failure retries from the SAME since value (no gap, no skip)', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({ cursor: 'cursor-1' });
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const poller = createProactivePoller({
      graph: { invoke },
      intervalMs: 60_000,
      initialLookbackMs: 1000,
      now,
      onError: () => {},
    });

    await poller.tick(); // fails
    await poller.tick(); // retries with the same bootstrapped `since`

    expect(invoke.mock.calls[0]?.[0]).toEqual(invoke.mock.calls[1]?.[0]);
  });

  it('start() schedules tick() on the configured interval', () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue({ cursor: 'c1' });
    const poller = createProactivePoller({ graph: { invoke }, intervalMs: 1000, initialLookbackMs: 1000 });

    const handle = poller.start();
    vi.advanceTimersByTime(3500);

    expect(invoke).toHaveBeenCalledTimes(3);
    clearInterval(handle);
  });
});
