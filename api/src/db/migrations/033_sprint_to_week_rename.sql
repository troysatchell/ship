-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values
-- PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE
--
-- Guarded, because schema.sql:100 declares document_type with the post-rename
-- labels already present. On a database created from schema.sql the old labels
-- do not exist and the bare ALTER fails with
--   "sprint_plan" is not an existing enum label
--
-- Four states, three of them acted on:
--
--   old present, new absent   -> rename (a genuine pre-033 database)
--   old absent,  new present  -> nothing to do, the rename already happened
--   old present, new present  -> the rename is impossible. This is NOT
--        automatically a fault: on a fresh database schema.sql declares
--        'weekly_review' and migration 017 then re-adds 'sprint_review' via
--        ADD VALUE IF NOT EXISTS, so both labels legitimately coexist by the
--        time this file runs. It is only dangerous if rows actually use the
--        old label, because then the value needs migrating and cannot be.
--        So: tolerate the empty case, RAISE on the one that would lose meaning.
--   neither present           -> the premise of this migration does not hold;
--        refuse rather than report success for work not done.
DO $$
DECLARE
  rename_pair TEXT[];
  old_label TEXT;
  new_label TEXT;
  old_present BOOLEAN;
  new_present BOOLEAN;
  stale_rows BIGINT;
BEGIN
  FOREACH rename_pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['sprint_plan',   'weekly_plan'],
    ARRAY['sprint_retro',  'weekly_retro'],
    ARRAY['sprint_review', 'weekly_review']
  ]
  LOOP
    old_label := rename_pair[1];
    new_label := rename_pair[2];

    SELECT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'document_type' AND e.enumlabel = old_label
    ) INTO old_present;

    SELECT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'document_type' AND e.enumlabel = new_label
    ) INTO new_present;

    IF old_present AND new_present THEN
      EXECUTE format(
        'SELECT count(*) FROM documents WHERE document_type::text = %L', old_label
      ) INTO stale_rows;

      IF stale_rows > 0 THEN
        RAISE EXCEPTION
          'document_type has both % and %, and % document(s) still use %. '
          'The rename cannot run and those rows would keep the retired value. '
          'Reassign them to % and re-run this migration.',
          old_label, new_label, stale_rows, old_label, new_label;
      END IF;

    ELSIF old_present THEN
      EXECUTE format(
        'ALTER TYPE document_type RENAME VALUE %L TO %L', old_label, new_label
      );

    ELSIF NOT new_present THEN
      RAISE EXCEPTION
        'document_type has neither % nor %; refusing to report success '
        'for a rename that cannot be verified.', old_label, new_label;
    END IF;
  END LOOP;
END
$$;

-- Note: We keep 'sprint' as a document_type because it represents the sprint document itself.
-- The terminology change is "Sprint 3" → "Week of Jan 27" in UI, but the underlying
-- document concept remains valid. The sprint document stores sprint_number and owner_id
-- for derived 7-day windows.

-- Update accountability_type values in issue properties
-- Sprint-related accountability types become week-related
UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_plan"')
WHERE properties->>'accountability_type' = 'sprint_plan';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_review"')
WHERE properties->>'accountability_type' = 'sprint_review';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_start"')
WHERE properties->>'accountability_type' = 'sprint_start';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_issues"')
WHERE properties->>'accountability_type' = 'sprint_issues';
