/**
 * TRO-276 / ERR-10 — last-resort process-level error handling.
 *
 * The real availability fix for ERR-10 is the try/catch at the WebSocket frame
 * handlers in `api/src/collaboration/index.ts`: that is what stops a known,
 * attacker-reachable, one-byte input from ending the process. This file is the
 * safety net underneath it, for genuinely unknown bugs.
 *
 * Why it EXITS rather than continuing
 * -----------------------------------
 * A handler that logs and carries on is its own hazard. By the time
 * `uncaughtException` fires, the exception has escaped every guard in the
 * application, so nothing is known about the state it left behind — a half-applied
 * Yjs transaction, a module-level Map holding an entry whose invariants no longer
 * hold, an in-flight flag that gates a security sweep and is now stuck. Node's own
 * guidance is that resuming after an uncaught exception leaves the process in an
 * undefined state. Trading a fast restart for an indefinitely wrong one is a bad
 * trade, and a *silently* wrong server is harder to diagnose than a dead one.
 *
 * Exiting is also not a regression in availability, which is the decisive point:
 * today, with no handler installed at all, Node already terminates the process on
 * an uncaught exception, and (since Node 15) on an unhandled rejection too. This
 * handler cannot make the process die more often than it already does. What it
 * changes is everything around the death: full structured context instead of a
 * bare stack, new connections refused before the exit so the load balancer sees it,
 * a bounded window for in-flight requests, and a deliberate non-zero exit code for
 * the supervisor. `Dockerfile:75` runs `node dist/index.js` as the container's
 * command, so a non-zero exit is a container restart.
 *
 * `unhandledRejection` is routed to the same path for the same reason: Node's
 * default has been `--unhandled-rejections=throw` since v15, so an unhandled
 * rejection is already a process kill today. Installing a listener takes ownership
 * of that decision and makes it observable rather than changing it.
 *
 * The corollary, stated plainly so it is not mistaken later: this file does not
 * make Ship more available. It makes failures legible. Availability comes from
 * guarding the handlers that touch untrusted input.
 */

/** How long in-flight work gets before the process is ended. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/** Minimal shape of an http.Server, so tests can pass a stub. */
export interface DrainableServer {
  close(callback?: (err?: Error) => void): unknown;
}

/** Injection seam for tests; defaults to the real `process`. */
export type SafetyNetListener = (...args: unknown[]) => void;

/**
 * The slice of `process` this module uses. Deliberately structural and minimal so
 * the real `process` satisfies it directly — no cast at the call site, and a test
 * double has to implement only what is genuinely used.
 */
export interface SafetyNetTarget {
  on(event: string, listener: SafetyNetListener): unknown;
  off(event: string, listener: SafetyNetListener): unknown;
  exit(code: number): unknown;
}

/**
 * What this module needs from a logger. `console` satisfies it, and so does a
 * recording fake — without either side needing a cast, which is the point:
 * `Pick<Console, 'error'>` forced one because its signature is `(...data: any[])`.
 */
export interface FatalLogger {
  error(message: string, meta?: unknown): void;
}

export interface ProcessSafetyNetOptions {
  /**
   * HTTP server to stop accepting new connections on before exiting. Optional:
   * without it the process still logs and exits, it just cannot refuse new work
   * on the way out.
   */
  server?: DrainableServer;
  /** Hard cap on the drain window. */
  drainTimeoutMs?: number;
  target?: SafetyNetTarget;
  logger?: FatalLogger;
}

/**
 * Install `uncaughtException` / `unhandledRejection` handlers.
 * Returns an uninstall function (used by tests and by any future shutdown path).
 */
export function installProcessSafetyNet(options: ProcessSafetyNetOptions = {}): () => void {
  const {
    server,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    target = process,
    logger = console,
  } = options;

  let shuttingDown = false;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    target.exit(code);
  };

  const fatal = (kind: 'uncaughtException' | 'unhandledRejection', error: unknown, detail?: unknown): void => {
    if (shuttingDown) {
      // A second fatal while draining. The drain path itself may be what is
      // failing, so stop trying to be graceful.
      logger.error(`[FATAL] ${kind} during shutdown; exiting immediately`, {
        error: serializeError(error),
      });
      exitOnce(1);
      return;
    }
    shuttingDown = true;

    logger.error(`[FATAL] ${kind} — draining and exiting`, {
      kind,
      error: serializeError(error),
      detail: detail === undefined ? undefined : String(detail),
      pid: typeof process !== 'undefined' ? process.pid : undefined,
      uptimeSeconds: typeof process !== 'undefined' ? Math.round(process.uptime()) : undefined,
      timestamp: new Date().toISOString(),
      drainTimeoutMs,
    });

    // Stop accepting new connections at once. Note that `server.close()` waits
    // for every existing connection to end, and open WebSockets do not end on
    // their own — so in this process the timeout below, not this callback, is
    // the normal path to exit. Calling it is still worth it: it closes the
    // listening socket immediately, so no new work arrives during the window.
    try {
      server?.close(() => exitOnce(1));
    } catch (closeErr) {
      logger.error('[FATAL] server.close() failed during shutdown', { error: serializeError(closeErr) });
    }

    // Deliberately not unref()'d: this timer must fire.
    setTimeout(() => exitOnce(1), drainTimeoutMs);
  };

  const onUncaughtException: SafetyNetListener = (error, origin) => fatal('uncaughtException', error, origin);
  const onUnhandledRejection: SafetyNetListener = (reason) => fatal('unhandledRejection', reason);

  target.on('uncaughtException', onUncaughtException);
  target.on('unhandledRejection', onUnhandledRejection);

  return () => {
    target.off('uncaughtException', onUncaughtException);
    target.off('unhandledRejection', onUnhandledRejection);
  };
}

/**
 * Structured, JSON-safe rendering of a thrown value.
 *
 * The stack is included but explicitly flagged as unreliable: lib0 — the decoder
 * behind the ERR-10 crashes — builds its errors as module-scope singletons whose
 * stack is captured at module *load*, so the trace points at whatever first
 * imported lib0 rather than at the throw site. An earlier ticket chased the wrong
 * file for exactly this reason.
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      stackCaveat: 'some library errors (lib0) are module-scope singletons; the stack may not be the throw site',
    };
  }
  return { name: typeof error, message: String(error) };
}
