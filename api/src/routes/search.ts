import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { authMiddleware, authed } from '../middleware/auth.js';
import { isWorkspaceAdmin } from '../middleware/visibility.js';

type RouterType = ReturnType<typeof Router>;
export const searchRouter: RouterType = Router();

// SECURITY: Escape SQL LIKE pattern special characters to prevent wildcard injection
// This prevents users from using % and _ to match arbitrary patterns
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

// Search for mentions (people + documents)
// GET /api/search/mentions?q=:query
searchRouter.get('/mentions', authMiddleware, authed(async (req, res) => {
  try {
    const searchQuery = (req.query.q as string) || '';
    const workspaceId = req.workspaceId;
    const userId = req.userId;

    // SECURITY: Escape wildcard characters to prevent SQL wildcard injection
    const sanitizedQuery = escapeLikePattern(searchQuery);

    // Check if user is admin for visibility filtering
    const isAdmin = await isWorkspaceAdmin(userId, workspaceId);

    // Search for people (person documents linked via properties.user_id)
    // Person documents are always workspace-visible, so no visibility filter needed
    const peopleResult = await pool.query(
      `SELECT
         d.id::text as id,
         d.title as name,
         'person' as document_type
       FROM documents d
       WHERE d.workspace_id = $1
         AND d.document_type = 'person'
         AND d.archived_at IS NULL
         AND d.deleted_at IS NULL
         AND d.title ILIKE $2
       ORDER BY d.title ASC
       LIMIT 5`,
      [workspaceId, `%${sanitizedQuery}%`]
    );

    // Search for other documents (wiki, issue, project, program)
    // Filter by visibility: workspace docs, user's private docs, or all if admin
    const documentsResult = await pool.query(
      `SELECT id, title, document_type, visibility
       FROM documents
       WHERE workspace_id = $1
         AND document_type IN ('wiki', 'issue', 'project', 'program')
         AND deleted_at IS NULL
         AND title ILIKE $2
         AND (visibility = 'workspace' OR created_by = $3 OR $4 = TRUE)
       ORDER BY
         CASE document_type
           WHEN 'issue' THEN 1
           WHEN 'wiki' THEN 2
           WHEN 'project' THEN 3
           WHEN 'program' THEN 4
           ELSE 5
         END,
         updated_at DESC
       LIMIT 10`,
      [workspaceId, `%${sanitizedQuery}%`, userId, isAdmin]
    );

    res.json({
      people: peopleResult.rows,
      documents: documentsResult.rows,
    });
  } catch (error) {
    console.error('Error searching mentions:', error);
    res.status(500).json({ error: 'Failed to search mentions' });
  }
}));

// TRO-175 / API-4: this path was already declared in the OpenAPI registry
// (openapi/schemas/search.ts) but had no backing Express route - any caller
// got a plain 404. It's the natural home for the command palette's document
// list: omitting `q` browses the full corpus (same visibility rules and row
// set as `GET /api/documents`, trimmed to only the columns the palette
// renders and to the six document types it groups by - wiki, issue, program,
// project, sprint, person - dropping weekly_plan/weekly_retro/standup/
// weekly_review rows the palette never displays), and passing `q` narrows it
// server-side by title.
interface DocumentSearchRow {
  id: string;
  document_type: string;
  title: string;
  ticket_number: number | null;
}

// Search or browse documents for UI surfaces like the command palette
// GET /api/search/documents?q=:query
searchRouter.get('/documents', authMiddleware, authed(async (req, res) => {
  try {
    const searchQuery = ((req.query.q as string) || '').trim();
    const workspaceId = req.workspaceId;
    const userId = req.userId;

    // Check if user is admin for visibility filtering
    const isAdmin = await isWorkspaceAdmin(userId, workspaceId);

    const params: (string | boolean)[] = [workspaceId, userId, isAdmin];
    let query = `
      SELECT id, document_type, title, ticket_number
      FROM documents
      WHERE workspace_id = $1
        AND archived_at IS NULL
        AND deleted_at IS NULL
        AND (visibility = 'workspace' OR created_by = $2 OR $3 = TRUE)
        AND document_type IN ('wiki', 'issue', 'program', 'project', 'sprint', 'person')
    `;

    // SECURITY: Escape wildcard characters to prevent SQL wildcard injection
    if (searchQuery) {
      const sanitizedQuery = escapeLikePattern(searchQuery);
      params.push(`%${sanitizedQuery}%`);
      query += ` AND title ILIKE $${params.length}`;
    }

    query += ` ORDER BY position ASC, created_at DESC`;

    const result = await pool.query<DocumentSearchRow>(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Error searching documents:', error);
    res.status(500).json({ error: 'Failed to search documents' });
  }
}));

// Search for learning wiki documents
// GET /api/search/learnings?q=:query&program_id=:program_id
searchRouter.get('/learnings', authMiddleware, authed(async (req, res) => {
  try {
    const searchQuery = (req.query.q as string) || '';
    const programId = req.query.program_id as string | undefined;
    const workspaceId = req.workspaceId;
    const userId = req.userId;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    // SECURITY: Escape wildcard characters to prevent SQL wildcard injection
    const sanitizedQuery = escapeLikePattern(searchQuery);

    // Check if user is admin for visibility filtering
    const isAdmin = await isWorkspaceAdmin(userId, workspaceId);

    // Search for learning wiki documents
    // Match documents where:
    // - title starts with "Learning:" OR properties.tags contains "learning"
    // - AND title/tags match the search query
    const params: (string | boolean | number)[] = [workspaceId, userId, isAdmin];
    let query = `
      SELECT
        d.id,
        d.title,
        prog_da.related_id as program_id,
        d.properties->>'category' as category,
        d.properties->'tags' as tags,
        d.properties->>'source_prd' as source_prd,
        d.properties->>'source_sprint_id' as source_sprint_id,
        d.created_at,
        d.updated_at,
        substring(d.content::text, 1, 500) as content_preview
      FROM documents d
      LEFT JOIN document_associations prog_da ON d.id = prog_da.document_id AND prog_da.relationship_type = 'program'
      WHERE d.workspace_id = $1
        AND d.document_type = 'wiki'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND (d.visibility = 'workspace' OR d.created_by = $2 OR $3 = TRUE)
        AND (
          d.title LIKE 'Learning:%'
          OR d.properties->'tags' ? 'learning'
        )
    `;

    // Add search query filter if provided
    if (searchQuery) {
      params.push(`%${sanitizedQuery}%`);
      const queryParamIndex = params.length;
      query += `
        AND (
          d.title ILIKE $${queryParamIndex}
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(d.properties->'tags') AS tag
            WHERE tag ILIKE $${queryParamIndex}
          )
          OR d.properties->>'category' ILIKE $${queryParamIndex}
        )
      `;
    }

    // Filter by program if provided
    if (programId) {
      params.push(programId);
      query += ` AND d.id IN (SELECT document_id FROM document_associations WHERE related_id = $${params.length} AND relationship_type = 'program')`;
    }

    params.push(limit);
    query += ` ORDER BY d.updated_at DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);

    res.json({
      learnings: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error('Error searching learnings:', error);
    res.status(500).json({ error: 'Failed to search learnings' });
  }
}));
