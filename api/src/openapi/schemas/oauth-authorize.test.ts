/**
 * TRO-551 regression coverage — the registry half of the fix.
 *
 * CodeRabbit flagged `GET /oauth/authorize` + `POST /oauth/authorize/decision`
 * (PF-103, TRO-412) as unregistered. Investigation found registration was
 * structurally impossible: `api/src/openapi/registry.ts` set one global
 * `servers: [{ url: '/api' }]`, so a route mounted outside `/api` (both of
 * these are mounted at the application root — `app.use('/oauth', ...)` in
 * `api/src/app.ts`) had no way to document its real path without either
 * misdocumenting it under `/api` or shipping an MCP tool that calls the
 * wrong URL. See CHANGES.md's TRO-412 entry (the honest deferral this
 * ticket resolves) and this file's own `../registry.ts` `ROOT_SERVER`
 * export for the fix.
 *
 * This file proves the REGISTRY side: a non-`/api` route's full path
 * reaches `generateOpenAPIDocument()` — the exact function `api/src/swagger.ts`
 * calls to build `/api/openapi.json`, which is the URL `api/src/mcp/server.ts`
 * fetches at startup — carrying a per-operation `servers` override instead
 * of being silently prefixed with `/api`. `api/src/mcp/server.test.ts`
 * proves the EXECUTOR side: that a tool built from an operation with this
 * override calls the un-prefixed URL, not `${url}/api${path}`.
 *
 * Red-before-green (observed, not claimed): before this ticket's registry.ts
 * and oauth-authorize.ts changes, `/oauth/authorize` and
 * `/oauth/authorize/decision` were not registered with the OpenAPI registry
 * at all (no `registerPath` call existed for them anywhere in
 * `api/src/openapi/schemas/*.ts` — confirmed by grep before writing this
 * fix), so every assertion below that checks for their presence would have
 * failed with "path not found" / accessing `.get`/`.post` on `undefined`.
 */
import { describe, it, expect } from 'vitest';
import { generateOpenAPIDocument } from '../index.js';

describe('TRO-551: non-/api route registration (PF-103 oauth authorize)', () => {
  const doc = generateOpenAPIDocument();

  it('registers GET /oauth/authorize as its own top-level path, not folded under /api', () => {
    expect(doc.paths).toHaveProperty('/oauth/authorize');
    expect(doc.paths?.['/api/oauth/authorize']).toBeUndefined();
  });

  it('registers POST /oauth/authorize/decision as its own top-level path, not folded under /api', () => {
    expect(doc.paths).toHaveProperty('/oauth/authorize/decision');
    expect(doc.paths?.['/api/oauth/authorize/decision']).toBeUndefined();
  });

  it('GET /oauth/authorize carries a per-operation servers override pointing at the app root', () => {
    const op = doc.paths?.['/oauth/authorize']?.get;
    expect(op).toBeDefined();
    expect(op?.servers).toEqual([
      { url: '/', description: expect.stringContaining('outside the /api prefix') },
    ]);
  });

  it('POST /oauth/authorize/decision carries the same servers override', () => {
    const op = doc.paths?.['/oauth/authorize/decision']?.post;
    expect(op).toBeDefined();
    expect(op?.servers).toEqual([
      { url: '/', description: expect.stringContaining('outside the /api prefix') },
    ]);
  });

  it('leaves an ordinary /api-relative route (control case) with no servers override', () => {
    // GET /issues (api/src/openapi/schemas/issues.ts) predates TRO-551 and is
    // never mounted outside /api — this must be unaffected by the fix.
    const op = doc.paths?.['/issues']?.get;
    expect(op).toBeDefined();
    expect(op?.servers).toBeUndefined();
  });

  it('the document-level servers default still points every other operation at /api', () => {
    expect(doc.servers).toEqual([{ url: '/api', description: 'API base path' }]);
  });
});
