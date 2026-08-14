# `platform/webhooks/`

Event registry, `IEventBus`, HMAC signer, deliverer (retries/DLQ), replay
(PLUGFORGE.MD §2.6, §2.1; Epic E3 — PF-300 through PF-306).

- `events.ts` (TRO-419 / PF-300) — the event registry: 8 event types
  (`document.created/updated/deleted`, `issue.created/assigned/status_changed`,
  `sprint.started/completed`), each with a Zod payload schema, keyed in a plain
  object (`eventRegistry.get(type)` / `.list()`) rather than a switch statement.
  Dependency-free (only `zod`) and does not import from elsewhere under
  `platform/`, same isolation rationale as `signer.ts`. Discovery findings
  (exact `properties` field names for issue state/assignee and sprint
  start/complete transitions) are recorded in the file's header comment and in
  the TRO-419 ticket comment.
- `signer.ts` (TRO-433 / PF-303) — HMAC `Ship-Signature` sign/verify.
- `eventBus.ts` (TRO-426 / PF-301) — `IEventBus` + `InProcessEventBus`: synchronous
  publish/subscribe, validated against `events.ts`'s registry.
- `secrets.ts` / `secretEncryption.ts` (TRO-431 / PF-302) — webhook signing-secret
  generation and AES-256-GCM encryption at rest.
- `clock.ts` (TRO-438 / PF-304) — the injectable `Clock` (`now(): number`,
  milliseconds) the deliverer takes as a dependency, plus `ManualClock` for
  deterministic tests. Distinct from `signer.ts`'s own `Clock` type, which
  returns unix seconds — see `clock.ts`'s header for why.
- `deliverer.ts` (TRO-438 / PF-304) — `IWebhookDeliverer` + `InMemoryWebhookDeliverer`:
  matches a published event against active `webhook_subscriptions` (by
  `event_type` and workspace), signs and POSTs via `signer.ts`, and persists
  every attempt to `webhook_deliveries` (migration 048). Retry schedule 1s/4s/
  16s/1m/5m/30m + jitter; 5xx/timeout retries, 4xx dead-letters immediately, 6
  failed attempts total → DLQ (`status = 'dead'`). `rehydrate()` restores
  outstanding attempts into a fresh instance after a crash/restart.
  `wireDelivererToEventBus()` subscribes it to an `IEventBus`. Replay
  (`POST /:id/replay`) is PF-306, not yet built.
