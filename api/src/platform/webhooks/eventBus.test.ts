/**
 * `IEventBus` / `InProcessEventBus` unit tests (TRO-426 / PF-301).
 *
 * Pure unit tests — no database, no HTTP — since the bus itself has no I/O.
 * `documentService.test.ts` and `routes/issues.test.ts` cover the bus wired up
 * to real document writes; this file covers the bus's own contract in
 * isolation: synchronous in-order dispatch, subscribe/unsubscribe, and that a
 * payload failing its registry schema throws instead of silently delivering.
 */
import { describe, it, expect } from 'vitest'
import { InProcessEventBus, type EventEnvelope } from './eventBus.js'

describe('InProcessEventBus (TRO-426 / PF-301)', () => {
  it('dispatches synchronously to a subscribed handler with a valid envelope', () => {
    const bus = new InProcessEventBus()
    const received: EventEnvelope[] = []
    bus.subscribe('document.created', (event) => {
      received.push(event)
    })

    const workspaceId = '11111111-1111-1111-1111-111111111111'
    const envelope = bus.publish('document.created', workspaceId, {
      id: '22222222-2222-2222-2222-222222222222',
      document_type: 'wiki',
      title: 'Test Doc',
      created_by: null,
    })

    // Synchronous: the handler already ran by the time publish() returns —
    // no next-tick, no microtask queue involved.
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(envelope)
    expect(envelope.type).toBe('document.created')
    expect(envelope.workspace_id).toBe(workspaceId)
    expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => new Date(envelope.created_at).toISOString()).not.toThrow()
  })

  it('calls every subscriber for the type, in subscription order', () => {
    const bus = new InProcessEventBus()
    const order: string[] = []
    bus.subscribe('document.deleted', () => order.push('first'))
    bus.subscribe('document.deleted', () => order.push('second'))

    bus.publish('document.deleted', '11111111-1111-1111-1111-111111111111', {
      id: '22222222-2222-2222-2222-222222222222',
      document_type: 'issue',
    })

    expect(order).toEqual(['first', 'second'])
  })

  it('does not call a handler subscribed to a different event type', () => {
    const bus = new InProcessEventBus()
    let called = false
    bus.subscribe('issue.created', () => {
      called = true
    })

    bus.publish('document.deleted', '11111111-1111-1111-1111-111111111111', {
      id: '22222222-2222-2222-2222-222222222222',
      document_type: 'issue',
    })

    expect(called).toBe(false)
  })

  it('unsubscribe stops further delivery to that handler', () => {
    const bus = new InProcessEventBus()
    const received: EventEnvelope[] = []
    const unsubscribe = bus.subscribe('document.deleted', (event) => {
      received.push(event)
    })

    bus.publish('document.deleted', '11111111-1111-1111-1111-111111111111', {
      id: '22222222-2222-2222-2222-222222222222',
      document_type: 'issue',
    })
    unsubscribe()
    bus.publish('document.deleted', '11111111-1111-1111-1111-111111111111', {
      id: '33333333-3333-3333-3333-333333333333',
      document_type: 'issue',
    })

    expect(received).toHaveLength(1)
  })

  it('throws instead of delivering when the payload fails the registry schema', () => {
    const bus = new InProcessEventBus()
    let called = false
    bus.subscribe('document.updated', () => {
      called = true
    })

    // `changed_fields` requires at least one entry per events.ts's schema.
    expect(() =>
      bus.publish('document.updated', '11111111-1111-1111-1111-111111111111', {
        id: '22222222-2222-2222-2222-222222222222',
        document_type: 'issue',
        title: 'Bad payload',
        changed_fields: [],
      })
    ).toThrow(/failed schema validation/)
    expect(called).toBe(false)
  })

  it('throws on a no-op issue.status_changed payload (state === previous_state)', () => {
    const bus = new InProcessEventBus()
    expect(() =>
      bus.publish('issue.status_changed', '11111111-1111-1111-1111-111111111111', {
        id: '22222222-2222-2222-2222-222222222222',
        state: 'in_progress',
        previous_state: 'in_progress',
      })
    ).toThrow(/failed schema validation/)
  })
})
