/**
 * PF-202 (Linear TRO-402) — `GET /api/v1/openapi.json` end-to-end: the route
 * is actually mounted, public (no bearer token needed), and serves the same
 * document `generateV1OpenAPIDocument()` produces.
 *
 * Uses the real `createApp()` + supertest, matching `v1-router.test.ts`'s
 * established pattern for `/api/v1` platform-level routes. No database
 * fixtures needed — this route reads nothing from the DB and requires no
 * auth.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../app.js';

/** Narrow local type for the JSON body under test (review-pattern rule 21:
 * `res.body` is `any` — type the boundary explicitly rather than touching
 * fields on it directly). Deliberately partial/loose — this suite only
 * asserts on the fields it cares about, `document.test.ts` owns the full
 * shape assertions against the real OpenAPI 3.1 schema. */
interface OpenApiDocumentBody {
  openapi?: string;
  paths?: Record<string, unknown>;
}

describe('PF-202: GET /api/v1/openapi.json', () => {
  const app: Express = createApp();

  it('200s with a JSON OpenAPI 3.1 document, no auth required', async () => {
    const res = await request(app).get('/api/v1/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const body: OpenApiDocumentBody = res.body;
    expect(body.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it('contains every registered /api/v1 route: health, itself, documents (+4 sub-resources), issues, sprints (+{id}), me, webhooks (+deliveries), people, changes (PF-203, PF-302, PF-305, PF-205)', async () => {
    const res = await request(app).get('/api/v1/openapi.json');

    const body: OpenApiDocumentBody = res.body;
    const paths = body.paths ?? {};
    // Updated by PF-302 (Linear TRO-431): /webhooks, /webhooks/{id},
    // /webhooks/{id}/rotate added — see document.test.ts's identical update
    // for the same rationale (a legitimate addition to a hand-maintained
    // list, not a weakened check).
    //
    // Updated by PF-305 (Linear TRO-442): /webhooks/deliveries added — same
    // rationale, see document.test.ts's identical update.
    //
    // Updated by PF-205 (Linear TRO-414): /people, /changes, the four
    // /documents/{id}/... sub-resources, and /sprints/{id} added — same
    // rationale.
    expect(Object.keys(paths).sort()).toEqual(
      [
        '/changes',
        '/documents',
        '/documents/{id}',
        '/documents/{id}/associations',
        '/documents/{id}/backlinks',
        '/documents/{id}/comments',
        '/documents/{id}/reverse-associations',
        '/health',
        '/issues',
        '/me',
        '/openapi.json',
        '/people',
        '/sprints',
        '/sprints/{id}',
        '/webhooks',
        '/webhooks/deliveries',
        '/webhooks/{id}',
        '/webhooks/{id}/rotate',
      ].sort()
    );
  });

  it('carries an X-Request-Id header like every other /api/v1 route (PF-001)', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('a cross-origin fetch succeeds with the public, credential-less CORS policy (matches /health\'s AC-2)', async () => {
    const previous = process.env.PUBLIC_API_CORS_ORIGIN;
    delete process.env.PUBLIC_API_CORS_ORIGIN;
    try {
      const res = await request(app)
        .get('/api/v1/openapi.json')
        .set('Origin', 'http://example.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.PUBLIC_API_CORS_ORIGIN;
      } else {
        process.env.PUBLIC_API_CORS_ORIGIN = previous;
      }
    }
  });
});
