-- db-query-audit baseline: EXPLAIN ANALYZE of the top-5 slowest statements captured in
-- audit/db-query/raw/pg-statements.log, with the real parameter values logged by Postgres.
-- Params: workspace e8d25b0f-a505-4636-97db-94c72f4e59be, user 2a56903a-3574-4f1b-8b72-7eba338f9f91,
--         isSuperAdmin = TRUE (dev@ship.local).
\echo '################ Q1  GET /api/issues  (api/src/routes/issues.ts list query)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT d.id, d.title, d.properties, d.ticket_number, d.content, d.created_at, d.updated_at,
       d.created_by, d.started_at, d.completed_at, d.cancelled_at, d.reopened_at, d.converted_from_id,
       u.name as assignee_name,
       CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived
FROM documents d
LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
     AND person_doc.document_type = 'person'
     AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'
WHERE d.workspace_id = 'e8d25b0f-a505-4636-97db-94c72f4e59be'
  AND d.document_type = 'issue'
  AND (d.visibility = 'workspace' OR d.created_by = '2a56903a-3574-4f1b-8b72-7eba338f9f91' OR TRUE = TRUE)
  AND d.archived_at IS NULL AND d.deleted_at IS NULL
ORDER BY CASE d.properties->>'priority' WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         d.updated_at DESC;

\echo '################ Q2  GET /api/documents  (unfiltered document list)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT id, workspace_id, document_type, title, parent_id, position, ticket_number, properties,
       created_at, updated_at, created_by, visibility
FROM documents
WHERE workspace_id = 'e8d25b0f-a505-4636-97db-94c72f4e59be'
  AND archived_at IS NULL AND deleted_at IS NULL
  AND (visibility = 'workspace' OR created_by = '2a56903a-3574-4f1b-8b72-7eba338f9f91' OR TRUE = TRUE)
ORDER BY position ASC, created_at DESC;

\echo '################ Q3  GET /api/issues  association batch (= ANY)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT da.document_id, da.related_id as id, da.relationship_type as type, d.title,
       d.properties->>'color' as color
FROM document_associations da
LEFT JOIN documents d ON da.related_id = d.id
WHERE da.document_id = ANY(
  ARRAY(SELECT id FROM documents WHERE workspace_id='e8d25b0f-a505-4636-97db-94c72f4e59be'
        AND document_type='issue' AND archived_at IS NULL AND deleted_at IS NULL)
)
ORDER BY da.document_id, da.relationship_type, da.created_at;

\echo '################ Q4  GET /api/weeks  (sprint aggregate, 6 correlated subqueries)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT d.id, d.title, d.properties, prog_da.related_id as program_id, p.title as program_name,
  p.properties->>'prefix' as program_prefix, p.properties->>'accountable_id' as program_accountable_id,
  (SELECT op.properties->>'reports_to' FROM documents op WHERE d.properties->>'owner_id' IS NOT NULL AND op.id = (d.properties->>'owner_id')::uuid AND op.document_type = 'person' AND op.workspace_id = d.workspace_id) as owner_reports_to,
  '2026-04-27 00:00:00'::timestamp as workspace_sprint_start_date,
  u.id as owner_id, u.name as owner_name, u.email as owner_email,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue') as issue_count,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue' AND i.properties->>'state' = 'done') as completed_count,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue' AND i.properties->>'state' IN ('in_progress','in_review')) as started_count,
  (SELECT COUNT(*) > 0 FROM documents pl WHERE pl.parent_id = d.id AND pl.document_type = 'weekly_plan') as has_plan,
  (SELECT COUNT(*) > 0 FROM documents rt JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint' WHERE rt.properties->>'outcome' IS NOT NULL) as has_retro,
  (SELECT rt.properties->>'outcome' FROM documents rt JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint' WHERE rt.properties->>'outcome' IS NOT NULL LIMIT 1) as retro_outcome,
  (SELECT rt.id FROM documents rt JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint' WHERE rt.properties->>'outcome' IS NOT NULL LIMIT 1) as retro_id
FROM documents d
LEFT JOIN document_associations prog_da ON prog_da.document_id = d.id AND prog_da.relationship_type = 'program'
LEFT JOIN documents p ON prog_da.related_id = p.id
LEFT JOIN users u ON (d.properties->'assignee_ids'->>0)::uuid = u.id
WHERE d.workspace_id = 'e8d25b0f-a505-4636-97db-94c72f4e59be'
  AND d.document_type = 'sprint'
  AND (d.properties->>'sprint_number')::int = 14
  AND (d.visibility = 'workspace' OR d.created_by = '2a56903a-3574-4f1b-8b72-7eba338f9f91' OR TRUE = TRUE)
ORDER BY (d.properties->>'sprint_number')::int, p.title;

\echo '################ Q5  auth middleware session touch (rolled back)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS)
UPDATE sessions SET last_activity = now() WHERE id = (SELECT id FROM sessions LIMIT 1);
ROLLBACK;

\echo '################ Q6  auth middleware session lookup (runs on every request)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT s.id, s.user_id, s.workspace_id, s.expires_at, s.last_activity, s.created_at, u.is_super_admin
FROM sessions s JOIN users u ON s.user_id = u.id
WHERE s.id = (SELECT id FROM sessions LIMIT 1);

\echo '################ SIZE CONTEXT'
SELECT relname, n_live_tup,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname IN ('documents','document_associations','sessions','users')
ORDER BY n_live_tup DESC;

\echo '################ documents column bloat: content / yjs_state share'
SELECT
  pg_size_pretty(sum(pg_column_size(content))) AS content_bytes,
  pg_size_pretty(sum(pg_column_size(yjs_state))) AS yjs_bytes,
  pg_size_pretty(sum(pg_column_size(properties))) AS properties_bytes,
  pg_size_pretty(sum(pg_column_size(documents.*))) AS whole_row_bytes
FROM documents;
