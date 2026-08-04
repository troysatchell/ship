-- Migration 041: add 'blocks' to relationship_type (FG-15 / TRO-333)
--
-- Ship's association types were only containment (parent | project | sprint |
-- program) — there was no way to express "issue A blocks issue B", a
-- dependency graph distinct from the containment tree. This is the first of
-- the four edits TRO-333 specifies; see that ticket's PM-review scope
-- amendment (2026-08-03) for why 'blocks' does NOT also get added to
-- shared/src/types/document.ts's BelongsToType — it is deliberately excluded
-- from the belongs_to (containment) concept.
--
-- Numbered 041, not 040 as TRO-333's own ticket body names it: TRO-332
-- (FG-14, cycle protection on document_associations) must land before this
-- migration per the bundle epic's stated internal order, and TRO-332 already
-- claimed 040. See CHANGES.md's TRO-332 entry for the explicit note.
--
-- Directional by construction: document_associations already has
-- document_id/related_id, so a single 'blocks' value is enough — document_id
-- blocks related_id. "Blocked by" is a reverse query (existing
-- /:id/reverse-associations endpoint), not a second enum value.
--
-- Pattern copied exactly from migration 017 (adding document_type enum
-- values): ALTER TYPE ... ADD VALUE IF NOT EXISTS wrapped in a DO block that
-- swallows duplicate_object, making this migration safe to re-run.
DO $$ BEGIN
  ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'blocks';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
