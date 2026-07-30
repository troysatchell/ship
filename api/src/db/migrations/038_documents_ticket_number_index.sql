-- DB-7: issue permalink lookups (GET /api/issues/by-ticket/:number) seq-scan
-- the whole documents table to find one row by ticket_number. Partial index
-- matches the route's exact predicate (workspace_id, ticket_number, WHERE
-- document_type = 'issue') so the planner can use an index scan instead of
-- reading every document in the workspace.
CREATE INDEX IF NOT EXISTS idx_documents_ticket_number
  ON documents (workspace_id, ticket_number)
  WHERE document_type = 'issue';
