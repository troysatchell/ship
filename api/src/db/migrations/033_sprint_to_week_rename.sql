-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values
-- PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE
--
-- Guarded, because schema.sql:100 declares document_type with the post-rename
-- labels already present. On a database created from schema.sql the old labels
-- do not exist and the bare ALTER fails with
--   "sprint_plan" is not an existing enum label
-- Each rename runs only when the old label is present and the new one is not.
DO $$
DECLARE
  rename_pair TEXT[];
BEGIN
  FOREACH rename_pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['sprint_plan',   'weekly_plan'],
    ARRAY['sprint_retro',  'weekly_retro'],
    ARRAY['sprint_review', 'weekly_review']
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'document_type' AND e.enumlabel = rename_pair[1]
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'document_type' AND e.enumlabel = rename_pair[2]
    ) THEN
      EXECUTE format(
        'ALTER TYPE document_type RENAME VALUE %L TO %L',
        rename_pair[1], rename_pair[2]
      );
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
