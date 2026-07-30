-- db-query-audit COMPARE (phase2-jul30): EXPLAIN ANALYZE of the CURRENT query shapes for
-- the same five statements baseline's audit/db-query/raw/explain.sql examined, run against
-- this worktree's byte-identical seeded dataset (500 docs / 20 users / 813 associations).
-- Params: workspace fe82ac70-ee0b-4bb7-af44-5ba0a4abdbe0, user 750c43f9-a503-45be-a852-6f4a82d17b35
--         (dev@ship.local, is_super_admin = TRUE).
--
-- Q1 and Q4's SQL TEXT differs from baseline's explain.sql on purpose: those are the
-- current, fixed query shapes (DB-5 dropped d.content from the issues list projection;
-- DB-6 replaced 3 correlated has_retro/retro_outcome/retro_id subqueries with one LATERAL
-- join), copied verbatim from api/src/routes/issues.ts and api/src/routes/weeks.ts. Q2
-- (documents unfiltered list) and Q6 (session lookup) are unchanged code paths, included
-- as an apples-to-apples control. Q3 replaces baseline's `= ANY($1)` batch with the current
-- `VALUES (...) JOIN` rewrite (DB-8), using the same 20-id realistic-page-size batch the
-- PR's own measurement used.

\echo '################ Q1  GET /api/issues  (CURRENT list query - DB-5: d.content dropped)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT d.id, d.title, d.properties, d.ticket_number,
       d.created_at, d.updated_at, d.created_by,
       d.started_at, d.completed_at, d.cancelled_at, d.reopened_at,
       d.converted_from_id,
       u.name as assignee_name,
       CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived
FROM documents d
LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
     AND person_doc.document_type = 'person'
     AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'
WHERE d.workspace_id = 'fe82ac70-ee0b-4bb7-af44-5ba0a4abdbe0'
  AND d.document_type = 'issue'
  AND (d.visibility = 'workspace' OR d.created_by = '750c43f9-a503-45be-a852-6f4a82d17b35' OR TRUE = TRUE)
  AND d.archived_at IS NULL AND d.deleted_at IS NULL
ORDER BY CASE d.properties->>'priority' WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         d.updated_at DESC;

\echo '################ Q2  GET /api/documents  (unfiltered document list - UNCHANGED shape, control)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT id, workspace_id, document_type, title, parent_id, position, ticket_number, properties,
       created_at, updated_at, created_by, visibility
FROM documents
WHERE workspace_id = 'fe82ac70-ee0b-4bb7-af44-5ba0a4abdbe0'
  AND archived_at IS NULL AND deleted_at IS NULL
  AND (visibility = 'workspace' OR created_by = '750c43f9-a503-45be-a852-6f4a82d17b35' OR TRUE = TRUE)
ORDER BY position ASC, created_at DESC;

\echo '################ Q3  association batch (CURRENT - DB-8: VALUES join replacing = ANY)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT da.document_id, da.related_id as id, da.relationship_type as type, d.title,
       d.properties->>'color' as color
FROM (VALUES
  ('550a5fd7-ead6-4260-bda1-2409ae6229b0'::uuid), ('fa94d116-5972-4486-b800-9f0ff8b6c7cb'::uuid),
  ('a26c44a3-ac8a-47ee-aba2-e7035855e8f5'::uuid), ('b94ad745-a996-43e6-8674-6ac3a39fad15'::uuid),
  ('c687dad2-3d40-4042-aeb4-10e1171ade0d'::uuid), ('afb64eab-e1e1-4f82-9dac-85c7deec9fd9'::uuid),
  ('a13d3ad2-fa6a-4572-b0a5-fee632c31098'::uuid), ('7dc26fe5-a500-4058-8907-271acaa522c1'::uuid),
  ('55424b8c-c14a-42c8-b833-e1b3ef004963'::uuid), ('d1bcabd2-2656-4917-9205-13a3e392eb1c'::uuid),
  ('5a7d96f2-3687-495f-90e5-3422ac99ec30'::uuid), ('5354527b-3424-4418-885f-b39ce0bb3d7b'::uuid),
  ('16f3aa9f-e6a3-4a52-8055-6d3dcdfa81b7'::uuid), ('cf188cf4-9104-48a3-8391-ffd32bcc7f7a'::uuid),
  ('4ef64793-687e-434b-bdd5-678aaf1f3d52'::uuid), ('d4d3970c-0c28-481d-b405-31626a9d4d78'::uuid),
  ('0d332af3-c8f8-412b-be3c-590dc7800b2f'::uuid), ('b320a9a2-7819-4723-945f-4d70defbd114'::uuid),
  ('598c6933-d12f-4aa6-a02c-977ed267336f'::uuid), ('b1259b33-a6d6-4ab6-a0a6-d681373106b4'::uuid)
) AS ids(document_id)
JOIN document_associations da ON da.document_id = ids.document_id
LEFT JOIN documents d ON da.related_id = d.id
ORDER BY da.document_id, da.relationship_type, da.created_at;

\echo '################ Q4  GET /api/weeks  (CURRENT - DB-6: LATERAL join replacing 3 correlated subqueries)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT d.id, d.title, d.properties, prog_da.related_id as program_id,
  p.title as program_name, p.properties->>'prefix' as program_prefix,
  p.properties->>'accountable_id' as program_accountable_id,
  (SELECT op.properties->>'reports_to' FROM documents op WHERE d.properties->>'owner_id' IS NOT NULL AND op.id = (d.properties->>'owner_id')::uuid AND op.document_type = 'person' AND op.workspace_id = d.workspace_id) as owner_reports_to,
  '2026-04-27 00:00:00'::timestamp as workspace_sprint_start_date,
  u.id as owner_id, u.name as owner_name, u.email as owner_email,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue') as issue_count,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue' AND i.properties->>'state' = 'done') as completed_count,
  (SELECT COUNT(*) FROM documents i JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint' WHERE i.document_type = 'issue' AND i.properties->>'state' IN ('in_progress','in_review')) as started_count,
  (SELECT COUNT(*) > 0 FROM documents pl WHERE pl.parent_id = d.id AND pl.document_type = 'weekly_plan') as has_plan,
  (retro.id IS NOT NULL) as has_retro,
  retro.outcome as retro_outcome,
  retro.id as retro_id
FROM documents d
LEFT JOIN document_associations prog_da ON prog_da.document_id = d.id AND prog_da.relationship_type = 'program'
LEFT JOIN documents p ON prog_da.related_id = p.id
LEFT JOIN LATERAL (
  SELECT MAX(rt.id::text)::uuid AS id, MAX(rt.properties->>'outcome') AS outcome
  FROM document_associations rda
  JOIN documents rt ON rt.id = rda.document_id
  WHERE rda.related_id = d.id AND rda.relationship_type = 'sprint'
    AND rt.properties->>'outcome' IS NOT NULL
) retro ON true
LEFT JOIN users u ON (d.properties->'assignee_ids'->>0)::uuid = u.id
WHERE d.workspace_id = 'fe82ac70-ee0b-4bb7-af44-5ba0a4abdbe0'
  AND d.document_type = 'sprint'
  AND (d.properties->>'sprint_number')::int = 14
  AND (d.visibility = 'workspace' OR d.created_by = '750c43f9-a503-45be-a852-6f4a82d17b35' OR TRUE = TRUE)
ORDER BY (d.properties->>'sprint_number')::int, p.title;

\echo '################ Q5  GET /api/issues/by-ticket/:number  (DB-7: ticket_number index)'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT d.id, d.title, d.properties, d.ticket_number, d.content,
       d.created_at, d.updated_at, d.created_by,
       d.started_at, d.completed_at, d.cancelled_at, d.reopened_at,
       d.converted_to_id, d.converted_from_id,
       u.name as assignee_name,
       CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived,
       creator.name as created_by_name
FROM documents d
LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
  AND person_doc.document_type = 'person'
  AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'
LEFT JOIN users creator ON d.created_by = creator.id
WHERE d.ticket_number = 1 AND d.workspace_id = 'fe82ac70-ee0b-4bb7-af44-5ba0a4abdbe0' AND d.document_type = 'issue'
  AND (d.visibility = 'workspace' OR d.created_by = '750c43f9-a503-45be-a852-6f4a82d17b35' OR TRUE = TRUE);

\echo '################ Q6  auth middleware session lookup (UNCHANGED, runs on every request)'
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
