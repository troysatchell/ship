import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';

// Mock pool before importing routes
// Implementations are passed to vi.fn() rather than chained on as
// .mockResolvedValue(...): vi.resetAllMocks() (used below) restores the
// implementation given to vi.fn(impl) but wipes one that was chained on, which
// would silently turn these into undefined-returning stubs.
//
// Both `queryMock` and `mockClient.query` are declared with the promise-returning
// signature directly, rather than typed via `vi.mocked(pool.query)` /
// `vi.mocked(mockClient.query)`: `vi.mocked(pool.query)` resolves to pg's
// callback overload (return type `void`), forcing a cast on every mocked result
// (confirmed directly against this repo's `tsc` — see iterations.test.ts / TRO-213).
// `mockClient` has no such overload problem since it isn't the real `pg.PoolClient`
// type, but leaving its initial impl un-annotated infers `rows: never[]` from the
// `{ rows: [] }` literal, which is just as unable to hold a real row shape.
const { queryMock, mockClient } = vi.hoisted(() => {
  const queryMock = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();
  const mockClient = {
    query: vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(async () => ({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    })),
    release: vi.fn(),
  };
  return { queryMock, mockClient };
});
vi.mock('../db/client.js', () => ({
  pool: {
    query: queryMock,
    connect: vi.fn(async () => mockClient),
  },
}));

// Mock visibility middleware
vi.mock('../middleware/visibility.js', () => ({
  getVisibilityContext: vi.fn(async () => ({ isAdmin: false })),
  VISIBILITY_FILTER_SQL: vi.fn(() => '1=1'),
}));

// Mock auth middleware
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => {
    req.userId = 'user-123';
    req.workspaceId = 'ws-123';
    next();
  }),
  // authMiddleware above always sets both fields before `next()`, so the real
  // authed() guard would never reject here either — this is a plain passthrough
  // matching that behavior, not a weakening of it (TRO-209 / TS-4).
  authed: (handler: unknown) => handler,
}));

import express from 'express';
import request from 'supertest';
import issuesRouter from './issues.js';
import { pgResult } from '../test/pg-result.js';

describe('Issues History API', () => {
  let app: express.Express;

  beforeEach(() => {
    // resetAllMocks, not the clear-only variant: clearing mocks wipes call records but
    // leaves unconsumed mockResolvedValueOnce values queued, so a test that
    // queues more responses than its handler consumes shifts every later test's
    // mocks by one. This file was the most frequent flaker (TRO-277 / TEST-12).
    //
    // Re-establishing the mock defaults here is no longer needed: the factories
    // above pass their implementations to vi.fn(impl), which resetAllMocks
    // restores.
    vi.resetAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
  });

  describe('POST /api/issues/:id/history', () => {
    it('creates history entry with valid data', async () => {
      const issueId = 'issue-123';

      queryMock
        // Issue access check
        .mockResolvedValueOnce(pgResult([{ id: issueId }]))
        // Insert history
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'verification_failed',
          old_value: '1',
          new_value: 'Test failed: assertion error',
          automated_by: 'claude',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });

    it('creates history entry without automated_by', async () => {
      const issueId = 'issue-123';

      queryMock
        .mockResolvedValueOnce(pgResult([{ id: issueId }]))
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'state',
          old_value: 'todo',
          new_value: 'in_progress',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 400 for missing field', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 400 for empty field', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          field: '',
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 400 for field too long', async () => {
      const res = await request(app)
        .post('/api/issues/issue-123/history')
        .send({
          field: 'a'.repeat(101),
          old_value: 'test',
          new_value: 'test2',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('returns 404 for non-existent issue', async () => {
      queryMock
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .post('/api/issues/nonexistent/history')
        .send({
          field: 'verification_failed',
          old_value: '1',
          new_value: 'error details',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Issue not found');
    });

    it('accepts null values', async () => {
      const issueId = 'issue-123';

      queryMock
        .mockResolvedValueOnce(pgResult([{ id: issueId }]))
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .post(`/api/issues/${issueId}/history`)
        .send({
          field: 'sprint_id',
          old_value: null,
          new_value: 'sprint-456',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe('GET /api/issues/:id/history', () => {
    it('returns history entries with automated_by', async () => {
      const issueId = 'issue-123';
      const historyEntries = [
        {
          id: 'hist-1',
          field: 'state',
          old_value: 'todo',
          new_value: 'in_progress',
          created_at: new Date(),
          changed_by_id: 'user-123',
          changed_by_name: 'Test User',
          automated_by: null,
        },
        {
          id: 'hist-2',
          field: 'verification_failed',
          old_value: '1',
          new_value: 'test assertion failed',
          created_at: new Date(),
          changed_by_id: 'user-123',
          changed_by_name: 'Test User',
          automated_by: 'claude',
        },
      ];

      queryMock
        // Issue access check
        .mockResolvedValueOnce(pgResult([{ id: issueId }]))
        // Get history
        .mockResolvedValueOnce(pgResult(historyEntries));

      const res = await request(app)
        .get(`/api/issues/${issueId}/history`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].automated_by).toBeNull();
      expect(res.body[1].automated_by).toBe('claude');
      expect(res.body[1].field).toBe('verification_failed');
    });

    it('returns 404 for non-existent issue', async () => {
      queryMock
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .get('/api/issues/nonexistent/history');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Issue not found');
    });
  });

  describe('PATCH /api/issues/:id with claude_metadata', () => {
    it('accepts claude_metadata with telemetry', async () => {
      const issueId = 'issue-123';
      const existingIssue = {
        id: issueId,
        title: 'Test Issue',
        properties: { state: 'todo', priority: 'medium' },
        sprint_id: null,
      };
      const updatedRow = {
        ...existingIssue,
        properties: {
          ...existingIssue.properties,
          state: 'done',
          claude_metadata: {
            updated_by: 'claude',
            story_id: 'test-story',
            confidence: 85,
            telemetry: { iterations: 2, feedback_loops: { type_check: 3, test: 2, build: 1 } },
          },
        },
        ticket_number: 1,
      };

      // Client queries (within transaction)
      mockClient.query
        // Get existing issue
        .mockResolvedValueOnce(pgResult([existingIssue]))
        // Check for children (cascade warning check)
        .mockResolvedValueOnce(pgResult([]))
        // BEGIN
        .mockResolvedValueOnce(pgResult([]))
        // Log state change (document_history insert)
        .mockResolvedValueOnce(pgResult([]))
        // Update issue
        .mockResolvedValueOnce(pgResult([updatedRow]))
        // Fetch updated issue after UPDATE
        .mockResolvedValueOnce(pgResult([updatedRow]))
        // COMMIT
        .mockResolvedValueOnce(pgResult([]));

      // Pool queries (post-commit, non-transactional)
      queryMock
        // Get belongs_to associations
        .mockResolvedValueOnce(pgResult([]));

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({
          state: 'done',
          claude_metadata: {
            updated_by: 'claude',
            story_id: 'test-story',
            confidence: 85,
            telemetry: {
              iterations: 2,
              feedback_loops: { type_check: 3, test: 2, build: 1 },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('done');
    });

    it('rejects claude_metadata with invalid confidence', async () => {
      const res = await request(app)
        .patch('/api/issues/issue-123')
        .send({
          claude_metadata: {
            updated_by: 'claude',
            confidence: 150, // Invalid: > 100
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });

    it('rejects claude_metadata with wrong updated_by', async () => {
      const res = await request(app)
        .patch('/api/issues/issue-123')
        .send({
          claude_metadata: {
            updated_by: 'human', // Must be 'claude'
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });
  });
});
