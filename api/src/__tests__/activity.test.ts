import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { QueryResult } from 'pg';

// Declared with the promise-returning signature: `vi.mocked(pool.query)` resolves to
// pg's callback overload, whose return type is `void`, forcing a cast on every mocked
// result and switching off checking of the row shapes these tests assert about
// (confirmed directly against this repo's `tsc` — see routes/iterations.test.ts / TRO-213).
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(),
}));

// Mock pool before importing routes
vi.mock('../db/client.js', () => ({
  pool: {
    query: queryMock,
  },
}));

// Mock auth middleware to inject test session data
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.workspaceId = 'test-workspace-id';
    req.userId = 'test-user-id';
    next();
  },
  // authMiddleware above always sets both fields before `next()`, so the real
  // authed() guard would never reject here either — this is a plain passthrough
  // matching that behavior, not a weakening of it (TRO-209 / TS-4).
  authed: (handler: unknown) => handler,
}));

import activityRouter from '../routes/activity.js';
import { pgResult } from '../test/pg-result.js';

// Create test Express app
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/activity', activityRouter);
  return app;
}

describe('Activity API', () => {
  let app: express.Application;

  beforeEach(() => {
    // resetAllMocks, not the clear-only variant: clearing mocks wipes call records but
    // leaves unconsumed mockResolvedValueOnce values queued, so a test that
    // queues more responses than its handler consumes shifts every later test's
    // mocks by one (TRO-277 / TEST-12).
    vi.resetAllMocks();
    app = createTestApp();
  });

  describe('GET /activity/:entityType/:entityId', () => {
    describe('successful activity retrieval', () => {
      it('returns 30 days of activity for a program', async () => {
        const programId = 'program-123';
        const workspaceId = 'test-workspace-id';

        // Mock entity exists check
        queryMock
          .mockResolvedValueOnce(pgResult([{ id: programId }]))
          // Mock activity query
          .mockResolvedValueOnce(pgResult([
            { date: '2024-01-01', count: 5 },
            { date: '2024-01-02', count: 3 },
            { date: '2024-01-03', count: 0 },
          ]));

        const response = await request(app)
          .get(`/activity/program/${programId}`)
          .expect(200);

        expect(response.body).toEqual({
          days: [
            { date: '2024-01-01', count: 5 },
            { date: '2024-01-02', count: 3 },
            { date: '2024-01-03', count: 0 },
          ],
        });

        // Verify entity check query
        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining('SELECT id FROM documents'),
          [programId, workspaceId, 'program']
        );
      });

      it('returns 30 days of activity for a project', async () => {
        const projectId = 'project-456';
        const workspaceId = 'test-workspace-id';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: projectId }]))
          .mockResolvedValueOnce(pgResult([
              { date: '2024-01-10', count: 12 },
              { date: '2024-01-11', count: 8 },
            ]));

        const response = await request(app)
          .get(`/activity/project/${projectId}`)
          .expect(200);

        expect(response.body).toEqual({
          days: [
            { date: '2024-01-10', count: 12 },
            { date: '2024-01-11', count: 8 },
          ],
        });

        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining('SELECT id FROM documents'),
          [projectId, workspaceId, 'project']
        );
      });

      it('returns 30 days of activity for a sprint', async () => {
        const sprintId = 'sprint-789';
        const workspaceId = 'test-workspace-id';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: sprintId }]))
          .mockResolvedValueOnce(pgResult([
              { date: '2024-01-20', count: 15 },
            ]));

        const response = await request(app)
          .get(`/activity/sprint/${sprintId}`)
          .expect(200);

        expect(response.body).toEqual({
          days: [
            { date: '2024-01-20', count: 15 },
          ],
        });

        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining('SELECT id FROM documents'),
          [sprintId, workspaceId, 'sprint']
        );
      });

      it('returns empty array for entity with no activity', async () => {
        const programId = 'empty-program';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: programId }]))
          .mockResolvedValueOnce(pgResult([]));

        const response = await request(app)
          .get(`/activity/program/${programId}`)
          .expect(200);

        expect(response.body).toEqual({
          days: [],
        });
      });
    });

    describe('error handling', () => {
      it('returns 400 for invalid entity type', async () => {
        const response = await request(app)
          .get('/activity/invalid-type/some-id')
          .expect(400);

        expect(response.body).toEqual({
          error: 'Invalid entity type. Must be program, project, or week.',
        });

        // Should not query database for invalid type
        expect(queryMock).not.toHaveBeenCalled();
      });

      it('returns 404 when entity does not exist', async () => {
        const nonExistentId = 'non-existent-id';

        queryMock.mockResolvedValueOnce(pgResult([]));

        const response = await request(app)
          .get(`/activity/program/${nonExistentId}`)
          .expect(404);

        expect(response.body).toEqual({
          error: 'Entity not found',
        });
      });

      it('returns 404 when entity belongs to different workspace', async () => {
        const programId = 'other-workspace-program';

        // Entity exists but not in user's workspace
        queryMock.mockResolvedValueOnce(pgResult([]));

        const response = await request(app)
          .get(`/activity/program/${programId}`)
          .expect(404);

        expect(response.body).toEqual({
          error: 'Entity not found',
        });
      });

      it('returns 500 on database error', async () => {
        const programId = 'program-error';

        queryMock.mockRejectedValueOnce(
          new Error('Database connection failed')
        );

        const response = await request(app)
          .get(`/activity/program/${programId}`)
          .expect(500);

        expect(response.body).toEqual({
          error: 'Failed to fetch activity data',
        });
      });
    });

    describe('workspace isolation', () => {
      it('only queries entities in the authenticated workspace', async () => {
        const programId = 'program-123';
        const workspaceId = 'test-workspace-id';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: programId }]))
          .mockResolvedValueOnce(pgResult([]));

        await request(app)
          .get(`/activity/program/${programId}`)
          .expect(200);

        // Verify workspace_id is included in entity check
        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining('workspace_id = $2'),
          [programId, workspaceId, 'program']
        );

        // Verify workspace_id is included in activity query
        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining('WHERE workspace_id = $2'),
          [programId, workspaceId]
        );
      });
    });

    describe('date range validation', () => {
      it('queries exactly 30 days of activity', async () => {
        const programId = 'program-123';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: programId }]))
          .mockResolvedValueOnce(pgResult(Array.from({ length: 30 }, (_, i) => ({
              date: `2024-01-${String(i + 1).padStart(2, '0')}`,
              count: i % 3,
            }))));

        const response = await request(app)
          .get(`/activity/program/${programId}`)
          .expect(200);

        // Should return exactly 30 days
        expect(response.body.days).toHaveLength(30);

        // Verify query uses 29 days interval (today + 29 previous days = 30 total)
        expect(queryMock).toHaveBeenCalledWith(
          expect.stringContaining("INTERVAL '29 days'"),
          [programId, 'test-workspace-id']
        );
      });
    });

    describe('entity type specific queries', () => {
      it('program query includes direct documents, projects, and sprints', async () => {
        const programId = 'program-123';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: programId }]))
          .mockResolvedValueOnce(pgResult([]));

        await request(app)
          .get(`/activity/program/${programId}`)
          .expect(200);

        const activityQuery = queryMock.mock.calls[1]![0];

        // Verify query structure includes all relevant associations via document_associations
        expect(activityQuery).toContain('program_projects');
        expect(activityQuery).toContain('program_sprints');
        expect(activityQuery).toContain('document_associations');
        expect(activityQuery).toContain("relationship_type = 'program'");
        expect(activityQuery).toContain("relationship_type = 'project'");
        expect(activityQuery).toContain("relationship_type = 'sprint'");
      });

      it('project query includes direct documents and sprints', async () => {
        const projectId = 'project-456';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: projectId }]))
          .mockResolvedValueOnce(pgResult([]));

        await request(app)
          .get(`/activity/project/${projectId}`)
          .expect(200);

        const activityQuery = queryMock.mock.calls[1]![0];

        expect(activityQuery).toContain('project_sprints');
        // Project and sprint associations use document_associations junction table
        expect(activityQuery).toContain('document_associations');
        expect(activityQuery).toContain("relationship_type = 'sprint'");
        expect(activityQuery).toContain("relationship_type = 'project'");
      });

      it('sprint query includes direct documents only', async () => {
        const sprintId = 'sprint-789';

        queryMock
          .mockResolvedValueOnce(pgResult([{ id: sprintId }]))
          .mockResolvedValueOnce(pgResult([]));

        await request(app)
          .get(`/activity/sprint/${sprintId}`)
          .expect(200);

        const activityQuery = queryMock.mock.calls[1]![0];

        // Issues linked via junction table
        expect(activityQuery).toContain('document_associations');
        expect(activityQuery).toContain("relationship_type = 'sprint'");
        expect(activityQuery).toContain('OR id = $1'); // Sprint document itself
        expect(activityQuery).not.toContain('project_sprints');
      });
    });
  });
});
