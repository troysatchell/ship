import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  installProcessSafetyNet,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type SafetyNetTarget,
  type FatalLogger,
} from '../process-safety.js'

/**
 * TRO-276 / ERR-10 — the process-level safety net.
 *
 * The frame guards in api/src/collaboration/index.ts are the availability fix;
 * this is the last resort under them. What it must do is narrow and testable:
 * take ownership of `uncaughtException` / `unhandledRejection`, log them with
 * enough context to diagnose, stop accepting new connections, and end the
 * process with a non-zero code rather than continuing on unknown state.
 *
 * The real `process` is never touched here — a fake target is injected, which is
 * exactly why `installProcessSafetyNet` accepts one.
 *
 * The drain is driven with vitest's fake timers rather than by sleeping. That is
 * not just faster: advancing the clock deliberately is what lets the "exits
 * exactly once" case prove an *absence* — no second exit after the window
 * elapses — which no amount of real waiting can establish.
 */

/** A stand-in for `process`: an EventEmitter plus a recording exit(). */
class FakeProcess extends EventEmitter implements SafetyNetTarget {
  readonly exitCodes: number[] = []
  exit(code: number): void {
    this.exitCodes.push(code)
  }
}

interface LoggedCall {
  message: string
  meta?: unknown
}

/** A recording logger. Implements FatalLogger directly, so no cast is involved. */
function makeLogger(): { calls: LoggedCall[]; logger: FatalLogger } {
  const calls: LoggedCall[] = []
  return {
    calls,
    logger: {
      error(message: string, meta?: unknown) {
        calls.push({ message, meta })
      },
    },
  }
}

describe('installProcessSafetyNet (TRO-276 / ERR-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers handlers for both fatal event types and removes them on uninstall', () => {
    const target = new FakeProcess()

    expect(
      target.listenerCount('uncaughtException'),
      'nothing should be listening before install'
    ).toBe(0)

    const uninstall = installProcessSafetyNet({ target, logger: makeLogger().logger })

    // Both matter. Node terminates on an uncaught exception when nothing is
    // listening, and since v15 it does the same for an unhandled rejection.
    expect(target.listenerCount('uncaughtException')).toBe(1)
    expect(target.listenerCount('unhandledRejection')).toBe(1)

    uninstall()

    expect(target.listenerCount('uncaughtException')).toBe(0)
    expect(target.listenerCount('unhandledRejection')).toBe(0)
  })

  it('logs an uncaught exception with the error name, message and stack', () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    installProcessSafetyNet({ target, logger })

    target.emit('uncaughtException', new RangeError('Invalid typed array length: 5'), 'uncaughtException')

    expect(calls, 'the fatal must be logged, not swallowed').toHaveLength(1)
    expect(calls[0]).toMatchObject({
      message: expect.stringContaining('uncaughtException'),
      meta: {
        kind: 'uncaughtException',
        error: {
          name: 'RangeError',
          message: 'Invalid typed array length: 5',
          // The stack is captured for diagnosis but explicitly flagged as
          // unreliable: lib0 — the decoder behind the ERR-10 crashes — builds its
          // errors as module-scope singletons whose stack is captured at import
          // time, so the trace is not the throw site. An earlier ticket chased the
          // wrong file for exactly this reason, so the caveat travels with the log.
          stack: expect.any(String),
          stackCaveat: expect.any(String),
        },
        timestamp: expect.any(String),
      },
    })
  })

  it('stops accepting new connections and exits non-zero after the drain window', () => {
    const target = new FakeProcess()
    const close = vi.fn()
    const drainTimeoutMs = 5_000
    installProcessSafetyNet({ target, logger: makeLogger().logger, server: { close }, drainTimeoutMs })

    target.emit('uncaughtException', new Error('Unexpected end of array'))

    // `server.close()` waits for every existing connection to end, and open
    // WebSockets never do — so the timeout, not the close callback, is the normal
    // path to exit in this process.
    expect(close, 'the listening socket must be closed so no new work arrives during the drain').toHaveBeenCalledTimes(1)
    expect(target.exitCodes, 'the exit must not be immediate — in-flight work gets the drain window').toEqual([])

    vi.advanceTimersByTime(drainTimeoutMs - 1)
    expect(target.exitCodes, 'the drain window must actually be honoured').toEqual([])

    vi.advanceTimersByTime(1)
    expect(
      target.exitCodes,
      'a process that has lost track of its own state must end, and with a non-zero code so the supervisor restarts it'
    ).toEqual([1])
  })

  it('exits as soon as the drain completes rather than always waiting out the window', () => {
    const target = new FakeProcess()
    installProcessSafetyNet({
      target,
      logger: makeLogger().logger,
      server: { close: (callback?: () => void) => callback?.() },
      drainTimeoutMs: 10_000,
    })

    target.emit('uncaughtException', new Error('boom'))

    expect(target.exitCodes).toEqual([1])
  })

  it('exits exactly once even when the drain window elapses after a completed drain', () => {
    const target = new FakeProcess()
    const drainTimeoutMs = 5_000
    installProcessSafetyNet({
      target,
      logger: makeLogger().logger,
      server: { close: (callback?: () => void) => callback?.() },
      drainTimeoutMs,
    })

    target.emit('uncaughtException', new Error('boom'))
    expect(target.exitCodes).toEqual([1])

    // Run the clock past the drain timer that is still pending. A double exit
    // would mask the first exit code.
    vi.advanceTimersByTime(drainTimeoutMs * 2)
    expect(target.exitCodes).toEqual([1])
  })

  it('abandons the drain if a second fatal arrives while shutting down', () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    installProcessSafetyNet({
      target,
      logger,
      server: { close: () => { /* never completes */ } },
      drainTimeoutMs: 10_000,
    })

    target.emit('uncaughtException', new Error('first'))
    expect(target.exitCodes).toEqual([])

    // The drain path itself may be what is failing; stop being graceful.
    target.emit('uncaughtException', new Error('second'))

    expect(target.exitCodes, 'a second fatal during shutdown must exit immediately').toEqual([1])
    expect(calls, 'both fatals must be logged').toHaveLength(2)
    expect(calls[1]).toMatchObject({
      message: expect.stringContaining('during shutdown'),
      meta: { error: { message: 'second' } },
    })
  })

  it('treats an unhandled rejection as fatal on the same path', () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    const close = vi.fn()
    const drainTimeoutMs = 5_000
    installProcessSafetyNet({ target, logger, server: { close }, drainTimeoutMs })

    // Node's default has been --unhandled-rejections=throw since v15, so this
    // already kills the process today. Owning it changes the diagnostics, not the
    // outcome.
    target.emit('unhandledRejection', new Error('rejected'), Promise.resolve())

    expect(calls[0]).toMatchObject({
      message: expect.stringContaining('unhandledRejection'),
      meta: { kind: 'unhandledRejection', error: { message: 'rejected' } },
    })
    expect(close).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(drainTimeoutMs)
    expect(target.exitCodes).toEqual([1])
  })

  it('logs a non-Error rejection value instead of dropping it', () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    installProcessSafetyNet({ target, logger })

    target.emit('unhandledRejection', 'a bare string rejection', Promise.resolve())

    expect(calls[0]).toMatchObject({
      meta: { error: { message: 'a bare string rejection' } },
    })
  })

  it('defaults the drain window to a bounded, non-zero value', () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(
      DEFAULT_DRAIN_TIMEOUT_MS,
      'an unbounded drain would leave a process in undefined state running indefinitely'
    ).toBeLessThanOrEqual(30_000)
  })
})
