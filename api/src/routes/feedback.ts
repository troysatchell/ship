import { Router, Request, Response } from 'express';
import { pool } from '../db/client.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { IssueDocumentRow } from './rowTypes.js';

type RouterType = ReturnType<typeof Router>;

/**
 * Row shape read by `extractFeedbackFromRow`. Both call sites satisfy this:
 * the GET /:id join query below selects every field explicitly; the POST /
 * handler's `INSERT ... RETURNING *` returns a full `documents` row, which
 * has no `program_*`/`created_by_name` columns at all — those stay
 * `undefined`, which is exactly what the optional fields below model.
 */
export interface FeedbackRow {
  id: string;
  title: string;
  properties: IssueDocumentRow['properties'];
  ticket_number: number;
  content: unknown;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  program_id?: string | null;
  program_name?: string | null;
  program_prefix?: string | null;
  program_color?: string | null;
  created_by_name?: string | null;
}

/** Minimal projection used to look up a program's workspace + ticket prefix. */
interface ProgramLookupRow {
  id: string;
  workspace_id: string;
  prefix: string | null;
}

/** `SELECT ... as next_number` — COALESCE(MAX(int4), 0) + 1 stays a JS number. */
interface NextTicketNumberRow {
  next_number: number;
}

/** Public program projection served to the unauthenticated feedback form. */
interface PublicProgramRow {
  id: string;
  name: string;
  prefix: string | null;
  color: string | null;
}

// Public routes - no auth/CSRF required
export const publicFeedbackRouter: RouterType = Router();

// Protected routes - auth/CSRF required
const router: RouterType = Router();

// Validation schemas
const createFeedbackSchema = z.object({
  title: z.string().min(1).max(500),
  program_id: z.string().uuid(),
  submitter_email: z.string().email().optional(),
  content: z.any().optional(),
});

const rejectFeedbackSchema = z.object({
  reason: z.string().min(1).max(1000),
});

// Helper to extract feedback from row
// Exported for TRO-207's regression test (rowTypes.test.ts), which pins this
// mapper's parameter/return types as not-`any` and its output shape.
export function extractFeedbackFromRow(row: FeedbackRow, programPrefix?: string | null) {
  const props = row.properties || {};
  return {
    id: row.id,
    title: row.title,
    state: props.state || 'triage',
    priority: props.priority || 'medium',
    source: props.source || 'external',
    rejection_reason: props.rejection_reason || null,
    assignee_id: props.assignee_id || null,
    ticket_number: row.ticket_number,
    program_id: row.program_id ?? null,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    program_name: row.program_name ?? null,
    program_prefix: row.program_prefix || programPrefix || null,
    program_color: row.program_color ?? null,
    created_by_name: row.created_by_name ?? null,
    display_id: `#${row.ticket_number}`,
  };
}

// Create feedback - PUBLIC endpoint (no auth required)
// Creates an issue with source='external', state='triage'
publicFeedbackRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createFeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
      return;
    }

    const { title, program_id, submitter_email, content } = parsed.data;

    // Verify program exists and get its workspace_id
    const programResult = await pool.query<ProgramLookupRow>(
      `SELECT id, workspace_id, properties->>'prefix' as prefix FROM documents WHERE id = $1 AND document_type = 'program'`,
      [program_id]
    );

    const programRow = programResult.rows[0];
    if (!programRow) {
      res.status(404).json({ error: 'Program not found' });
      return;
    }

    const workspaceId = programRow.workspace_id;
    const programPrefix = programRow.prefix;

    // Get next ticket number for workspace
    const ticketResult = await pool.query<NextTicketNumberRow>(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
       FROM documents
       WHERE workspace_id = $1 AND document_type = 'issue'`,
      [workspaceId]
    );
    const nextTicketRow = ticketResult.rows[0];
    const ticketNumber = nextTicketRow ? nextTicketRow.next_number : 1;

    // Build properties JSONB - external feedback goes directly to triage
    const properties = {
      state: 'triage',
      priority: 'medium',
      source: 'external',
      submitter_email: submitter_email || null,
      assignee_id: null,
      rejection_reason: null,
    };

    // Create the feedback issue (no created_by for public submissions)
    const result = await pool.query<FeedbackRow>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, content)
       VALUES ($1, 'issue', $2, $3, $4, $5)
       RETURNING *`,
      [workspaceId, title, JSON.stringify(properties), ticketNumber, content ? JSON.stringify(content) : null]
    );

    const createdRow = result.rows[0];
    if (!createdRow) {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    const feedbackId = createdRow.id;

    // Create program association via document_associations
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program') ON CONFLICT DO NOTHING`,
      [feedbackId, program_id]
    );

    res.status(201).json({ ...extractFeedbackFromRow(createdRow, programPrefix), program_id });
  } catch (err) {
    console.error('Create feedback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get program info for public feedback form (no auth required)
publicFeedbackRouter.get('/program/:programId', async (req: Request, res: Response) => {
  try {
    const programId = req.params.programId as string;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(programId)) {
      res.status(404).json({ error: 'Program not found' });
      return;
    }

    const result = await pool.query<PublicProgramRow>(
      `SELECT id, title as name, properties->>'prefix' as prefix, properties->>'color' as color
       FROM documents WHERE id = $1 AND document_type = 'program'`,
      [programId]
    );

    const programRow = result.rows[0];
    if (!programRow) {
      res.status(404).json({ error: 'Program not found' });
      return;
    }

    res.json(programRow);
  } catch (err) {
    console.error('Get program for feedback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single feedback item
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }

    const result = await pool.query<FeedbackRow>(
      `SELECT d.id, d.title, d.properties, d.ticket_number,
              prog_da.related_id as program_id,
              d.content, d.created_at, d.updated_at, d.created_by,
              p.title as program_name,
              p.properties->>'prefix' as program_prefix,
              p.properties->>'color' as program_color,
              creator.name as created_by_name
       FROM documents d
       LEFT JOIN document_associations prog_da ON d.id = prog_da.document_id AND prog_da.relationship_type = 'program'
       LEFT JOIN documents p ON prog_da.related_id = p.id AND p.document_type = 'program'
       LEFT JOIN users creator ON d.created_by = creator.id
       WHERE d.id = $1 AND d.workspace_id = $2 AND d.document_type = 'issue' AND d.properties->>'source' = 'external'`,
      [id, req.workspaceId]
    );

    const feedbackRow = result.rows[0];
    if (!feedbackRow) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }

    res.json(extractFeedbackFromRow(feedbackRow));
  } catch (err) {
    console.error('Get feedback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Note: Accept and reject actions are now handled via /api/issues/:id/accept and /api/issues/:id/reject

export default router;
