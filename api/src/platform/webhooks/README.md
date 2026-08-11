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
- `IEventBus`, deliverer, DLQ, replay — not yet built (PF-301/PF-304/PF-306).
