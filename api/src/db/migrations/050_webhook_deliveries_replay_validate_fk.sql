-- Migration 050: validate webhook_deliveries.replayed_from_id's FK (PF-306 / TRO-446)
--
-- Migration 049 added the FK as NOT VALID (CodeRabbit, PR #229's review) to
-- avoid a validated-add's table scan + SHARE ROW EXCLUSIVE lock. This
-- migration completes the standard two-step pattern: VALIDATE CONSTRAINT
-- only needs SHARE UPDATE EXCLUSIVE, which is compatible with concurrent
-- reads and writes. Runs in its own migration/transaction (not folded into
-- 049) so the two lock profiles stay genuinely separate, matching Postgres's
-- own documented reason for splitting them.
ALTER TABLE webhook_deliveries
  VALIDATE CONSTRAINT webhook_deliveries_replayed_from_id_fkey;
