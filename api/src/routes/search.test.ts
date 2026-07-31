import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

describe('Search API', () => {
  const app = createApp('http://localhost:5173');
  // Use unique identifiers to avoid conflicts between concurrent test runs
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `search-${testRunId}@ship.local`;
  const testWorkspaceName = `Search Test ${testRunId}`;

  let sessionCookie: string;
  let testWorkspaceId: string;
  let testUserId: string;
  let testPersonDocId: string;
  let testWikiDocId: string;

  beforeAll(async () => {
    // Create test workspace
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1)
       RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = workspaceResult.rows[0].id;

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Search Test User')
       RETURNING id`,
      [testEmail]
    );
    testUserId = userResult.rows[0].id;

    // Create workspace membership
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    );

    // Create session (sessions.id is TEXT not UUID, generated from crypto.randomBytes)
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    );
    sessionCookie = `session_id=${sessionId}`;

    // Create test person document
    const personResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content)
       VALUES ($1, 'person', 'Test Person', '{}')
       RETURNING id`,
      [testWorkspaceId]
    );
    testPersonDocId = personResult.rows[0].id;

    // Create test wiki document
    const wikiResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content)
       VALUES ($1, 'wiki', 'Test Wiki', '{}')
       RETURNING id`,
      [testWorkspaceId]
    );
    testWikiDocId = wikiResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data in correct order (foreign keys)
    await pool.query('DELETE FROM documents WHERE id IN ($1, $2)', [testPersonDocId, testWikiDocId]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
    // Don't close pool - it's shared across test files
  });

  it('GET /api/search/mentions returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/search/mentions?q=test');

    expect(res.status).toBe(401);
  });

  it('GET /api/search/mentions returns people and documents', async () => {
    const res = await request(app)
      .get('/api/search/mentions?q=Test')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('people');
    expect(res.body).toHaveProperty('documents');
    expect(Array.isArray(res.body.people)).toBe(true);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });

  it('GET /api/search/mentions filters by query string', async () => {
    const res = await request(app)
      .get('/api/search/mentions?q=nonexistent12345')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(0);
    expect(res.body.documents).toHaveLength(0);
  });

  it('GET /api/search/mentions returns people with correct structure', async () => {
    const res = await request(app)
      .get('/api/search/mentions?q=Test')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);

    // Should find our test person
    expect(res.body.people.length).toBeGreaterThan(0);
    const person = res.body.people[0];
    expect(person).toHaveProperty('id');
    expect(person).toHaveProperty('name');
  });

  it('GET /api/search/mentions returns documents with correct structure', async () => {
    const res = await request(app)
      .get('/api/search/mentions?q=Test')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);

    // Should find our test wiki document
    expect(res.body.documents.length).toBeGreaterThan(0);
    const doc = res.body.documents[0];
    expect(doc).toHaveProperty('id');
    expect(doc).toHaveProperty('title');
    expect(doc).toHaveProperty('document_type');
  });
});

describe('Search Learnings API', () => {
  const app = createApp('http://localhost:5173');
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `learning-${testRunId}@ship.local`;
  const testWorkspaceName = `Learning Test ${testRunId}`;

  let sessionCookie: string;
  let testWorkspaceId: string;
  let testUserId: string;
  let learningDocId: string;
  let regularWikiId: string;

  beforeAll(async () => {
    // Create test workspace
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = workspaceResult.rows[0].id;

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Learning Test User')
       RETURNING id`,
      [testEmail]
    );
    testUserId = userResult.rows[0].id;

    // Create workspace membership
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    );

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    );
    sessionCookie = `session_id=${sessionId}`;

    // Create learning document (title starts with "Learning:")
    const learningResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, content, created_by)
       VALUES ($1, 'wiki', 'Learning: API Token Authentication', $2, '{"type":"doc","content":[]}', $3)
       RETURNING id`,
      [testWorkspaceId, JSON.stringify({ tags: ['security', 'api'], category: 'authentication', source_prd: 'test-prd' }), testUserId]
    );
    learningDocId = learningResult.rows[0].id;

    // Create regular wiki document (should not appear in learnings search)
    const regularResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, created_by)
       VALUES ($1, 'wiki', 'Regular Wiki Document', '{}', $2)
       RETURNING id`,
      [testWorkspaceId, testUserId]
    );
    regularWikiId = regularResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE id IN ($1, $2)', [learningDocId, regularWikiId]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
  });

  it('GET /api/search/learnings returns 401 without auth', async () => {
    const res = await request(app).get('/api/search/learnings');
    expect(res.status).toBe(401);
  });

  it('GET /api/search/learnings returns learnings by title', async () => {
    const res = await request(app)
      .get('/api/search/learnings')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('learnings');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.learnings)).toBe(true);

    // Should find our learning document
    const learning = res.body.learnings.find((l: any) => l.id === learningDocId);
    expect(learning).toBeDefined();
    expect(learning.title).toBe('Learning: API Token Authentication');
  });

  it('GET /api/search/learnings filters by keyword', async () => {
    const res = await request(app)
      .get('/api/search/learnings?q=authentication')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.learnings.length).toBeGreaterThan(0);
    expect(res.body.learnings[0].category).toBe('authentication');
  });

  it('GET /api/search/learnings returns tags and metadata', async () => {
    const res = await request(app)
      .get('/api/search/learnings?q=API')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    const learning = res.body.learnings.find((l: any) => l.id === learningDocId);
    expect(learning).toBeDefined();
    expect(learning.tags).toContain('security');
    expect(learning.source_prd).toBe('test-prd');
  });

  it('GET /api/search/learnings excludes non-learning wiki docs', async () => {
    const res = await request(app)
      .get('/api/search/learnings?q=Regular')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    // Regular wiki doc should not appear
    const regularDoc = res.body.learnings.find((l: any) => l.id === regularWikiId);
    expect(regularDoc).toBeUndefined();
  });

  it('GET /api/search/learnings respects limit parameter', async () => {
    const res = await request(app)
      .get('/api/search/learnings?limit=1')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.learnings.length).toBeLessThanOrEqual(1);
  });
});

// TRO-175 / API-4: `/api/search/documents` was registered in the OpenAPI
// schema with no backing route (any caller 404'd). It now backs the command
// palette's document list - covered here rather than only in the frontend
// test, since the frontend test mocks this endpoint and would not catch a
// server-side regression in the shape or visibility rules.
describe('Search Documents API (TRO-175 / API-4)', () => {
  const app = createApp('http://localhost:5173');
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testWorkspaceName = `Search Documents Test ${testRunId}`;

  let memberSessionCookie: string;
  let otherMemberSessionCookie: string;
  let adminSessionCookie: string;
  let testWorkspaceId: string;
  let memberId: string;
  let otherMemberId: string;
  let adminId: string;
  let issueDocId: string;
  let standupDocId: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = workspaceResult.rows[0].id;

    const memberResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Doc Search Member') RETURNING id`,
      [`docsearch-member-${testRunId}@ship.local`]
    );
    memberId = memberResult.rows[0].id;

    const otherMemberResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Doc Search Other Member') RETURNING id`,
      [`docsearch-other-${testRunId}@ship.local`]
    );
    otherMemberId = otherMemberResult.rows[0].id;

    const adminResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Doc Search Admin') RETURNING id`,
      [`docsearch-admin-${testRunId}@ship.local`]
    );
    adminId = adminResult.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, memberId]
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, otherMemberId]
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [testWorkspaceId, adminId]
    );

    const memberSessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [memberSessionId, memberId, testWorkspaceId]
    );
    memberSessionCookie = `session_id=${memberSessionId}`;

    const otherMemberSessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [otherMemberSessionId, otherMemberId, testWorkspaceId]
    );
    otherMemberSessionCookie = `session_id=${otherMemberSessionId}`;

    const adminSessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [adminSessionId, adminId, testWorkspaceId]
    );
    adminSessionCookie = `session_id=${adminSessionId}`;

    // A palette-relevant type (issue), with a ticket_number set.
    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, ticket_number, visibility, created_by)
       VALUES ($1, 'issue', 'Fix the search endpoint', '{}', 42, 'workspace', $2)
       RETURNING id`,
      [testWorkspaceId, memberId]
    );
    issueDocId = issueResult.rows[0].id;

    // A type the command palette never groups/renders - must be excluded.
    const standupResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, visibility, created_by)
       VALUES ($1, 'standup', 'Daily standup notes', '{}', 'workspace', $2)
       RETURNING id`,
      [testWorkspaceId, memberId]
    );
    standupDocId = standupResult.rows[0].id;

    // A private doc owned by memberId - visible to member + admin, not otherMember.
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, visibility, created_by)
       VALUES ($1, 'wiki', 'Members Only Private Wiki', '{}', 'private', $2)`,
      [testWorkspaceId, memberId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId]);
    await pool.query('DELETE FROM sessions WHERE user_id IN ($1, $2, $3)', [memberId, otherMemberId, adminId]);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [testWorkspaceId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [memberId, otherMemberId, adminId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/search/documents');
    expect(res.status).toBe(401);
  });

  it('browses (no q) all palette-relevant document types, excluding types the palette never renders', async () => {
    const res = await request(app)
      .get('/api/search/documents')
      .set('Cookie', memberSessionCookie);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(issueDocId);
    // 'standup' is a real document_type but not one of the six the command
    // palette groups by (issue/wiki/program/project/sprint/person) - it must
    // never be shipped to the client for this endpoint.
    expect(ids).not.toContain(standupDocId);
    for (const doc of res.body as Array<{ document_type: string }>) {
      expect(['wiki', 'issue', 'program', 'project', 'sprint', 'person']).toContain(doc.document_type);
    }
  });

  it('includes ticket_number on issue documents', async () => {
    const res = await request(app)
      .get('/api/search/documents')
      .set('Cookie', memberSessionCookie);

    expect(res.status).toBe(200);
    const issue = (res.body as Array<{ id: string; ticket_number: number | null }>).find(
      (d) => d.id === issueDocId
    );
    expect(issue).toBeDefined();
    expect(issue?.ticket_number).toBe(42);
  });

  it('filters by title when q is provided', async () => {
    const res = await request(app)
      .get('/api/search/documents?q=search endpoint')
      .set('Cookie', memberSessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(issueDocId);
  });

  it('excludes another member\'s private document', async () => {
    const res = await request(app)
      .get('/api/search/documents?q=Members Only Private')
      .set('Cookie', otherMemberSessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('includes the creator\'s own private document', async () => {
    const res = await request(app)
      .get('/api/search/documents?q=Members Only Private')
      .set('Cookie', memberSessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Members Only Private Wiki');
  });

  it('includes any member\'s private document for an admin', async () => {
    const res = await request(app)
      .get('/api/search/documents?q=Members Only Private')
      .set('Cookie', adminSessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Members Only Private Wiki');
  });
});
