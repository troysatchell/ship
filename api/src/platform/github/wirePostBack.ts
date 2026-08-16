/**
 * Wires `postStatusChangeComments` as an `IEventBus` subscriber for `issue.status_changed` (PF-804
 * / TRO-453) — the "Ship -> GitHub" direction's entry point, mirroring
 * `deliverer.ts`'s own `wireDelivererToEventBus` shape (fire-and-forget dispatch, one bad
 * subscriber must not break `publish()`'s synchronous loop for every other subscriber — see
 * `eventBus.ts`'s own header).
 *
 * `IEventBus` handlers are synchronous by contract (`eventBus.ts`: "A handler that needs to do
 * async work ... enqueues it") — this handler fires `postStatusChangeComments()` without awaiting
 * it, same as `wireDelivererToEventBus` does for `enqueueEvent()`.
 */

import type { Pool } from 'pg'
import type { IEventBus, EventEnvelope, Unsubscribe } from '../webhooks/eventBus.js'
import { postStatusChangeComments } from './postBackService.js'
import type { GithubAppCredentials } from './installationAuth.js'

interface IssueStatusChangedData {
  id: string
  state: string
  previous_state: string
}

export function wireGithubPostBack(
  bus: IEventBus,
  pool: Pool,
  credentials: GithubAppCredentials,
  onError: (error: unknown, event: EventEnvelope<IssueStatusChangedData>) => void = (error, event) => {
    console.error(`github post-back: failed to process issue.status_changed for issue ${event.data.id}`, error)
  }
): Unsubscribe {
  return bus.subscribe<IssueStatusChangedData>('issue.status_changed', (event) => {
    void postStatusChangeComments(pool, credentials, {
      issueId: event.data.id,
      state: event.data.state,
      previousState: event.data.previous_state,
    }).catch((error: unknown) => onError(error, event))
  })
}
