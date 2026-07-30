-- DB-10: no index backs `ORDER BY ... updated_at DESC`, used by list queries
-- in issues.ts, documents.ts, weeks.ts, projects.ts, programs.ts, dashboard.ts
-- and search.ts. Invisible at small row counts (an unsupported quicksort costs
-- microseconds), but it is exactly what makes `LIMIT` cheap once a list route
-- paginates instead of returning every row - which API-2/DB-5's opt-in
-- pagination (PR #19, merged) now gives this index an actual consumer.
CREATE INDEX IF NOT EXISTS idx_documents_workspace_updated_at
  ON documents (workspace_id, updated_at DESC);
