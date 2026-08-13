/**
 * TRO-551 regression coverage — the MCP-executor half of the fix.
 *
 * Before this ticket, `executeToolCall` built every tool's request URL as
 * `` `${CONFIG.url}/api${path}` `` unconditionally (`api/src/mcp/server.ts:375`,
 * per the ticket's own citation). A route registered outside `/api` — PF-103's
 * `/oauth/authorize` — would have its generated MCP tool call
 * `${url}/api/oauth/authorize`, which 404s on every invocation. That was true
 * even if the OpenAPI registry side were fixed independently: this file proves
 * the executor actually reads the operation's `servers` override and stops
 * assuming `/api`, which `api/src/openapi/schemas/oauth-authorize.test.ts`
 * proves the registry now emits for exactly these two operations.
 *
 * Tests the extracted pure functions directly (`resolveServerPrefix`,
 * `buildRequestUrl`) rather than the full `executeToolCall` — same reasoning
 * as `api/src/swagger.test.ts`'s header: no live server, no module-level
 * `CONFIG`, no `~/.claude/.env` dependency (`loadConfig()` throws without
 * it — the reason `main()` is now guarded to not run on import, see the
 * bottom of `server.ts`).
 *
 * Red-before-green (observed, not claimed): reverting `buildRequestUrl` to
 * its pre-fix form (`` let url = \`${baseUrl}/api${path}\`; `` with no
 * `resolveServerPrefix` call at all) and re-running this file fails the
 * "non-/api operation" case below with:
 *   expected 'http://ship.example/api/oauth/authorize' to be
 *   'http://ship.example/oauth/authorize'
 * — the exact 404-shaped bug the ticket describes — while the "ordinary /api
 * operation" case still passes, confirming the regression is isolated to the
 * non-default-prefix path, not a wholesale breakage.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveServerPrefix,
  buildRequestUrl,
  type OperationObject,
  type ToolOperation,
} from './server.js';

describe('TRO-551: resolveServerPrefix', () => {
  it('defaults to /api when the operation has no servers override', () => {
    const operation: OperationObject = { summary: 'Get issue by ID' };
    expect(resolveServerPrefix({})).toBe('/api');
    expect(resolveServerPrefix(operation)).toBe('/api');
  });

  it('uses the operation-level servers override when present (ROOT_SERVER convention: url "/")', () => {
    const operation: OperationObject = {
      servers: [{ url: '/', description: 'Mounted at the application root — outside the /api prefix.' }],
    };
    expect(resolveServerPrefix(operation)).toBe('');
  });

  it('strips exactly one trailing slash from a custom override so prefix+path never double-slashes', () => {
    const operation: OperationObject = { servers: [{ url: '/v1/' }] };
    expect(resolveServerPrefix(operation)).toBe('/v1');
  });

  it('throws on an absolute server URL rather than silently concatenating it onto baseUrl (CodeRabbit, TRO-551)', () => {
    const operation: OperationObject = { servers: [{ url: 'https://other-host.example' }] };
    expect(() => resolveServerPrefix(operation)).toThrow(/Unsupported absolute server URL/);
  });
});

describe('TRO-551: buildRequestUrl', () => {
  it('builds the /api-prefixed URL for an ordinary operation (unaffected control case)', () => {
    const toolOp: ToolOperation = {
      method: 'get',
      path: '/issues/{id}',
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true }],
      },
    };

    const { url } = buildRequestUrl('http://ship.example', toolOp, { id: 'abc-123' });

    expect(url).toBe('http://ship.example/api/issues/abc-123');
  });

  it('builds the un-prefixed URL for an operation carrying the ROOT_SERVER override (PF-103 shape)', () => {
    const toolOp: ToolOperation = {
      method: 'get',
      path: '/oauth/authorize',
      operation: {
        servers: [{ url: '/', description: 'Mounted at the application root — outside the /api prefix.' }],
        parameters: [
          { name: 'client_id', in: 'query', required: true },
        ],
      },
    };

    const { url } = buildRequestUrl('http://ship.example', toolOp, { client_id: 'ship_app_1' });

    // NOT '.../api/oauth/authorize' — that would 404 against the real router,
    // which mounts this route at the application root (api/src/app.ts).
    expect(url).toBe('http://ship.example/oauth/authorize?client_id=ship_app_1');
  });

  it('builds the un-prefixed URL for POST /oauth/authorize/decision, with non-parameter args going to the body', () => {
    const toolOp: ToolOperation = {
      method: 'post',
      path: '/oauth/authorize/decision',
      operation: {
        servers: [{ url: '/', description: 'Mounted at the application root — outside the /api prefix.' }],
      },
    };

    const { url, bodyParams } = buildRequestUrl('http://ship.example', toolOp, {
      client_id: 'ship_app_1',
      decision: 'approve',
    });

    expect(url).toBe('http://ship.example/oauth/authorize/decision');
    expect(bodyParams).toEqual({ client_id: 'ship_app_1', decision: 'approve' });
  });
});
