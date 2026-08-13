/**
 * The domain write path for `documents` rows (PLUGFORGE.MD §2.6, §4 PF-301).
 *
 * Today this file holds exactly one function: the INSERT `/api/v1/documents`
 * POST calls (PF-200). Written as a service function — not inline SQL in the
 * route — on purpose: PF-301 ("consolidate document create/update/delete
 * into a `documentService` write path that both `/api` and `/api/v1` call")
 * surveyed nine existing internal route files that each do their own inline
 * `documents` INSERT/UPDATE/DELETE (see that ticket's scoping note) and will
 * redirect them to functions living here, adding `IEventBus.publish()` once
 * PF-300's event bus exists. Landing the v1 write path as a function in this
 * file from day one means that later consolidation is a MOVE (redirect other
 * call sites here) rather than a REWRITE (this logic doesn't change) — the
 * exact framing PF-200's architect note asks for.
 *
 * Deliberately thin: no association wiring, no event publication (the event
 * bus does not exist yet), no visibility/property-extraction logic the
 * internal `routes/documents.ts` create path has grown over time. Those stay
 * out of scope for PF-200; PF-301 is where this function grows into the
 * shared write path other routes redirect to.
 */

import { pool } from '../db/client.js';

export interface CreateDocumentParams {
  workspaceId: string;
  title: string;
  documentType: string;
  properties?: Record<string, unknown>;
  createdByUserId?: string | null;
}

export interface DocumentRecord {
  id: string;
  title: string;
  document_type: string;
  properties: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export async function createDocument(params: CreateDocumentParams): Promise<DocumentRecord> {
  const result = await pool.query<DocumentRecord>(
    `INSERT INTO documents (workspace_id, title, document_type, properties, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, document_type, properties, created_at, updated_at`,
    [
      params.workspaceId,
      params.title,
      params.documentType,
      JSON.stringify(params.properties ?? {}),
      params.createdByUserId ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    // INSERT ... RETURNING with no WHERE clause always produces exactly one
    // row on success; reaching here means the INSERT itself failed silently
    // somehow, which is a server bug, not a caller error.
    throw new Error('documentService.createDocument: INSERT ... RETURNING produced no row');
  }
  return row;
}
