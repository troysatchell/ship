-- Migration 049: webhook_deliveries.replayed_from_id (PF-306 / TRO-446)
--
-- `POST /api/v1/webhooks/deliveries/:id/replay` creates a NEW delivery row
-- rather than mutating the original (this ticket's own AC — the delivery log
-- must show both the original and the replay as distinct rows). Migration
-- 048's own header already named this exact need: "Replay/dedup lookup index
-- (PF-306, not built by this ticket): resolving every attempt row for a
-- given event ... filters by event_id" — checked fresh before writing this
-- file (`ls api/src/db/migrations/ | sort -V | tail -5`, same renumbering
-- discipline every migration in this table's neighborhood documents in its
-- own header): no `replayed_from_id` or equivalent column exists yet on
-- `webhook_deliveries`, so this migration adds the minimal one.
--
-- Self-referential, nullable FK: NULL for every row created by the normal
-- enqueueEvent()/attempt() pipeline (a fresh delivery, or one of its own
-- automatic retries) — non-NULL ONLY for a row created by the replay route,
-- pointing at the delivery it replayed. `ON DELETE SET NULL` (not CASCADE):
-- losing the link if the original row is ever removed by a future retention
-- ticket is acceptable; losing the replay row itself — a real record of what
-- was actually sent to the subscriber — is not. This mirrors
-- `webhook_deliveries.subscription_id`'s own CASCADE choice being the
-- opposite for the opposite reason (deleting a subscription IS meant to take
-- its delivery history with it; deleting one delivery row is not meant to
-- take an unrelated replay row with it).
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS replayed_from_id UUID REFERENCES webhook_deliveries(id) ON DELETE SET NULL;

-- Lookup index: "show me every replay of this delivery" (a future delivery-
-- log UI grouping replays under their original) filters by this column.
-- Partial (`WHERE replayed_from_id IS NOT NULL`) for the same reason
-- migration 048's own `idx_webhook_deliveries_pending_id` is partial — the
-- vast majority of rows will have a NULL value (only replay rows don't), so
-- indexing just the non-NULL subset is cheap and matches the actual query
-- shape (nobody ever searches for "every row with a NULL replayed_from_id"
-- through this index; that would be most of the table).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_replayed_from_id
  ON webhook_deliveries (replayed_from_id) WHERE replayed_from_id IS NOT NULL;
