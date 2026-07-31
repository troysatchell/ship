import { pool } from '../db/client.js';

/** Row shape for the role lookup below (DB-3 / TRO-180) — touched while naming that
 * statement, so it gets a real type instead of the implicit `any` `pool.query` would
 * otherwise return (RULE-21). `workspace_memberships.role` (schema.sql) is a free-text
 * column, not an enum, so this stays `string` rather than a literal union. */
interface WorkspaceMembershipRoleRow {
  role: string | null;
}

/**
 * Check if user is a workspace admin
 */
export async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  // Named (DB-3 / TRO-180): `getVisibilityContext` calls this from nearly every
  // list/get route (documents, issues, weeks, programs, workspaces, ...), so this
  // single call site accounts for a large share of the "3 auth queries per
  // request" DB-2 measured — and, being one statement of fixed shape reused
  // everywhere, it never got a cached plan. See CHANGES.md for the measured
  // effect and the connection-pooling caveat.
  const result = await pool.query<WorkspaceMembershipRoleRow>({
    name: 'workspace_admin_role_lookup',
    text: 'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
    values: [workspaceId, userId],
  });
  return result.rows[0]?.role === 'admin';
}

/**
 * Get visibility filter context for SQL queries.
 * Returns the isAdmin boolean that should be used with visibility filter SQL.
 *
 * The visibility filter pattern is:
 *   (visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE)
 *
 * This allows:
 * - All workspace-visible documents to be seen by everyone
 * - Private documents to be seen only by their creator
 * - Admins to see all documents
 */
export async function getVisibilityContext(
  userId: string,
  workspaceId: string
): Promise<{ isAdmin: boolean }> {
  const isAdmin = await isWorkspaceAdmin(userId, workspaceId);
  return { isAdmin };
}

/**
 * SQL fragment for visibility filtering.
 * Use with parameterized queries where:
 * - $N is userId
 * - $N+1 is isAdmin boolean
 *
 * Example:
 *   const { isAdmin } = await getVisibilityContext(userId, workspaceId);
 *   const query = `
 *     SELECT * FROM documents d
 *     WHERE d.workspace_id = $1
 *       AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
 *   `;
 *   await pool.query(query, [workspaceId, userId, isAdmin]);
 */
export function VISIBILITY_FILTER_SQL(
  tableAlias: string,
  userIdParam: string,
  isAdminParam: string
): string {
  return `(${tableAlias}.visibility = 'workspace' OR ${tableAlias}.created_by = ${userIdParam} OR ${isAdminParam} = TRUE)`;
}
