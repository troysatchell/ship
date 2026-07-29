import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import {
  installProcessSafetyNet,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type SafetyNetTarget,
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
 * exactly why `installProcessSafetyNet` takes one.
 */

/** A stand-in for `process`: an EventEmitter plus a recording exit(). */
class FakeProcess extends EventEmitter implements SafetyNetTarget {
  readonly exitCodes: number[] = []
  exit(code: number): void {
    this.exitCodes.push(code)
  }
}

function makeLogger() {
  const calls: Array<{ message: string; meta: unknown }> = []
  return {
    calls,
    logger: {
      error: (message: string, meta?: unknown) => {
        calls.push({ message, meta })
      },
    } as unknown as Pick<Console, 'error'>,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('installProcessSafetyNet (TRO-276 / ERR-10)', () => {
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
    installProcessSafetyNet({ target, logger, drainTimeoutMs: 10_000 })

    const boom = new RangeError('Invalid typed array length: 5')
    target.emit('uncaughtException', boom, 'uncaughtException')

    expect(calls.length, 'the fatal must be logged, not swallowed').toBe(1)
    expect(calls[0]!.message).toContain('uncaughtException')

    const meta = calls[0]!.meta as Record<string, any>
    expect(meta.error.name).toBe('RangeError')
    expect(meta.error.message).toBe('Invalid typed array length: 5')
    expect(meta.error.stack, 'the stack must be captured for diagnosis').toBeTruthy()
    // The lib0 trap that sent an earlier ticket to the wrong file: decoding
    // errors are module-scope singletons whose stack is captured at import time.
    // The log has to say so, or the next reader chases the same ghost.
    expect(
      meta.error.stackCaveat,
      'the log must warn that the stack may not be the throw site'
    ).toBeTruthy()
    expect(meta.timestamp, 'a fatal log needs a timestamp').toBeTruthy()
  })

  it('stops accepting new connections and exits non-zero after the drain window', async () => {
    const target = new FakeProcess()
    const close = vi.fn()
    installProcessSafetyNet({
      target,
      logger: makeLogger().logger,
      // `server.close()` waits for every existing connection to end, and open
      // WebSockets never do — so the timeout, not the close callback, is the
      // normal path to exit in this process.
      server: { close },
      drainTimeoutMs: 30,
    })

    target.emit('uncaughtException', new Error('Unexpected end of array'))

    expect(close, 'the listening socket must be closed so no new work arrives during the drain').toHaveBeenCalledTimes(1)
    expect(target.exitCodes, 'the exit must not be immediate — in-flight work gets the drain window').toEqual([])

    await delay(120)

    expect(
      target.exitCodes,
      'a process that has lost track of its own state must end, and with a non-zero code so the supervisor restarts it'
    ).toEqual([1])
  })

  it('exits as soon as the drain completes rather than always waiting out the window', async () => {
    const target = new FakeProcess()
    installProcessSafetyNet({
      target,
      logger: makeLogger().logger,
      server: { close: (cb?: () => void) => cb?.() },
      drainTimeoutMs: 10_000,
    })

    target.emit('uncaughtException', new Error('boom'))

    expect(target.exitCodes).toEqual([1])
  })

  it('exits exactly once even when the drain window elapses after a completed drain', async () => {
    const target = new FakeProcess()
    installProcessSafetyNet({
      target,
      logger: makeLogger().logger,
      server: { close: (cb?: () => void) => cb?.() },
      drainTimeoutMs: 20,
    })

    target.emit('uncaughtException', new Error('boom'))
    await delay(80)

    expect(target.exitCodes, 'double exit would mask the first exit code').toEqual([1])
  })

  it('abandons the drain if a second fatal arrives while shutting down', async () => {
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
    expect(calls.length, 'both fatals must be logged').toBe(2)
    expect(calls[1]!.message).toContain('during shutdown')
  })

  it('treats an unhandled rejection as fatal on the same path', async () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    const close = vi.fn()
    installProcessSafetyNet({ target, logger, server: { close }, drainTimeoutMs: 30 })

    // Node's default has been --unhandled-rejections=throw since v15, so this
    // already kills the process today. Owning it changes the diagnostics, not
    // the outcome.
    target.emit('unhandledRejection', new Error('rejected'), Promise.resolve())

    expect(calls[0]!.message).toContain('unhandledRejection')
    expect(close).toHaveBeenCalledTimes(1)

    await delay(120)
    expect(target.exitCodes).toEqual([1])
  })

  it('logs a non-Error rejection value instead of dropping it', () => {
    const target = new FakeProcess()
    const { calls, logger } = makeLogger()
    installProcessSafetyNet({ target, logger, drainTimeoutMs: 10_000 })

    target.emit('unhandledRejection', 'a bare string rejection', Promise.resolve())

    const meta = calls[0]!.meta as Record<string, any>
    expect(meta.error.message).toBe('a bare string rejection')
  })

  it('defaults the drain window to a bounded, non-zero value', () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(
      DEFAULT_DRAIN_TIMEOUT_MS,
      'an unbounded drain would leave a process in undefined state running indefinitely'
    ).toBeLessThanOrEqual(30_000)
  })
})
