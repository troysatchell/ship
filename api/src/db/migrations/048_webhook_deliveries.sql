-- Migration 048: webhook_deliveries (PF-304 / TRO-438)
--
-- PLUGFORGE.MD §2.6 lists this as migration "045", but that number was
-- consumed months ago (045_oauth_tokens_refresh_expiry.sql, PF-104). Renumbered
-- to the next available slot as of this ticket's dispatch (verified fresh via
-- `ls api/src/db/migrations/ | sort -V | tail -3` before writing this file:
-- 045/046/047 all taken) — same renumbering situation 046 and 047 already
-- document in their own headers for PF-105/PF-106/PF-302.
--
-- Row shape: **one row per delivery ATTEMPT**, not one row per logical
-- delivery updated in place — this is the literal reading of the ticket's own
-- "every attempt persisted" AC and its `attempt_number` column. A delivery
-- that retries 3 times before succeeding leaves 3 rows behind, all sharing the
-- same `idempotency_key` (the *original* delivery's identifier — see
-- docs/architecture.md's Webhook Pipeline section) and the same `event_id`,
-- distinguished by `attempt_number`.
--
-- Row lifecycle (`api/src/platform/webhooks/deliverer.ts` owns every
-- transition):
--   'pending' -> row inserted the moment an attempt is SCHEDULED (enqueue time
--     for attempt 1; immediately after a prior attempt fails-and-retries, for
--     attempt N+1). `next_attempt_at` is that attempt's due time.
--   'pending' -> 'success'  the attempt got a 2xx response. `next_attempt_at`
--     cleared to NULL; `response_status`/`response_excerpt`/`latency_ms` filled in.
--   'pending' -> 'failed'   the attempt got a 5xx/timeout AND a retry was
--     scheduled (a NEW sibling row, attempt_number+1, inserted as 'pending').
--     `next_attempt_at` on THIS row is left set to that sibling's due time —
--     informational for a future delivery-log/replay UI ("this failed, next
--     retry at ..."), not a live scheduling pointer once the row is terminal.
--   'pending' -> 'dead'     the attempt got a 4xx (permanent failure,
--     dead-lettered immediately, no retry scheduled regardless of
--     attempt_number) OR was the 6th failed attempt (DLQ). `next_attempt_at`
--     cleared to NULL.
-- 'pending' is therefore also the crash-recovery marker: a boot-time scan for
-- `status = 'pending'` rows (`InMemoryWebhookDeliverer.rehydrate()`) is what
-- survives a process restart — docs/architecture.md's "Deliverer crash"
-- section names this exact recovery as PF-304's own design intent.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  -- Not a FK: events (`platform/webhooks/eventBus.ts`'s `EventEnvelope`) are
  -- ephemeral — only their `id` travels past `IEventBus.publish()`, there is
  -- no `events` table for this to reference.
  event_id UUID NOT NULL,
  -- Plain TEXT, not CHECK-constrained against the 8-value enum — same
  -- deliberately-application-level validation call migration 047 already
  -- makes for `webhook_subscriptions.event_type` (zod against
  -- `platform/webhooks/events.ts`'s `EVENT_TYPES`), and for the identical
  -- "events as data" reason: a DB CHECK constraint here would be a second,
  -- migration-frozen copy of the same list.
  event_type TEXT NOT NULL,
  -- The exact event envelope this attempt sent (or would send, while still
  -- 'pending') — `JSON.stringify(EventEnvelope)`, one snapshot per attempt row
  -- even though the payload is identical across every attempt of the same
  -- delivery, so a delivery-log/replay feature never has to join back to a
  -- separate events table that does not exist.
  payload JSONB NOT NULL,
  -- Stable across every attempt row of the same logical delivery (assigned
  -- once, at enqueue time) — never regenerated on retry. Lets a subscriber's
  -- own dedupe logic recognize "this is the Nth attempt/replay of the SAME
  -- delivery," matching docs/architecture.md's "Idempotency-Key origin: the
  -- *original* delivery's identifier" and PF-306's future replay endpoint
  -- reusing this same value.
  idempotency_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'dead')),
  response_status INTEGER,
  response_excerpt TEXT,
  latency_ms INTEGER,
  next_attempt_at TIMESTAMPTZ,
  -- NOT NULL, same stricter-than-042/043 precedent 047 already sets for its
  -- own created_at (every row this ticket's code reads back is typed as a
  -- non-nullable Date) — this is a brand-new table with no legacy rows.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK-lookup / per-subscription delivery-log index — same convention as
-- idx_webhook_subscriptions_app_id (migration 047).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_id ON webhook_deliveries (subscription_id);

-- Rehydration-query index: `InMemoryWebhookDeliverer.rehydrate()` scans
-- exactly this shape at boot ("which attempts were scheduled but never
-- executed before the process died"). Partial or full scan of every row would
-- both be correct, but this index is cheap to add now and the table is meant
-- to grow without bound (every attempt, forever, until a future retention
-- ticket).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending_next_attempt
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Replay/dedup lookup index (PF-306, not built by this ticket): resolving
-- every attempt row for a given event, or checking whether an event has
-- already been delivered to a subscription, filters by event_id far more
-- often than it scans a subscription's whole history.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_id ON webhook_deliveries (event_id);

-- Keyset-pagination index for a future delivery-log listing endpoint — same
-- (created_at DESC, id DESC) cursor shape as platform/api/v1/pagination.ts,
-- same precedent as idx_webhook_subscriptions_created_at_id (migration 047).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at_id ON webhook_deliveries (created_at DESC, id DESC);
