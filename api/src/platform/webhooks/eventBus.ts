/**
 * `IEventBus` + in-process synchronous implementation (TRO-426 / PF-301).
 *
 * PLUGFORGE.MD §2.6 / §4 names this as part of the domain write path: "in-process
 * synchronous bus implementation." Read literally — synchronous, not "eventually
 * consistent via a queue." `publish()` builds the envelope, validates it against
 * `eventRegistry`'s Zod schema for that event type (the registry is the single
 * source of truth for shape — see `events.ts`), and calls every subscribed handler
 * in the same call stack, in subscription order. Handlers are typed as plain
 * synchronous functions (`(event) => void`), not `Promise`-returning, specifically
 * so "synchronous" is actually true end to end rather than "synchronous dispatch of
 * async work nobody awaits." A handler that needs to do async work (e.g. the future
 * PF-304 webhook deliverer) enqueues it — buffering/retry/DLQ is explicitly out of
 * scope here as PF-304/PF-306 (see `README.md` in this directory).
 *
 * A handler that throws is NOT caught here. That is deliberate for this ticket's
 * risk profile: `documentService` is the only caller of `publish()`, and a
 * subscriber unable to process an event (e.g. one whose payload it can't handle)
 * should fail the write loudly rather than have the bus swallow the error and leave
 * the caller believing the event was delivered. If a future ticket wants
 * best-effort fan-out (one bad subscriber must not break the others, or must not
 * break the write), that is an explicit design change to make there, not a default
 * to bake in silently here.
 *
 * Dependency-free apart from `events.ts` (this directory's own event registry) and
 * `node:crypto`, matching the isolation rationale `signer.ts` and `events.ts`
 * already document for this directory.
 */

import { randomUUID } from 'node:crypto'
import { eventRegistry, type EventType } from './events.js'

/** The envelope shape every event carries — mirrors `eventSchema()` in `events.ts`. */
export interface EventEnvelope<TData = unknown> {
  id: string
  type: EventType
  created_at: string
  workspace_id: string
  data: TData
}

/** A subscriber. Deliberately synchronous — see file header. */
export type EventHandler<TData = unknown> = (event: EventEnvelope<TData>) => void

/** Returned by `subscribe()`; call it to remove that one subscription. */
export type Unsubscribe = () => void

export interface IEventBus {
  /**
   * Builds the envelope, validates it against `eventRegistry.get(type).schema`,
   * dispatches synchronously to every current subscriber for `type`, and returns
   * the envelope that was dispatched. Throws if the assembled payload does not
   * match the registry's schema for `type` — a mismatch here means the caller
   * (`documentService`) built an invalid payload, which is a bug in the domain
   * write path, not a delivery failure.
   */
  publish<TData = unknown>(type: EventType, workspaceId: string, data: TData): EventEnvelope<TData>
  /** Registers `handler` for `type`. Returns an unsubscribe function. */
  subscribe<TData = unknown>(type: EventType, handler: EventHandler<TData>): Unsubscribe
}

export class InProcessEventBus implements IEventBus {
  private readonly handlersByType = new Map<EventType, Set<EventHandler>>()

  subscribe<TData = unknown>(type: EventType, handler: EventHandler<TData>): Unsubscribe {
    let handlers = this.handlersByType.get(type)
    if (!handlers) {
      handlers = new Set()
      this.handlersByType.set(type, handlers)
    }
    handlers.add(handler as EventHandler)
    return () => {
      handlers?.delete(handler as EventHandler)
    }
  }

  publish<TData = unknown>(type: EventType, workspaceId: string, data: TData): EventEnvelope<TData> {
    const envelope: EventEnvelope<TData> = {
      id: randomUUID(),
      type,
      created_at: new Date().toISOString(),
      workspace_id: workspaceId,
      data,
    }

    // Validate against the registry before dispatch — same envelope shape
    // `eventSchema()` builds in events.ts, so a payload that reaches a subscriber
    // is always one that matches its documented contract.
    const definition = eventRegistry.get(type)
    const result = definition.schema.safeParse(envelope)
    if (!result.success) {
      throw new Error(
        `eventBus.publish: payload for event type '${type}' failed schema validation: ${result.error.message}`
      )
    }

    const handlers = this.handlersByType.get(type)
    if (handlers) {
      // Snapshot before iterating: a handler that subscribes/unsubscribes during
      // dispatch must not mutate the Set being iterated.
      for (const handler of [...handlers]) {
        handler(envelope)
      }
    }

    return envelope
  }
}

// ─── Singleton accessors ─────────────────────────────────────────────────
//
// `documentService` (the only caller allowed to `publish()`, per this ticket's
// AC) reaches the bus through `getEventBus()` rather than importing a
// module-level instance directly, so tests can install an isolated bus
// (`setEventBusForTesting`) without one test's subscriptions leaking into
// another's — vitest does not reset ES module state between tests in the same
// file/process by default.

let activeBus: IEventBus = new InProcessEventBus()

/** The process-wide event bus. `documentService.ts` is the only production caller. */
export function getEventBus(): IEventBus {
  return activeBus
}

/** Test-only seam: install an isolated bus so subscriptions don't leak across tests. */
export function setEventBusForTesting(bus: IEventBus): void {
  activeBus = bus
}

/** Test-only seam: restore a fresh default bus (no subscribers). */
export function resetEventBusForTesting(): void {
  activeBus = new InProcessEventBus()
}
